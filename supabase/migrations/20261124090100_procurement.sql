-- Procurement (Module 4) and planning stock.
--
-- Planning stock is the stock in an outlet's STORE locations, moved only by
-- the supply chain: opening stock, goods received from vendors, issues to and
-- returns from departments, transfers, wastage in the store, adjustments and
-- counts. Sales and prep production still write the ledger (for food cost),
-- but never count towards planning stock. Reorder levels are checked against
-- planning stock plus what is already on order.
--
-- Purchase orders:  draft -> submitted -> approved -> partially_received -> received
--                   a draft or submitted order can be cancelled; an approved one
--                   too while nothing has arrived; a partly received one can be
--                   closed short. Rejecting a submitted order sends it back to draft.
-- Goods receipts:   posted in one call, against an approved order or directly
--                   from a vendor, into a store location. Each line writes a
--                   'receipt' ledger row at the price paid (before GST).
--                   Receiving more than was ordered needs p_accept_excess.
--
--   save_purchase_order / submit_ / decide_ / cancel_ / close_purchase_order
--   post_goods_receipt / void_goods_receipt
--   planning_stock (view), reorder_suggestions()

-- ---------------------------------------------------------------------------
-- Permissions and tabs
-- ---------------------------------------------------------------------------
insert into public.permissions (code, area, description, sort_order) values
  ('purchase.view',    'Purchasing', 'View purchase orders, goods receipts and reorder planning', 500),
  ('purchase.order',   'Purchasing', 'Raise, edit, submit and cancel purchase orders',            510),
  ('purchase.approve', 'Purchasing', 'Approve or reject purchase orders, close them short and void receipts', 520),
  ('purchase.receive', 'Purchasing', 'Receive goods from vendors into the store',                530);

insert into private.default_role_permissions (role_key, permission_code)
select r.role_key, p.code
from (values
  ('admin',       array['purchase.view','purchase.order','purchase.approve','purchase.receive']),
  ('manager',     array['purchase.view','purchase.order','purchase.approve','purchase.receive']),
  ('storekeeper', array['purchase.view','purchase.receive']),
  ('purchase',    array['purchase.view','purchase.order']),
  ('finance',     array['purchase.view'])
) as r(role_key, codes)
cross join lateral unnest(r.codes) as p(code);

insert into public.role_permissions (organisation_id, role_id, permission_code)
select ro.organisation_id, ro.id, d.permission_code
from private.default_role_permissions d
join public.roles ro on ro.key = d.role_key
where d.permission_code like 'purchase.%'
on conflict (role_id, permission_code) do nothing;

insert into public.app_tabs (key, label, path, section, view_permission, sort_order) values
  ('reorder',         'Reorder planning', '/reorder',         'Purchasing', 'purchase.view', 250),
  ('purchase_orders', 'Purchase orders',  '/purchase-orders', 'Purchasing', 'purchase.view', 260),
  ('receipts',        'Goods receipts',   '/receipts',        'Purchasing', 'purchase.view', 270);

-- ---------------------------------------------------------------------------
-- Purchase orders
-- ---------------------------------------------------------------------------
create table public.purchase_orders (
  id                     uuid primary key default gen_random_uuid(),
  organisation_id        uuid not null,
  outlet_id              uuid not null,
  vendor_id              uuid not null,
  po_no                  text,
  deliver_to_location_id uuid not null,
  status                 text not null default 'draft' check (status in (
                           'draft', 'submitted', 'approved', 'partially_received', 'received', 'closed', 'cancelled')),
  order_date             date not null default current_date,
  expected_date          date,
  note                   text,
  total_amount           numeric(14,2) not null default 0,
  tax_amount             numeric(14,2) not null default 0,
  created_by             uuid default auth.uid() references auth.users (id) on delete set null,
  submitted_by           uuid references auth.users (id) on delete set null,
  submitted_at           timestamptz,
  decided_by             uuid references auth.users (id) on delete set null,
  decided_at             timestamptz,
  decision_note          text,
  closed_by              uuid references auth.users (id) on delete set null,
  closed_at              timestamptz,
  close_reason           text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  sync_version           bigint not null default 0,
  unique (id, outlet_id),
  check (expected_date is null or expected_date >= order_date),
  foreign key (outlet_id, organisation_id)
    references public.outlets (id, organisation_id) on delete restrict,
  foreign key (vendor_id, organisation_id)
    references public.vendors (id, organisation_id) on delete restrict,
  foreign key (deliver_to_location_id, outlet_id)
    references public.storage_locations (id, outlet_id) on delete restrict
);

create unique index purchase_orders_outlet_no_key on public.purchase_orders (outlet_id, po_no) where po_no is not null;
create index purchase_orders_outlet_status_idx on public.purchase_orders (outlet_id, status);
create index purchase_orders_vendor_id_idx on public.purchase_orders (vendor_id);
create index purchase_orders_organisation_id_idx on public.purchase_orders (organisation_id);

comment on column public.purchase_orders.total_amount is 'Sum of line amounts before GST, in rupees.';

create table public.purchase_order_lines (
  id                uuid primary key default gen_random_uuid(),
  organisation_id   uuid not null,
  outlet_id         uuid not null,
  purchase_order_id uuid not null,
  item_id           uuid not null,
  pack_size_id      uuid,
  unit              text references public.units (code),
  base_per_unit     numeric not null check (base_per_unit > 0),
  quantity          numeric not null check (quantity > 0),
  rate              numeric(14,2) not null check (rate >= 0),
  gst_rate          numeric(5,2) check (gst_rate is null or (gst_rate >= 0 and gst_rate <= 100)),
  quantity_in_base  numeric generated always as (round(quantity * base_per_unit, 6)) stored,
  rate_per_base     numeric(18,6) generated always as (round(rate / base_per_unit, 6)) stored,
  amount            numeric(14,2) generated always as (round(quantity * rate, 2)) stored,
  received_in_base  numeric not null default 0 check (received_in_base >= 0),
  note              text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  sync_version      bigint not null default 0,
  check (num_nonnulls(pack_size_id, unit) = 1),
  foreign key (purchase_order_id, outlet_id)
    references public.purchase_orders (id, outlet_id) on delete cascade,
  foreign key (outlet_id, organisation_id)
    references public.outlets (id, organisation_id) on delete restrict,
  foreign key (item_id, organisation_id)
    references public.items (id, organisation_id) on delete restrict,
  foreign key (pack_size_id, item_id)
    references public.item_pack_sizes (id, item_id) on delete restrict
);

create index purchase_order_lines_order_idx on public.purchase_order_lines (purchase_order_id);
create index purchase_order_lines_item_id_idx on public.purchase_order_lines (item_id);

comment on column public.purchase_order_lines.quantity is 'Packs (pack_size_id) or units (unit) ordered.';
comment on column public.purchase_order_lines.rate is 'Rupees per pack or unit, before GST.';
comment on column public.purchase_order_lines.received_in_base is 'Base units received so far, kept by post_goods_receipt and void_goods_receipt.';

-- ---------------------------------------------------------------------------
-- Goods receipts
-- ---------------------------------------------------------------------------
create table public.goods_receipts (
  id                uuid primary key default gen_random_uuid(),
  organisation_id   uuid not null,
  outlet_id         uuid not null,
  vendor_id         uuid not null,
  purchase_order_id uuid,
  grn_no            text,
  location_id       uuid not null,
  invoice_no        text check (invoice_no is null or length(invoice_no) <= 40),
  invoice_date      date,
  received_at       timestamptz not null default now(),
  total_amount      numeric(14,2) not null default 0,
  tax_amount        numeric(14,2) not null default 0,
  note              text,
  received_by       uuid default auth.uid() references auth.users (id) on delete set null,
  voided_at         timestamptz,
  voided_by         uuid references auth.users (id) on delete set null,
  void_reason       text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  sync_version      bigint not null default 0,
  unique (id, outlet_id),
  check (voided_at is null or void_reason is not null),
  foreign key (outlet_id, organisation_id)
    references public.outlets (id, organisation_id) on delete restrict,
  foreign key (vendor_id, organisation_id)
    references public.vendors (id, organisation_id) on delete restrict,
  foreign key (purchase_order_id, outlet_id)
    references public.purchase_orders (id, outlet_id) on delete restrict,
  foreign key (location_id, outlet_id)
    references public.storage_locations (id, outlet_id) on delete restrict
);

create unique index goods_receipts_outlet_no_key on public.goods_receipts (outlet_id, grn_no) where grn_no is not null;
create index goods_receipts_outlet_time_idx on public.goods_receipts (outlet_id, received_at);
create index goods_receipts_purchase_order_idx on public.goods_receipts (purchase_order_id);
create index goods_receipts_vendor_id_idx on public.goods_receipts (vendor_id);
create index goods_receipts_organisation_id_idx on public.goods_receipts (organisation_id);

create table public.goods_receipt_lines (
  id                     uuid primary key default gen_random_uuid(),
  organisation_id        uuid not null,
  outlet_id              uuid not null,
  receipt_id             uuid not null,
  purchase_order_line_id uuid references public.purchase_order_lines (id) on delete restrict,
  item_id                uuid not null,
  pack_size_id           uuid,
  unit                   text references public.units (code),
  base_per_unit          numeric not null check (base_per_unit > 0),
  quantity               numeric not null check (quantity > 0),
  rate                   numeric(14,2) not null check (rate >= 0),
  gst_rate               numeric(5,2) check (gst_rate is null or (gst_rate >= 0 and gst_rate <= 100)),
  quantity_in_base       numeric generated always as (round(quantity * base_per_unit, 6)) stored,
  rate_per_base          numeric(18,6) generated always as (round(rate / base_per_unit, 6)) stored,
  amount                 numeric(14,2) generated always as (round(quantity * rate, 2)) stored,
  note                   text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  sync_version           bigint not null default 0,
  check (num_nonnulls(pack_size_id, unit) = 1),
  foreign key (receipt_id, outlet_id)
    references public.goods_receipts (id, outlet_id) on delete cascade,
  foreign key (outlet_id, organisation_id)
    references public.outlets (id, organisation_id) on delete restrict,
  foreign key (item_id, organisation_id)
    references public.items (id, organisation_id) on delete restrict,
  foreign key (pack_size_id, item_id)
    references public.item_pack_sizes (id, item_id) on delete restrict
);

create index goods_receipt_lines_receipt_idx on public.goods_receipt_lines (receipt_id);
create index goods_receipt_lines_po_line_idx on public.goods_receipt_lines (purchase_order_line_id);
create index goods_receipt_lines_item_id_idx on public.goods_receipt_lines (item_id);

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- Base units in one pack (pack_size_id) or one unit (unit) of an item.
create or replace function private.base_per_purchase_unit(p_item_id uuid, p_pack_size_id uuid, p_unit text)
returns numeric
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v numeric;
begin
  if p_pack_size_id is not null then
    select p.quantity_in_base into v from public.item_pack_sizes p
    where p.id = p_pack_size_id and p.item_id = p_item_id;
    if v is null then
      raise exception 'That pack size does not belong to this item' using errcode = '22023';
    end if;
    return v;
  end if;
  if p_unit is null then
    raise exception 'Choose a pack size or a unit' using errcode = '22023';
  end if;
  return private.to_base_qty(p_item_id, 1, p_unit);
end;
$$;

-- The vendor's current rate for one pack or unit of an item, if there is one.
create or replace function private.vendor_rate(p_vendor_id uuid, p_item_id uuid, p_pack_size_id uuid, p_unit text)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select vi.rate from public.vendor_items vi
  where vi.vendor_id = p_vendor_id and vi.item_id = p_item_id and vi.valid_to is null
    and coalesce(vi.pack_size_id::text, vi.price_unit) = coalesce(p_pack_size_id::text, p_unit)
  order by vi.valid_from desc
  limit 1;
$$;

-- Sets an order's status from what has been received.
create or replace function private.refresh_purchase_order_status(p_purchase_order_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_new text;
  v_any boolean;
  v_all boolean;
begin
  select status into v_status from public.purchase_orders where id = p_purchase_order_id;
  if v_status not in ('approved', 'partially_received', 'received', 'closed') then
    return v_status;
  end if;

  select coalesce(bool_or(l.received_in_base > 0), false),
         coalesce(bool_and(l.received_in_base >= l.quantity_in_base), false)
  into v_any, v_all
  from public.purchase_order_lines l where l.purchase_order_id = p_purchase_order_id;

  v_new := case
    when v_all then 'received'
    when v_status = 'closed' and v_any then 'closed'
    when v_any then 'partially_received'
    else 'approved' end;

  if v_new <> v_status then
    update public.purchase_orders
    set status = v_new,
        closed_at    = case when v_new = 'closed' then closed_at end,
        closed_by    = case when v_new = 'closed' then closed_by end,
        close_reason = case when v_new = 'closed' then close_reason end
    where id = p_purchase_order_id;
  end if;
  return v_new;
end;
$$;

revoke all on function private.base_per_purchase_unit(uuid, uuid, text) from public;
revoke all on function private.vendor_rate(uuid, uuid, uuid, text) from public;
revoke all on function private.refresh_purchase_order_status(uuid) from public;

-- ---------------------------------------------------------------------------
-- Purchase order functions
-- ---------------------------------------------------------------------------

-- Creates (p_purchase_order_id null) or replaces a draft order and its lines.
-- p_lines: [{"item_id": "...", "pack_size_id": null, "unit": "kg", "quantity": 10,
--            "rate": 42.5, "gst_rate": 5, "note": "..."}]. Rate defaults to the
-- vendor's current rate and GST to the item's.
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
                 where l.id = p_location_id and l.outlet_id = p_outlet_id and l.is_active and l.kind = 'store') then
    raise exception 'Deliver to an active store location of this outlet' using errcode = '22023';
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

create or replace function public.submit_purchase_order(p_purchase_order_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.purchase_orders;
begin
  select * into v from public.purchase_orders where id = p_purchase_order_id for update;
  if not found then
    raise exception 'Purchase order not found' using errcode = 'P0002';
  end if;
  perform private.require_outlet_permission(v.outlet_id, 'purchase.order');
  if v.status <> 'draft' then
    raise exception 'Only a draft order can be submitted' using errcode = '55000';
  end if;
  if not exists (select 1 from public.purchase_order_lines where purchase_order_id = v.id) then
    raise exception 'Add at least one item before submitting' using errcode = '22023';
  end if;
  update public.purchase_orders
  set status = 'submitted', submitted_by = auth.uid(), submitted_at = now(),
      decided_by = null, decided_at = null, decision_note = null
  where id = v.id;
end;
$$;

-- Approve, or reject back to draft with a note.
create or replace function public.decide_purchase_order(p_purchase_order_id uuid, p_approve boolean, p_note text default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.purchase_orders;
begin
  select * into v from public.purchase_orders where id = p_purchase_order_id for update;
  if not found then
    raise exception 'Purchase order not found' using errcode = 'P0002';
  end if;
  perform private.require_outlet_permission(v.outlet_id, 'purchase.approve');
  if v.status <> 'submitted' then
    raise exception 'Only a submitted order can be approved or rejected' using errcode = '55000';
  end if;
  if not p_approve and coalesce(trim(p_note), '') = '' then
    raise exception 'Say why it is rejected' using errcode = '22023';
  end if;
  update public.purchase_orders
  set status = case when p_approve then 'approved' else 'draft' end,
      decided_by = auth.uid(), decided_at = now(), decision_note = nullif(trim(p_note), '')
  where id = v.id;
  return case when p_approve then 'approved' else 'draft' end;
end;
$$;

create or replace function public.cancel_purchase_order(p_purchase_order_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.purchase_orders;
begin
  select * into v from public.purchase_orders where id = p_purchase_order_id for update;
  if not found then
    raise exception 'Purchase order not found' using errcode = 'P0002';
  end if;
  perform private.require_outlet_permission(v.outlet_id, 'purchase.order');
  if v.status not in ('draft', 'submitted', 'approved') then
    raise exception 'A % order cannot be cancelled', replace(v.status, '_', ' ') using errcode = '55000';
  end if;
  if exists (select 1 from public.goods_receipts g where g.purchase_order_id = v.id and g.voided_at is null) then
    raise exception 'Goods have been received against this order; close it instead' using errcode = '55000';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'Give a reason for cancelling' using errcode = '22023';
  end if;
  update public.purchase_orders
  set status = 'cancelled', closed_by = auth.uid(), closed_at = now(), close_reason = trim(p_reason)
  where id = v.id;
end;
$$;

-- Closes a partly received order: the rest will not come.
create or replace function public.close_purchase_order(p_purchase_order_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.purchase_orders;
begin
  select * into v from public.purchase_orders where id = p_purchase_order_id for update;
  if not found then
    raise exception 'Purchase order not found' using errcode = 'P0002';
  end if;
  perform private.require_outlet_permission(v.outlet_id, 'purchase.approve');
  if v.status <> 'partially_received' then
    raise exception 'Only a partly received order can be closed short' using errcode = '55000';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'Give a reason for closing short' using errcode = '22023';
  end if;
  update public.purchase_orders
  set status = 'closed', closed_by = auth.uid(), closed_at = now(), close_reason = trim(p_reason)
  where id = v.id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Goods receipts
-- ---------------------------------------------------------------------------
-- p_lines: [{"purchase_order_line_id": "...", "item_id": "...", "pack_size_id": null,
--            "unit": "kg", "quantity": 10, "rate": 42.5, "gst_rate": 5}]
-- A line with purchase_order_line_id takes its item, pack or unit, rate and GST
-- from the order unless given. A line without one is an item that was not
-- ordered (or a receipt with no order) and needs a rate or a vendor price.
create or replace function public.post_goods_receipt(
  p_outlet_id         uuid,
  p_vendor_id         uuid,
  p_location_id       uuid,
  p_lines             jsonb,
  p_purchase_order_id uuid default null,
  p_invoice_no        text default null,
  p_invoice_date      date default null,
  p_note              text default null,
  p_received_at       timestamptz default null,
  p_accept_excess     boolean default false)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org  uuid;
  v_po   public.purchase_orders;
  v_pol  public.purchase_order_lines;
  v_id   uuid;
  v_e    jsonb;
  v_item public.items;
  v_pack uuid;
  v_unit text;
  v_rate numeric;
  v_gst  numeric;
  v_bpu  numeric;
  v_qty  numeric;
  v_line_id uuid;
  v_at   timestamptz := coalesce(p_received_at, now());
begin
  v_org := private.require_outlet_permission(p_outlet_id, 'purchase.receive');

  if not exists (select 1 from public.storage_locations l
                 where l.id = p_location_id and l.outlet_id = p_outlet_id and l.is_active and l.kind = 'store') then
    raise exception 'Receive into an active store location of this outlet' using errcode = '22023';
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

  insert into public.goods_receipts (
    organisation_id, outlet_id, vendor_id, purchase_order_id, grn_no, location_id,
    invoice_no, invoice_date, received_at, note, received_by)
  values (
    v_org, p_outlet_id, p_vendor_id, p_purchase_order_id, private.next_doc_no(p_outlet_id, 'grn', 'GRN'), p_location_id,
    nullif(trim(p_invoice_no), ''), p_invoice_date, v_at, nullif(trim(p_note), ''), auth.uid())
  returning id into v_id;

  for v_e in select * from jsonb_array_elements(p_lines) loop
    if coalesce((v_e ->> 'quantity')::numeric, 0) <= 0 then
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
      v_unit := case when v_pack is null then coalesce(nullif(v_e ->> 'unit', ''), v_pol.unit, v_item.base_unit) end;
    else
      if nullif(v_e ->> 'item_id', '') is null then
        raise exception 'Every line needs an item' using errcode = '22023';
      end if;
      v_item := private.require_item(v_org, (v_e ->> 'item_id')::uuid);
      v_pack := nullif(v_e ->> 'pack_size_id', '')::uuid;
      v_unit := case when v_pack is null then coalesce(nullif(v_e ->> 'unit', ''), v_item.base_unit) end;
    end if;

    v_bpu := private.base_per_purchase_unit(v_item.id, v_pack, v_unit);
    v_qty := (v_e ->> 'quantity')::numeric;

    v_rate := nullif(v_e ->> 'rate', '')::numeric;
    if v_rate is null and v_pol.id is not null then
      v_rate := round(v_pol.rate_per_base * v_bpu, 2);   -- the ordered price, in this pack or unit
    end if;
    v_rate := coalesce(v_rate, private.vendor_rate(p_vendor_id, v_item.id, v_pack, v_unit));
    if v_rate is null then
      raise exception '%: enter the rate on the bill (this vendor has no price for it)', v_item.name using errcode = '22023';
    end if;
    v_gst := coalesce(nullif(v_e ->> 'gst_rate', '')::numeric, v_pol.gst_rate, v_item.gst_rate);

    if v_pol.id is not null then
      if not p_accept_excess and v_pol.received_in_base + round(v_qty * v_bpu, 6) > v_pol.quantity_in_base then
        raise exception '%: more than was ordered. Tick "accept extra" to receive it anyway.', v_item.name using errcode = '22023';
      end if;
      update public.purchase_order_lines
      set received_in_base = received_in_base + round(v_qty * v_bpu, 6)
      where id = v_pol.id;
    elsif p_purchase_order_id is not null and not p_accept_excess then
      raise exception '%: not on this order. Tick "accept extra" to receive it anyway.', v_item.name using errcode = '22023';
    end if;

    insert into public.goods_receipt_lines (
      organisation_id, outlet_id, receipt_id, purchase_order_line_id, item_id, pack_size_id, unit,
      base_per_unit, quantity, rate, gst_rate, note)
    values (
      v_org, p_outlet_id, v_id, v_pol.id, v_item.id, v_pack, v_unit,
      v_bpu, v_qty, v_rate, v_gst, nullif(trim(v_e ->> 'note'), ''))
    returning id into v_line_id;

    perform private.add_ledger_entry(
      v_org, p_outlet_id, p_location_id, v_item.id, 'receipt',
      round(v_qty * v_bpu, 6), round(v_rate / v_bpu, 6),
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
    perform private.refresh_purchase_order_status(p_purchase_order_id);
  end if;

  return v_id;
end;
$$;

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
    from (select l.purchase_order_line_id, sum(l.quantity_in_base) as qty
          from public.goods_receipt_lines l
          where l.receipt_id = v.id and l.purchase_order_line_id is not null
          group by l.purchase_order_line_id) r
    where pol.id = r.purchase_order_line_id;
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

-- ---------------------------------------------------------------------------
-- Planning stock (runs with the caller's permissions)
-- ---------------------------------------------------------------------------
create view public.planning_stock
with (security_invoker = true)
as
with totals as (
  select l.organisation_id, l.outlet_id, l.item_id,
         sum(l.quantity) as quantity, sum(l.value) as value
  from public.stock_ledger l
  join public.storage_locations sl on sl.id = l.location_id
  where sl.kind = 'store'
    and l.movement_type not in ('sale', 'prep_production', 'prep_consumption')
  group by l.organisation_id, l.outlet_id, l.item_id
),
on_order as (
  select pol.outlet_id, pol.item_id,
         sum(greatest(pol.quantity_in_base - pol.received_in_base, 0)) as quantity
  from public.purchase_order_lines pol
  join public.purchase_orders po on po.id = pol.purchase_order_id
  where po.status in ('submitted', 'approved', 'partially_received')
  group by pol.outlet_id, pol.item_id
)
select
  coalesce(t.organisation_id, s.organisation_id) as organisation_id,
  coalesce(t.outlet_id, s.outlet_id)             as outlet_id,
  coalesce(t.item_id, s.item_id)                 as item_id,
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
from totals t
full join public.item_outlet_settings s
  on s.outlet_id = t.outlet_id and s.item_id = t.item_id
left join on_order oo
  on oo.outlet_id = coalesce(t.outlet_id, s.outlet_id) and oo.item_id = coalesce(t.item_id, s.item_id)
where coalesce(s.is_stocked, true);

comment on view public.planning_stock is 'Store stock per item and outlet, moved only by receipts, issues, returns, transfers, wastage, adjustments and counts; with what is on order and reorder flags.';

revoke all on table public.planning_stock from anon, authenticated;
grant select on public.planning_stock to authenticated;

-- Items at or below their reorder level (counting what is on order), with how
-- much to order and from whom: the preferred vendor, else the cheapest price.
create or replace function public.reorder_suggestions(p_outlet_id uuid)
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
  lead_time_days  integer)
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
           coalesce((select sum(l.quantity) from public.stock_ledger l
                     join public.storage_locations sl on sl.id = l.location_id
                     where l.outlet_id = p_outlet_id and l.item_id = s.item_id and sl.kind = 'store'
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
         n.lead_time_days
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
-- Triggers and sync
-- ---------------------------------------------------------------------------
create trigger set_updated_at before update on public.purchase_orders
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.purchase_order_lines
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.goods_receipts
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.goods_receipt_lines
  for each row execute function private.set_updated_at();

create trigger bump_sync_version before insert or update on public.purchase_orders
  for each row execute function private.bump_sync_version();
create trigger bump_sync_version before insert or update on public.purchase_order_lines
  for each row execute function private.bump_sync_version();
create trigger bump_sync_version before insert or update on public.goods_receipts
  for each row execute function private.bump_sync_version();
create trigger bump_sync_version before insert or update on public.goods_receipt_lines
  for each row execute function private.bump_sync_version();

-- Draft order lines are replaced on every save.
create trigger record_tombstone after delete on public.purchase_order_lines
  for each row execute function private.record_tombstone('id');

insert into private.sync_tables (table_name, direction, scope) values
  ('purchase_orders',      'up', 'outlet'),
  ('purchase_order_lines', 'up', 'outlet'),
  ('goods_receipts',       'up', 'outlet'),
  ('goods_receipt_lines',  'up', 'outlet');

-- ---------------------------------------------------------------------------
-- Privileges and row-level security: read-only tables, functions write
-- ---------------------------------------------------------------------------
alter table public.purchase_orders      enable row level security;
alter table public.purchase_order_lines enable row level security;
alter table public.goods_receipts       enable row level security;
alter table public.goods_receipt_lines  enable row level security;

revoke all on table public.purchase_orders, public.purchase_order_lines,
  public.goods_receipts, public.goods_receipt_lines from anon, authenticated;

grant select on public.purchase_orders, public.purchase_order_lines,
  public.goods_receipts, public.goods_receipt_lines to authenticated;

create policy "Purchasing staff can read purchase orders"
  on public.purchase_orders for select to authenticated
  using (outlet_id in (select private.outlet_ids_with('purchase.view'))
         or outlet_id in (select private.outlet_ids_with('purchase.order'))
         or outlet_id in (select private.outlet_ids_with('purchase.approve'))
         or outlet_id in (select private.outlet_ids_with('purchase.receive')));

create policy "Purchasing staff can read purchase order lines"
  on public.purchase_order_lines for select to authenticated
  using (outlet_id in (select private.outlet_ids_with('purchase.view'))
         or outlet_id in (select private.outlet_ids_with('purchase.order'))
         or outlet_id in (select private.outlet_ids_with('purchase.approve'))
         or outlet_id in (select private.outlet_ids_with('purchase.receive')));

create policy "Purchasing staff and stock viewers can read goods receipts"
  on public.goods_receipts for select to authenticated
  using (outlet_id in (select private.outlet_ids_with('purchase.view'))
         or outlet_id in (select private.outlet_ids_with('purchase.receive'))
         or outlet_id in (select private.outlet_ids_with('stock.view')));

create policy "Purchasing staff and stock viewers can read goods receipt lines"
  on public.goods_receipt_lines for select to authenticated
  using (outlet_id in (select private.outlet_ids_with('purchase.view'))
         or outlet_id in (select private.outlet_ids_with('purchase.receive'))
         or outlet_id in (select private.outlet_ids_with('stock.view')));

revoke all on function public.save_purchase_order(uuid, uuid, uuid, uuid, jsonb, date, text) from public, anon;
revoke all on function public.submit_purchase_order(uuid) from public, anon;
revoke all on function public.decide_purchase_order(uuid, boolean, text) from public, anon;
revoke all on function public.cancel_purchase_order(uuid, text) from public, anon;
revoke all on function public.close_purchase_order(uuid, text) from public, anon;
revoke all on function public.post_goods_receipt(uuid, uuid, uuid, jsonb, uuid, text, date, text, timestamptz, boolean) from public, anon;
revoke all on function public.void_goods_receipt(uuid, text) from public, anon;
revoke all on function public.reorder_suggestions(uuid) from public, anon;

grant execute on function public.save_purchase_order(uuid, uuid, uuid, uuid, jsonb, date, text) to authenticated;
grant execute on function public.submit_purchase_order(uuid) to authenticated;
grant execute on function public.decide_purchase_order(uuid, boolean, text) to authenticated;
grant execute on function public.cancel_purchase_order(uuid, text) to authenticated;
grant execute on function public.close_purchase_order(uuid, text) to authenticated;
grant execute on function public.post_goods_receipt(uuid, uuid, uuid, jsonb, uuid, text, date, text, timestamptz, boolean) to authenticated;
grant execute on function public.void_goods_receipt(uuid, text) to authenticated;
grant execute on function public.reorder_suggestions(uuid) to authenticated;
