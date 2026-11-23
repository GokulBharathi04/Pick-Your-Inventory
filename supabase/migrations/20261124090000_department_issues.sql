-- Departments, stock issues and end-of-day returns.
--
-- A department (Tandoor, Chinese, Bakery, Bar) takes stock out of a store
-- during the day with an ISSUE, and at the end of the day hands back what it
-- did not use with a RETURN. Departments do not hold stock: what was issued
-- and not returned on a business day is what the department used that day.
--
-- Both are posted in one call (post_department_movement) that writes the
-- document, its lines and the stock ledger rows together. A return can never
-- exceed what that department was issued on that business day, less what it
-- has already returned.
--
--   departments                    master, per outlet (syncs DOWN)
--   department_issues (+ _lines)   issue and return documents (sync UP)
--   post_department_movement()     posts an issue or a return
--   void_department_movement()     reverses one
--   department_usage()             issued, returned and used per day, department and item

-- ---------------------------------------------------------------------------
-- Permission and tab
-- ---------------------------------------------------------------------------
insert into public.permissions (code, area, description, sort_order) values
  ('departments.issue', 'Stock', 'Issue stock to departments and take back end-of-day returns', 325);

insert into private.default_role_permissions (role_key, permission_code) values
  ('admin',       'departments.issue'),
  ('manager',     'departments.issue'),
  ('storekeeper', 'departments.issue'),
  ('chef',        'departments.issue');

insert into public.role_permissions (organisation_id, role_id, permission_code)
select r.organisation_id, r.id, 'departments.issue'
from public.roles r
where r.key in ('admin', 'manager', 'storekeeper', 'chef')
on conflict (role_id, permission_code) do nothing;

insert into public.app_tabs (key, label, path, section, view_permission, sort_order) values
  ('issues', 'Issues and returns', '/issues', 'Stock', 'departments.issue', 207);

-- ---------------------------------------------------------------------------
-- Ledger: two new movement types
-- ---------------------------------------------------------------------------
alter table public.stock_ledger drop constraint stock_ledger_movement_type_check;
alter table public.stock_ledger add constraint stock_ledger_movement_type_check check (movement_type in (
  'opening', 'receipt', 'sale', 'prep_production', 'prep_consumption',
  'transfer_out', 'transfer_in', 'wastage', 'staff_meal',
  'adjustment', 'count_variance', 'vendor_return',
  'department_issue', 'department_return'));

alter table public.stock_ledger drop constraint stock_ledger_source_type_check;
alter table public.stock_ledger add constraint stock_ledger_source_type_check check (source_type in (
  'opening', 'adjustment', 'goods_receipt', 'sales_import', 'prep_batch',
  'stock_transfer', 'wastage', 'stock_count', 'vendor_return', 'reversal',
  'department_issue'));

alter table public.stock_ledger drop constraint stock_ledger_direction;
alter table public.stock_ledger add constraint stock_ledger_direction check (
  reverses_entry_id is not null
  or (movement_type in ('opening', 'receipt', 'prep_production', 'transfer_in', 'department_return') and quantity > 0)
  or (movement_type in ('sale', 'prep_consumption', 'transfer_out', 'wastage', 'staff_meal', 'vendor_return', 'department_issue') and quantity < 0)
  or movement_type in ('adjustment', 'count_variance'));

-- ---------------------------------------------------------------------------
-- Helpers: document numbers and the business day
-- ---------------------------------------------------------------------------
create table private.document_counters (
  outlet_id uuid not null references public.outlets (id) on delete cascade,
  doc_type  text not null,
  last_no   integer not null default 0,
  primary key (outlet_id, doc_type)
);

comment on table private.document_counters is 'Running number per outlet and document type (ISS-00001, PO-00001).';

-- Next number for an outlet and document type, e.g. ISS-00042.
create or replace function private.next_doc_no(p_outlet_id uuid, p_doc_type text, p_prefix text)
returns text
language sql
security definer
set search_path = ''
as $$
  insert into private.document_counters as c (outlet_id, doc_type, last_no)
  values (p_outlet_id, p_doc_type, 1)
  on conflict (outlet_id, doc_type) do update set last_no = c.last_no + 1
  returning p_prefix || '-' || lpad(last_no::text, 5, '0');
$$;

-- The calendar day a moment falls on in the organisation's time zone.
create or replace function private.business_date(p_outlet_id uuid, p_at timestamptz)
returns date
language sql
stable
security definer
set search_path = ''
as $$
  select (p_at at time zone coalesce(o.timezone, 'Asia/Kolkata'))::date
  from public.outlets ou
  join public.organisations o on o.id = ou.organisation_id
  where ou.id = p_outlet_id;
$$;

revoke all on function private.next_doc_no(uuid, text, text) from public;
revoke all on function private.business_date(uuid, timestamptz) from public;

-- ---------------------------------------------------------------------------
-- Departments
-- ---------------------------------------------------------------------------
create table public.departments (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null,
  outlet_id       uuid not null,
  name            text not null check (length(trim(name)) between 1 and 60),
  code            text check (code is null or code ~ '^[A-Za-z0-9_-]{1,20}$'),
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  sync_version    bigint not null default 0,
  unique (id, outlet_id),
  foreign key (outlet_id, organisation_id)
    references public.outlets (id, organisation_id) on delete restrict
);

create unique index departments_outlet_name_key on public.departments (outlet_id, lower(name));
create index departments_organisation_id_idx on public.departments (organisation_id);

comment on table public.departments is 'A section of an outlet that takes stock from the store (Tandoor, Chinese, Bar). Departments hold no stock: issued minus returned is what they used.';

-- ---------------------------------------------------------------------------
-- Issues and returns
-- ---------------------------------------------------------------------------
create table public.department_issues (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null,
  outlet_id       uuid not null,
  department_id   uuid not null,
  location_id     uuid not null,
  kind            text not null check (kind in ('issue', 'return')),
  doc_no          text,
  business_date   date not null,
  note            text,
  occurred_at     timestamptz not null default now(),
  recorded_by     uuid default auth.uid() references auth.users (id) on delete set null,
  voided_at       timestamptz,
  voided_by       uuid references auth.users (id) on delete set null,
  void_reason     text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  sync_version    bigint not null default 0,
  unique (id, outlet_id),
  check (voided_at is null or void_reason is not null),
  foreign key (outlet_id, organisation_id)
    references public.outlets (id, organisation_id) on delete restrict,
  foreign key (department_id, outlet_id)
    references public.departments (id, outlet_id) on delete restrict,
  foreign key (location_id, outlet_id)
    references public.storage_locations (id, outlet_id) on delete restrict
);

create unique index department_issues_outlet_no_key on public.department_issues (outlet_id, doc_no)
  where doc_no is not null;
create index department_issues_outlet_date_idx on public.department_issues (outlet_id, business_date);
create index department_issues_department_date_idx on public.department_issues (department_id, business_date);
create index department_issues_organisation_id_idx on public.department_issues (organisation_id);

comment on column public.department_issues.location_id is 'The store the stock left (issue) or went back to (return).';
comment on column public.department_issues.business_date is 'The trading day it belongs to, in the organisation''s time zone. Returns are matched to issues by day.';

create table public.department_issue_lines (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null,
  outlet_id       uuid not null,
  issue_id        uuid not null,
  item_id         uuid not null,
  quantity        numeric not null check (quantity > 0),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  sync_version    bigint not null default 0,
  unique (issue_id, item_id),
  foreign key (issue_id, outlet_id)
    references public.department_issues (id, outlet_id) on delete cascade,
  foreign key (outlet_id, organisation_id)
    references public.outlets (id, organisation_id) on delete restrict,
  foreign key (item_id, organisation_id)
    references public.items (id, organisation_id) on delete restrict
);

create index department_issue_lines_item_id_idx on public.department_issue_lines (item_id);

comment on column public.department_issue_lines.quantity is 'Base units issued or returned (positive). The ledger signs it.';

-- What a department still holds of an item on a business day: issued minus
-- returned, leaving out voided documents.
create or replace function private.department_net_issued(
  p_department_id uuid, p_business_date date, p_item_id uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(case when d.kind = 'issue' then l.quantity else -l.quantity end), 0)
  from public.department_issues d
  join public.department_issue_lines l on l.issue_id = d.id
  where d.department_id = p_department_id
    and d.business_date = p_business_date
    and l.item_id = p_item_id
    and d.voided_at is null;
$$;

revoke all on function private.department_net_issued(uuid, date, uuid) from public;

-- ---------------------------------------------------------------------------
-- Posting
-- ---------------------------------------------------------------------------
-- p_lines: [{"item_id": "...", "quantity": 2.5, "unit": "kg"}, ...]. The unit
-- is optional; without it the quantity is in the item's base unit. The same
-- item on several lines is added up.
create or replace function public.post_department_movement(
  p_outlet_id     uuid,
  p_department_id uuid,
  p_location_id   uuid,
  p_kind          text,
  p_lines         jsonb,
  p_note          text default null,
  p_occurred_at   timestamptz default null,
  p_business_date date default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org  uuid;
  v_at   timestamptz := coalesce(p_occurred_at, now());
  v_date date;
  v_id   uuid;
  v_line record;
  v_line_id uuid;
  v_avail numeric;
  v_cost numeric;
  v_name text;
begin
  v_org := private.require_outlet_permission(p_outlet_id, 'departments.issue');

  if p_kind is null or p_kind not in ('issue', 'return') then
    raise exception 'Choose issue or return' using errcode = '22023';
  end if;

  if not exists (select 1 from public.departments d
                 where d.id = p_department_id and d.outlet_id = p_outlet_id and d.is_active) then
    raise exception 'Choose an active department of this outlet' using errcode = '22023';
  end if;

  if not exists (select 1 from public.storage_locations l
                 where l.id = p_location_id and l.outlet_id = p_outlet_id and l.is_active and l.kind = 'store') then
    raise exception 'Issues come from, and returns go back to, an active store location' using errcode = '22023';
  end if;

  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Add at least one item' using errcode = '22023';
  end if;

  if exists (select 1 from jsonb_array_elements(p_lines) e
             where nullif(e ->> 'item_id', '') is null
                or coalesce((e ->> 'quantity')::numeric, 0) <= 0) then
    raise exception 'Every line needs an item and a quantity above zero' using errcode = '22023';
  end if;

  v_date := coalesce(p_business_date, private.business_date(p_outlet_id, v_at));

  insert into public.department_issues (
    organisation_id, outlet_id, department_id, location_id, kind, doc_no, business_date, note, occurred_at, recorded_by)
  values (
    v_org, p_outlet_id, p_department_id, p_location_id, p_kind,
    private.next_doc_no(p_outlet_id, p_kind, case when p_kind = 'issue' then 'ISS' else 'RET' end),
    v_date, nullif(trim(p_note), ''), v_at, auth.uid())
  returning id into v_id;

  for v_line in
    select x.item_id, sum(x.qty) as quantity
    from (
      select (e ->> 'item_id')::uuid as item_id,
             case when nullif(e ->> 'unit', '') is null then (e ->> 'quantity')::numeric
                  else private.to_base_qty((e ->> 'item_id')::uuid, (e ->> 'quantity')::numeric, e ->> 'unit') end as qty
      from jsonb_array_elements(p_lines) e
    ) x
    group by x.item_id
  loop
    v_name := (private.require_item(v_org, v_line.item_id)).name;

    if p_kind = 'return' then
      -- this document's own line is not inserted yet, so this is what is still out
      v_avail := private.department_net_issued(p_department_id, v_date, v_line.item_id);
      if v_line.quantity > v_avail then
        raise exception '%: this department can return at most % (issued on % less returns already made)',
          v_name, round(v_avail, 3), to_char(v_date, 'DD Mon YYYY') using errcode = '22023';
      end if;

      -- returned at the average cost it went out at that day
      select round(sum(l.value) / nullif(sum(l.quantity), 0), 6) into v_cost
      from public.stock_ledger l
      join public.department_issues d on d.id = l.source_id
      where l.movement_type = 'department_issue'
        and l.item_id = v_line.item_id
        and d.department_id = p_department_id
        and d.business_date = v_date
        and d.kind = 'issue'
        and d.voided_at is null
        and l.reverses_entry_id is null;
      v_cost := coalesce(v_cost, private.current_unit_cost(p_outlet_id, v_line.item_id));
    else
      v_cost := private.current_unit_cost(p_outlet_id, v_line.item_id);
    end if;

    insert into public.department_issue_lines (organisation_id, outlet_id, issue_id, item_id, quantity)
    values (v_org, p_outlet_id, v_id, v_line.item_id, round(v_line.quantity, 6))
    returning id into v_line_id;

    perform private.add_ledger_entry(
      v_org, p_outlet_id, p_location_id, v_line.item_id,
      case when p_kind = 'issue' then 'department_issue' else 'department_return' end,
      case when p_kind = 'issue' then -v_line.quantity else v_line.quantity end,
      v_cost, 'department_issue', v_id, v_line_id, v_at, nullif(trim(p_note), ''));
  end loop;

  return v_id;
end;
$$;

create or replace function public.void_department_movement(p_issue_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.department_issues;
  v_bad text;
begin
  select * into v from public.department_issues where id = p_issue_id for update;
  if not found then
    raise exception 'Issue or return not found' using errcode = 'P0002';
  end if;
  perform private.require_outlet_permission(v.outlet_id, 'stock.adjust');

  if v.voided_at is not null then
    raise exception 'This % is already void', v.kind using errcode = '55000';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'Give a reason for voiding' using errcode = '22023';
  end if;

  -- Voiding an issue must not leave more returned than issued that day.
  if v.kind = 'issue' then
    select i.name into v_bad
    from public.department_issue_lines l
    join public.items i on i.id = l.item_id
    where l.issue_id = v.id
      and private.department_net_issued(v.department_id, v.business_date, l.item_id) - l.quantity < 0
    limit 1;
    if v_bad is not null then
      raise exception '%: void the return for this day first, then this issue', v_bad using errcode = '55000';
    end if;
  end if;

  perform private.reverse_ledger_entries('department_issue', v.id,
    initcap(v.kind) || ' voided: ' || p_reason);

  update public.department_issues
  set voided_at = now(), voided_by = auth.uid(), void_reason = p_reason
  where id = v.id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Report: what each department used (runs with the caller's rights)
-- ---------------------------------------------------------------------------
create or replace function public.department_usage(
  p_outlet_id     uuid,
  p_from          date,
  p_to            date,
  p_department_id uuid default null)
returns table (
  business_date date,
  department_id uuid,
  item_id       uuid,
  issued        numeric,
  returned      numeric,
  used          numeric,
  used_value    numeric)
language sql
stable
set search_path = ''
as $$
  -- Reversals keep their movement type and source, so voided documents net out.
  select d.business_date, d.department_id, l.item_id,
         coalesce(sum(-l.quantity) filter (where l.movement_type = 'department_issue'), 0),
         coalesce(sum(l.quantity)  filter (where l.movement_type = 'department_return'), 0),
         -sum(l.quantity),
         -sum(l.value)
  from public.stock_ledger l
  join public.department_issues d on d.id = l.source_id
  where l.movement_type in ('department_issue', 'department_return')
    and d.outlet_id = p_outlet_id
    and d.business_date between p_from and p_to
    and (p_department_id is null or d.department_id = p_department_id)
  group by d.business_date, d.department_id, l.item_id;
$$;

-- ---------------------------------------------------------------------------
-- Triggers and sync
-- ---------------------------------------------------------------------------
create trigger set_updated_at before update on public.departments
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.department_issues
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.department_issue_lines
  for each row execute function private.set_updated_at();

create trigger bump_sync_version before insert or update on public.departments
  for each row execute function private.bump_sync_version();
create trigger bump_sync_version before insert or update on public.department_issues
  for each row execute function private.bump_sync_version();
create trigger bump_sync_version before insert or update on public.department_issue_lines
  for each row execute function private.bump_sync_version();

insert into private.sync_tables (table_name, direction, scope) values
  ('departments',            'down', 'organisation'),
  ('department_issues',      'up',   'outlet'),
  ('department_issue_lines', 'up',   'outlet');

-- ---------------------------------------------------------------------------
-- Privileges and row-level security
-- ---------------------------------------------------------------------------
alter table public.departments            enable row level security;
alter table public.department_issues      enable row level security;
alter table public.department_issue_lines enable row level security;

revoke all on table public.departments, public.department_issues, public.department_issue_lines
from anon, authenticated;

grant select on public.departments to authenticated;
grant insert (organisation_id, outlet_id, name, code) on public.departments to authenticated;
grant update (name, code, is_active) on public.departments to authenticated;

-- Issues and returns are written only by the posting functions.
grant select on public.department_issues, public.department_issue_lines to authenticated;

create policy "Members can read departments of their organisation"
  on public.departments for select to authenticated
  using (organisation_id in (select private.my_organisation_ids()));
create policy "Organisation managers can add departments"
  on public.departments for insert to authenticated
  with check (organisation_id in (select private.org_ids_with('organisation.manage')));
create policy "Organisation managers can edit departments"
  on public.departments for update to authenticated
  using (organisation_id in (select private.org_ids_with('organisation.manage')))
  with check (organisation_id in (select private.org_ids_with('organisation.manage')));

create policy "Stock viewers and issuers can read issues and returns"
  on public.department_issues for select to authenticated
  using (outlet_id in (select private.outlet_ids_with('stock.view'))
         or outlet_id in (select private.outlet_ids_with('departments.issue')));

create policy "Stock viewers and issuers can read issue lines"
  on public.department_issue_lines for select to authenticated
  using (outlet_id in (select private.outlet_ids_with('stock.view'))
         or outlet_id in (select private.outlet_ids_with('departments.issue')));

revoke all on function public.post_department_movement(uuid, uuid, uuid, text, jsonb, text, timestamptz, date) from public, anon;
revoke all on function public.void_department_movement(uuid, text) from public, anon;
revoke all on function public.department_usage(uuid, date, date, uuid) from public, anon;

grant execute on function public.post_department_movement(uuid, uuid, uuid, text, jsonb, text, timestamptz, date) to authenticated;
grant execute on function public.void_department_movement(uuid, text) to authenticated;
grant execute on function public.department_usage(uuid, date, date, uuid) to authenticated;
