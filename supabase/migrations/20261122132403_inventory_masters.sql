-- Inventory, part 1 of 3: masters (Module 1).
--
-- Units, item categories, items (raw, prep, packaging, consumable), pack sizes,
-- vendors, the vendor price list and per-outlet reorder settings.
-- All of these are set up in the cloud and sync DOWN to outlets.
--
-- Quantities are always held in the item's base unit: g, ml or pcs.
-- Vendors sell in packs (crate = 12 kg) or standard units (kg, l, dozen);
-- private.to_base_qty converts any of those to the base unit.

-- ---------------------------------------------------------------------------
-- Permissions, default role access and tabs for inventory (Modules 1-3)
-- ---------------------------------------------------------------------------
insert into public.permissions (code, area, description, sort_order) values
  ('masters.view',      'Inventory', 'View items, categories, vendors and prices', 100),
  ('masters.edit',      'Inventory', 'Add and edit items, categories, vendors, prices and reorder levels', 110),
  ('recipes.view',      'Menu',      'View the menu and recipes', 200),
  ('recipes.edit',      'Menu',      'Edit the menu and recipes', 210),
  ('stock.view',        'Stock',     'View stock on hand and movement history', 300),
  ('stock.adjust',      'Stock',     'Request opening stock and stock adjustments', 310),
  ('stock.transfer',    'Stock',     'Transfer stock between storage locations', 320),
  ('wastage.record',    'Stock',     'Record wastage and staff meals', 330),
  ('counts.count',      'Stock',     'Enter physical counts', 340),
  ('counts.approve',    'Stock',     'Review and approve count variances', 350),
  ('production.record', 'Kitchen',   'Record prep batches made', 360),
  ('sales.view',        'Sales',     'View sales entries', 400),
  ('sales.record',      'Sales',     'Enter and upload daily sales', 410);

insert into private.default_role_permissions (role_key, permission_code)
select r.role_key, p.code
from (values
  ('admin',       array['masters.view','masters.edit','recipes.view','recipes.edit','stock.view','stock.adjust','stock.transfer','wastage.record','counts.count','counts.approve','production.record','sales.view','sales.record']),
  ('manager',     array['masters.view','masters.edit','recipes.view','recipes.edit','stock.view','stock.adjust','stock.transfer','wastage.record','counts.count','counts.approve','production.record','sales.view','sales.record']),
  ('storekeeper', array['masters.view','stock.view','stock.adjust','stock.transfer','wastage.record','counts.count']),
  ('chef',        array['masters.view','recipes.view','recipes.edit','stock.view','wastage.record','counts.count','production.record']),
  ('purchase',    array['masters.view','masters.edit','stock.view']),
  ('finance',     array['masters.view','recipes.view','stock.view','sales.view'])
) as r(role_key, codes)
cross join lateral unnest(r.codes) as p(code);

-- Give the new defaults to roles of organisations that already exist.
insert into public.role_permissions (organisation_id, role_id, permission_code)
select ro.organisation_id, ro.id, d.permission_code
from private.default_role_permissions d
join public.roles ro on ro.key = d.role_key
where d.permission_code in (
  'masters.view','masters.edit','recipes.view','recipes.edit','stock.view','stock.adjust',
  'stock.transfer','wastage.record','counts.count','counts.approve','production.record',
  'sales.view','sales.record')
on conflict (role_id, permission_code) do nothing;

insert into public.app_tabs (key, label, path, section, view_permission, sort_order) values
  ('items',      'Items',            '/items',      'Inventory', 'masters.view',      100),
  ('vendors',    'Vendors',          '/vendors',    'Inventory', 'masters.view',      110),
  ('stock',      'Stock on hand',    '/stock',      'Stock',     'stock.view',        200),
  ('transfers',  'Transfers',        '/transfers',  'Stock',     'stock.transfer',    210),
  ('wastage',    'Wastage',          '/wastage',    'Stock',     'wastage.record',    220),
  ('counts',     'Counts',           '/counts',     'Stock',     'counts.count',      230),
  ('menu',       'Menu and recipes', '/menu',       'Kitchen',   'recipes.view',      300),
  ('production', 'Prep production',  '/production', 'Kitchen',   'production.record', 310),
  ('sales',      'Sales',            '/sales',      'Sales',     'sales.view',        400);

-- ---------------------------------------------------------------------------
-- Units: shared reference list, the same in every database
-- ---------------------------------------------------------------------------
create table public.units (
  code           text primary key check (code ~ '^[a-z]{1,10}$'),
  name           text not null,
  dimension      text not null check (dimension in ('mass', 'volume', 'count')),
  base_code      text not null references public.units (code),
  factor_to_base numeric not null check (factor_to_base > 0),
  sort_order     integer not null default 0
);

insert into public.units (code, name, dimension, base_code, factor_to_base, sort_order) values
  ('g',     'Gram',       'mass',   'g',   1,    10),
  ('kg',    'Kilogram',   'mass',   'g',   1000, 20),
  ('ml',    'Millilitre', 'volume', 'ml',  1,    30),
  ('l',     'Litre',      'volume', 'ml',  1000, 40),
  ('pcs',   'Pieces',     'count',  'pcs', 1,    50),
  ('dozen', 'Dozen',      'count',  'pcs', 12,   60);

comment on table public.units is 'Shared units. Base units are g, ml and pcs; stock is always held in a base unit.';

-- ---------------------------------------------------------------------------
-- Item categories
-- ---------------------------------------------------------------------------
create table public.item_categories (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete restrict,
  name            text not null check (length(trim(name)) between 1 and 60),
  sort_order      integer not null default 100,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  sync_version    bigint not null default 0,
  unique (id, organisation_id)
);

create unique index item_categories_organisation_name_key
  on public.item_categories (organisation_id, lower(name));

create table private.default_item_categories (
  name       text primary key,
  sort_order integer not null
);

insert into private.default_item_categories (name, sort_order) values
  ('Vegetables', 10), ('Fruits', 20), ('Meat and seafood', 30), ('Dairy', 40),
  ('Dry store', 50), ('Spices', 60), ('Oils', 70), ('Beverages', 80),
  ('Packaging', 90), ('Cleaning', 100), ('Prep items', 110);

create or replace function private.create_default_item_categories(p_organisation_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.item_categories (organisation_id, name, sort_order)
  select p_organisation_id, d.name, d.sort_order
  from private.default_item_categories d
  on conflict do nothing;
$$;

revoke all on function private.create_default_item_categories(uuid) from public;
grant execute on function private.create_default_item_categories(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Items
-- ---------------------------------------------------------------------------
create table public.items (
  id                uuid primary key default gen_random_uuid(),
  organisation_id   uuid not null references public.organisations (id) on delete restrict,
  category_id       uuid,
  code              text check (code is null or code ~ '^[A-Za-z0-9_-]{1,20}$'),
  name              text not null check (length(trim(name)) between 1 and 120),
  item_type         text not null default 'raw'
                    check (item_type in ('raw', 'prep', 'packaging', 'consumable')),
  base_unit         text not null references public.units (code)
                    check (base_unit in ('g', 'ml', 'pcs')),
  -- Optional conversion to another unit family, e.g. eggs (pcs) at 50 g each:
  -- alt_unit = 'g', alt_per_base = 50.
  alt_unit          text references public.units (code)
                    check (alt_unit is null or alt_unit in ('g', 'ml', 'pcs')),
  alt_per_base      numeric check (alt_per_base is null or alt_per_base > 0),
  -- Share of the bought weight that is usable, e.g. 85 for onions after peeling.
  default_yield_pct numeric(5,2) not null default 100
                    check (default_yield_pct > 0 and default_yield_pct <= 100),
  shelf_life_days   integer check (shelf_life_days is null or shelf_life_days > 0),
  track_expiry      boolean not null default false,
  hsn_code          text check (hsn_code is null or hsn_code ~ '^[0-9]{4,8}$'),
  gst_rate          numeric(5,2) check (gst_rate is null or (gst_rate >= 0 and gst_rate <= 100)),
  is_active         boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  sync_version      bigint not null default 0,
  unique (id, organisation_id),
  unique (organisation_id, code),
  check ((alt_unit is null) = (alt_per_base is null)),
  check (alt_unit is null or alt_unit <> base_unit),
  foreign key (category_id, organisation_id)
    references public.item_categories (id, organisation_id) on delete restrict
);

create unique index items_organisation_name_key on public.items (organisation_id, lower(name));
create index items_category_id_idx on public.items (category_id);

comment on table public.items is 'Everything the restaurant buys or makes. Stock is held in base_unit (g, ml or pcs).';

-- Converts a quantity in any unit to the item's base unit.
create or replace function private.to_base_qty(p_item_id uuid, p_qty numeric, p_unit text)
returns numeric
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_item record;
  v_unit record;
begin
  select i.name, i.base_unit, i.alt_unit, i.alt_per_base into v_item
  from public.items i where i.id = p_item_id;
  if not found then
    raise exception 'Item not found' using errcode = 'P0002';
  end if;

  select u.base_code, u.factor_to_base into v_unit
  from public.units u where u.code = p_unit;
  if not found then
    raise exception 'Unknown unit: %', p_unit using errcode = '22023';
  end if;

  if v_unit.base_code = v_item.base_unit then
    return round(p_qty * v_unit.factor_to_base, 6);
  end if;

  if v_item.alt_unit is not null and v_unit.base_code = v_item.alt_unit then
    return round(p_qty * v_unit.factor_to_base / v_item.alt_per_base, 6);
  end if;

  raise exception '% cannot be measured in %', v_item.name, p_unit using errcode = '22023';
end;
$$;

revoke all on function private.to_base_qty(uuid, numeric, text) from public;
grant execute on function private.to_base_qty(uuid, numeric, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Pack sizes: how vendors sell an item (crate of 12 kg, tray of 30 eggs)
-- ---------------------------------------------------------------------------
create table public.item_pack_sizes (
  id               uuid primary key default gen_random_uuid(),
  organisation_id  uuid not null,
  item_id          uuid not null,
  name             text not null check (length(trim(name)) between 1 and 60),
  quantity_in_base numeric not null check (quantity_in_base > 0),
  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  sync_version     bigint not null default 0,
  unique (id, organisation_id),
  unique (id, item_id),
  foreign key (item_id, organisation_id)
    references public.items (id, organisation_id) on delete restrict
);

create unique index item_pack_sizes_item_name_key on public.item_pack_sizes (item_id, lower(name));
create index item_pack_sizes_organisation_id_idx on public.item_pack_sizes (organisation_id);

comment on column public.item_pack_sizes.quantity_in_base is 'Base units in one pack, e.g. 12000 for a 12 kg crate. Fixed once created; add a new pack size instead.';

-- ---------------------------------------------------------------------------
-- Vendors
-- ---------------------------------------------------------------------------
create table public.vendors (
  id                 uuid primary key default gen_random_uuid(),
  organisation_id    uuid not null references public.organisations (id) on delete restrict,
  name               text not null check (length(trim(name)) between 1 and 120),
  code               text check (code is null or code ~ '^[A-Za-z0-9_-]{1,20}$'),
  contact_person     text check (contact_person is null or length(contact_person) <= 120),
  phone              text check (phone is null or length(phone) <= 20),
  whatsapp           text check (whatsapp is null or length(whatsapp) <= 20),
  email              text check (email is null or email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  gstin              text check (gstin is null or gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  address_line1      text,
  address_line2      text,
  city               text,
  state              text,
  pincode            text check (pincode is null or pincode ~ '^[1-9][0-9]{5}$'),
  payment_terms_days integer not null default 0 check (payment_terms_days between 0 and 365),
  preferred_channel  text not null default 'whatsapp' check (preferred_channel in ('whatsapp', 'email', 'sms')),
  notes              text,
  is_active          boolean not null default true,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  sync_version       bigint not null default 0,
  unique (id, organisation_id),
  unique (organisation_id, code)
);

create unique index vendors_organisation_name_key on public.vendors (organisation_id, lower(name));

comment on table public.vendors is 'Suppliers. Bank details are added with accounts payable (Module 5), visible to finance only.';

-- ---------------------------------------------------------------------------
-- Vendor price list: one open rate per vendor, item and pack/unit.
-- A new rate closes the previous one, so price history is kept.
-- ---------------------------------------------------------------------------
create table public.vendor_items (
  id                   uuid primary key default gen_random_uuid(),
  organisation_id      uuid not null,
  vendor_id            uuid not null,
  item_id              uuid not null,
  pack_size_id         uuid,
  price_unit           text references public.units (code),
  purchase_qty_in_base numeric not null check (purchase_qty_in_base > 0),
  rate                 numeric(14,2) not null check (rate >= 0),
  rate_per_base        numeric(18,6) generated always as (round(rate / purchase_qty_in_base, 6)) stored,
  valid_from           date not null default current_date,
  valid_to             date,
  vendor_item_code     text check (vendor_item_code is null or length(vendor_item_code) <= 40),
  min_order_qty        numeric check (min_order_qty is null or min_order_qty > 0),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  sync_version         bigint not null default 0,
  check (num_nonnulls(pack_size_id, price_unit) = 1),
  check (valid_to is null or valid_to >= valid_from),
  foreign key (vendor_id, organisation_id)
    references public.vendors (id, organisation_id) on delete restrict,
  foreign key (item_id, organisation_id)
    references public.items (id, organisation_id) on delete restrict,
  foreign key (pack_size_id, item_id)
    references public.item_pack_sizes (id, item_id) on delete restrict
);

create unique index vendor_items_one_open_rate
  on public.vendor_items (vendor_id, item_id, coalesce(pack_size_id::text, price_unit))
  where valid_to is null;
create index vendor_items_item_id_idx on public.vendor_items (item_id);
create index vendor_items_organisation_id_idx on public.vendor_items (organisation_id);

comment on column public.vendor_items.rate is 'Price for one pack (pack_size_id) or one price_unit, in rupees, before GST.';
comment on column public.vendor_items.rate_per_base is 'Rupees per base unit (per g, ml or pc).';

-- Fills purchase_qty_in_base, and on a new rate closes the previous open one.
create or replace function private.prepare_vendor_item()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_open record;
begin
  if new.pack_size_id is not null then
    select p.quantity_in_base into new.purchase_qty_in_base
    from public.item_pack_sizes p
    where p.id = new.pack_size_id and p.item_id = new.item_id;
    if new.purchase_qty_in_base is null then
      raise exception 'That pack size does not belong to this item' using errcode = '22023';
    end if;
  else
    new.purchase_qty_in_base := private.to_base_qty(new.item_id, 1, new.price_unit);
  end if;

  if tg_op = 'INSERT' then
    select v.id, v.valid_from into v_open
    from public.vendor_items v
    where v.vendor_id = new.vendor_id
      and v.item_id = new.item_id
      and coalesce(v.pack_size_id::text, v.price_unit) = coalesce(new.pack_size_id::text, new.price_unit)
      and v.valid_to is null
    for update;

    if found then
      if v_open.valid_from >= new.valid_from then
        raise exception 'A rate starting on or after % already exists for this vendor and item. Edit that rate instead.', new.valid_from
          using errcode = '23505';
      end if;
      update public.vendor_items set valid_to = new.valid_from - 1 where id = v_open.id;
    end if;
  end if;

  return new;
end;
$$;

revoke all on function private.prepare_vendor_item() from public;

create trigger prepare_vendor_item before insert or update on public.vendor_items
  for each row execute function private.prepare_vendor_item();

-- ---------------------------------------------------------------------------
-- Per-outlet settings: reorder level ("rate limiter"), preferred vendor,
-- default storage location
-- ---------------------------------------------------------------------------
create table public.item_outlet_settings (
  organisation_id     uuid not null,
  outlet_id           uuid not null,
  item_id             uuid not null,
  is_stocked          boolean not null default true,
  preferred_vendor_id uuid,
  default_location_id uuid,
  reorder_level       numeric check (reorder_level is null or reorder_level >= 0),
  reorder_qty         numeric check (reorder_qty is null or reorder_qty > 0),
  max_level           numeric check (max_level is null or max_level >= 0),
  lead_time_days      integer check (lead_time_days is null or lead_time_days between 0 and 90),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  sync_version        bigint not null default 0,
  primary key (outlet_id, item_id),
  foreign key (outlet_id, organisation_id)
    references public.outlets (id, organisation_id) on delete restrict,
  foreign key (item_id, organisation_id)
    references public.items (id, organisation_id) on delete restrict,
  foreign key (preferred_vendor_id, organisation_id)
    references public.vendors (id, organisation_id) on delete restrict,
  foreign key (default_location_id, outlet_id)
    references public.storage_locations (id, outlet_id) on delete restrict
);

create index item_outlet_settings_item_id_idx on public.item_outlet_settings (item_id);
create index item_outlet_settings_organisation_id_idx on public.item_outlet_settings (organisation_id);

comment on column public.item_outlet_settings.reorder_level is 'Base units. At or below this, the reorder engine (Module 4) drafts a purchase request.';

-- ---------------------------------------------------------------------------
-- Triggers: updated_at and sync_version
-- ---------------------------------------------------------------------------
create trigger set_updated_at before update on public.item_categories
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.items
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.item_pack_sizes
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.vendors
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.vendor_items
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.item_outlet_settings
  for each row execute function private.set_updated_at();

create trigger bump_sync_version before insert or update on public.item_categories
  for each row execute function private.bump_sync_version();
create trigger bump_sync_version before insert or update on public.items
  for each row execute function private.bump_sync_version();
create trigger bump_sync_version before insert or update on public.item_pack_sizes
  for each row execute function private.bump_sync_version();
create trigger bump_sync_version before insert or update on public.vendors
  for each row execute function private.bump_sync_version();
create trigger bump_sync_version before insert or update on public.vendor_items
  for each row execute function private.bump_sync_version();
create trigger bump_sync_version before insert or update on public.item_outlet_settings
  for each row execute function private.bump_sync_version();

insert into private.sync_tables (table_name, direction, scope) values
  ('item_categories',      'down', 'organisation'),
  ('items',                'down', 'organisation'),
  ('item_pack_sizes',      'down', 'organisation'),
  ('vendors',              'down', 'organisation'),
  ('vendor_items',         'down', 'organisation'),
  ('item_outlet_settings', 'down', 'organisation');

-- ---------------------------------------------------------------------------
-- Privileges and row-level security
-- ---------------------------------------------------------------------------
alter table public.units                enable row level security;
alter table public.item_categories      enable row level security;
alter table public.items                enable row level security;
alter table public.item_pack_sizes      enable row level security;
alter table public.vendors              enable row level security;
alter table public.vendor_items         enable row level security;
alter table public.item_outlet_settings enable row level security;

revoke all on table
  public.units, public.item_categories, public.items, public.item_pack_sizes,
  public.vendors, public.vendor_items, public.item_outlet_settings
from anon, authenticated;

grant select on public.units to authenticated;

grant select on public.item_categories to authenticated;
grant insert (organisation_id, name, sort_order) on public.item_categories to authenticated;
grant update (name, sort_order, is_active) on public.item_categories to authenticated;

grant select on public.items to authenticated;
grant insert (organisation_id, category_id, code, name, item_type, base_unit, alt_unit, alt_per_base,
              default_yield_pct, shelf_life_days, track_expiry, hsn_code, gst_rate)
  on public.items to authenticated;
grant update (category_id, code, name, item_type, base_unit, alt_unit, alt_per_base,
              default_yield_pct, shelf_life_days, track_expiry, hsn_code, gst_rate, is_active)
  on public.items to authenticated;

grant select on public.item_pack_sizes to authenticated;
grant insert (organisation_id, item_id, name, quantity_in_base) on public.item_pack_sizes to authenticated;
grant update (name, is_active) on public.item_pack_sizes to authenticated;

grant select on public.vendors to authenticated;
grant insert (organisation_id, name, code, contact_person, phone, whatsapp, email, gstin,
              address_line1, address_line2, city, state, pincode, payment_terms_days,
              preferred_channel, notes)
  on public.vendors to authenticated;
grant update (name, code, contact_person, phone, whatsapp, email, gstin, address_line1,
              address_line2, city, state, pincode, payment_terms_days, preferred_channel,
              notes, is_active)
  on public.vendors to authenticated;

grant select on public.vendor_items to authenticated;
grant insert (organisation_id, vendor_id, item_id, pack_size_id, price_unit, rate, valid_from,
              valid_to, vendor_item_code, min_order_qty)
  on public.vendor_items to authenticated;
grant update (rate, valid_to, vendor_item_code, min_order_qty) on public.vendor_items to authenticated;

grant select on public.item_outlet_settings to authenticated;
grant insert (organisation_id, outlet_id, item_id, is_stocked, preferred_vendor_id,
              default_location_id, reorder_level, reorder_qty, max_level, lead_time_days)
  on public.item_outlet_settings to authenticated;
grant update (is_stocked, preferred_vendor_id, default_location_id, reorder_level, reorder_qty,
              max_level, lead_time_days)
  on public.item_outlet_settings to authenticated;

create policy "Signed-in users can read units"
  on public.units for select to authenticated using (true);

-- Item categories, items, pack sizes, vendors, prices: masters.view reads,
-- masters.edit adds and edits. Nothing is deleted; deactivate instead.
create policy "Masters viewers can read item categories"
  on public.item_categories for select to authenticated
  using (organisation_id in (select private.org_ids_with('masters.view'))
         or organisation_id in (select private.org_ids_with('masters.edit')));
create policy "Masters editors can add item categories"
  on public.item_categories for insert to authenticated
  with check (organisation_id in (select private.org_ids_with('masters.edit')));
create policy "Masters editors can edit item categories"
  on public.item_categories for update to authenticated
  using (organisation_id in (select private.org_ids_with('masters.edit')))
  with check (organisation_id in (select private.org_ids_with('masters.edit')));

create policy "Masters viewers can read items"
  on public.items for select to authenticated
  using (organisation_id in (select private.org_ids_with('masters.view'))
         or organisation_id in (select private.org_ids_with('masters.edit')));
create policy "Masters editors can add items"
  on public.items for insert to authenticated
  with check (organisation_id in (select private.org_ids_with('masters.edit')));
create policy "Masters editors can edit items"
  on public.items for update to authenticated
  using (organisation_id in (select private.org_ids_with('masters.edit')))
  with check (organisation_id in (select private.org_ids_with('masters.edit')));

create policy "Masters viewers can read pack sizes"
  on public.item_pack_sizes for select to authenticated
  using (organisation_id in (select private.org_ids_with('masters.view'))
         or organisation_id in (select private.org_ids_with('masters.edit')));
create policy "Masters editors can add pack sizes"
  on public.item_pack_sizes for insert to authenticated
  with check (organisation_id in (select private.org_ids_with('masters.edit')));
create policy "Masters editors can edit pack sizes"
  on public.item_pack_sizes for update to authenticated
  using (organisation_id in (select private.org_ids_with('masters.edit')))
  with check (organisation_id in (select private.org_ids_with('masters.edit')));

create policy "Masters viewers can read vendors"
  on public.vendors for select to authenticated
  using (organisation_id in (select private.org_ids_with('masters.view'))
         or organisation_id in (select private.org_ids_with('masters.edit')));
create policy "Masters editors can add vendors"
  on public.vendors for insert to authenticated
  with check (organisation_id in (select private.org_ids_with('masters.edit')));
create policy "Masters editors can edit vendors"
  on public.vendors for update to authenticated
  using (organisation_id in (select private.org_ids_with('masters.edit')))
  with check (organisation_id in (select private.org_ids_with('masters.edit')));

create policy "Masters viewers can read vendor prices"
  on public.vendor_items for select to authenticated
  using (organisation_id in (select private.org_ids_with('masters.view'))
         or organisation_id in (select private.org_ids_with('masters.edit')));
create policy "Masters editors can add vendor prices"
  on public.vendor_items for insert to authenticated
  with check (organisation_id in (select private.org_ids_with('masters.edit')));
create policy "Masters editors can edit vendor prices"
  on public.vendor_items for update to authenticated
  using (organisation_id in (select private.org_ids_with('masters.edit')))
  with check (organisation_id in (select private.org_ids_with('masters.edit')));

-- Outlet settings: people see their own outlets' settings; masters editors
-- set them for every outlet.
create policy "Members can read settings of their outlets"
  on public.item_outlet_settings for select to authenticated
  using (outlet_id in (select private.outlet_ids_with('masters.view'))
         or organisation_id in (select private.org_ids_with('masters.edit')));
create policy "Masters editors can add outlet settings"
  on public.item_outlet_settings for insert to authenticated
  with check (organisation_id in (select private.org_ids_with('masters.edit')));
create policy "Masters editors can edit outlet settings"
  on public.item_outlet_settings for update to authenticated
  using (organisation_id in (select private.org_ids_with('masters.edit')))
  with check (organisation_id in (select private.org_ids_with('masters.edit')));
