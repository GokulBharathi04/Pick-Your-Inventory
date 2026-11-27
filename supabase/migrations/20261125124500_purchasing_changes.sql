-- Purchasing changes after the first round of testing on dev.
--
-- 1. Vendor codes are given automatically (V0001, V0002, ...) and can't be typed.
-- 2. Items have a stock unit people see and type in (kg, g, l, ml, pcs, dozen).
--    Stock is still held in the base unit (g, ml or pcs) underneath.
-- 3. Items whose weight varies per piece (whole chicken): kept by weight, ordered
--    or counted in pieces at a typical weight, and received with the pieces AND
--    the weight that actually arrived. Stock and cost follow the actual weight.
-- 4. Any storage location can receive goods, not only stores: a kitchen with
--    cold storage can take chicken straight from the vendor. Purchase orders,
--    receipts, department issues and planning stock use these locations.
-- 5. A delivery against a purchase order completes it. If less arrived, the
--    order closes short unless the receiver keeps the rest on order. More than
--    was ordered, or items not on the order, are always accepted.

-- ---------------------------------------------------------------------------
-- 1. Automatic vendor codes
-- ---------------------------------------------------------------------------
-- Numbered per organisation. Vendors are added in the cloud only (they sync
-- down to outlets), so one counter per organisation is enough; a lock on the
-- organisation keeps two people adding vendors at once from taking one number.
create or replace function private.next_vendor_code(p_organisation_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_no integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('vendor_code:' || p_organisation_id::text, 0));
  select coalesce(max(substring(v.code from '^V([0-9]{1,9})$')::integer), 0) + 1 into v_no
  from public.vendors v where v.organisation_id = p_organisation_id;
  return 'V' || lpad(v_no::text, greatest(4, length(v_no::text)), '0');
end;
$$;

create or replace function private.assign_vendor_code()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.code is null then
    new.code := private.next_vendor_code(new.organisation_id);
  end if;
  return new;
end;
$$;

revoke all on function private.next_vendor_code(uuid) from public;
revoke all on function private.assign_vendor_code() from public;

create trigger assign_vendor_code before insert on public.vendors
  for each row execute function private.assign_vendor_code();

-- Vendors added before this get a code too, oldest first. Codes people typed
-- earlier are kept.
do $$
declare
  v record;
begin
  for v in select id, organisation_id from public.vendors where code is null order by created_at, id loop
    update public.vendors set code = private.next_vendor_code(v.organisation_id) where id = v.id;
  end loop;
end;
$$;

comment on column public.vendors.code is 'Given automatically when the vendor is added (V0001, V0002, ... per organisation).';

revoke insert (code), update (code) on public.vendors from authenticated;

-- ---------------------------------------------------------------------------
-- 2 and 3. Stock unit, and items whose weight varies per piece
-- ---------------------------------------------------------------------------
alter table public.items
  add column stock_unit text references public.units (code),
  add column variable_weight boolean not null default false;

update public.items
set stock_unit = case base_unit when 'g' then 'kg' when 'ml' then 'l' else base_unit end;

comment on column public.items.stock_unit is 'The unit people see and type stock in (kg, g, l, ml, pcs, dozen). Stock is held in base_unit underneath.';
comment on column public.items.variable_weight is 'Weight varies per piece (whole chicken): kept by weight, alt_unit pcs at a typical weight; receipts record the pieces and the actual weight.';

create or replace function private.prepare_item_units()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.stock_unit is null
     or (tg_op = 'UPDATE' and new.base_unit is distinct from old.base_unit and new.stock_unit is not distinct from old.stock_unit) then
    new.stock_unit := case new.base_unit when 'g' then 'kg' when 'ml' then 'l' else new.base_unit end;
  end if;
  if new.base_unit in ('g', 'ml', 'pcs')
     and (select u.base_code from public.units u where u.code = new.stock_unit) is distinct from new.base_unit then
    raise exception 'The stock unit must measure the same way as the item (%)', new.base_unit using errcode = '22023';
  end if;
  if new.variable_weight and not (new.base_unit in ('g', 'ml') and new.alt_unit = 'pcs') then
    raise exception 'An item whose weight varies is kept by weight, with a typical weight per piece' using errcode = '22023';
  end if;
  return new;
end;
$$;

create trigger prepare_item_units before insert or update on public.items
  for each row execute function private.prepare_item_units();

alter table public.items alter column stock_unit set not null;

grant insert (stock_unit, variable_weight) on public.items to authenticated;
grant update (stock_unit, variable_weight) on public.items to authenticated;

alter table public.goods_receipt_lines
  add column pieces numeric check (pieces is null or pieces > 0),
  add column credited_in_base numeric check (credited_in_base is null or credited_in_base >= 0);

comment on column public.goods_receipt_lines.pieces is 'Pieces that arrived, for items whose weight varies; quantity is then the weight that arrived.';
comment on column public.goods_receipt_lines.credited_in_base is 'What this line counted towards its order line. Differs from quantity_in_base when an item whose weight varies was ordered by the piece. Null on older lines: use quantity_in_base.';

-- ---------------------------------------------------------------------------
-- 4. Locations that receive goods
-- ---------------------------------------------------------------------------
alter table public.storage_locations add column receives_goods boolean;

update public.storage_locations set receives_goods = kind in ('store', 'cold_room');

create or replace function private.prepare_storage_location()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.receives_goods := coalesce(new.receives_goods, new.kind in ('store', 'cold_room'));
  return new;
end;
$$;

create trigger prepare_storage_location before insert or update on public.storage_locations
  for each row execute function private.prepare_storage_location();

alter table public.storage_locations alter column receives_goods set not null;

comment on column public.storage_locations.receives_goods is 'Goods arrive here from vendors and are issued to departments from here. Stores by default; a kitchen with cold storage can too.';

grant insert (receives_goods) on public.storage_locations to authenticated;
grant update (receives_goods) on public.storage_locations to authenticated;

-- Planning stock is the stock in the locations that receive goods.
create or replace view public.planning_stock
with (security_invoker = true)
as
with totals as (
  select l.organisation_id, l.outlet_id, l.item_id,
         sum(l.quantity) as quantity, sum(l.value) as value
  from public.stock_ledger l
  join public.storage_locations sl on sl.id = l.location_id
  where sl.receives_goods
    and l.movement_type not in ('sale', 'prep_production', 'prep_consumption')
  group by l.organisation_id, l.outlet_id, l.item_id
),
on_order as (
  select pol.organisation_id, pol.outlet_id, pol.item_id,
         sum(greatest(pol.quantity_in_base - pol.received_in_base, 0)) as quantity
  from public.purchase_order_lines pol
  join public.purchase_orders po on po.id = pol.purchase_order_id
  where po.status in ('submitted', 'approved', 'partially_received')
  group by pol.organisation_id, pol.outlet_id, pol.item_id
),
-- Every item with stock, settings or something on order (a new item that is
-- only on order shows too).
keys as (
  select organisation_id, outlet_id, item_id from totals
  union
  select organisation_id, outlet_id, item_id from public.item_outlet_settings
  union
  select organisation_id, outlet_id, item_id from on_order
)
select
  k.organisation_id,
  k.outlet_id,
  k.item_id,
  coalesce(t.quantity, 0)                        as quantity,
  coalesce(t.value, 0)                           as value,
  case when t.quantity > 0 then round(t.value / t.quantity, 6) end as average_cost,
  coalesce(oo.quantity, 0)                       as on_order,
  s.reorder_level,
  s.reorder_qty,
  s.max_level,
  coalesce(s.reorder_level is not null
           and coalesce(t.quantity, 0) + coalesce(oo.quantity, 0) <= s.reorder_level, false) as below_reorder_level,
  coalesce(t.quantity, 0) < 0                    as is_negative
from keys k
left join totals t on t.outlet_id = k.outlet_id and t.item_id = k.item_id
left join public.item_outlet_settings s on s.outlet_id = k.outlet_id and s.item_id = k.item_id
left join on_order oo on oo.outlet_id = k.outlet_id and oo.item_id = k.item_id
where coalesce(s.is_stocked, true);

-- Purchase orders deliver to a location that receives goods.
create or replace function public.save_purchase_order(
  p_purchase_order_id uuid,
  p_outlet_id         uuid,
  p_vendor_id         uuid,
  p_location_id       uuid,
  p_lines             jsonb,
  p_expected_date     date default null,
  p_note              text default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_po  public.purchase_orders;
  v_id  uuid;
  v_e   jsonb;
  v_item public.items;
  v_pack uuid;
  v_unit text;
  v_rate numeric;
begin
  v_org := private.require_outlet_permission(p_outlet_id, 'purchase.order');

  if not exists (select 1 from public.vendors v where v.id = p_vendor_id and v.organisation_id = v_org and v.is_active) then
    raise exception 'Choose an active vendor' using errcode = '22023';
  end if;
  if not exists (select 1 from public.storage_locations l
                 where l.id = p_location_id and l.outlet_id = p_outlet_id and l.is_active and l.receives_goods) then
    raise exception 'Deliver to an active location of this outlet that receives goods' using errcode = '22023';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Add at least one item' using errcode = '22023';
  end if;

  if p_purchase_order_id is null then
    insert into public.purchase_orders (organisation_id, outlet_id, vendor_id, po_no, deliver_to_location_id, expected_date, note)
    values (v_org, p_outlet_id, p_vendor_id, private.next_doc_no(p_outlet_id, 'po', 'PO'), p_location_id,
            p_expected_date, nullif(trim(p_note), ''))
    returning id into v_id;
  else
    select * into v_po from public.purchase_orders where id = p_purchase_order_id for update;
    if not found or v_po.outlet_id <> p_outlet_id then
      raise exception 'Purchase order not found' using errcode = 'P0002';
    end if;
    if v_po.status <> 'draft' then
      raise exception 'Only a draft order can be changed; this one is %', replace(v_po.status, '_', ' ') using errcode = '55000';
    end if;
    update public.purchase_orders
    set vendor_id = p_vendor_id, deliver_to_location_id = p_location_id,
        expected_date = p_expected_date, note = nullif(trim(p_note), '')
    where id = p_purchase_order_id;
    delete from public.purchase_order_lines where purchase_order_id = p_purchase_order_id;
    v_id := p_purchase_order_id;
  end if;

  for v_e in select * from jsonb_array_elements(p_lines) loop
    if nullif(v_e ->> 'item_id', '') is null or coalesce((v_e ->> 'quantity')::numeric, 0) <= 0 then
      raise exception 'Every line needs an item and a quantity above zero' using errcode = '22023';
    end if;
    v_item := private.require_item(v_org, (v_e ->> 'item_id')::uuid);
    v_pack := nullif(v_e ->> 'pack_size_id', '')::uuid;
    v_unit := case when v_pack is null then coalesce(nullif(v_e ->> 'unit', ''), v_item.base_unit) end;
    v_rate := coalesce(nullif(v_e ->> 'rate', '')::numeric, private.vendor_rate(p_vendor_id, v_item.id, v_pack, v_unit));
    if v_rate is null then
      raise exception '%: enter a rate (this vendor has no price for it)', v_item.name using errcode = '22023';
    end if;

    insert into public.purchase_order_lines (
      organisation_id, outlet_id, purchase_order_id, item_id, pack_size_id, unit, base_per_unit, quantity, rate, gst_rate, note)
    values (
      v_org, p_outlet_id, v_id, v_item.id, v_pack, v_unit,
      private.base_per_purchase_unit(v_item.id, v_pack, v_unit),
      (v_e ->> 'quantity')::numeric, v_rate,
      coalesce(nullif(v_e ->> 'gst_rate', '')::numeric, v_item.gst_rate),
      nullif(trim(v_e ->> 'note'), ''));
  end loop;

  update public.purchase_orders po
  set total_amount = t.amount, tax_amount = t.tax
  from (select coalesce(sum(l.amount), 0) as amount,
               coalesce(round(sum(l.amount * coalesce(l.gst_rate, 0) / 100), 2), 0) as tax
        from public.purchase_order_lines l where l.purchase_order_id = v_id) t
  where po.id = v_id;

  return v_id;
end;
$$;

-- Issues and returns use a location that receives goods.
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
                 where l.id = p_location_id and l.outlet_id = p_outlet_id and l.is_active and l.receives_goods) then
    raise exception 'Issues come from, and returns go back to, an active location that receives goods' using errcode = '22023';
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

-- Reorder suggestions now say where each item is received (its default
-- location, if that location receives goods), so orders can go there.
drop function public.reorder_suggestions(uuid);

create function public.reorder_suggestions(p_outlet_id uuid)
returns table (
  item_id         uuid,
  on_hand         numeric,
  on_order        numeric,
  reorder_level   numeric,
  reorder_qty     numeric,
  max_level       numeric,
  suggested_base  numeric,
  vendor_id       uuid,
  pack_size_id    uuid,
  unit            text,
  rate            numeric,
  base_per_unit   numeric,
  suggested_units numeric,
  lead_time_days  integer,
  location_id     uuid)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from private.outlet_ids_with('purchase.view') as x(id) where x.id = p_outlet_id) then
    raise exception 'You do not have permission to plan purchases at this outlet' using errcode = '42501';
  end if;

  return query
  with stock as (
    select s.item_id, s.reorder_level, s.reorder_qty, s.max_level, s.lead_time_days, s.preferred_vendor_id,
           (select dl.id from public.storage_locations dl
            where dl.id = s.default_location_id and dl.is_active and dl.receives_goods) as location_id,
           coalesce((select sum(l.quantity) from public.stock_ledger l
                     join public.storage_locations sl on sl.id = l.location_id
                     where l.outlet_id = p_outlet_id and l.item_id = s.item_id and sl.receives_goods
                       and l.movement_type not in ('sale', 'prep_production', 'prep_consumption')), 0) as on_hand,
           coalesce((select sum(greatest(pol.quantity_in_base - pol.received_in_base, 0))
                     from public.purchase_order_lines pol
                     join public.purchase_orders po on po.id = pol.purchase_order_id
                     where pol.outlet_id = p_outlet_id and pol.item_id = s.item_id
                       and po.status in ('submitted', 'approved', 'partially_received')), 0) as on_order
    from public.item_outlet_settings s
    join public.items i on i.id = s.item_id and i.is_active
    where s.outlet_id = p_outlet_id and s.is_stocked and s.reorder_level is not null
  ),
  needed as (
    select st.*,
           greatest(coalesce(st.max_level - (st.on_hand + st.on_order),
                             st.reorder_qty,
                             st.reorder_level - (st.on_hand + st.on_order)), 0) as need
    from stock st
    where st.on_hand + st.on_order <= st.reorder_level
  )
  select n.item_id, n.on_hand, n.on_order, n.reorder_level, n.reorder_qty, n.max_level, n.need,
         vi.vendor_id, vi.pack_size_id, vi.price_unit, vi.rate, vi.purchase_qty_in_base,
         case when vi.purchase_qty_in_base > 0 then ceil(n.need / vi.purchase_qty_in_base) end,
         n.lead_time_days, n.location_id
  from needed n
  left join lateral (
    select v.vendor_id, v.pack_size_id, v.price_unit, v.rate, v.purchase_qty_in_base
    from public.vendor_items v
    join public.vendors ve on ve.id = v.vendor_id and ve.is_active
    where v.item_id = n.item_id and v.valid_to is null
    order by (v.vendor_id = n.preferred_vendor_id) desc nulls last, v.rate_per_base, v.valid_from desc
    limit 1
  ) vi on true;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Goods receipts: extra always accepted, a delivery completes the order
-- ---------------------------------------------------------------------------
drop function public.post_goods_receipt(uuid, uuid, uuid, jsonb, uuid, text, date, text, timestamptz, boolean);

-- p_lines: [{"purchase_order_line_id": "...", "item_id": "...", "pack_size_id": null,
--            "unit": "kg", "quantity": 20, "rate": 80, "gst_rate": 5, "note": "..."}]
-- An item whose weight varies (whole chicken) gives the pieces and the weight
-- that arrived instead of a quantity:
--   {"purchase_order_line_id": "...", "pieces": 10, "weight": 12.4, "weight_unit": "kg",
--    "unit": "pcs", "rate": 250}
-- "unit" is what the bill is priced in: per piece (pcs, dozen) or per weight
-- (kg, g). Stock always goes in at the actual weight. An order line placed by
-- the piece is matched by pieces; one placed by weight, by weight.
-- Against an order: more than ordered, or items not on it, are received as
-- extra. If less arrived than was ordered, the order closes short unless
-- p_keep_open keeps the rest on order.
create function public.post_goods_receipt(
  p_outlet_id         uuid,
  p_vendor_id         uuid,
  p_location_id       uuid,
  p_lines             jsonb,
  p_purchase_order_id uuid default null,
  p_invoice_no        text default null,
  p_invoice_date      date default null,
  p_note              text default null,
  p_received_at       timestamptz default null,
  p_keep_open         boolean default false)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org     uuid;
  v_po      public.purchase_orders;
  v_pol     public.purchase_order_lines;
  v_id      uuid;
  v_grn     text;
  v_e       jsonb;
  v_item    public.items;
  v_pack    uuid;
  v_unit    text;
  v_u       public.units;
  v_pu      public.units;
  v_rate    numeric;
  v_gst     numeric;
  v_bpu     numeric;
  v_qty     numeric;
  v_in_base numeric;
  v_pieces  numeric;
  v_wt_unit text;
  v_vrate   numeric;
  v_vbase   text;
  v_vfactor numeric;
  v_credit  numeric;
  v_status  text;
  v_line_id uuid;
  v_at      timestamptz := coalesce(p_received_at, now());
begin
  v_org := private.require_outlet_permission(p_outlet_id, 'purchase.receive');

  if not exists (select 1 from public.storage_locations l
                 where l.id = p_location_id and l.outlet_id = p_outlet_id and l.is_active and l.receives_goods) then
    raise exception 'Receive into an active location of this outlet that receives goods' using errcode = '22023';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Add at least one item' using errcode = '22023';
  end if;

  if p_purchase_order_id is not null then
    select * into v_po from public.purchase_orders where id = p_purchase_order_id for update;
    if not found or v_po.outlet_id <> p_outlet_id then
      raise exception 'Purchase order not found' using errcode = 'P0002';
    end if;
    if v_po.status not in ('approved', 'partially_received') then
      raise exception 'Goods can be received only against an approved order; this one is %',
        replace(v_po.status, '_', ' ') using errcode = '55000';
    end if;
    if v_po.vendor_id <> p_vendor_id then
      raise exception 'This order is from a different vendor' using errcode = '22023';
    end if;
  elsif not exists (select 1 from public.vendors v where v.id = p_vendor_id and v.organisation_id = v_org) then
    raise exception 'Choose a vendor' using errcode = '22023';
  end if;

  v_grn := private.next_doc_no(p_outlet_id, 'grn', 'GRN');
  insert into public.goods_receipts (
    organisation_id, outlet_id, vendor_id, purchase_order_id, grn_no, location_id,
    invoice_no, invoice_date, received_at, note, received_by)
  values (
    v_org, p_outlet_id, p_vendor_id, p_purchase_order_id, v_grn, p_location_id,
    nullif(trim(p_invoice_no), ''), p_invoice_date, v_at, nullif(trim(p_note), ''), auth.uid())
  returning id into v_id;

  for v_e in select * from jsonb_array_elements(p_lines) loop
    if coalesce(nullif(v_e ->> 'quantity', '')::numeric, nullif(v_e ->> 'weight', '')::numeric, 0) <= 0 then
      continue;  -- lines left at zero were not delivered
    end if;

    v_pol := null;
    if nullif(v_e ->> 'purchase_order_line_id', '') is not null then
      if p_purchase_order_id is null then
        raise exception 'A line refers to an order, but no order was chosen' using errcode = '22023';
      end if;
      select * into v_pol from public.purchase_order_lines
      where id = (v_e ->> 'purchase_order_line_id')::uuid and purchase_order_id = p_purchase_order_id
      for update;
      if not found then
        raise exception 'A line does not belong to this order' using errcode = '22023';
      end if;
      v_item := private.require_item(v_org, v_pol.item_id);
      v_pack := coalesce(nullif(v_e ->> 'pack_size_id', '')::uuid, case when v_e ? 'unit' then null else v_pol.pack_size_id end);
      v_unit := case when v_pack is null then coalesce(nullif(v_e ->> 'unit', ''), v_pol.unit, v_item.stock_unit) end;
    else
      if nullif(v_e ->> 'item_id', '') is null then
        raise exception 'Every line needs an item' using errcode = '22023';
      end if;
      v_item := private.require_item(v_org, (v_e ->> 'item_id')::uuid);
      v_pack := nullif(v_e ->> 'pack_size_id', '')::uuid;
      v_unit := case when v_pack is null then coalesce(nullif(v_e ->> 'unit', ''), v_item.stock_unit) end;
    end if;

    v_pieces := null;
    if v_item.variable_weight then
      -- Pieces and the weight that arrived; priced per piece or per weight.
      v_pieces  := nullif(v_e ->> 'pieces', '')::numeric;
      v_wt_unit := coalesce(nullif(v_e ->> 'weight_unit', ''), v_item.stock_unit);
      if v_pieces is null or v_pieces <= 0 or coalesce(nullif(v_e ->> 'weight', '')::numeric, 0) <= 0 then
        raise exception '%: enter how many pieces arrived and what they weighed', v_item.name using errcode = '22023';
      end if;
      if (select u.base_code from public.units u where u.code = v_wt_unit) is distinct from v_item.base_unit then
        raise exception '%: enter the weight in % or a unit like it', v_item.name, v_item.stock_unit using errcode = '22023';
      end if;
      if v_pack is not null then
        raise exception '%: its weight varies, so receive it by the piece or by weight, not in packs', v_item.name using errcode = '22023';
      end if;
      v_in_base := private.to_base_qty(v_item.id, (v_e ->> 'weight')::numeric, v_wt_unit);
      select * into v_u from public.units u where u.code = v_unit;
      if v_u.base_code = v_item.base_unit then
        v_qty := round(v_in_base / v_u.factor_to_base, 6);
        v_bpu := v_u.factor_to_base;
      elsif v_u.base_code = v_item.alt_unit then
        v_qty := round(v_pieces / v_u.factor_to_base, 6);
        v_bpu := v_in_base / v_qty;   -- the actual weight of one piece (or dozen)
      else
        raise exception '%: price it per piece or per weight', v_item.name using errcode = '22023';
      end if;
    else
      v_qty := (v_e ->> 'quantity')::numeric;
      v_bpu := private.base_per_purchase_unit(v_item.id, v_pack, v_unit);
      v_in_base := round(v_qty * v_bpu, 6);
    end if;

    -- The ordered price, in the unit the bill is priced in.
    select * into v_pu from public.units u where u.code = v_pol.unit;
    v_rate := nullif(v_e ->> 'rate', '')::numeric;
    if v_rate is null and v_pol.id is not null then
      if v_item.variable_weight and v_pu.base_code = v_item.alt_unit then
        -- ordered by the piece: the bill is pieces × the piece price
        v_rate := round(v_pol.rate / v_pu.factor_to_base * v_pieces / v_qty, 2);
      else
        v_rate := round(v_pol.rate_per_base * v_bpu, 2);
      end if;
    end if;
    if v_rate is null and v_item.variable_weight then
      -- the vendor's price per piece or per weight, whichever they have
      select vi.rate, u.base_code, u.factor_to_base into v_vrate, v_vbase, v_vfactor
      from public.vendor_items vi join public.units u on u.code = vi.price_unit
      where vi.vendor_id = p_vendor_id and vi.item_id = v_item.id and vi.valid_to is null
      order by (vi.price_unit = v_unit) desc, vi.valid_from desc
      limit 1;
      if v_vrate is not null then
        v_rate := round(v_vrate * case when v_vbase = v_item.base_unit then v_in_base else v_pieces end
                        / v_vfactor / v_qty, 2);
      end if;
    elsif v_rate is null then
      v_rate := private.vendor_rate(p_vendor_id, v_item.id, v_pack, v_unit);
    end if;
    if v_rate is null then
      raise exception '%: enter the rate on the bill (this vendor has no price for it)', v_item.name using errcode = '22023';
    end if;
    v_gst := coalesce(nullif(v_e ->> 'gst_rate', '')::numeric, v_pol.gst_rate, v_item.gst_rate);

    v_credit := null;
    if v_pol.id is not null then
      v_credit := case when v_item.variable_weight and v_pu.base_code = v_item.alt_unit
                       then round(v_pieces / v_pu.factor_to_base * v_pol.base_per_unit, 6)
                       else v_in_base end;
      update public.purchase_order_lines
      set received_in_base = received_in_base + v_credit
      where id = v_pol.id;
    end if;

    insert into public.goods_receipt_lines (
      organisation_id, outlet_id, receipt_id, purchase_order_line_id, item_id, pack_size_id, unit,
      base_per_unit, quantity, rate, gst_rate, pieces, credited_in_base, note)
    values (
      v_org, p_outlet_id, v_id, v_pol.id, v_item.id, v_pack, v_unit,
      v_bpu, v_qty, v_rate, v_gst, v_pieces, v_credit, nullif(trim(v_e ->> 'note'), ''))
    returning id into v_line_id;

    perform private.add_ledger_entry(
      v_org, p_outlet_id, p_location_id, v_item.id, 'receipt',
      v_in_base, round(v_rate / v_bpu, 6),
      'goods_receipt', v_id, v_line_id, v_at, null);
  end loop;

  if not exists (select 1 from public.goods_receipt_lines where receipt_id = v_id) then
    raise exception 'Enter the quantity received for at least one item' using errcode = '22023';
  end if;

  update public.goods_receipts g
  set total_amount = t.amount, tax_amount = t.tax
  from (select coalesce(sum(l.amount), 0) as amount,
               coalesce(round(sum(l.amount * coalesce(l.gst_rate, 0) / 100), 2), 0) as tax
        from public.goods_receipt_lines l where l.receipt_id = v_id) t
  where g.id = v_id;

  if p_purchase_order_id is not null then
    v_status := private.refresh_purchase_order_status(p_purchase_order_id);
    if v_status = 'partially_received' and not coalesce(p_keep_open, false) then
      update public.purchase_orders
      set status = 'closed', closed_by = auth.uid(), closed_at = now(),
          close_reason = 'Delivered short (' || v_grn || ')'
      where id = p_purchase_order_id;
    end if;
  end if;

  return v_id;
end;
$$;

-- Voiding a receipt takes back what its lines counted towards the order. If
-- this receipt closed the order short, the order opens again.
create or replace function public.void_goods_receipt(p_receipt_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.goods_receipts;
begin
  select * into v from public.goods_receipts where id = p_receipt_id for update;
  if not found then
    raise exception 'Goods receipt not found' using errcode = 'P0002';
  end if;
  perform private.require_outlet_permission(v.outlet_id, 'purchase.approve');
  if v.voided_at is not null then
    raise exception 'This receipt is already void' using errcode = '55000';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'Give a reason for voiding' using errcode = '22023';
  end if;

  if v.purchase_order_id is not null then
    perform 1 from public.purchase_orders where id = v.purchase_order_id for update;
    update public.purchase_order_lines pol
    set received_in_base = greatest(pol.received_in_base - r.qty, 0)
    from (select l.purchase_order_line_id, sum(coalesce(l.credited_in_base, l.quantity_in_base)) as qty
          from public.goods_receipt_lines l
          where l.receipt_id = v.id and l.purchase_order_line_id is not null
          group by l.purchase_order_line_id) r
    where pol.id = r.purchase_order_line_id;

    update public.purchase_orders
    set status = 'approved', closed_by = null, closed_at = null, close_reason = null
    where id = v.purchase_order_id and status = 'closed'
      and close_reason = 'Delivered short (' || v.grn_no || ')';
  end if;

  perform private.reverse_ledger_entries('goods_receipt', v.id, 'Receipt voided: ' || p_reason);

  update public.goods_receipts
  set voided_at = now(), voided_by = auth.uid(), void_reason = trim(p_reason)
  where id = v.id;

  if v.purchase_order_id is not null then
    perform private.refresh_purchase_order_status(v.purchase_order_id);
  end if;
end;
$$;

-- Recent average weight per piece, from the last 10 receipts of each item that
-- recorded pieces. Runs with the caller's rights.
create or replace function public.piece_weights(p_outlet_id uuid)
returns table (item_id uuid, receipts bigint, pieces numeric, weight_in_base numeric, average_in_base numeric)
language sql
stable
set search_path = ''
as $$
  select r.item_id, count(*), sum(r.pieces), sum(r.quantity_in_base), round(sum(r.quantity_in_base) / sum(r.pieces), 3)
  from (
    select gl.item_id, gl.pieces, gl.quantity_in_base,
           row_number() over (partition by gl.item_id order by g.received_at desc, gl.created_at desc) as n
    from public.goods_receipt_lines gl
    join public.goods_receipts g on g.id = gl.receipt_id
    where gl.outlet_id = p_outlet_id and gl.pieces is not null and g.voided_at is null
  ) r
  where r.n <= 10
  group by r.item_id;
$$;

-- ---------------------------------------------------------------------------
-- Who can call what
-- ---------------------------------------------------------------------------
revoke all on function private.prepare_item_units() from public;
revoke all on function private.prepare_storage_location() from public;
revoke all on function public.post_goods_receipt(uuid, uuid, uuid, jsonb, uuid, text, date, text, timestamptz, boolean) from public, anon;
revoke all on function public.reorder_suggestions(uuid) from public, anon;
revoke all on function public.piece_weights(uuid) from public, anon;
grant execute on function public.post_goods_receipt(uuid, uuid, uuid, jsonb, uuid, text, date, text, timestamptz, boolean) to authenticated;
grant execute on function public.reorder_suggestions(uuid) to authenticated;
grant execute on function public.piece_weights(uuid) to authenticated;
