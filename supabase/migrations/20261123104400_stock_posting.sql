-- Stock posting: the functions that turn documents into stock ledger rows.
--
-- Each function checks the caller's permission at the outlet, locks the
-- document, checks its status, writes the ledger rows and updates the
-- document, all in one transaction. The app calls them as RPCs.
--
--   post_wastage / void_wastage
--   decide_stock_adjustment            (opening stock and adjustments)
--   send_ / receive_ / cancel_stock_transfer
--   submit_ / approve_ / cancel_stock_count
--   post_prep_batch / void_prep_batch
--   post_sales_import / void_sales_import
--
-- Costing: stock leaves at the outlet's moving average cost (ledger value
-- divided by quantity). With no stock on hand it falls back to the last cost
-- received, then the preferred vendor's current rate.
--
-- Prep items: by default a prep item (gravy base) is made in batches and
-- kept in stock, so a sale deducts the prep item itself. A prep item marked
-- deduct_ingredients_on_sale (made to order) is expanded through its recipe
-- at the time of sale instead.

-- ---------------------------------------------------------------------------
-- New permission: approve opening stock and adjustments
-- ---------------------------------------------------------------------------
insert into public.permissions (code, area, description, sort_order) values
  ('adjustments.approve', 'Stock', 'Approve or reject opening stock and stock adjustments', 315);

insert into private.default_role_permissions (role_key, permission_code) values
  ('admin', 'adjustments.approve'),
  ('manager', 'adjustments.approve');

insert into public.role_permissions (organisation_id, role_id, permission_code)
select r.organisation_id, r.id, 'adjustments.approve'
from public.roles r
where r.key in ('admin', 'manager')
on conflict (role_id, permission_code) do nothing;

-- ---------------------------------------------------------------------------
-- Prep items made to order
-- ---------------------------------------------------------------------------
alter table public.items
  add column deduct_ingredients_on_sale boolean not null default false;

comment on column public.items.deduct_ingredients_on_sale is
  'For prep items made to order: a sale deducts the ingredients of its recipe instead of the prep item''s own stock.';

grant insert (deduct_ingredients_on_sale) on public.items to authenticated;
grant update (deduct_ingredients_on_sale) on public.items to authenticated;

-- ---------------------------------------------------------------------------
-- Helpers (private: called only by the functions below)
-- ---------------------------------------------------------------------------

-- Checks the caller holds a permission at an outlet; returns its organisation.
create or replace function private.require_outlet_permission(p_outlet_id uuid, p_permission text)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid;
begin
  if auth.uid() is null then
    raise exception 'Sign in first' using errcode = '42501';
  end if;

  select o.organisation_id into v_org from public.outlets o where o.id = p_outlet_id;

  if v_org is null
     or not exists (select 1 from private.outlet_ids_with(p_permission) as x(id) where x.id = p_outlet_id) then
    raise exception 'You do not have permission to do this at this outlet' using errcode = '42501';
  end if;

  return v_org;
end;
$$;

-- Checks an item belongs to the organisation and returns it.
create or replace function private.require_item(p_organisation_id uuid, p_item_id uuid)
returns public.items
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_item public.items;
begin
  select * into v_item from public.items i
  where i.id = p_item_id and i.organisation_id = p_organisation_id;
  if not found then
    raise exception 'Item not found' using errcode = 'P0002';
  end if;
  return v_item;
end;
$$;

-- Rupees per base unit to value stock leaving the outlet now.
create or replace function private.current_unit_cost(p_outlet_id uuid, p_item_id uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    -- moving average of what is on hand
    (select round(sum(l.value) / sum(l.quantity), 6)
     from public.stock_ledger l
     where l.outlet_id = p_outlet_id and l.item_id = p_item_id
     having sum(l.quantity) > 0 and sum(l.value) > 0),
    -- last cost received
    (select l.unit_cost
     from public.stock_ledger l
     where l.outlet_id = p_outlet_id and l.item_id = p_item_id
       and l.quantity > 0 and l.unit_cost > 0
     order by l.occurred_at desc, l.created_at desc
     limit 1),
    -- current vendor rate, preferred vendor first
    (select vi.rate_per_base
     from public.vendor_items vi
     left join public.item_outlet_settings s
       on s.item_id = vi.item_id and s.outlet_id = p_outlet_id
     where vi.item_id = p_item_id and vi.valid_to is null
     order by (vi.vendor_id = s.preferred_vendor_id) desc nulls last, vi.valid_from desc
     limit 1),
    0);
$$;

-- Where a sale takes an item from: the item's default location if it is a
-- kitchen or bar, otherwise the outlet's kitchen, otherwise any location.
create or replace function private.usage_location(p_outlet_id uuid, p_item_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select l.id
     from public.item_outlet_settings s
     join public.storage_locations l on l.id = s.default_location_id
     where s.outlet_id = p_outlet_id and s.item_id = p_item_id
       and l.is_active and l.kind in ('kitchen', 'bar')),
    (select l.id from public.storage_locations l
     where l.outlet_id = p_outlet_id and l.is_active and l.kind = 'kitchen'
     order by l.created_at, l.id limit 1),
    (select s.default_location_id from public.item_outlet_settings s
     where s.outlet_id = p_outlet_id and s.item_id = p_item_id),
    (select l.id from public.storage_locations l
     where l.outlet_id = p_outlet_id and l.is_active
     order by l.created_at, l.id limit 1));
$$;

-- Writes one ledger row (quantity in base units, signed).
create or replace function private.add_ledger_entry(
  p_organisation_id uuid,
  p_outlet_id       uuid,
  p_location_id     uuid,
  p_item_id         uuid,
  p_movement_type   text,
  p_quantity        numeric,
  p_unit_cost       numeric,
  p_source_type     text,
  p_source_id       uuid,
  p_source_line_id  uuid default null,
  p_occurred_at     timestamptz default null,
  p_note            text default null)
returns uuid
language sql
security definer
set search_path = ''
as $$
  insert into public.stock_ledger (
    organisation_id, outlet_id, location_id, item_id, movement_type, quantity, unit_cost,
    source_type, source_id, source_line_id, occurred_at, recorded_by, note)
  values (
    p_organisation_id, p_outlet_id, p_location_id, p_item_id, p_movement_type,
    round(p_quantity, 6), round(coalesce(p_unit_cost, 0), 6),
    p_source_type, p_source_id, p_source_line_id, coalesce(p_occurred_at, now()), auth.uid(), p_note)
  returning id;
$$;

-- Reverses every not-yet-reversed ledger row a document wrote.
create or replace function private.reverse_ledger_entries(p_source_type text, p_source_id uuid, p_note text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  insert into public.stock_ledger (
    organisation_id, outlet_id, location_id, item_id, movement_type, quantity, unit_cost,
    source_type, source_id, source_line_id, reverses_entry_id, occurred_at, recorded_by, note)
  select l.organisation_id, l.outlet_id, l.location_id, l.item_id, l.movement_type, -l.quantity, l.unit_cost,
         'reversal', l.source_id, l.source_line_id, l.id, now(), auth.uid(), p_note
  from public.stock_ledger l
  where l.source_type = p_source_type
    and l.source_id = p_source_id
    and l.reverses_entry_id is null
    and not exists (select 1 from public.stock_ledger r where r.reverses_entry_id = l.id);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Base-unit quantities of stock items used by p_multiplier units of a
-- recipe's yield. Prep items marked deduct_ingredients_on_sale are expanded
-- through their own active recipe.
create or replace function private.expand_recipe(p_recipe_id uuid, p_multiplier numeric, p_depth integer default 0)
returns table (item_id uuid, quantity numeric)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_yield numeric;
  v_line record;
  v_sub uuid;
begin
  if p_depth > 10 then
    raise exception 'Recipes are nested too deeply' using errcode = '54001';
  end if;

  select r.yield_qty into v_yield from public.recipes r where r.id = p_recipe_id;

  for v_line in
    select rl.item_id, rl.quantity_in_base, i.item_type, i.deduct_ingredients_on_sale, i.name
    from public.recipe_lines rl
    join public.items i on i.id = rl.item_id
    where rl.recipe_id = p_recipe_id
  loop
    if v_line.item_type = 'prep' and v_line.deduct_ingredients_on_sale then
      select r.id into v_sub from public.recipes r
      where r.prep_item_id = v_line.item_id and r.status = 'active';
      if v_sub is null then
        raise exception '% is made to order but has no active recipe', v_line.name using errcode = '22023';
      end if;
      return query
        select e.item_id, e.quantity
        from private.expand_recipe(v_sub, v_line.quantity_in_base * p_multiplier / v_yield, p_depth + 1) e;
    else
      item_id := v_line.item_id;
      quantity := v_line.quantity_in_base * p_multiplier / v_yield;
      return next;
    end if;
  end loop;
end;
$$;

revoke all on function private.require_outlet_permission(uuid, text) from public;
revoke all on function private.require_item(uuid, uuid) from public;
revoke all on function private.current_unit_cost(uuid, uuid) from public;
revoke all on function private.usage_location(uuid, uuid) from public;
revoke all on function private.add_ledger_entry(uuid, uuid, uuid, uuid, text, numeric, numeric, text, uuid, uuid, timestamptz, text) from public;
revoke all on function private.reverse_ledger_entries(text, uuid, text) from public;
revoke all on function private.expand_recipe(uuid, numeric, integer) from public;

-- ---------------------------------------------------------------------------
-- Wastage
-- ---------------------------------------------------------------------------
create or replace function public.post_wastage(
  p_outlet_id   uuid,
  p_location_id uuid,
  p_item_id     uuid,
  p_quantity    numeric,
  p_reason      text,
  p_unit        text default null,
  p_note        text default null,
  p_occurred_at timestamptz default null,
  p_photo_path  text default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_qty numeric;
  v_id uuid;
  v_at timestamptz := coalesce(p_occurred_at, now());
begin
  v_org := private.require_outlet_permission(p_outlet_id, 'wastage.record');
  perform private.require_item(v_org, p_item_id);

  if p_quantity is null or p_quantity <= 0 then
    raise exception 'Enter a quantity above zero' using errcode = '22023';
  end if;
  v_qty := case when p_unit is null then p_quantity
                else private.to_base_qty(p_item_id, p_quantity, p_unit) end;

  insert into public.wastage_entries (
    organisation_id, outlet_id, location_id, item_id, quantity, reason, note, photo_path, occurred_at, recorded_by)
  values (v_org, p_outlet_id, p_location_id, p_item_id, v_qty, p_reason, p_note, p_photo_path, v_at, auth.uid())
  returning id into v_id;

  perform private.add_ledger_entry(
    v_org, p_outlet_id, p_location_id, p_item_id,
    case when p_reason = 'staff_meal' then 'staff_meal' else 'wastage' end,
    -v_qty, private.current_unit_cost(p_outlet_id, p_item_id),
    'wastage', v_id, null, v_at, p_note);

  return v_id;
end;
$$;

create or replace function public.void_wastage(p_wastage_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.wastage_entries;
begin
  select * into v from public.wastage_entries where id = p_wastage_id for update;
  if not found then
    raise exception 'Wastage entry not found' using errcode = 'P0002';
  end if;
  perform private.require_outlet_permission(v.outlet_id, 'stock.adjust');

  if v.voided_at is not null then
    raise exception 'This wastage entry is already void' using errcode = '55000';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'Give a reason for voiding' using errcode = '22023';
  end if;

  perform private.reverse_ledger_entries('wastage', v.id, 'Wastage voided: ' || p_reason);

  update public.wastage_entries
  set voided_at = now(), voided_by = auth.uid(), void_reason = p_reason
  where id = v.id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Opening stock and adjustments (requested by inserting a row; decided here)
-- ---------------------------------------------------------------------------
create or replace function public.decide_stock_adjustment(
  p_adjustment_id uuid,
  p_approve       boolean,
  p_note          text default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.stock_adjustments;
  v_cost numeric;
begin
  select * into v from public.stock_adjustments where id = p_adjustment_id for update;
  if not found then
    raise exception 'Adjustment not found' using errcode = 'P0002';
  end if;
  perform private.require_outlet_permission(v.outlet_id, 'adjustments.approve');

  if v.status <> 'pending' then
    raise exception 'This adjustment is already %', v.status using errcode = '55000';
  end if;

  if p_approve then
    v_cost := coalesce(v.unit_cost, private.current_unit_cost(v.outlet_id, v.item_id));
    perform private.add_ledger_entry(
      v.organisation_id, v.outlet_id, v.location_id, v.item_id,
      case when v.kind = 'opening' then 'opening' else 'adjustment' end,
      v.quantity, v_cost,
      case when v.kind = 'opening' then 'opening' else 'adjustment' end,
      v.id, null, now(), v.reason);
  end if;

  update public.stock_adjustments
  set status = case when p_approve then 'posted' else 'rejected' end,
      decided_by = auth.uid(), decided_at = now(), decision_note = p_note
  where id = v.id;

  return case when p_approve then 'posted' else 'rejected' end;
end;
$$;

-- ---------------------------------------------------------------------------
-- Transfers between storage locations
-- ---------------------------------------------------------------------------
create or replace function public.send_stock_transfer(p_transfer_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.stock_transfers;
  v_line record;
begin
  select * into v from public.stock_transfers where id = p_transfer_id for update;
  if not found then
    raise exception 'Transfer not found' using errcode = 'P0002';
  end if;
  perform private.require_outlet_permission(v.outlet_id, 'stock.transfer');

  if v.status <> 'draft' then
    raise exception 'This transfer is already %', v.status using errcode = '55000';
  end if;
  if not exists (select 1 from public.stock_transfer_lines where transfer_id = v.id) then
    raise exception 'Add at least one item before sending' using errcode = '22023';
  end if;

  for v_line in select * from public.stock_transfer_lines where transfer_id = v.id loop
    perform private.add_ledger_entry(
      v.organisation_id, v.outlet_id, v.from_location_id, v_line.item_id, 'transfer_out',
      -v_line.quantity_sent, private.current_unit_cost(v.outlet_id, v_line.item_id),
      'stock_transfer', v.id, v_line.id, now(), null);
  end loop;

  update public.stock_transfers
  set status = 'sent', sent_by = auth.uid(), sent_at = now()
  where id = v.id;
end;
$$;

-- p_received: optional [{"line_id": "...", "quantity": 4800}, ...] in base
-- units. Lines not listed are received in full.
create or replace function public.receive_stock_transfer(p_transfer_id uuid, p_received jsonb default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.stock_transfers;
  v_line record;
  v_qty numeric;
  v_cost numeric;
begin
  select * into v from public.stock_transfers where id = p_transfer_id for update;
  if not found then
    raise exception 'Transfer not found' using errcode = 'P0002';
  end if;
  perform private.require_outlet_permission(v.outlet_id, 'stock.transfer');

  if v.status <> 'sent' then
    raise exception 'Only a sent transfer can be received; this one is %', v.status using errcode = '55000';
  end if;

  for v_line in select * from public.stock_transfer_lines where transfer_id = v.id loop
    select (e ->> 'quantity')::numeric into v_qty
    from jsonb_array_elements(coalesce(p_received, '[]'::jsonb)) e
    where (e ->> 'line_id')::uuid = v_line.id;
    v_qty := coalesce(v_qty, v_line.quantity_sent);

    if v_qty < 0 or v_qty > v_line.quantity_sent then
      raise exception 'Received quantity must be between 0 and the quantity sent' using errcode = '22023';
    end if;

    update public.stock_transfer_lines set quantity_received = v_qty where id = v_line.id;

    if v_qty > 0 then
      select l.unit_cost into v_cost from public.stock_ledger l
      where l.source_type = 'stock_transfer' and l.source_line_id = v_line.id
        and l.movement_type = 'transfer_out' and l.reverses_entry_id is null
      limit 1;
      perform private.add_ledger_entry(
        v.organisation_id, v.outlet_id, v.to_location_id, v_line.item_id, 'transfer_in',
        v_qty, v_cost, 'stock_transfer', v.id, v_line.id, now(), null);
    end if;
  end loop;

  update public.stock_transfers
  set status = 'received', received_by = auth.uid(), received_at = now()
  where id = v.id;
end;
$$;

create or replace function public.cancel_stock_transfer(p_transfer_id uuid, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.stock_transfers;
begin
  select * into v from public.stock_transfers where id = p_transfer_id for update;
  if not found then
    raise exception 'Transfer not found' using errcode = 'P0002';
  end if;
  perform private.require_outlet_permission(v.outlet_id, 'stock.transfer');

  if v.status not in ('draft', 'sent') then
    raise exception 'A % transfer cannot be cancelled', v.status using errcode = '55000';
  end if;

  if v.status = 'sent' then
    perform private.reverse_ledger_entries('stock_transfer', v.id, 'Transfer cancelled');
  end if;

  update public.stock_transfers
  set status = 'cancelled',
      note = concat_ws(E'\n', v.note, 'Cancelled: ' || coalesce(nullif(trim(p_reason), ''), 'no reason given'))
  where id = v.id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Physical counts
-- ---------------------------------------------------------------------------

-- Fills each line's system quantity and cost (the count was blind until now).
create or replace function public.submit_stock_count(p_count_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.stock_counts;
begin
  select * into v from public.stock_counts where id = p_count_id for update;
  if not found then
    raise exception 'Count not found' using errcode = 'P0002';
  end if;
  perform private.require_outlet_permission(v.outlet_id, 'counts.count');

  if v.status <> 'in_progress' then
    raise exception 'This count is already %', v.status using errcode = '55000';
  end if;
  if not exists (select 1 from public.stock_count_lines where count_id = v.id and counted_qty is not null) then
    raise exception 'Enter at least one counted quantity before submitting' using errcode = '22023';
  end if;

  update public.stock_count_lines cl
  set system_qty = coalesce((select sum(l.quantity) from public.stock_ledger l
                             where l.location_id = cl.location_id and l.item_id = cl.item_id), 0),
      unit_cost  = private.current_unit_cost(cl.outlet_id, cl.item_id)
  where cl.count_id = v.id;

  update public.stock_counts
  set status = 'submitted', submitted_by = auth.uid(), submitted_at = now()
  where id = v.id;
end;
$$;

-- Posts each counted line's variance (counted minus system) to the ledger.
create or replace function public.approve_stock_count(p_count_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.stock_counts;
  v_line record;
  v_count integer := 0;
begin
  select * into v from public.stock_counts where id = p_count_id for update;
  if not found then
    raise exception 'Count not found' using errcode = 'P0002';
  end if;
  perform private.require_outlet_permission(v.outlet_id, 'counts.approve');

  if v.status <> 'submitted' then
    raise exception 'Only a submitted count can be approved; this one is %', v.status using errcode = '55000';
  end if;

  for v_line in
    select * from public.stock_count_lines
    where count_id = v.id and counted_qty is not null and variance_qty <> 0
  loop
    perform private.add_ledger_entry(
      v.organisation_id, v.outlet_id, v_line.location_id, v_line.item_id, 'count_variance',
      v_line.variance_qty, v_line.unit_cost, 'stock_count', v.id, v_line.id, now(), null);
    v_count := v_count + 1;
  end loop;

  update public.stock_counts
  set status = 'approved', approved_by = auth.uid(), approved_at = now()
  where id = v.id;

  return v_count;
end;
$$;

create or replace function public.cancel_stock_count(p_count_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.stock_counts;
begin
  select * into v from public.stock_counts where id = p_count_id for update;
  if not found then
    raise exception 'Count not found' using errcode = 'P0002';
  end if;
  perform private.require_outlet_permission(
    v.outlet_id, case when v.status = 'submitted' then 'counts.approve' else 'counts.count' end);

  if v.status not in ('in_progress', 'submitted') then
    raise exception 'A % count cannot be cancelled', v.status using errcode = '55000';
  end if;

  update public.stock_counts set status = 'cancelled' where id = v.id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Prep production
-- ---------------------------------------------------------------------------
create or replace function public.post_prep_batch(
  p_outlet_id         uuid,
  p_location_id       uuid,
  p_prep_item_id      uuid,
  p_batches           numeric,
  p_quantity_produced numeric default null,
  p_note              text default null,
  p_produced_at       timestamptz default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_item public.items;
  v_recipe public.recipes;
  v_produced numeric;
  v_id uuid;
  v_use record;
  v_cost numeric;
  v_total numeric := 0;
  v_at timestamptz := coalesce(p_produced_at, now());
begin
  v_org := private.require_outlet_permission(p_outlet_id, 'production.record');
  v_item := private.require_item(v_org, p_prep_item_id);

  if v_item.item_type <> 'prep' then
    raise exception '% is not a prep item', v_item.name using errcode = '22023';
  end if;
  if p_batches is null or p_batches <= 0 then
    raise exception 'Enter how many batches were made' using errcode = '22023';
  end if;

  select * into v_recipe from public.recipes
  where prep_item_id = p_prep_item_id and status = 'active';
  if not found then
    raise exception '% has no active recipe', v_item.name using errcode = '22023';
  end if;

  v_produced := coalesce(p_quantity_produced, v_recipe.yield_qty * p_batches);
  if v_produced <= 0 then
    raise exception 'Enter the quantity produced' using errcode = '22023';
  end if;

  insert into public.prep_batches (
    organisation_id, outlet_id, location_id, prep_item_id, recipe_id, batches, quantity_produced,
    note, produced_by, produced_at)
  values (v_org, p_outlet_id, p_location_id, p_prep_item_id, v_recipe.id, p_batches, v_produced,
          p_note, auth.uid(), v_at)
  returning id into v_id;

  -- Ingredients come out of the location where the batch was made.
  for v_use in
    select e.item_id, sum(e.quantity) as quantity
    from private.expand_recipe(v_recipe.id, v_recipe.yield_qty * p_batches) e
    group by e.item_id
  loop
    v_cost := private.current_unit_cost(p_outlet_id, v_use.item_id);
    perform private.add_ledger_entry(
      v_org, p_outlet_id, p_location_id, v_use.item_id, 'prep_consumption',
      -v_use.quantity, v_cost, 'prep_batch', v_id, null, v_at, null);
    v_total := v_total + round(v_use.quantity * v_cost, 2);
  end loop;

  -- The prep item goes into stock at the cost of what went into it.
  perform private.add_ledger_entry(
    v_org, p_outlet_id, p_location_id, p_prep_item_id, 'prep_production',
    v_produced, v_total / v_produced, 'prep_batch', v_id, null, v_at, null);

  return v_id;
end;
$$;

create or replace function public.void_prep_batch(p_prep_batch_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.prep_batches;
begin
  select * into v from public.prep_batches where id = p_prep_batch_id for update;
  if not found then
    raise exception 'Prep batch not found' using errcode = 'P0002';
  end if;
  perform private.require_outlet_permission(v.outlet_id, 'production.record');

  if v.voided_at is not null then
    raise exception 'This prep batch is already void' using errcode = '55000';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'Give a reason for voiding' using errcode = '22023';
  end if;

  perform private.reverse_ledger_entries('prep_batch', v.id, 'Prep batch voided: ' || p_reason);

  update public.prep_batches
  set voided_at = now(), voided_by = auth.uid(), void_reason = p_reason
  where id = v.id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Sales
-- ---------------------------------------------------------------------------
create or replace function public.post_sales_import(p_sales_import_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.sales_imports;
  v_tz text;
  v_at timestamptz;
  v_unmapped integer;
  v_missing text;
  v_use record;
  v_count integer := 0;
begin
  select * into v from public.sales_imports where id = p_sales_import_id for update;
  if not found then
    raise exception 'Sales entry not found' using errcode = 'P0002';
  end if;
  perform private.require_outlet_permission(v.outlet_id, 'sales.record');

  if v.status <> 'draft' then
    raise exception 'This sales entry is already %', v.status using errcode = '55000';
  end if;
  if not exists (select 1 from public.sales_lines where sales_import_id = v.id) then
    raise exception 'This sales entry has no lines' using errcode = '22023';
  end if;

  select count(*) into v_unmapped
  from public.sales_lines where sales_import_id = v.id and menu_item_id is null;
  if v_unmapped > 0 then
    raise exception '% line(s) are not matched to a menu item yet', v_unmapped using errcode = '22023';
  end if;

  select string_agg(distinct m.name, ', ') into v_missing
  from public.sales_lines sl
  join public.menu_items m on m.id = sl.menu_item_id
  where sl.sales_import_id = v.id
    and not exists (select 1 from public.recipes r where r.menu_item_id = sl.menu_item_id and r.status = 'active');
  if v_missing is not null then
    raise exception 'These dishes have no active recipe: %', v_missing using errcode = '22023';
  end if;

  -- Record the recipe version each line is deducted with.
  update public.sales_lines sl
  set recipe_id = r.id
  from public.recipes r
  where sl.sales_import_id = v.id and r.menu_item_id = sl.menu_item_id and r.status = 'active';

  -- Sales are dated at the end of the business day, in the organisation's time zone.
  select o.timezone into v_tz from public.organisations o where o.id = v.organisation_id;
  v_at := (v.business_date + time '23:59:00') at time zone coalesce(v_tz, 'Asia/Kolkata');

  for v_use in
    select e.item_id, sum(e.quantity) as quantity
    from public.sales_lines sl
    cross join lateral private.expand_recipe(sl.recipe_id, sl.quantity) e
    where sl.sales_import_id = v.id
    group by e.item_id
    having sum(e.quantity) > 0
  loop
    perform private.add_ledger_entry(
      v.organisation_id, v.outlet_id, private.usage_location(v.outlet_id, v_use.item_id), v_use.item_id,
      'sale', -v_use.quantity, private.current_unit_cost(v.outlet_id, v_use.item_id),
      'sales_import', v.id, null, v_at, null);
    v_count := v_count + 1;
  end loop;

  update public.sales_imports
  set status = 'posted', posted_by = auth.uid(), posted_at = now(),
      line_count = (select count(*) from public.sales_lines where sales_import_id = v.id),
      total_amount = (select coalesce(sum(amount), 0) from public.sales_lines where sales_import_id = v.id)
  where id = v.id;

  return v_count;
end;
$$;

create or replace function public.void_sales_import(p_sales_import_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.sales_imports;
begin
  select * into v from public.sales_imports where id = p_sales_import_id for update;
  if not found then
    raise exception 'Sales entry not found' using errcode = 'P0002';
  end if;
  perform private.require_outlet_permission(v.outlet_id, 'sales.record');

  if v.status <> 'posted' then
    raise exception 'Only a posted sales entry can be voided; this one is %', v.status using errcode = '55000';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'Give a reason for voiding' using errcode = '22023';
  end if;

  perform private.reverse_ledger_entries('sales_import', v.id, 'Sales voided: ' || p_reason);

  update public.sales_imports
  set status = 'voided', voided_by = auth.uid(), voided_at = now(), void_reason = p_reason
  where id = v.id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Who can call what: signed-in users only (each function checks permissions)
-- ---------------------------------------------------------------------------
revoke all on function public.post_wastage(uuid, uuid, uuid, numeric, text, text, text, timestamptz, text) from public, anon;
revoke all on function public.void_wastage(uuid, text) from public, anon;
revoke all on function public.decide_stock_adjustment(uuid, boolean, text) from public, anon;
revoke all on function public.send_stock_transfer(uuid) from public, anon;
revoke all on function public.receive_stock_transfer(uuid, jsonb) from public, anon;
revoke all on function public.cancel_stock_transfer(uuid, text) from public, anon;
revoke all on function public.submit_stock_count(uuid) from public, anon;
revoke all on function public.approve_stock_count(uuid) from public, anon;
revoke all on function public.cancel_stock_count(uuid) from public, anon;
revoke all on function public.post_prep_batch(uuid, uuid, uuid, numeric, numeric, text, timestamptz) from public, anon;
revoke all on function public.void_prep_batch(uuid, text) from public, anon;
revoke all on function public.post_sales_import(uuid) from public, anon;
revoke all on function public.void_sales_import(uuid, text) from public, anon;

grant execute on function public.post_wastage(uuid, uuid, uuid, numeric, text, text, text, timestamptz, text) to authenticated;
grant execute on function public.void_wastage(uuid, text) to authenticated;
grant execute on function public.decide_stock_adjustment(uuid, boolean, text) to authenticated;
grant execute on function public.send_stock_transfer(uuid) to authenticated;
grant execute on function public.receive_stock_transfer(uuid, jsonb) to authenticated;
grant execute on function public.cancel_stock_transfer(uuid, text) to authenticated;
grant execute on function public.submit_stock_count(uuid) to authenticated;
grant execute on function public.approve_stock_count(uuid) to authenticated;
grant execute on function public.cancel_stock_count(uuid) to authenticated;
grant execute on function public.post_prep_batch(uuid, uuid, uuid, numeric, numeric, text, timestamptz) to authenticated;
grant execute on function public.void_prep_batch(uuid, text) to authenticated;
grant execute on function public.post_sales_import(uuid) to authenticated;
grant execute on function public.void_sales_import(uuid, text) to authenticated;
