-- Supply chain tests (pgTAP): purchase orders, goods receipts, department
-- issues and end-of-day returns, and planning stock. Run with: supabase test db
-- Everything runs in one transaction and is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(54);

-- ---------------------------------------------------------------------------
-- Setup (as postgres)
--   alice  owner of org A (outlet A1 Anna Nagar: Main store, Kitchen)
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
  ('bbbbbbbb-0000-0000-0000-0000000000b1', 'bbbbbbbb-0000-0000-0000-000000000001', 'Bob Main');

insert into public.storage_locations (id, organisation_id, outlet_id, name, kind) values
  ('aaaaaaaa-0000-0000-0001-0000000000a1', 'aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'Main store', 'store'),
  ('aaaaaaaa-0000-0000-0002-0000000000a1', 'aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'Kitchen', 'kitchen'),
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

insert into public.items (organisation_id, name, base_unit, gst_rate) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Rice',   'g',  5),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Oil',    'ml', 5),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Tomato', 'g',  0);

insert into public.item_pack_sizes (id, organisation_id, item_id, name, quantity_in_base)
select 'aaaaaaaa-4000-0000-0000-000000000001', organisation_id, id, 'Crate', 10000
from public.items where name = 'Tomato';

insert into public.vendors (id, organisation_id, name) values
  ('aaaaaaaa-5000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'Koyambedu Fresh');

-- Rice at ₹80 a kg, tomatoes at ₹400 a 10 kg crate.
insert into public.vendor_items (organisation_id, vendor_id, item_id, price_unit, pack_size_id, rate)
select 'aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-5000-0000-0000-000000000001', i.id,
       case when i.name = 'Rice' then 'kg' end,
       case when i.name = 'Tomato' then 'aaaaaaaa-4000-0000-0000-000000000001'::uuid end,
       case when i.name = 'Rice' then 80 else 400 end
from public.items i where i.name in ('Rice', 'Tomato');

insert into public.item_outlet_settings (organisation_id, outlet_id, item_id, preferred_vendor_id, reorder_level, reorder_qty, max_level)
select organisation_id, 'aaaaaaaa-0000-0000-0000-0000000000a1', id, 'aaaaaaaa-5000-0000-0000-000000000001',
       case when name = 'Rice' then 5000 else 10000 end,
       case when name = 'Rice' then 20000 end,
       case when name = 'Tomato' then 30000 end
from public.items where name in ('Rice', 'Tomato');

insert into public.departments (id, organisation_id, outlet_id, name) values
  ('aaaaaaaa-6000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'Tandoor'),
  ('aaaaaaaa-6000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'Chinese');

-- Test helpers
create temp table t_ids (k text primary key, id uuid not null);
grant select, insert on t_ids to authenticated;

create function pg_temp.ref(p_key text) returns uuid language sql security definer as
  $$ select id from t_ids where k = p_key $$;
create function pg_temp.item(p_name text) returns uuid language sql security definer as
  $$ select id from public.items where organisation_id = 'aaaaaaaa-0000-0000-0000-000000000001' and name = p_name $$;
create function pg_temp.on_hand(p_item text) returns numeric language sql security definer as
  $$ select coalesce(sum(l.quantity), 0) from public.stock_ledger l
     where l.location_id = 'aaaaaaaa-0000-0000-0001-0000000000a1' and l.item_id = pg_temp.item(p_item) $$;
create function pg_temp.po_line(p_po text, p_item text) returns uuid language sql security definer as
  $$ select id from public.purchase_order_lines where purchase_order_id = pg_temp.ref(p_po) and item_id = pg_temp.item(p_item) $$;
create function pg_temp.po_status(p_po text) returns text language sql security definer as
  $$ select status from public.purchase_orders where id = pg_temp.ref(p_po) $$;

-- ---------------------------------------------------------------------------
-- 0. Permissions and tabs
-- ---------------------------------------------------------------------------
select is((select count(*)::int from public.role_permissions rp join public.roles r on r.id = rp.role_id
           where r.organisation_id = 'aaaaaaaa-0000-0000-0000-000000000001' and r.key = 'storekeeper'
             and rp.permission_code in ('departments.issue', 'purchase.receive', 'purchase.view')),
          3, 'storekeepers can issue to departments, view purchasing and receive goods');

select is((select count(*)::int from public.role_permissions rp join public.roles r on r.id = rp.role_id
           where r.organisation_id = 'aaaaaaaa-0000-0000-0000-000000000001' and r.key = 'storekeeper'
             and rp.permission_code in ('purchase.order', 'purchase.approve')),
          0, 'storekeepers cannot raise or approve purchase orders');

select is((select count(*)::int from public.app_tabs where key in ('issues', 'reorder', 'purchase_orders', 'receipts')),
          4, 'the new screens have side-menu tabs');

-- ---------------------------------------------------------------------------
-- A. Purchase orders
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims to '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';

select lives_ok($$
  insert into t_ids select 'po1', public.save_purchase_order(
    null, 'aaaaaaaa-0000-0000-0000-0000000000a1', 'aaaaaaaa-5000-0000-0000-000000000001',
    'aaaaaaaa-0000-0000-0001-0000000000a1',
    jsonb_build_array(
      jsonb_build_object('item_id', pg_temp.item('Rice'), 'unit', 'kg', 'quantity', 25),
      jsonb_build_object('item_id', pg_temp.item('Tomato'), 'pack_size_id', 'aaaaaaaa-4000-0000-0000-000000000001', 'quantity', 2)),
    current_date + 2, 'Weekly order')
$$, 'the owner raises a draft purchase order');

select is((select po_no from public.purchase_orders where id = pg_temp.ref('po1')), 'PO-00001',
          'orders are numbered per outlet');
select is((select total_amount from public.purchase_orders where id = pg_temp.ref('po1')), 2800.00::numeric,
          'rates default to the vendor''s price: 25 kg × ₹80 + 2 crates × ₹400 = ₹2,800');
select is((select tax_amount from public.purchase_orders where id = pg_temp.ref('po1')), 100.00::numeric,
          'GST defaults to the item''s rate: 5% of ₹2,000 rice');

select throws_ok($$
  select public.save_purchase_order(null, 'aaaaaaaa-0000-0000-0000-0000000000a1', 'aaaaaaaa-5000-0000-0000-000000000001',
    'aaaaaaaa-0000-0000-0002-0000000000a1', jsonb_build_array(jsonb_build_object('item_id', pg_temp.item('Rice'), 'unit', 'kg', 'quantity', 1)))
$$, '22023', null, 'an order must be delivered to a store, not the kitchen');

select throws_ok($$
  select public.post_goods_receipt('aaaaaaaa-0000-0000-0000-0000000000a1', 'aaaaaaaa-5000-0000-0000-000000000001',
    'aaaaaaaa-0000-0000-0001-0000000000a1',
    jsonb_build_array(jsonb_build_object('purchase_order_line_id', pg_temp.po_line('po1', 'Rice'), 'quantity', 1)),
    pg_temp.ref('po1'))
$$, '55000', null, 'goods cannot be received against an order that is not approved');

select lives_ok($$ select public.submit_purchase_order(pg_temp.ref('po1')) $$, 'the order is submitted');

set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';

select throws_ok($$
  select public.save_purchase_order(null, 'aaaaaaaa-0000-0000-0000-0000000000a1', 'aaaaaaaa-5000-0000-0000-000000000001',
    'aaaaaaaa-0000-0000-0001-0000000000a1', jsonb_build_array(jsonb_build_object('item_id', pg_temp.item('Rice'), 'unit', 'kg', 'quantity', 1)))
$$, '42501', null, 'a storekeeper cannot raise a purchase order');

select throws_ok($$ select public.decide_purchase_order(pg_temp.ref('po1'), true) $$,
  '42501', null, 'a storekeeper cannot approve a purchase order');

set local request.jwt.claims to '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';

select throws_ok($$ select public.decide_purchase_order(pg_temp.ref('po1'), false) $$,
  '22023', null, 'rejecting needs a reason');

select is(public.decide_purchase_order(pg_temp.ref('po1'), true, 'OK'), 'approved', 'the owner approves the order');

select is((select on_order from public.planning_stock
           where outlet_id = 'aaaaaaaa-0000-0000-0000-0000000000a1' and item_id = pg_temp.item('Rice')),
          25000::numeric, 'planning stock shows 25 kg of rice on order');

-- ---------------------------------------------------------------------------
-- B. Goods receipts
-- ---------------------------------------------------------------------------
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';

select lives_ok($$
  insert into t_ids select 'grn1', public.post_goods_receipt(
    'aaaaaaaa-0000-0000-0000-0000000000a1', 'aaaaaaaa-5000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0001-0000000000a1',
    jsonb_build_array(
      jsonb_build_object('purchase_order_line_id', pg_temp.po_line('po1', 'Rice'), 'quantity', 20),
      jsonb_build_object('purchase_order_line_id', pg_temp.po_line('po1', 'Tomato'), 'quantity', 0)),
    pg_temp.ref('po1'), 'INV-101', current_date)
$$, 'the storekeeper receives 20 kg of rice; the tomatoes have not come');

select is(pg_temp.on_hand('Rice'), 20000::numeric, 'the store now holds 20 kg of rice');
select is((select value from public.stock_ledger where source_id = pg_temp.ref('grn1') and item_id = pg_temp.item('Rice')),
          1600.00::numeric, 'the receipt is valued at the ordered price: 20 kg × ₹80 = ₹1,600');
select is(pg_temp.po_status('po1'), 'partially_received', 'the order is partly received');
select is((select on_order from public.planning_stock
           where outlet_id = 'aaaaaaaa-0000-0000-0000-0000000000a1' and item_id = pg_temp.item('Rice')),
          5000::numeric, '5 kg of rice is still on order');

select throws_ok($$
  select public.post_goods_receipt('aaaaaaaa-0000-0000-0000-0000000000a1', 'aaaaaaaa-5000-0000-0000-000000000001',
    'aaaaaaaa-0000-0000-0001-0000000000a1',
    jsonb_build_array(jsonb_build_object('purchase_order_line_id', pg_temp.po_line('po1', 'Rice'), 'quantity', 6)),
    pg_temp.ref('po1'))
$$, '22023', null, 'receiving more than was ordered is refused');

select lives_ok($$
  insert into t_ids select 'grn2', public.post_goods_receipt(
    'aaaaaaaa-0000-0000-0000-0000000000a1', 'aaaaaaaa-5000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0001-0000000000a1',
    jsonb_build_array(
      jsonb_build_object('purchase_order_line_id', pg_temp.po_line('po1', 'Rice'), 'quantity', 6),
      jsonb_build_object('purchase_order_line_id', pg_temp.po_line('po1', 'Tomato'), 'quantity', 2)),
    pg_temp.ref('po1'), 'INV-102', current_date, null, null, true)
$$, 'with "accept extra" the rest arrives, 1 kg of rice over');

select is(pg_temp.po_status('po1'), 'received', 'everything ordered has arrived');
select is(pg_temp.on_hand('Tomato'), 20000::numeric, 'the store holds 2 crates (20 kg) of tomatoes');

set local request.jwt.claims to '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';

select lives_ok($$ select public.void_goods_receipt(pg_temp.ref('grn2'), 'Wrong invoice') $$, 'the owner voids the second receipt');
select is(pg_temp.on_hand('Tomato'), 0::numeric, 'voiding takes the tomatoes back out of stock');
select is(pg_temp.po_status('po1'), 'partially_received', 'the order is partly received again');

select throws_ok($$ select public.cancel_purchase_order(pg_temp.ref('po1'), 'Not needed') $$,
  '55000', null, 'an order with goods received cannot be cancelled');

select lives_ok($$ select public.close_purchase_order(pg_temp.ref('po1'), 'Vendor out of tomatoes') $$,
  'the owner closes the order short');
select is(pg_temp.po_status('po1'), 'closed', 'the order is closed');
select is((select on_order from public.planning_stock
           where outlet_id = 'aaaaaaaa-0000-0000-0000-0000000000a1' and item_id = pg_temp.item('Tomato')),
          0::numeric, 'nothing is on order once the order is closed');

select throws_ok($$
  select public.post_goods_receipt('aaaaaaaa-0000-0000-0000-0000000000a1', 'aaaaaaaa-5000-0000-0000-000000000001',
    'aaaaaaaa-0000-0000-0001-0000000000a1',
    jsonb_build_array(jsonb_build_object('item_id', pg_temp.item('Oil'), 'unit', 'l', 'quantity', 5)))
$$, '22023', null, 'a direct receipt needs a rate when the vendor has no price');

select lives_ok($$
  select public.post_goods_receipt('aaaaaaaa-0000-0000-0000-0000000000a1', 'aaaaaaaa-5000-0000-0000-000000000001',
    'aaaaaaaa-0000-0000-0001-0000000000a1',
    jsonb_build_array(jsonb_build_object('item_id', pg_temp.item('Oil'), 'unit', 'l', 'quantity', 5, 'rate', 150)))
$$, 'goods can be received without an order');
select is(pg_temp.on_hand('Oil'), 5000::numeric, 'the store holds 5 l of oil');

set local request.jwt.claims to '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';

select is((select count(*)::int from public.purchase_orders where id = pg_temp.ref('po1')), 0,
          'another organisation cannot see the order');

-- ---------------------------------------------------------------------------
-- C. Department issues and end-of-day returns
-- ---------------------------------------------------------------------------
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';

select lives_ok($$
  insert into t_ids select 'iss1', public.post_department_movement(
    'aaaaaaaa-0000-0000-0000-0000000000a1', 'aaaaaaaa-6000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0001-0000000000a1',
    'issue',
    jsonb_build_array(
      jsonb_build_object('item_id', pg_temp.item('Rice'), 'quantity', 3, 'unit', 'kg'),
      jsonb_build_object('item_id', pg_temp.item('Rice'), 'quantity', 1000),
      jsonb_build_object('item_id', pg_temp.item('Oil'), 'quantity', 1, 'unit', 'l')),
    'Lunch service', null, current_date)
$$, 'the storekeeper issues rice and oil to the Tandoor');

select is(pg_temp.on_hand('Rice'), 16000::numeric, 'the issue takes 4 kg of rice out of the store');
select is((select doc_no from public.department_issues where id = pg_temp.ref('iss1')), 'ISS-00001', 'issues are numbered');
select is((select count(*)::int from public.department_issue_lines where issue_id = pg_temp.ref('iss1')), 2,
          'the same item on two lines is added up');

select throws_ok($$
  select public.post_department_movement('aaaaaaaa-0000-0000-0000-0000000000a1', 'aaaaaaaa-6000-0000-0000-000000000001',
    'aaaaaaaa-0000-0000-0002-0000000000a1', 'issue',
    jsonb_build_array(jsonb_build_object('item_id', pg_temp.item('Rice'), 'quantity', 100)))
$$, '22023', null, 'issues come from a store, not the kitchen');

select lives_ok($$
  insert into t_ids select 'ret1', public.post_department_movement(
    'aaaaaaaa-0000-0000-0000-0000000000a1', 'aaaaaaaa-6000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0001-0000000000a1',
    'return', jsonb_build_array(jsonb_build_object('item_id', pg_temp.item('Rice'), 'quantity', 1.5, 'unit', 'kg')),
    'Left over', null, current_date)
$$, 'at the end of the day the Tandoor returns 1.5 kg of rice');

select is(pg_temp.on_hand('Rice'), 17500::numeric, 'the return puts 1.5 kg back in the store');

select throws_ok($$
  select public.post_department_movement('aaaaaaaa-0000-0000-0000-0000000000a1', 'aaaaaaaa-6000-0000-0000-000000000001',
    'aaaaaaaa-0000-0000-0001-0000000000a1', 'return',
    jsonb_build_array(jsonb_build_object('item_id', pg_temp.item('Rice'), 'quantity', 3, 'unit', 'kg')), null, null, current_date)
$$, '22023', null, 'a department cannot return more than it still holds (2.5 kg)');

select throws_ok($$
  select public.post_department_movement('aaaaaaaa-0000-0000-0000-0000000000a1', 'aaaaaaaa-6000-0000-0000-000000000002',
    'aaaaaaaa-0000-0000-0001-0000000000a1', 'return',
    jsonb_build_array(jsonb_build_object('item_id', pg_temp.item('Rice'), 'quantity', 100)), null, null, current_date)
$$, '22023', null, 'a department cannot return what it was never issued');

select is((select used from public.department_usage('aaaaaaaa-0000-0000-0000-0000000000a1', current_date, current_date)
           where department_id = 'aaaaaaaa-6000-0000-0000-000000000001' and item_id = pg_temp.item('Rice')),
          2500::numeric, 'the Tandoor used 4 kg issued less 1.5 kg returned = 2.5 kg of rice');
select is((select used_value from public.department_usage('aaaaaaaa-0000-0000-0000-0000000000a1', current_date, current_date)
           where department_id = 'aaaaaaaa-6000-0000-0000-000000000001' and item_id = pg_temp.item('Rice')),
          200.00::numeric, 'that is 2.5 kg × ₹80 = ₹200');

set local request.jwt.claims to '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';

select throws_ok($$ select public.void_department_movement(pg_temp.ref('iss1'), 'Entered twice') $$,
  '55000', null, 'an issue cannot be voided while its return stands');
select lives_ok($$ select public.void_department_movement(pg_temp.ref('ret1'), 'Counted wrong') $$, 'the return is voided');
select is(pg_temp.on_hand('Rice'), 16000::numeric, 'voiding the return takes the 1.5 kg back out');

set local request.jwt.claims to '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';

select throws_ok($$
  select public.post_department_movement('aaaaaaaa-0000-0000-0000-0000000000a1', 'aaaaaaaa-6000-0000-0000-000000000001',
    'aaaaaaaa-0000-0000-0001-0000000000a1', 'issue',
    jsonb_build_array(jsonb_build_object('item_id', pg_temp.item('Rice'), 'quantity', 100)))
$$, '42501', null, 'another organisation cannot issue stock here');

-- ---------------------------------------------------------------------------
-- D. Planning stock and reorder suggestions
-- ---------------------------------------------------------------------------
-- A sale deducted from the store (no kitchen chosen) does not change planning stock.
reset role;
insert into public.stock_ledger (organisation_id, outlet_id, location_id, item_id, movement_type, quantity, unit_cost, source_type)
values ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'aaaaaaaa-0000-0000-0001-0000000000a1',
        pg_temp.item('Rice'), 'sale', -1000, 0.08, 'sales_import');
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';

select is((select quantity from public.planning_stock
           where outlet_id = 'aaaaaaaa-0000-0000-0000-0000000000a1' and item_id = pg_temp.item('Rice')),
          16000::numeric, 'planning stock ignores sales: still 16 kg of rice');

select is((select suggested_units from public.reorder_suggestions('aaaaaaaa-0000-0000-0000-0000000000a1')
           where item_id = pg_temp.item('Tomato')),
          3::numeric, 'tomatoes are at 0 against a 10 kg reorder level: order 3 crates up to the 30 kg maximum');
select is((select count(*)::int from public.reorder_suggestions('aaaaaaaa-0000-0000-0000-0000000000a1')
           where item_id = pg_temp.item('Rice')),
          0, 'rice is above its reorder level, so it is not suggested');

set local request.jwt.claims to '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';

select throws_ok($$ select * from public.reorder_suggestions('aaaaaaaa-0000-0000-0000-0000000000a1') $$,
  '42501', null, 'another organisation cannot see reorder suggestions');

select * from finish();
rollback;
