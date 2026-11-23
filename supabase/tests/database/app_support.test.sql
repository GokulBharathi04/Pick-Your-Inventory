-- Tests for the web app's support functions (pgTAP). Run with: supabase test db
-- Everything runs in one transaction and is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(27);

-- ---------------------------------------------------------------------------
-- Setup (as postgres)
--   alice  owner of org A (outlets A1, A2)
--   bob    owner of org B
--   sam    storekeeper of org A, outlet A1 only
--   carol, dave  new logins that belong to no business yet
-- ---------------------------------------------------------------------------
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('11111111-1111-1111-1111-111111111111', 'alice@pick-your-inventory.local', now(), '{}'),
  ('22222222-2222-2222-2222-222222222222', 'bob@pick-your-inventory.local',   now(), '{}'),
  ('33333333-3333-3333-3333-333333333333', 'sam@pick-your-inventory.local',   now(), '{}'),
  ('44444444-4444-4444-4444-444444444444', 'carol@pick-your-inventory.local', now(), '{}'),
  ('55555555-5555-5555-5555-555555555555', 'dave@pick-your-inventory.local',  now(), '{}');

insert into public.organisations (id, name) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Alice Biryani House'),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'Bob Cafe');

select private.create_default_roles(id) from public.organisations;

insert into public.outlets (id, organisation_id, name) values
  ('aaaaaaaa-0000-0000-0000-0000000000a1', 'aaaaaaaa-0000-0000-0000-000000000001', 'Anna Nagar'),
  ('aaaaaaaa-0000-0000-0000-0000000000a2', 'aaaaaaaa-0000-0000-0000-000000000001', 'T Nagar'),
  ('bbbbbbbb-0000-0000-0000-0000000000b1', 'bbbbbbbb-0000-0000-0000-000000000001', 'Bob Main');

insert into public.storage_locations (id, organisation_id, outlet_id, name, kind) values
  ('aaaaaaaa-0000-0000-0002-0000000000a1', 'aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'Kitchen', 'kitchen');

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

-- Items, stock and recipes for the cost checks.
insert into public.items (id, organisation_id, name, base_unit, item_type) values
  ('aaaaaaaa-1000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'Rice',       'g',  'raw'),
  ('aaaaaaaa-1000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001', 'Onion',      'g',  'raw'),
  ('aaaaaaaa-1000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000001', 'Oil',        'ml', 'raw'),
  ('aaaaaaaa-1000-0000-0000-000000000004', 'aaaaaaaa-0000-0000-0000-000000000001', 'Gravy base', 'g',  'prep');

insert into public.stock_ledger (organisation_id, outlet_id, location_id, item_id, movement_type, quantity, unit_cost, source_type, occurred_at)
values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'aaaaaaaa-0000-0000-0002-0000000000a1', 'aaaaaaaa-1000-0000-0000-000000000001', 'opening', 10000, 0.08, 'opening', '2026-11-20 10:00+05:30'),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'aaaaaaaa-0000-0000-0002-0000000000a1', 'aaaaaaaa-1000-0000-0000-000000000002', 'opening', 10000, 0.04, 'opening', '2026-11-20 10:00+05:30'),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'aaaaaaaa-0000-0000-0002-0000000000a1', 'aaaaaaaa-1000-0000-0000-000000000003', 'opening', 3000, 0.15, 'opening', '2026-11-20 10:00+05:30');

insert into public.menu_items (id, organisation_id, name, selling_price) values
  ('aaaaaaaa-2000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'Chicken biryani', 250);

insert into public.recipes (id, organisation_id, prep_item_id, menu_item_id, yield_qty) values
  ('aaaaaaaa-3000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-1000-0000-0000-000000000004', null, 5000),
  ('aaaaaaaa-3000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001', null, 'aaaaaaaa-2000-0000-0000-000000000001', 1);

insert into public.recipe_lines (organisation_id, recipe_id, item_id, quantity, unit) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-3000-0000-0000-000000000001', 'aaaaaaaa-1000-0000-0000-000000000002', 2,   'kg'),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-3000-0000-0000-000000000001', 'aaaaaaaa-1000-0000-0000-000000000003', 0.5, 'l'),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-3000-0000-0000-000000000002', 'aaaaaaaa-1000-0000-0000-000000000001', 150, 'g'),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-3000-0000-0000-000000000002', 'aaaaaaaa-1000-0000-0000-000000000004', 100, 'g');

update public.recipes set status = 'active' where organisation_id = 'aaaaaaaa-0000-0000-0000-000000000001';

insert into public.sales_imports (id, organisation_id, outlet_id, business_date, status) values
  ('aaaaaaaa-5000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000a1', '2026-11-21', 'posted');
insert into public.sales_lines (organisation_id, outlet_id, sales_import_id, menu_item_id, item_name, quantity, amount) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'aaaaaaaa-5000-0000-0000-000000000001',
   'aaaaaaaa-2000-0000-0000-000000000001', 'Chicken biryani', 12, 3000);

-- ---------------------------------------------------------------------------
-- Tabs
-- ---------------------------------------------------------------------------
select is((select count(*)::int from public.app_tabs where key in ('adjustments', 'reports')), 2,
          'the adjustments and reports tabs are added');

-- ---------------------------------------------------------------------------
-- my_access
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims to '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';

select is(jsonb_array_length(public.my_access() -> 'organisations'), 1, 'the owner belongs to one organisation');
select is((public.my_access() -> 'organisations' -> 0 ->> 'is_owner')::boolean, true, 'and is its owner');
select is(jsonb_array_length(public.my_access() -> 'organisations' -> 0 -> 'outlets'), 2, 'the owner sees both outlets');

set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';

select is(jsonb_array_length(public.my_access() -> 'organisations' -> 0 -> 'outlets'), 1,
          'a storekeeper sees only the outlet they work in');
select ok(public.my_access() -> 'organisations' -> 0 -> 'permissions' ? 'stock.adjust'
          and not (public.my_access() -> 'organisations' -> 0 -> 'permissions' ? 'counts.approve'),
          'a storekeeper''s permissions are their role''s');

set local request.jwt.claims to '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';

select is(public.my_access() -> 'organisations' -> 0 ->> 'organisation_name', 'Bob Cafe',
          'another owner sees only their own organisation');

-- ---------------------------------------------------------------------------
-- Members
-- ---------------------------------------------------------------------------
set local request.jwt.claims to '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';

select is((select count(*)::int from public.list_members('aaaaaaaa-0000-0000-0000-000000000001')), 2,
          'the owner can list the organisation''s members');

select lives_ok($$
  select public.add_staff_member('aaaaaaaa-0000-0000-0000-000000000001', '44444444-4444-4444-4444-444444444444',
    (select id from public.roles where organisation_id = 'aaaaaaaa-0000-0000-0000-000000000001' and key = 'chef'),
    false, array['aaaaaaaa-0000-0000-0000-0000000000a1']::uuid[], 'Carol')
$$, 'the owner can add a new login as a chef at one outlet');

select is((select role_key || ':' || cardinality(outlet_ids) from public.list_members('aaaaaaaa-0000-0000-0000-000000000001')
           where email = 'carol@pick-your-inventory.local'), 'chef:1', 'the new member has the chef role and one outlet');

select is((select full_name from public.profiles where id = '44444444-4444-4444-4444-444444444444'), 'Carol',
          'the new member''s name is saved');

select throws_ok($$
  select public.add_staff_member('aaaaaaaa-0000-0000-0000-000000000001', '33333333-3333-3333-3333-333333333333',
    (select id from public.roles where organisation_id = 'aaaaaaaa-0000-0000-0000-000000000001' and key = 'chef'), true)
$$, '23505', null, 'a login that already belongs to a business cannot be added');

select throws_ok($$
  select public.add_staff_member('aaaaaaaa-0000-0000-0000-000000000001', '55555555-5555-5555-5555-555555555555',
    (select id from public.roles where organisation_id = 'aaaaaaaa-0000-0000-0000-000000000001' and key = 'owner'), true)
$$, '22023', null, 'nobody can be added as owner');

select throws_ok($$
  select public.add_staff_member('aaaaaaaa-0000-0000-0000-000000000001', '55555555-5555-5555-5555-555555555555',
    (select id from public.roles where organisation_id = 'aaaaaaaa-0000-0000-0000-000000000001' and key = 'chef'), false)
$$, '22023', null, 'a member needs all outlets or at least one');

select throws_ok($$
  select public.add_staff_member('aaaaaaaa-0000-0000-0000-000000000001', '55555555-5555-5555-5555-555555555555',
    (select id from public.roles where organisation_id = 'bbbbbbbb-0000-0000-0000-000000000001' and key = 'chef'), true)
$$, 'P0002', null, 'a role from another organisation cannot be used');

set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';

select throws_ok($$ select * from public.list_members('aaaaaaaa-0000-0000-0000-000000000001') $$,
  '42501', null, 'a storekeeper cannot list members');

select throws_ok($$
  select public.add_staff_member('aaaaaaaa-0000-0000-0000-000000000001', '55555555-5555-5555-5555-555555555555',
    (select id from public.roles where organisation_id = 'aaaaaaaa-0000-0000-0000-000000000001' and key = 'chef'), true)
$$, '42501', null, 'a storekeeper cannot add members');

set local request.jwt.claims to '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';

select throws_ok($$
  select public.add_staff_member('aaaaaaaa-0000-0000-0000-000000000001', '55555555-5555-5555-5555-555555555555',
    'aaaaaaaa-0000-0000-0000-000000000001', true)
$$, '42501', null, 'another organisation''s owner cannot add members here');

-- ---------------------------------------------------------------------------
-- Costs
-- ---------------------------------------------------------------------------
set local request.jwt.claims to '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';

select is((select unit_cost from public.item_costs('aaaaaaaa-0000-0000-0000-0000000000a1')
           where item_id = 'aaaaaaaa-1000-0000-0000-000000000001'), 0.08::numeric,
          'rice costs its average cost of ₹0.08 a gram');

select is((select unit_cost from public.item_costs('aaaaaaaa-0000-0000-0000-0000000000a1')
           where item_id = 'aaaaaaaa-1000-0000-0000-000000000004'), 0.031::numeric,
          'gravy base with no stock is costed from its recipe: (₹80 + ₹75) / 5000 g');

select is((select cost_per_unit || ' / ' || food_cost_pct from public.recipe_costs('aaaaaaaa-0000-0000-0000-0000000000a1')
           where menu_item_id = 'aaaaaaaa-2000-0000-0000-000000000001'), '15.100000 / 6.0',
          'a plate of biryani costs ₹15.10, 6% of its ₹250 price');

set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';

select throws_ok($$ select * from public.item_costs('aaaaaaaa-0000-0000-0000-0000000000a2') $$,
  '42501', null, 'costs are only shown for outlets the user works at');

set local request.jwt.claims to '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';

select throws_ok($$ select * from public.recipe_costs('aaaaaaaa-0000-0000-0000-0000000000a1') $$,
  '42501', null, 'another organisation cannot see recipe costs');

-- ---------------------------------------------------------------------------
-- Reports
-- ---------------------------------------------------------------------------
set local request.jwt.claims to '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';

select is((select opening_entries::int || ' / ' || closing_qty::int
           from public.movement_summary('aaaaaaaa-0000-0000-0000-0000000000a1', '2026-11-20 00:00+05:30', '2026-11-21 00:00+05:30')
           where item_id = 'aaaaaaaa-1000-0000-0000-000000000001'), '10000 / 10000',
          'the movement summary shows the opening entry and the closing stock');

select is((select quantity::int from public.sales_by_item('aaaaaaaa-0000-0000-0000-0000000000a1', '2026-11-21', '2026-11-21')), 12,
          'sales by item adds up posted sales');

set local request.jwt.claims to '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';

select is((select count(*)::int from public.movement_summary('aaaaaaaa-0000-0000-0000-0000000000a1', '2026-11-01', '2026-12-01')), 0,
          'another organisation sees no movements here');

reset role;
set local role anon;

select throws_ok($$ select public.my_access() $$, '42501', null, 'signed-out visitors cannot call the app functions');

reset role;

select * from finish();
rollback;
