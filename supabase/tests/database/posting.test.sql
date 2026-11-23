-- Stock posting tests (pgTAP). Run with: supabase test db
-- Everything runs in one transaction and is rolled back.
--
-- Walks one outlet (Anna Nagar) through a day: opening stock, a transfer to
-- the kitchen, wastage, a prep batch, a day's sales and a count, checking
-- stock on hand after each step.
begin;
create extension if not exists pgtap with schema extensions;

select plan(72);

-- ---------------------------------------------------------------------------
-- Setup (as postgres)
--   alice  owner of org A (outlets A1 Anna Nagar, A2 T Nagar)
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

-- Items. Gravy base is made in batches and kept in stock; spice mix is made
-- to order, so a sale deducts its ingredients.
insert into public.items (organisation_id, name, base_unit, item_type, deduct_ingredients_on_sale) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Rice',       'g',  'raw',  false),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Chicken',    'g',  'raw',  false),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Oil',        'ml', 'raw',  false),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Onion',      'g',  'raw',  false),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Tomato',     'g',  'raw',  false),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Gravy base', 'g',  'prep', false),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Spice mix',  'g',  'prep', true);

insert into public.vendors (organisation_id, name) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Koyambedu Fresh');

-- Tomato at ₹40 a kg, i.e. ₹0.04 a gram.
insert into public.vendor_items (organisation_id, vendor_id, item_id, price_unit, rate)
select 'aaaaaaaa-0000-0000-0000-000000000001', v.id, i.id, 'kg', 40
from public.vendors v, public.items i
where v.name = 'Koyambedu Fresh' and i.name = 'Tomato';

insert into public.menu_items (id, organisation_id, name, selling_price) values
  ('aaaaaaaa-2000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'Chicken biryani', 250),
  ('aaaaaaaa-2000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001', 'Lime soda', 60);

-- Recipes: gravy base (5 kg a batch), spice mix (100 g), chicken biryani (1 plate).
insert into public.recipes (id, organisation_id, prep_item_id, menu_item_id, yield_qty)
select 'aaaaaaaa-3000-0000-0000-000000000001'::uuid, organisation_id, id, null::uuid, 5000
from public.items where name = 'Gravy base'
union all
select 'aaaaaaaa-3000-0000-0000-000000000002'::uuid, organisation_id, id, null::uuid, 100
from public.items where name = 'Spice mix'
union all
select 'aaaaaaaa-3000-0000-0000-000000000003'::uuid, 'aaaaaaaa-0000-0000-0000-000000000001', null, 'aaaaaaaa-2000-0000-0000-000000000001', 1;

insert into public.recipe_lines (organisation_id, recipe_id, item_id, quantity, unit)
select 'aaaaaaaa-0000-0000-0000-000000000001', l.recipe_id::uuid, i.id, l.quantity, l.unit
from (values
  ('aaaaaaaa-3000-0000-0000-000000000001', 'Onion',      2,   'kg'),
  ('aaaaaaaa-3000-0000-0000-000000000001', 'Oil',        0.5, 'l'),
  ('aaaaaaaa-3000-0000-0000-000000000002', 'Oil',        20,  'ml'),
  ('aaaaaaaa-3000-0000-0000-000000000002', 'Onion',      80,  'g'),
  ('aaaaaaaa-3000-0000-0000-000000000003', 'Rice',       150, 'g'),
  ('aaaaaaaa-3000-0000-0000-000000000003', 'Chicken',    200, 'g'),
  ('aaaaaaaa-3000-0000-0000-000000000003', 'Gravy base', 100, 'g'),
  ('aaaaaaaa-3000-0000-0000-000000000003', 'Spice mix',  10,  'g')
) as l(recipe_id, item_name, quantity, unit)
join public.items i on i.name = l.item_name and i.organisation_id = 'aaaaaaaa-0000-0000-0000-000000000001';

update public.recipes set status = 'active' where organisation_id = 'aaaaaaaa-0000-0000-0000-000000000001';

-- Test helpers: document ids by key, and lookups by name.
create temp table t_ids (k text primary key, id uuid not null);
grant select, insert on t_ids to authenticated;

create function pg_temp.ref(p_key text) returns uuid language sql security definer as
  $$ select id from t_ids where k = p_key $$;
create function pg_temp.item(p_name text) returns uuid language sql security definer as
  $$ select id from public.items where organisation_id = 'aaaaaaaa-0000-0000-0000-000000000001' and name = p_name $$;
create function pg_temp.outlet(p_key text) returns uuid language sql immutable as
  $$ select case p_key when 'A1' then 'aaaaaaaa-0000-0000-0000-0000000000a1'::uuid
                       when 'A2' then 'aaaaaaaa-0000-0000-0000-0000000000a2'::uuid end $$;
create function pg_temp.loc(p_key text) returns uuid language sql immutable as
  $$ select case p_key when 'A1 store'   then 'aaaaaaaa-0000-0000-0001-0000000000a1'::uuid
                       when 'A1 kitchen' then 'aaaaaaaa-0000-0000-0002-0000000000a1'::uuid
                       when 'A2 store'   then 'aaaaaaaa-0000-0000-0001-0000000000a2'::uuid end $$;
create function pg_temp.on_hand(p_location text, p_item text) returns numeric language sql security definer as
  $$ select coalesce(sum(l.quantity), 0) from public.stock_ledger l
     where l.location_id = pg_temp.loc(p_location) and l.item_id = pg_temp.item(p_item) $$;

-- ---------------------------------------------------------------------------
-- 0. The new approval permission
-- ---------------------------------------------------------------------------
select is((select count(*)::int from public.role_permissions rp join public.roles r on r.id = rp.role_id
           where r.organisation_id = 'aaaaaaaa-0000-0000-0000-000000000001' and r.key = 'manager'
             and rp.permission_code = 'adjustments.approve'),
          1, 'managers can approve adjustments by default');

select is((select count(*)::int from public.role_permissions rp join public.roles r on r.id = rp.role_id
           where r.organisation_id = 'aaaaaaaa-0000-0000-0000-000000000001' and r.key = 'storekeeper'
             and rp.permission_code = 'adjustments.approve'),
          0, 'storekeepers cannot approve adjustments by default');

-- ---------------------------------------------------------------------------
-- A. Opening stock and adjustments
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';

select lives_ok($$
  with a as (
    insert into public.stock_adjustments (organisation_id, outlet_id, location_id, item_id, kind, quantity, unit_cost, reason)
    values ('aaaaaaaa-0000-0000-0000-000000000001', pg_temp.outlet('A1'), pg_temp.loc('A1 store'),
            pg_temp.item('Rice'), 'opening', 10000, 0.08, 'Opening stock')
    returning id)
  insert into t_ids select 'opening_rice', id from a
$$, 'a storekeeper can request opening stock');

select throws_ok($$ select public.decide_stock_adjustment(pg_temp.ref('opening_rice'), true) $$,
  '42501', null, 'a storekeeper cannot approve opening stock');

set local request.jwt.claims to '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';

select is(public.decide_stock_adjustment(pg_temp.ref('opening_rice'), true), 'posted',
          'the owner approves the opening stock');

select is(pg_temp.on_hand('A1 store', 'Rice'), 10000::numeric, 'the main store now holds 10 kg of rice');

select is((select value from public.stock_ledger where source_id = pg_temp.ref('opening_rice')), 800.00::numeric,
          'opening stock is valued at 10000 g × ₹0.08 = ₹800');

select throws_ok($$ select public.decide_stock_adjustment(pg_temp.ref('opening_rice'), true) $$,
  '55000', null, 'an adjustment cannot be decided twice');

insert into public.stock_adjustments (organisation_id, outlet_id, location_id, item_id, kind, quantity, unit_cost, reason)
values
  ('aaaaaaaa-0000-0000-0000-000000000001', pg_temp.outlet('A1'), pg_temp.loc('A1 kitchen'), pg_temp.item('Chicken'), 'opening', 5000, 0.30, 'Opening stock'),
  ('aaaaaaaa-0000-0000-0000-000000000001', pg_temp.outlet('A1'), pg_temp.loc('A1 kitchen'), pg_temp.item('Oil'), 'opening', 3000, 0.15, 'Opening stock'),
  ('aaaaaaaa-0000-0000-0000-000000000001', pg_temp.outlet('A1'), pg_temp.loc('A1 kitchen'), pg_temp.item('Onion'), 'opening', 10000, 0.04, 'Opening stock');

select lives_ok($$
  select public.decide_stock_adjustment(id, true) from public.stock_adjustments where status = 'pending'
$$, 'the owner approves the kitchen''s opening stock');

set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';

with a as (
  insert into public.stock_adjustments (organisation_id, outlet_id, location_id, item_id, quantity, reason)
  values ('aaaaaaaa-0000-0000-0000-000000000001', pg_temp.outlet('A1'), pg_temp.loc('A1 store'),
          pg_temp.item('Rice'), -500, 'Spilled bag')
  returning id)
insert into t_ids select 'adj_spill', id from a;

set local request.jwt.claims to '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';

select is(public.decide_stock_adjustment(pg_temp.ref('adj_spill'), false, 'Bag was found'), 'rejected',
          'the owner can reject an adjustment');

select is((select count(*)::int from public.stock_ledger where source_id = pg_temp.ref('adj_spill')), 0,
          'a rejected adjustment writes nothing to the ledger');

set local request.jwt.claims to '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';

select throws_ok($$ select public.decide_stock_adjustment(pg_temp.ref('adj_spill'), true) $$,
  '42501', null, 'another organisation''s owner cannot decide an adjustment');

-- ---------------------------------------------------------------------------
-- B. Transfers: main store to kitchen
-- ---------------------------------------------------------------------------
set local request.jwt.claims to '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';

with t as (
  insert into public.stock_transfers (organisation_id, outlet_id, from_location_id, to_location_id, note)
  values ('aaaaaaaa-0000-0000-0000-000000000001', pg_temp.outlet('A1'), pg_temp.loc('A1 store'), pg_temp.loc('A1 kitchen'), 'Morning issue')
  returning id)
insert into t_ids select 'transfer1', id from t;

insert into public.stock_transfer_lines (organisation_id, outlet_id, transfer_id, item_id, quantity_sent)
values ('aaaaaaaa-0000-0000-0000-000000000001', pg_temp.outlet('A1'), pg_temp.ref('transfer1'), pg_temp.item('Rice'), 4000);

select lives_ok($$ select public.send_stock_transfer(pg_temp.ref('transfer1')) $$, 'a draft transfer can be sent');

select is(pg_temp.on_hand('A1 store', 'Rice'), 6000::numeric, 'sending takes 4 kg of rice out of the main store');

select throws_ok($$ select public.send_stock_transfer(pg_temp.ref('transfer1')) $$,
  '55000', null, 'a transfer cannot be sent twice');

select throws_ok($$
  select public.receive_stock_transfer(pg_temp.ref('transfer1'), jsonb_build_array(jsonb_build_object(
    'line_id', (select id from public.stock_transfer_lines where transfer_id = pg_temp.ref('transfer1')),
    'quantity', 4500)))
$$, '22023', null, 'more than was sent cannot be received');

select lives_ok($$
  select public.receive_stock_transfer(pg_temp.ref('transfer1'), jsonb_build_array(jsonb_build_object(
    'line_id', (select id from public.stock_transfer_lines where transfer_id = pg_temp.ref('transfer1')),
    'quantity', 3900)))
$$, 'a transfer can be received short');

select is(pg_temp.on_hand('A1 kitchen', 'Rice'), 3900::numeric, 'the kitchen receives the 3.9 kg that arrived');

select is((select unit_cost from public.stock_ledger
           where source_id = pg_temp.ref('transfer1') and movement_type = 'transfer_in'),
          0.08::numeric, 'stock arrives at the cost it left at');

select is((select status from public.stock_transfers where id = pg_temp.ref('transfer1')), 'received',
          'the transfer is marked received');

select throws_ok($$ select public.cancel_stock_transfer(pg_temp.ref('transfer1')) $$,
  '55000', null, 'a received transfer cannot be cancelled');

with t as (
  insert into public.stock_transfers (organisation_id, outlet_id, from_location_id, to_location_id)
  values ('aaaaaaaa-0000-0000-0000-000000000001', pg_temp.outlet('A1'), pg_temp.loc('A1 store'), pg_temp.loc('A1 kitchen'))
  returning id)
insert into t_ids select 'transfer2', id from t;

insert into public.stock_transfer_lines (organisation_id, outlet_id, transfer_id, item_id, quantity_sent)
values ('aaaaaaaa-0000-0000-0000-000000000001', pg_temp.outlet('A1'), pg_temp.ref('transfer2'), pg_temp.item('Rice'), 1000);

select public.send_stock_transfer(pg_temp.ref('transfer2'));

select lives_ok($$ select public.cancel_stock_transfer(pg_temp.ref('transfer2'), 'Wrong item') $$,
  'a sent transfer can be cancelled');

select is(pg_temp.on_hand('A1 store', 'Rice'), 6000::numeric, 'cancelling puts the rice back in the main store');

select is((select count(*)::int from public.stock_ledger
           where source_id = pg_temp.ref('transfer2') and reverses_entry_id is not null),
          1, 'cancelling records a reversing entry instead of deleting');

-- ---------------------------------------------------------------------------
-- C. Wastage and staff meals
-- ---------------------------------------------------------------------------
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';

select lives_ok($$
  insert into t_ids select 'waste_onion',
    public.post_wastage(pg_temp.outlet('A1'), pg_temp.loc('A1 kitchen'), pg_temp.item('Onion'), 0.5, 'spoiled', 'kg')
$$, 'a storekeeper can record wastage in kilograms');

select is(pg_temp.on_hand('A1 kitchen', 'Onion'), 9500::numeric, '500 g of onion comes out of the kitchen');

select is((select value from public.stock_ledger where source_id = pg_temp.ref('waste_onion')), -20.00::numeric,
          'the wastage is valued at the average cost: 500 g × ₹0.04 = ₹20');

insert into t_ids select 'staff_meal',
  public.post_wastage(pg_temp.outlet('A1'), pg_temp.loc('A1 kitchen'), pg_temp.item('Rice'), 300, 'staff_meal');

select is((select movement_type from public.stock_ledger where source_id = pg_temp.ref('staff_meal')), 'staff_meal',
          'a staff meal is recorded as its own movement type');

select throws_ok($$
  select public.post_wastage(pg_temp.outlet('A2'), pg_temp.loc('A2 store'), pg_temp.item('Onion'), 100, 'spoiled')
$$, '42501', null, 'a storekeeper cannot record wastage at an outlet they do not work in');

select throws_ok($$
  select public.post_wastage(pg_temp.outlet('A1'), pg_temp.loc('A1 kitchen'), pg_temp.item('Onion'), 0, 'spoiled')
$$, '22023', null, 'wastage needs a quantity above zero');

select lives_ok($$ select public.void_wastage(pg_temp.ref('waste_onion'), 'Entered twice') $$,
  'a wastage entry can be voided');

select is(pg_temp.on_hand('A1 kitchen', 'Onion'), 10000::numeric, 'voiding puts the onion back');

select throws_ok($$ select public.void_wastage(pg_temp.ref('waste_onion'), 'Again') $$,
  '55000', null, 'a wastage entry cannot be voided twice');

set local request.jwt.claims to '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';

select throws_ok($$
  select public.post_wastage(pg_temp.outlet('A1'), pg_temp.loc('A1 kitchen'), pg_temp.item('Onion'), 100, 'spoiled')
$$, '42501', null, 'another organisation''s owner cannot record wastage here');

set local request.jwt.claims to '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';

insert into t_ids select 'waste_tomato',
  public.post_wastage(pg_temp.outlet('A1'), pg_temp.loc('A1 kitchen'), pg_temp.item('Tomato'), 100, 'spoiled');

select is((select unit_cost from public.stock_ledger where source_id = pg_temp.ref('waste_tomato')), 0.04::numeric,
          'with no stock history, the vendor''s current rate is used as the cost');

-- ---------------------------------------------------------------------------
-- D. Prep production: gravy base
-- ---------------------------------------------------------------------------
select lives_ok($$
  insert into t_ids select 'batch1',
    public.post_prep_batch(pg_temp.outlet('A1'), pg_temp.loc('A1 kitchen'), pg_temp.item('Gravy base'), 2)
$$, 'a cook can record two batches of gravy base');

select is(pg_temp.on_hand('A1 kitchen', 'Onion'), 6000::numeric, 'two batches use 4 kg of onion');
select is(pg_temp.on_hand('A1 kitchen', 'Oil'), 2000::numeric, 'two batches use 1 litre of oil');
select is(pg_temp.on_hand('A1 kitchen', 'Gravy base'), 10000::numeric, 'two batches make 10 kg of gravy base');

select is((select unit_cost from public.stock_ledger
           where source_id = pg_temp.ref('batch1') and movement_type = 'prep_production'),
          0.031::numeric, 'gravy base is costed from its ingredients: (₹160 + ₹150) / 10000 g');

select throws_ok($$
  select public.post_prep_batch(pg_temp.outlet('A1'), pg_temp.loc('A1 kitchen'), pg_temp.item('Rice'), 1)
$$, '22023', null, 'only a prep item can be produced');

insert into t_ids select 'batch2',
  public.post_prep_batch(pg_temp.outlet('A1'), pg_temp.loc('A1 kitchen'), pg_temp.item('Gravy base'), 1);

select lives_ok($$ select public.void_prep_batch(pg_temp.ref('batch2'), 'Recorded by mistake') $$,
  'a prep batch can be voided');

select is(pg_temp.on_hand('A1 kitchen', 'Gravy base'), 10000::numeric,
          'voiding takes the batch out and puts its ingredients back');

select throws_ok($$ select public.void_prep_batch(pg_temp.ref('batch2'), 'Again') $$,
  '55000', null, 'a prep batch cannot be voided twice');

set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';

select throws_ok($$
  select public.post_prep_batch(pg_temp.outlet('A1'), pg_temp.loc('A1 kitchen'), pg_temp.item('Gravy base'), 1)
$$, '42501', null, 'a storekeeper cannot record prep production');

-- ---------------------------------------------------------------------------
-- E. Sales: 10 chicken biryani on 22 Nov
-- ---------------------------------------------------------------------------
set local request.jwt.claims to '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';

with s as (
  insert into public.sales_imports (organisation_id, outlet_id, business_date)
  values ('aaaaaaaa-0000-0000-0000-000000000001', pg_temp.outlet('A1'), date '2026-11-22')
  returning id)
insert into t_ids select 'sales1', id from s;

insert into public.sales_lines (organisation_id, outlet_id, sales_import_id, menu_item_id, item_name, quantity, unit_price, amount)
values ('aaaaaaaa-0000-0000-0000-000000000001', pg_temp.outlet('A1'), pg_temp.ref('sales1'),
        'aaaaaaaa-2000-0000-0000-000000000001', 'Chicken biryani', 10, 250, 2500);

select is(public.post_sales_import(pg_temp.ref('sales1')), 5,
          'posting deducts five stock items (rice, chicken, gravy base, and the spice mix''s oil and onion)');

select is(pg_temp.on_hand('A1 kitchen', 'Rice'), 2100::numeric, '10 plates use 1.5 kg of rice');
select is(pg_temp.on_hand('A1 kitchen', 'Gravy base'), 9000::numeric,
          'gravy base is taken from stock, not re-made from its ingredients');
select is(pg_temp.on_hand('A1 kitchen', 'Onion'), 5920::numeric,
          'the made-to-order spice mix deducts its own onion (10 × 10 g × 80%)');

select is((select count(*)::int from public.stock_ledger where item_id = pg_temp.item('Spice mix')), 0,
          'a made-to-order prep item never appears in the ledger');

select is((select recipe_id from public.sales_lines where sales_import_id = pg_temp.ref('sales1')),
          'aaaaaaaa-3000-0000-0000-000000000003'::uuid, 'each sales line records the recipe version used');

select is((select status from public.sales_imports where id = pg_temp.ref('sales1')), 'posted',
          'the sales entry is marked posted');

select is((select total_amount from public.sales_imports where id = pg_temp.ref('sales1')), 2500.00::numeric,
          'the sales total is filled in on posting');

select is((select max(occurred_at) from public.stock_ledger where source_id = pg_temp.ref('sales1')),
          '2026-11-22 23:59:00+05:30'::timestamptz, 'sales are dated at the end of the business day, India time');

select throws_ok($$ select public.post_sales_import(pg_temp.ref('sales1')) $$,
  '55000', null, 'a sales entry cannot be posted twice');

with s as (
  insert into public.sales_imports (organisation_id, outlet_id, business_date)
  values ('aaaaaaaa-0000-0000-0000-000000000001', pg_temp.outlet('A1'), date '2026-11-23')
  returning id)
insert into t_ids select 'sales_unmatched', id from s;

insert into public.sales_lines (organisation_id, outlet_id, sales_import_id, item_name, quantity)
values ('aaaaaaaa-0000-0000-0000-000000000001', pg_temp.outlet('A1'), pg_temp.ref('sales_unmatched'), 'Mystery dish', 1);

select throws_ok($$ select public.post_sales_import(pg_temp.ref('sales_unmatched')) $$,
  '22023', null, 'sales with lines not matched to a menu item are held');

with s as (
  insert into public.sales_imports (organisation_id, outlet_id, business_date, source_ref)
  values ('aaaaaaaa-0000-0000-0000-000000000001', pg_temp.outlet('A1'), date '2026-11-23', 'bar')
  returning id)
insert into t_ids select 'sales_no_recipe', id from s;

insert into public.sales_lines (organisation_id, outlet_id, sales_import_id, menu_item_id, item_name, quantity)
values ('aaaaaaaa-0000-0000-0000-000000000001', pg_temp.outlet('A1'), pg_temp.ref('sales_no_recipe'),
        'aaaaaaaa-2000-0000-0000-000000000002', 'Lime soda', 4);

select throws_ok($$ select public.post_sales_import(pg_temp.ref('sales_no_recipe')) $$,
  '22023', null, 'sales of a dish with no active recipe are held');

set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';

select throws_ok($$ select public.post_sales_import(pg_temp.ref('sales_unmatched')) $$,
  '42501', null, 'a storekeeper cannot post sales');

set local request.jwt.claims to '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';

select throws_ok($$ select public.void_sales_import(pg_temp.ref('sales1'), 'Not mine') $$,
  '42501', null, 'another organisation''s owner cannot void these sales');

set local request.jwt.claims to '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';

select lives_ok($$ select public.void_sales_import(pg_temp.ref('sales1'), 'Wrong date') $$,
  'posted sales can be voided');

select is(pg_temp.on_hand('A1 kitchen', 'Rice'), 3600::numeric, 'voiding puts the rice back');

select is((select count(*)::int from public.stock_ledger
           where source_id = pg_temp.ref('sales1') and reverses_entry_id is not null),
          5, 'voiding reverses each of the five deductions');

-- ---------------------------------------------------------------------------
-- F. Physical count of the kitchen
-- ---------------------------------------------------------------------------
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';

with c as (
  insert into public.stock_counts (organisation_id, outlet_id, location_id)
  values ('aaaaaaaa-0000-0000-0000-000000000001', pg_temp.outlet('A1'), pg_temp.loc('A1 kitchen'))
  returning id)
insert into t_ids select 'count1', id from c;

insert into public.stock_count_lines (organisation_id, outlet_id, count_id, item_id, location_id, counted_qty)
values
  ('aaaaaaaa-0000-0000-0000-000000000001', pg_temp.outlet('A1'), pg_temp.ref('count1'), pg_temp.item('Rice'),  pg_temp.loc('A1 kitchen'), 3550),
  ('aaaaaaaa-0000-0000-0000-000000000001', pg_temp.outlet('A1'), pg_temp.ref('count1'), pg_temp.item('Onion'), pg_temp.loc('A1 kitchen'), 6000);

select lives_ok($$ select public.submit_stock_count(pg_temp.ref('count1')) $$, 'a storekeeper can submit a count');

select is((select system_qty from public.stock_count_lines
           where count_id = pg_temp.ref('count1') and item_id = pg_temp.item('Rice')),
          3600::numeric, 'submitting fills in the system quantity');

select is((select variance_qty from public.stock_count_lines
           where count_id = pg_temp.ref('count1') and item_id = pg_temp.item('Rice')),
          -50::numeric, 'the rice is 50 g short');

select throws_ok($$ select public.approve_stock_count(pg_temp.ref('count1')) $$,
  '42501', null, 'a storekeeper cannot approve a count');

set local request.jwt.claims to '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';

select is(public.approve_stock_count(pg_temp.ref('count1')), 1,
          'approving posts one variance (the onion matched)');

select is(pg_temp.on_hand('A1 kitchen', 'Rice'), 3550::numeric, 'stock now matches what was counted');

select throws_ok($$ select public.approve_stock_count(pg_temp.ref('count1')) $$,
  '55000', null, 'a count cannot be approved twice');

-- ---------------------------------------------------------------------------
-- G. Made-to-order prep items and who can call the functions
-- ---------------------------------------------------------------------------
select lives_ok($$
  update public.items set deduct_ingredients_on_sale = true where id = pg_temp.item('Gravy base')
$$, 'a masters editor can mark a prep item as made to order');

reset role;

select is((select sum(quantity) from private.expand_recipe('aaaaaaaa-3000-0000-0000-000000000003', 10)
           where item_id = pg_temp.item('Onion')),
          480::numeric, 'with gravy base made to order, 10 plates use 400 g of onion for gravy plus 80 g for spice mix');

set local role anon;

select throws_ok($$
  select public.post_wastage(pg_temp.outlet('A1'), pg_temp.loc('A1 kitchen'), pg_temp.item('Onion'), 100, 'spoiled')
$$, '42501', null, 'signed-out visitors cannot call posting functions');

reset role;

select * from finish();
rollback;
