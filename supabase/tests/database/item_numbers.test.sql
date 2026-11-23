-- Item numbers (items.item_no) tests (pgTAP). Run with: supabase test db
begin;
create extension if not exists pgtap with schema extensions;

select plan(6);

insert into auth.users (id, email, email_confirmed_at) values
  ('11111111-1111-1111-1111-111111111111', 'alice@example.com', now());

insert into public.organisations (id, name) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Alice Biryani House');

select private.create_default_roles('aaaaaaaa-0000-0000-0000-000000000001');

insert into public.memberships (organisation_id, user_id, role_id, all_outlets)
select organisation_id, '11111111-1111-1111-1111-111111111111', id, true
from public.roles
where organisation_id = 'aaaaaaaa-0000-0000-0000-000000000001' and key = 'owner';

set local role authenticated;
set local request.jwt.claims to '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';

insert into public.items (organisation_id, name, base_unit)
values ('aaaaaaaa-0000-0000-0000-000000000001', 'Tomato', 'g');
insert into public.items (organisation_id, name, base_unit)
values ('aaaaaaaa-0000-0000-0000-000000000001', 'Onion', 'g');

select ok((select item_no from public.items where name = 'Tomato') >= 1000,
          'a new item gets a number of 1000 or more without asking for one');

select ok((select item_no from public.items where name = 'Onion')
          > (select item_no from public.items where name = 'Tomato'),
          'each new item gets a higher number');

select throws_ok($$
  insert into public.items (organisation_id, name, base_unit, item_no)
  values ('aaaaaaaa-0000-0000-0000-000000000001', 'Garlic', 'g', 5)
$$, '42501', null, 'users cannot choose an item number');

select throws_ok($$
  update public.items set item_no = 7 where name = 'Tomato'
$$, '42501', null, 'users cannot change an item number');

select is((select count(*)::int from public.items where item_no is null), 0,
          'every item has a number');

reset role;

select throws_ok($$
  insert into public.items (organisation_id, name, base_unit, item_no)
  values ('aaaaaaaa-0000-0000-0000-000000000001', 'Duplicate', 'g',
          (select item_no from public.items where name = 'Tomato'))
$$, '23505', null, 'two items can never share a number');

select * from finish();
rollback;
