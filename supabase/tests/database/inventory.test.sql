-- Inventory schema tests (pgTAP). Run with: supabase test db
-- Everything runs in one transaction and is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(59);

-- ---------------------------------------------------------------------------
-- Setup (as postgres): two organisations, three people
--   alice  owner of org A (outlets A1, A2)
--   bob    owner of org B
--   sam    storekeeper of org A, outlet A1 only
-- ---------------------------------------------------------------------------
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('11111111-1111-1111-1111-111111111111', 'alice@example.com', now(), '{"full_name":"Alice"}'),
  ('22222222-2222-2222-2222-222222222222', 'bob@example.com',   now(), '{"full_name":"Bob"}'),
  ('33333333-3333-3333-3333-333333333333', 'sam@example.com',   now(), '{"full_name":"Sam"}');

insert into public.organisations (id, name) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Alice Biryani House'),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'Bob Cafe');

select private.create_default_roles(id) from public.organisations;
select private.create_default_item_categories('aaaaaaaa-0000-0000-0000-000000000001');

insert into public.outlets (id, organisation_id, name) values
  ('aaaaaaaa-0000-0000-0000-0000000000a1', 'aaaaaaaa-0000-0000-0000-000000000001', 'Anna Nagar'),
  ('aaaaaaaa-0000-0000-0000-0000000000a2', 'aaaaaaaa-0000-0000-0000-000000000001', 'T Nagar'),
  ('bbbbbbbb-0000-0000-0000-0000000000b1', 'bbbbbbbb-0000-0000-0000-000000000001', 'Bob Main');

insert into public.storage_locations (id, organisation_id, outlet_id, name, kind) values
  ('aaaaaaaa-0000-0000-0001-0000000000a1', 'aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'Main store', 'store'),
  ('aaaaaaaa-0000-0000-0002-0000000000a1', 'aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'Kitchen', 'kitchen'),
  ('aaaaaaaa-0000-0000-0001-0000000000a2', 'aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000a2', 'Main store', 'store'),
  ('bbbbbbbb-0000-0000-0001-0000000000b1', 'bbbbbbbb-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-0000000000b1', 'Store', 'store');

insert into public.memberships (organisation_id, user_id, role_id, all_outlets)
select r.organisation_id, u.id, r.id, true
from public.roles r
join (values ('aaaaaaaa-0000-0000-0000-000000000001'::uuid, '11111111-1111-1111-1111-111111111111'::uuid),
             ('bbbbbbbb-0000-0000-0000-000000000001'::uuid, '22222222-2222-2222-2222-222222222222'::uuid))
  as u(org, id) on u.org = r.organisation_id
where r.key = 'owner';

insert into public.memberships (id, organisation_id, user_id, role_id, all_outlets)
select 'cccccccc-0000-0000-0000-000000000003', r.organisation_id, '33333333-3333-3333-3333-333333333333', r.id, false
from public.roles r
where r.organisation_id = 'aaaaaaaa-0000-0000-0000-000000000001' and r.key = 'storekeeper';

insert into public.membership_outlets (organisation_id, membership_id, outlet_id) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-0000000000a1');

-- ---------------------------------------------------------------------------
-- A. Defaults and sync markers
-- ---------------------------------------------------------------------------
select is((select count(*)::int from public.roles where organisation_id = 'aaaaaaaa-0000-0000-0000-000000000001'),
          7, 'a new organisation gets 7 default roles');

select is((select count(*)::int from public.role_permissions rp join public.roles r on r.id = rp.role_id
           where r.organisation_id = 'aaaaaaaa-0000-0000-0000-000000000001' and r.key = 'admin'),
          17, 'admin gets every permission except owner-only ones');

select is((select count(*)::int from public.role_permissions rp join public.roles r on r.id = rp.role_id
           where r.organisation_id = 'aaaaaaaa-0000-0000-0000-000000000001' and r.key = 'storekeeper'),
          6, 'storekeeper gets its 6 default permissions');

select is((select count(*)::int from public.units), 6, 'six shared units are seeded');

select ok((select sync_version from public.organisations where id = 'aaaaaaaa-0000-0000-0000-000000000001') > 0,
          'inserts stamp a sync_version');

create temp table t_version as
  select sync_version as v from public.organisations where id = 'aaaaaaaa-0000-0000-0000-000000000001';
update public.organisations set legal_name = 'Alice Foods Pvt Ltd' where id = 'aaaaaaaa-0000-0000-0000-000000000001';
select ok((select sync_version from public.organisations where id = 'aaaaaaaa-0000-0000-0000-000000000001')
          > (select v from t_version), 'updates move sync_version forward');

-- ---------------------------------------------------------------------------
-- B. Masters, as alice (owner)
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims to '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';

select lives_ok($$
  insert into public.items (organisation_id, name, base_unit, category_id)
  values ('aaaaaaaa-0000-0000-0000-000000000001', 'Tomato', 'g',
          (select id from public.item_categories where name = 'Vegetables'))
$$, 'owner can add an item');

select throws_ok($$
  insert into public.items (organisation_id, name, base_unit)
  values ('aaaaaaaa-0000-0000-0000-000000000001', 'Rice', 'kg')
$$, '23514', null, 'an item''s base unit must be g, ml or pcs');

select lives_ok($$
  insert into public.item_pack_sizes (organisation_id, item_id, name, quantity_in_base)
  values ('aaaaaaaa-0000-0000-0000-000000000001', (select id from public.items where name = 'Tomato'), 'Crate', 12000)
$$, 'owner can add a 12 kg crate pack size');

select lives_ok($$
  insert into public.vendors (organisation_id, name, phone)
  values ('aaaaaaaa-0000-0000-0000-000000000001', 'Koyambedu Fresh', '9840000000')
$$, 'owner can add a vendor');

select lives_ok($$
  insert into public.vendor_items (organisation_id, vendor_id, item_id, pack_size_id, rate, valid_from)
  values ('aaaaaaaa-0000-0000-0000-000000000001',
          (select id from public.vendors where name = 'Koyambedu Fresh'),
          (select id from public.items where name = 'Tomato'),
          (select id from public.item_pack_sizes where name = 'Crate'),
          480, date '2026-11-01')
$$, 'owner can add a vendor rate per crate');

select is((select purchase_qty_in_base from public.vendor_items where rate = 480), 12000::numeric,
          'a crate rate is converted to 12000 g');

select is((select rate_per_base from public.vendor_items where rate = 480), 0.040000::numeric(18,6),
          'rate per gram is 480 / 12000 = 0.04');

select lives_ok($$
  insert into public.vendor_items (organisation_id, vendor_id, item_id, pack_size_id, rate, valid_from)
  values ('aaaaaaaa-0000-0000-0000-000000000001',
          (select id from public.vendors where name = 'Koyambedu Fresh'),
          (select id from public.items where name = 'Tomato'),
          (select id from public.item_pack_sizes where name = 'Crate'),
          540, date '2026-11-15')
$$, 'a new rate can be added from a later date');

select is((select valid_to from public.vendor_items where rate = 480), date '2026-11-14',
          'the new rate closes the previous one the day before');

select throws_ok($$
  insert into public.vendor_items (organisation_id, vendor_id, item_id, price_unit, rate)
  values ('aaaaaaaa-0000-0000-0000-000000000001',
          (select id from public.vendors where name = 'Koyambedu Fresh'),
          (select id from public.items where name = 'Tomato'), 'pcs', 5)
$$, '22023', null, 'a gram item cannot be priced per piece without a conversion');

select lives_ok($$
  insert into public.items (organisation_id, name, base_unit, alt_unit, alt_per_base)
  values ('aaaaaaaa-0000-0000-0000-000000000001', 'Sunflower oil', 'ml', 'g', 0.91)
$$, 'an item can carry a conversion to another unit family');

select lives_ok($$
  insert into public.vendor_items (organisation_id, vendor_id, item_id, price_unit, rate)
  values ('aaaaaaaa-0000-0000-0000-000000000001',
          (select id from public.vendors where name = 'Koyambedu Fresh'),
          (select id from public.items where name = 'Sunflower oil'), 'kg', 150)
$$, 'oil held in ml can be priced per kg');

select is((select purchase_qty_in_base from public.vendor_items where rate = 150), 1098.901099::numeric,
          '1 kg of oil at 0.91 g/ml is 1098.9 ml');

-- ---------------------------------------------------------------------------
-- C. Isolation and permissions
-- ---------------------------------------------------------------------------
set local request.jwt.claims to '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';

select is((select count(*)::int from public.items where organisation_id = 'aaaaaaaa-0000-0000-0000-000000000001'),
          0, 'another organisation''s owner sees none of its items');

select throws_ok($$
  insert into public.items (organisation_id, name, base_unit)
  values ('aaaaaaaa-0000-0000-0000-000000000001', 'Intruder', 'g')
$$, '42501', null, 'another organisation''s owner cannot add items to it');

set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';

select is((select count(*)::int from public.items), 2, 'storekeeper can read items (masters.view)');

select throws_ok($$
  insert into public.items (organisation_id, name, base_unit)
  values ('aaaaaaaa-0000-0000-0000-000000000001', 'Garlic', 'g')
$$, '42501', null, 'storekeeper cannot add items (no masters.edit)');

reset role;
set local role anon;
select throws_ok($$ select count(*) from public.items $$, '42501', null, 'signed-out visitors cannot read items');
reset role;

-- ---------------------------------------------------------------------------
-- D. Stock ledger (posting functions come next; entries inserted as postgres)
-- ---------------------------------------------------------------------------
select lives_ok($$
  insert into public.stock_ledger (id, organisation_id, outlet_id, location_id, item_id, movement_type,
                                   quantity, unit_cost, source_type)
  values ('aaaaaaaa-0000-0006-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001',
          'aaaaaaaa-0000-0000-0000-0000000000a1', 'aaaaaaaa-0000-0000-0001-0000000000a1',
          (select id from public.items where name = 'Tomato'), 'opening', 24000, 0.04, 'opening')
$$, 'opening stock is recorded as a positive movement');

select throws_ok($$
  update public.stock_ledger set quantity = 1 where id = 'aaaaaaaa-0000-0006-0000-000000000001'
$$, '55000', null, 'ledger entries cannot be updated');

select throws_ok($$
  delete from public.stock_ledger where id = 'aaaaaaaa-0000-0006-0000-000000000001'
$$, '55000', null, 'ledger entries cannot be deleted');

select throws_ok($$
  insert into public.stock_ledger (organisation_id, outlet_id, location_id, item_id, movement_type,
                                   quantity, unit_cost, source_type)
  values ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000a1',
          'aaaaaaaa-0000-0000-0001-0000000000a1', (select id from public.items where name = 'Tomato'),
          'wastage', 500, 0.04, 'wastage')
$$, '23514', null, 'wastage must be a negative movement');

insert into public.stock_ledger (id, organisation_id, outlet_id, location_id, item_id, movement_type,
                                 quantity, unit_cost, source_type)
values ('aaaaaaaa-0000-0006-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001',
        'aaaaaaaa-0000-0000-0000-0000000000a1', 'aaaaaaaa-0000-0000-0001-0000000000a1',
        (select id from public.items where name = 'Tomato'), 'wastage', -1000, 0.04, 'wastage');

select throws_ok($$
  insert into public.stock_ledger (organisation_id, outlet_id, location_id, item_id, movement_type,
                                   quantity, unit_cost, source_type, reverses_entry_id)
  values ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000a1',
          'aaaaaaaa-0000-0000-0001-0000000000a1', (select id from public.items where name = 'Tomato'),
          'wastage', 900, 0.04, 'reversal', 'aaaaaaaa-0000-0006-0000-000000000002')
$$, '22023', null, 'a reversal must cancel the exact quantity');

select lives_ok($$
  insert into public.stock_ledger (organisation_id, outlet_id, location_id, item_id, movement_type,
                                   quantity, unit_cost, source_type, reverses_entry_id)
  values ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000a1',
          'aaaaaaaa-0000-0000-0001-0000000000a1', (select id from public.items where name = 'Tomato'),
          'wastage', 1000, 0.04, 'reversal', 'aaaaaaaa-0000-0006-0000-000000000002')
$$, 'an exact reversal is accepted');

select throws_ok($$
  insert into public.stock_ledger (organisation_id, outlet_id, location_id, item_id, movement_type,
                                   quantity, unit_cost, source_type, reverses_entry_id)
  values ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000a1',
          'aaaaaaaa-0000-0000-0001-0000000000a1', (select id from public.items where name = 'Tomato'),
          'wastage', 1000, 0.04, 'reversal', 'aaaaaaaa-0000-0006-0000-000000000002')
$$, '23505', null, 'an entry can be reversed only once');

insert into public.stock_ledger (organisation_id, outlet_id, location_id, item_id, movement_type,
                                 quantity, unit_cost, source_type)
values ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000a2',
        'aaaaaaaa-0000-0000-0001-0000000000a2', (select id from public.items where name = 'Tomato'),
        'opening', 5000, 0.05, 'opening');

insert into public.item_outlet_settings (organisation_id, outlet_id, item_id, reorder_level, reorder_qty)
values ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000a1',
        (select id from public.items where name = 'Tomato'), 30000, 24000);

set local role authenticated;
set local request.jwt.claims to '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';

select is((select quantity from public.outlet_stock
           where outlet_id = 'aaaaaaaa-0000-0000-0000-0000000000a1'
             and item_id = (select id from public.items where name = 'Tomato')),
          24000::numeric, 'stock on hand is the sum of the ledger (24000 - 1000 + 1000)');

select is((select average_cost from public.outlet_stock
           where outlet_id = 'aaaaaaaa-0000-0000-0000-0000000000a1'
             and item_id = (select id from public.items where name = 'Tomato')),
          0.040000::numeric, 'average cost is value / quantity');

select ok((select below_reorder_level from public.outlet_stock
           where outlet_id = 'aaaaaaaa-0000-0000-0000-0000000000a1'
             and item_id = (select id from public.items where name = 'Tomato')),
          '24 kg against a 30 kg reorder level is flagged');

select is((select count(*)::int from public.outlet_stock where item_id = (select id from public.items where name = 'Tomato')),
          2, 'the owner sees stock in both outlets');

set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';

select is((select count(*)::int from public.stock_ledger
           where outlet_id = 'aaaaaaaa-0000-0000-0000-0000000000a2'),
          0, 'a storekeeper of A1 sees no ledger rows of A2');

select is((select count(*)::int from public.stock_ledger
           where outlet_id = 'aaaaaaaa-0000-0000-0000-0000000000a1'),
          3, 'a storekeeper of A1 sees the ledger of A1');

reset role;

select throws_ok($$
  update public.items set base_unit = 'ml' where name = 'Tomato'
$$, '55000', null, 'an item with stock movements cannot change its base unit');

-- ---------------------------------------------------------------------------
-- E. Recipes, as alice
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims to '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';

insert into public.items (organisation_id, name, base_unit, item_type, default_yield_pct) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Onion', 'g', 'raw', 85),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Paneer', 'g', 'raw', 100),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Gravy base', 'g', 'prep', 100),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Masala paste', 'g', 'prep', 100);

insert into public.recipes (organisation_id, prep_item_id, version, yield_qty)
values ('aaaaaaaa-0000-0000-0000-000000000001', (select id from public.items where name = 'Gravy base'), 1, 5000),
       ('aaaaaaaa-0000-0000-0000-000000000001', (select id from public.items where name = 'Masala paste'), 1, 2000);

select lives_ok($$
  insert into public.recipe_lines (organisation_id, recipe_id, item_id, quantity, unit)
  values ('aaaaaaaa-0000-0000-0000-000000000001',
          (select r.id from public.recipes r join public.items i on i.id = r.prep_item_id where i.name = 'Gravy base'),
          (select id from public.items where name = 'Onion'), 1.2, 'kg')
$$, 'a recipe line can be entered in kg');

select is((select rl.quantity_in_base from public.recipe_lines rl join public.items i on i.id = rl.item_id
           where i.name = 'Onion'),
          1411.764706::numeric, '1.2 kg of onion at 85% yield deducts 1411.76 g gross');

select throws_ok($$
  insert into public.recipe_lines (organisation_id, recipe_id, item_id, quantity, unit)
  values ('aaaaaaaa-0000-0000-0000-000000000001',
          (select r.id from public.recipes r join public.items i on i.id = r.prep_item_id where i.name = 'Gravy base'),
          (select id from public.items where name = 'Paneer'), 100, 'ml')
$$, '22023', null, 'a gram item cannot be used in ml');

select lives_ok($$
  insert into public.recipe_lines (organisation_id, recipe_id, item_id, quantity, unit)
  values ('aaaaaaaa-0000-0000-0000-000000000001',
          (select r.id from public.recipes r join public.items i on i.id = r.prep_item_id where i.name = 'Gravy base'),
          (select id from public.items where name = 'Masala paste'), 200, 'g')
$$, 'a prep item can be an ingredient of another prep recipe');

select throws_ok($$
  insert into public.recipe_lines (organisation_id, recipe_id, item_id, quantity, unit)
  values ('aaaaaaaa-0000-0000-0000-000000000001',
          (select r.id from public.recipes r join public.items i on i.id = r.prep_item_id where i.name = 'Masala paste'),
          (select id from public.items where name = 'Gravy base'), 50, 'g')
$$, '22023', null, 'a loop between prep recipes is refused');

select throws_ok($$
  insert into public.recipes (organisation_id, prep_item_id, version, yield_qty)
  values ('aaaaaaaa-0000-0000-0000-000000000001', (select id from public.items where name = 'Onion'), 1, 1000)
$$, '22023', null, 'a prep recipe must be for a prep item');

select lives_ok($$
  update public.recipes set status = 'active'
  where prep_item_id = (select id from public.items where name = 'Gravy base') and version = 1
$$, 'a draft recipe can be activated');

select throws_ok($$
  insert into public.recipe_lines (organisation_id, recipe_id, item_id, quantity, unit)
  values ('aaaaaaaa-0000-0000-0000-000000000001',
          (select r.id from public.recipes r join public.items i on i.id = r.prep_item_id
           where i.name = 'Gravy base' and r.version = 1),
          (select id from public.items where name = 'Paneer'), 100, 'g')
$$, '42501', null, 'lines of an active recipe cannot change');

select throws_ok($$
  update public.recipes set yield_qty = 6000
  where prep_item_id = (select id from public.items where name = 'Gravy base') and version = 1
$$, '55000', null, 'an active recipe cannot be edited');

insert into public.recipes (organisation_id, prep_item_id, version, yield_qty)
values ('aaaaaaaa-0000-0000-0000-000000000001', (select id from public.items where name = 'Gravy base'), 2, 5500);
update public.recipes set status = 'active'
where prep_item_id = (select id from public.items where name = 'Gravy base') and version = 2;

select is((select status from public.recipes
           where prep_item_id = (select id from public.items where name = 'Gravy base') and version = 1),
          'retired', 'activating version 2 retires version 1');

-- ---------------------------------------------------------------------------
-- F. Sales entry
-- ---------------------------------------------------------------------------
select lives_ok($$
  insert into public.sales_imports (organisation_id, outlet_id, business_date, source)
  values ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000a1', date '2026-11-22', 'manual')
$$, 'owner can start a manual sales entry');

select is((select idempotency_key from public.sales_imports where business_date = date '2026-11-22'),
          'manual:2026-11-22:', 'the import key is source, date and reference');

select throws_ok($$
  insert into public.sales_imports (organisation_id, outlet_id, business_date, source)
  values ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000a1', date '2026-11-22', 'manual')
$$, '23505', null, 'the same sales cannot be entered twice');

set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';

select throws_ok($$
  insert into public.sales_imports (organisation_id, outlet_id, business_date, source)
  values ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000a1', date '2026-11-23', 'manual')
$$, '42501', null, 'a storekeeper cannot enter sales');

-- ---------------------------------------------------------------------------
-- G. Counts and deletion records, as sam
-- ---------------------------------------------------------------------------
select lives_ok($$
  insert into public.stock_counts (organisation_id, outlet_id, location_id, note)
  values ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000a1',
          'aaaaaaaa-0000-0000-0001-0000000000a1', 'Weekly count')
$$, 'storekeeper can start a count at their outlet');

select lives_ok($$
  insert into public.stock_count_lines (organisation_id, outlet_id, count_id, item_id, location_id, counted_qty)
  values ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000a1',
          (select id from public.stock_counts where note = 'Weekly count'),
          (select id from public.items where name = 'Tomato'),
          'aaaaaaaa-0000-0000-0001-0000000000a1', 23000)
$$, 'storekeeper can enter a counted quantity');

select is((select counted_by from public.stock_count_lines where counted_qty = 23000),
          '33333333-3333-3333-3333-333333333333'::uuid, 'the counter is recorded automatically');

select throws_ok($$
  insert into public.stock_counts (organisation_id, outlet_id, note)
  values ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000a2', 'Not my outlet')
$$, '42501', null, 'storekeeper cannot start a count at another outlet');

delete from public.stock_count_lines where counted_qty = 23000;

reset role;

select is((select count(*)::int from private.sync_tombstones where table_name = 'stock_count_lines'),
          1, 'a deleted line leaves a tombstone so the deletion syncs');

-- ---------------------------------------------------------------------------
-- H. Sync status visibility
-- ---------------------------------------------------------------------------
insert into public.sync_nodes (organisation_id, outlet_id, name)
values ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'Anna Nagar counter PC');

set local role authenticated;
set local request.jwt.claims to '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
select is((select count(*)::int from public.sync_nodes), 1, 'the owner sees outlet sync status');

set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
select is((select count(*)::int from public.sync_nodes), 0, 'a storekeeper does not see sync status');

reset role;

select * from finish();
rollback;
