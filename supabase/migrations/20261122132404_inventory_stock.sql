-- Inventory, part 2 of 3: stock ledger and stock documents (Module 2).
--
-- The stock ledger is the single record of every stock movement. Stock on
-- hand is the sum of the ledger; it is never typed in. Ledger rows are never
-- changed or deleted: a mistake is undone by a reversing entry.
--
-- Documents that move stock (transfers, wastage, adjustments, counts) are
-- created at an outlet and sync UP to the cloud with the ledger. Turning a
-- document into ledger entries happens in posting functions (next step);
-- this migration defines the tables, rules and access.
--
-- Transfers here are between storage locations of one outlet. Outlet-to-outlet
-- transfers pass through the cloud and arrive with the sync engine.

-- ---------------------------------------------------------------------------
-- Stock ledger
-- ---------------------------------------------------------------------------
create table public.stock_ledger (
  id                uuid primary key default gen_random_uuid(),
  organisation_id   uuid not null,
  outlet_id         uuid not null,
  location_id       uuid not null,
  item_id           uuid not null,
  movement_type     text not null check (movement_type in (
                      'opening', 'receipt', 'sale', 'prep_production', 'prep_consumption',
                      'transfer_out', 'transfer_in', 'wastage', 'staff_meal',
                      'adjustment', 'count_variance', 'vendor_return')),
  quantity          numeric not null check (quantity <> 0),
  unit_cost         numeric(18,6) not null default 0 check (unit_cost >= 0),
  value             numeric(14,2) generated always as (round(quantity * unit_cost, 2)) stored,
  source_type       text not null check (source_type in (
                      'opening', 'adjustment', 'goods_receipt', 'sales_import', 'prep_batch',
                      'stock_transfer', 'wastage', 'stock_count', 'vendor_return', 'reversal')),
  source_id         uuid,
  source_line_id    uuid,
  reverses_entry_id uuid references public.stock_ledger (id) on delete restrict,
  occurred_at       timestamptz not null default now(),
  recorded_by       uuid references auth.users (id) on delete set null,
  note              text,
  created_at        timestamptz not null default now(),
  sync_version      bigint not null default 0,
  foreign key (outlet_id, organisation_id)
    references public.outlets (id, organisation_id) on delete restrict,
  foreign key (location_id, outlet_id)
    references public.storage_locations (id, outlet_id) on delete restrict,
  foreign key (item_id, organisation_id)
    references public.items (id, organisation_id) on delete restrict,
  -- Stock comes in with positive quantities and goes out with negative ones.
  constraint stock_ledger_direction check (
    reverses_entry_id is not null
    or (movement_type in ('opening', 'receipt', 'prep_production', 'transfer_in') and quantity > 0)
    or (movement_type in ('sale', 'prep_consumption', 'transfer_out', 'wastage', 'staff_meal', 'vendor_return') and quantity < 0)
    or movement_type in ('adjustment', 'count_variance')
  ),
  constraint stock_ledger_reversal_source check (
    (reverses_entry_id is null) = (source_type <> 'reversal')
  )
);

create unique index stock_ledger_one_reversal_per_entry
  on public.stock_ledger (reverses_entry_id) where reverses_entry_id is not null;
create index stock_ledger_outlet_item_time_idx on public.stock_ledger (outlet_id, item_id, occurred_at);
create index stock_ledger_location_item_idx on public.stock_ledger (location_id, item_id);
create index stock_ledger_item_id_idx on public.stock_ledger (item_id);
create index stock_ledger_organisation_id_idx on public.stock_ledger (organisation_id);
create index stock_ledger_source_idx on public.stock_ledger (source_type, source_id);

comment on table public.stock_ledger is 'Every stock movement, in base units, signed (+ in, - out). Append-only: corrections are reversing entries.';
comment on column public.stock_ledger.unit_cost is 'Rupees per base unit. Issues are valued at the average cost at the time, so value / quantity stays the moving average.';

-- Append-only: refuse every update, delete and truncate.
create or replace function private.stock_ledger_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'Stock ledger entries cannot be changed or deleted. Record a reversing entry instead.'
    using errcode = '55000';
end;
$$;

create trigger stock_ledger_no_update_or_delete before update or delete on public.stock_ledger
  for each row execute function private.stock_ledger_append_only();
create trigger stock_ledger_no_truncate before truncate on public.stock_ledger
  for each statement execute function private.stock_ledger_append_only();

-- A reversal must exactly cancel the entry it reverses.
create or replace function private.check_stock_reversal()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_orig public.stock_ledger;
begin
  if new.reverses_entry_id is null then
    return new;
  end if;

  select * into v_orig from public.stock_ledger where id = new.reverses_entry_id;
  if not found then
    raise exception 'The entry being reversed does not exist' using errcode = '23503';
  end if;
  if v_orig.reverses_entry_id is not null then
    raise exception 'A reversal cannot itself be reversed; record a new entry instead' using errcode = '22023';
  end if;
  if new.item_id <> v_orig.item_id or new.location_id <> v_orig.location_id
     or new.outlet_id <> v_orig.outlet_id or new.movement_type <> v_orig.movement_type
     or new.quantity <> -v_orig.quantity or new.unit_cost <> v_orig.unit_cost then
    raise exception 'A reversal must have the same item, location, type and cost, with the opposite quantity'
      using errcode = '22023';
  end if;
  return new;
end;
$$;

revoke all on function private.check_stock_reversal() from public;

create trigger check_stock_reversal before insert on public.stock_ledger
  for each row execute function private.check_stock_reversal();

-- An item's base unit cannot change once it has stock movements.
create or replace function private.guard_item_base_unit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.base_unit is distinct from old.base_unit
     and exists (select 1 from public.stock_ledger l where l.item_id = old.id) then
    raise exception 'The base unit of % cannot change because it already has stock movements', old.name
      using errcode = '55000';
  end if;
  return new;
end;
$$;

revoke all on function private.guard_item_base_unit() from public;

create trigger guard_item_base_unit before update of base_unit on public.items
  for each row execute function private.guard_item_base_unit();

-- ---------------------------------------------------------------------------
-- Transfers between storage locations of one outlet
-- ---------------------------------------------------------------------------
create table public.stock_transfers (
  id               uuid primary key default gen_random_uuid(),
  organisation_id  uuid not null,
  outlet_id        uuid not null,
  transfer_no      text,
  from_location_id uuid not null,
  to_location_id   uuid not null,
  status           text not null default 'draft' check (status in ('draft', 'sent', 'received', 'cancelled')),
  note             text,
  created_by       uuid default auth.uid() references auth.users (id) on delete set null,
  sent_by          uuid references auth.users (id) on delete set null,
  sent_at          timestamptz,
  received_by      uuid references auth.users (id) on delete set null,
  received_at      timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  sync_version     bigint not null default 0,
  unique (id, outlet_id),
  check (from_location_id <> to_location_id),
  foreign key (outlet_id, organisation_id)
    references public.outlets (id, organisation_id) on delete restrict,
  foreign key (from_location_id, outlet_id)
    references public.storage_locations (id, outlet_id) on delete restrict,
  foreign key (to_location_id, outlet_id)
    references public.storage_locations (id, outlet_id) on delete restrict
);

create unique index stock_transfers_outlet_no_key on public.stock_transfers (outlet_id, transfer_no)
  where transfer_no is not null;
create index stock_transfers_organisation_id_idx on public.stock_transfers (organisation_id);

create table public.stock_transfer_lines (
  id                uuid primary key default gen_random_uuid(),
  organisation_id   uuid not null,
  outlet_id         uuid not null,
  transfer_id       uuid not null,
  item_id           uuid not null,
  quantity_sent     numeric not null check (quantity_sent > 0),
  quantity_received numeric check (quantity_received is null or quantity_received >= 0),
  note              text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  sync_version      bigint not null default 0,
  unique (transfer_id, item_id),
  foreign key (transfer_id, outlet_id)
    references public.stock_transfers (id, outlet_id) on delete cascade,
  foreign key (outlet_id, organisation_id)
    references public.outlets (id, organisation_id) on delete restrict,
  foreign key (item_id, organisation_id)
    references public.items (id, organisation_id) on delete restrict
);

create index stock_transfer_lines_item_id_idx on public.stock_transfer_lines (item_id);

create or replace function private.transfer_is_draft(p_transfer_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select t.status = 'draft' from public.stock_transfers t where t.id = p_transfer_id), false);
$$;

-- ---------------------------------------------------------------------------
-- Wastage and staff meals (posted by a function together with its ledger row)
-- ---------------------------------------------------------------------------
create table public.wastage_entries (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null,
  outlet_id       uuid not null,
  location_id     uuid not null,
  item_id         uuid not null,
  quantity        numeric not null check (quantity > 0),
  reason          text not null check (reason in (
                    'spoiled', 'expired', 'burnt', 'dropped', 'overproduced',
                    'staff_meal', 'tasting', 'other')),
  note            text,
  photo_path      text,
  occurred_at     timestamptz not null default now(),
  recorded_by     uuid default auth.uid() references auth.users (id) on delete set null,
  voided_at       timestamptz,
  voided_by       uuid references auth.users (id) on delete set null,
  void_reason     text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  sync_version    bigint not null default 0,
  check (voided_at is null or void_reason is not null),
  foreign key (outlet_id, organisation_id)
    references public.outlets (id, organisation_id) on delete restrict,
  foreign key (location_id, outlet_id)
    references public.storage_locations (id, outlet_id) on delete restrict,
  foreign key (item_id, organisation_id)
    references public.items (id, organisation_id) on delete restrict
);

create index wastage_entries_outlet_time_idx on public.wastage_entries (outlet_id, occurred_at);
create index wastage_entries_item_id_idx on public.wastage_entries (item_id);
create index wastage_entries_organisation_id_idx on public.wastage_entries (organisation_id);

comment on column public.wastage_entries.quantity is 'Base units wasted (positive). The ledger records it as a negative movement.';

-- ---------------------------------------------------------------------------
-- Opening stock and adjustments: requested, then posted or rejected
-- ---------------------------------------------------------------------------
create table public.stock_adjustments (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null,
  outlet_id       uuid not null,
  location_id     uuid not null,
  item_id         uuid not null,
  kind            text not null default 'adjustment' check (kind in ('opening', 'adjustment')),
  quantity        numeric not null check (quantity <> 0),
  unit_cost       numeric(18,6) check (unit_cost is null or unit_cost >= 0),
  reason          text not null check (length(trim(reason)) between 1 and 200),
  status          text not null default 'pending' check (status in ('pending', 'posted', 'rejected')),
  requested_by    uuid default auth.uid() references auth.users (id) on delete set null,
  requested_at    timestamptz not null default now(),
  decided_by      uuid references auth.users (id) on delete set null,
  decided_at      timestamptz,
  decision_note   text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  sync_version    bigint not null default 0,
  check (kind <> 'opening' or (quantity > 0 and unit_cost is not null)),
  foreign key (outlet_id, organisation_id)
    references public.outlets (id, organisation_id) on delete restrict,
  foreign key (location_id, outlet_id)
    references public.storage_locations (id, outlet_id) on delete restrict,
  foreign key (item_id, organisation_id)
    references public.items (id, organisation_id) on delete restrict
);

create index stock_adjustments_outlet_status_idx on public.stock_adjustments (outlet_id, status);
create index stock_adjustments_organisation_id_idx on public.stock_adjustments (organisation_id);

comment on column public.stock_adjustments.unit_cost is 'Required for opening stock. Adjustments use the average cost when posted.';

-- ---------------------------------------------------------------------------
-- Physical counts. Counts are blind: system quantities are filled in only
-- when the count is submitted.
-- ---------------------------------------------------------------------------
create table public.stock_counts (
  id                 uuid primary key default gen_random_uuid(),
  organisation_id    uuid not null,
  outlet_id          uuid not null,
  location_id        uuid,
  count_no           text,
  scope_category_ids uuid[] not null default '{}',
  status             text not null default 'in_progress'
                     check (status in ('in_progress', 'submitted', 'approved', 'cancelled')),
  note               text,
  started_by         uuid default auth.uid() references auth.users (id) on delete set null,
  started_at         timestamptz not null default now(),
  submitted_by       uuid references auth.users (id) on delete set null,
  submitted_at       timestamptz,
  approved_by        uuid references auth.users (id) on delete set null,
  approved_at        timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  sync_version       bigint not null default 0,
  unique (id, outlet_id),
  foreign key (outlet_id, organisation_id)
    references public.outlets (id, organisation_id) on delete restrict,
  foreign key (location_id, outlet_id)
    references public.storage_locations (id, outlet_id) on delete restrict
);

create unique index stock_counts_outlet_no_key on public.stock_counts (outlet_id, count_no)
  where count_no is not null;
create index stock_counts_organisation_id_idx on public.stock_counts (organisation_id);

create table public.stock_count_lines (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null,
  outlet_id       uuid not null,
  count_id        uuid not null,
  item_id         uuid not null,
  location_id     uuid not null,
  counted_qty     numeric check (counted_qty is null or counted_qty >= 0),
  counted_by      uuid references auth.users (id) on delete set null,
  counted_at      timestamptz,
  system_qty      numeric,
  unit_cost       numeric(18,6) check (unit_cost is null or unit_cost >= 0),
  variance_qty    numeric generated always as (counted_qty - system_qty) stored,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  sync_version    bigint not null default 0,
  unique (count_id, item_id, location_id),
  foreign key (count_id, outlet_id)
    references public.stock_counts (id, outlet_id) on delete cascade,
  foreign key (outlet_id, organisation_id)
    references public.outlets (id, organisation_id) on delete restrict,
  foreign key (location_id, outlet_id)
    references public.storage_locations (id, outlet_id) on delete restrict,
  foreign key (item_id, organisation_id)
    references public.items (id, organisation_id) on delete restrict
);

create index stock_count_lines_item_id_idx on public.stock_count_lines (item_id);

comment on column public.stock_count_lines.system_qty is 'Snapshot of stock on hand, filled when the count is submitted (blind until then).';

create or replace function private.count_is_open(p_count_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select c.status = 'in_progress' from public.stock_counts c where c.id = p_count_id), false);
$$;

-- Records who counted a line and when.
create or replace function private.stamp_counted_by()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.counted_qty is not null
     and (tg_op = 'INSERT' or new.counted_qty is distinct from old.counted_qty) then
    new.counted_by := auth.uid();
    new.counted_at := now();
  end if;
  return new;
end;
$$;

create trigger stamp_counted_by before insert or update on public.stock_count_lines
  for each row execute function private.stamp_counted_by();

revoke all on function private.transfer_is_draft(uuid) from public;
revoke all on function private.count_is_open(uuid) from public;
grant execute on function private.transfer_is_draft(uuid) to authenticated, service_role;
grant execute on function private.count_is_open(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Stock on hand (views run with the caller's permissions)
-- ---------------------------------------------------------------------------
create view public.stock_on_hand
with (security_invoker = true)
as
select
  l.organisation_id,
  l.outlet_id,
  l.location_id,
  l.item_id,
  sum(l.quantity)    as quantity,
  sum(l.value)       as value,
  max(l.occurred_at) as last_movement_at
from public.stock_ledger l
group by l.organisation_id, l.outlet_id, l.location_id, l.item_id;

comment on view public.stock_on_hand is 'Stock per item per storage location: the sum of the ledger.';

create view public.outlet_stock
with (security_invoker = true)
as
with totals as (
  select l.organisation_id, l.outlet_id, l.item_id,
         sum(l.quantity) as quantity, sum(l.value) as value
  from public.stock_ledger l
  group by l.organisation_id, l.outlet_id, l.item_id
)
select
  coalesce(t.organisation_id, s.organisation_id) as organisation_id,
  coalesce(t.outlet_id, s.outlet_id)             as outlet_id,
  coalesce(t.item_id, s.item_id)                 as item_id,
  coalesce(t.quantity, 0)                        as quantity,
  coalesce(t.value, 0)                           as value,
  case when t.quantity > 0 then round(t.value / t.quantity, 6) end as average_cost,
  s.reorder_level,
  s.reorder_qty,
  coalesce(s.reorder_level is not null and coalesce(t.quantity, 0) <= s.reorder_level, false) as below_reorder_level,
  coalesce(t.quantity, 0) < 0                    as is_negative
from totals t
full join public.item_outlet_settings s
  on s.outlet_id = t.outlet_id and s.item_id = t.item_id
where coalesce(s.is_stocked, true);

comment on view public.outlet_stock is 'Stock per item per outlet with average cost and reorder flags.';

-- ---------------------------------------------------------------------------
-- Triggers: updated_at, sync_version, tombstones for deletable lines
-- ---------------------------------------------------------------------------
create trigger set_updated_at before update on public.stock_transfers
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.stock_transfer_lines
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.wastage_entries
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.stock_adjustments
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.stock_counts
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.stock_count_lines
  for each row execute function private.set_updated_at();

create trigger bump_sync_version before insert on public.stock_ledger
  for each row execute function private.bump_sync_version();
create trigger bump_sync_version before insert or update on public.stock_transfers
  for each row execute function private.bump_sync_version();
create trigger bump_sync_version before insert or update on public.stock_transfer_lines
  for each row execute function private.bump_sync_version();
create trigger bump_sync_version before insert or update on public.wastage_entries
  for each row execute function private.bump_sync_version();
create trigger bump_sync_version before insert or update on public.stock_adjustments
  for each row execute function private.bump_sync_version();
create trigger bump_sync_version before insert or update on public.stock_counts
  for each row execute function private.bump_sync_version();
create trigger bump_sync_version before insert or update on public.stock_count_lines
  for each row execute function private.bump_sync_version();

create trigger record_tombstone after delete on public.stock_transfer_lines
  for each row execute function private.record_tombstone('id');
create trigger record_tombstone after delete on public.stock_count_lines
  for each row execute function private.record_tombstone('id');

insert into private.sync_tables (table_name, direction, scope) values
  ('stock_ledger',         'up', 'outlet'),
  ('stock_transfers',      'up', 'outlet'),
  ('stock_transfer_lines', 'up', 'outlet'),
  ('wastage_entries',      'up', 'outlet'),
  ('stock_adjustments',    'up', 'outlet'),
  ('stock_counts',         'up', 'outlet'),
  ('stock_count_lines',    'up', 'outlet');

-- ---------------------------------------------------------------------------
-- Privileges and row-level security
-- ---------------------------------------------------------------------------
alter table public.stock_ledger         enable row level security;
alter table public.stock_transfers      enable row level security;
alter table public.stock_transfer_lines enable row level security;
alter table public.wastage_entries      enable row level security;
alter table public.stock_adjustments    enable row level security;
alter table public.stock_counts         enable row level security;
alter table public.stock_count_lines    enable row level security;

revoke all on table
  public.stock_ledger, public.stock_transfers, public.stock_transfer_lines,
  public.wastage_entries, public.stock_adjustments, public.stock_counts,
  public.stock_count_lines, public.stock_on_hand, public.outlet_stock
from anon, authenticated;

-- Ledger and wastage: read-only for users; posting functions write them.
grant select on public.stock_ledger, public.wastage_entries to authenticated;
grant select on public.stock_on_hand, public.outlet_stock to authenticated;

grant select on public.stock_transfers to authenticated;
grant insert (organisation_id, outlet_id, from_location_id, to_location_id, note)
  on public.stock_transfers to authenticated;
grant update (from_location_id, to_location_id, note) on public.stock_transfers to authenticated;

grant select, delete on public.stock_transfer_lines to authenticated;
grant insert (organisation_id, outlet_id, transfer_id, item_id, quantity_sent, note)
  on public.stock_transfer_lines to authenticated;
grant update (quantity_sent, note) on public.stock_transfer_lines to authenticated;

grant select on public.stock_adjustments to authenticated;
grant insert (organisation_id, outlet_id, location_id, item_id, kind, quantity, unit_cost, reason)
  on public.stock_adjustments to authenticated;

grant select on public.stock_counts to authenticated;
grant insert (organisation_id, outlet_id, location_id, scope_category_ids, note)
  on public.stock_counts to authenticated;
grant update (note) on public.stock_counts to authenticated;

grant select, delete on public.stock_count_lines to authenticated;
grant insert (organisation_id, outlet_id, count_id, item_id, location_id, counted_qty)
  on public.stock_count_lines to authenticated;
grant update (counted_qty) on public.stock_count_lines to authenticated;

create policy "Stock viewers can read the ledger of their outlets"
  on public.stock_ledger for select to authenticated
  using (outlet_id in (select private.outlet_ids_with('stock.view')));

create policy "Stock viewers and transferers can read transfers"
  on public.stock_transfers for select to authenticated
  using (outlet_id in (select private.outlet_ids_with('stock.view'))
         or outlet_id in (select private.outlet_ids_with('stock.transfer')));
create policy "Transferers can start transfers"
  on public.stock_transfers for insert to authenticated
  with check (outlet_id in (select private.outlet_ids_with('stock.transfer')) and status = 'draft');
create policy "Transferers can edit draft transfers"
  on public.stock_transfers for update to authenticated
  using (outlet_id in (select private.outlet_ids_with('stock.transfer')) and status = 'draft')
  with check (outlet_id in (select private.outlet_ids_with('stock.transfer')) and status = 'draft');

create policy "Stock viewers and transferers can read transfer lines"
  on public.stock_transfer_lines for select to authenticated
  using (outlet_id in (select private.outlet_ids_with('stock.view'))
         or outlet_id in (select private.outlet_ids_with('stock.transfer')));
create policy "Transferers can add lines to draft transfers"
  on public.stock_transfer_lines for insert to authenticated
  with check (outlet_id in (select private.outlet_ids_with('stock.transfer'))
              and private.transfer_is_draft(transfer_id));
create policy "Transferers can edit lines of draft transfers"
  on public.stock_transfer_lines for update to authenticated
  using (outlet_id in (select private.outlet_ids_with('stock.transfer'))
         and private.transfer_is_draft(transfer_id))
  with check (outlet_id in (select private.outlet_ids_with('stock.transfer'))
              and private.transfer_is_draft(transfer_id));
create policy "Transferers can remove lines of draft transfers"
  on public.stock_transfer_lines for delete to authenticated
  using (outlet_id in (select private.outlet_ids_with('stock.transfer'))
         and private.transfer_is_draft(transfer_id));

create policy "Stock viewers and wastage recorders can read wastage"
  on public.wastage_entries for select to authenticated
  using (outlet_id in (select private.outlet_ids_with('stock.view'))
         or outlet_id in (select private.outlet_ids_with('wastage.record')));

create policy "Stock viewers and adjusters can read adjustments"
  on public.stock_adjustments for select to authenticated
  using (outlet_id in (select private.outlet_ids_with('stock.view'))
         or outlet_id in (select private.outlet_ids_with('stock.adjust')));
create policy "Adjusters can request adjustments"
  on public.stock_adjustments for insert to authenticated
  with check (outlet_id in (select private.outlet_ids_with('stock.adjust')) and status = 'pending');

create policy "Counters, approvers and stock viewers can read counts"
  on public.stock_counts for select to authenticated
  using (outlet_id in (select private.outlet_ids_with('counts.count'))
         or outlet_id in (select private.outlet_ids_with('counts.approve'))
         or outlet_id in (select private.outlet_ids_with('stock.view')));
create policy "Counters can start counts"
  on public.stock_counts for insert to authenticated
  with check (outlet_id in (select private.outlet_ids_with('counts.count')) and status = 'in_progress');
create policy "Counters can edit counts in progress"
  on public.stock_counts for update to authenticated
  using (outlet_id in (select private.outlet_ids_with('counts.count')) and status = 'in_progress')
  with check (outlet_id in (select private.outlet_ids_with('counts.count')) and status = 'in_progress');

create policy "Counters, approvers and stock viewers can read count lines"
  on public.stock_count_lines for select to authenticated
  using (outlet_id in (select private.outlet_ids_with('counts.count'))
         or outlet_id in (select private.outlet_ids_with('counts.approve'))
         or outlet_id in (select private.outlet_ids_with('stock.view')));
create policy "Counters can add lines to counts in progress"
  on public.stock_count_lines for insert to authenticated
  with check (outlet_id in (select private.outlet_ids_with('counts.count'))
              and private.count_is_open(count_id));
create policy "Counters can enter quantities on counts in progress"
  on public.stock_count_lines for update to authenticated
  using (outlet_id in (select private.outlet_ids_with('counts.count'))
         and private.count_is_open(count_id))
  with check (outlet_id in (select private.outlet_ids_with('counts.count'))
              and private.count_is_open(count_id));
create policy "Counters can remove lines from counts in progress"
  on public.stock_count_lines for delete to authenticated
  using (outlet_id in (select private.outlet_ids_with('counts.count'))
         and private.count_is_open(count_id));
