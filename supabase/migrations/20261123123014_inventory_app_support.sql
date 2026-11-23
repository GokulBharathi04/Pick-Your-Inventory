-- Support for the web app's inventory screens.
--
--   my_access()            who the signed-in user is: organisations, role,
--                          permissions and outlets (drives the side menu)
--   list_members()         people in an organisation, for the Users screen
--   add_staff_member()     puts a new login into an organisation with a role
--                          and outlets (called by the create-staff-user Edge
--                          Function after it creates the login)
--   item_costs()           current cost per base unit of every item at an outlet
--   recipe_costs()         cost per portion and food cost % of every recipe
--   movement_summary()     opening, movements by type and closing per item
--   sales_by_item()        quantity and amount sold per dish
--
-- Also adds side-menu tabs for opening stock and adjustments, and reports.

-- ---------------------------------------------------------------------------
-- Tabs
-- ---------------------------------------------------------------------------
insert into public.app_tabs (key, label, path, section, view_permission, sort_order) values
  ('adjustments', 'Opening stock and adjustments', '/adjustments', 'Stock',   'stock.adjust', 205),
  ('reports',     'Reports',                       '/reports',     'Reports', 'stock.view',   500);

-- ---------------------------------------------------------------------------
-- Who am I?
-- ---------------------------------------------------------------------------
create or replace function public.my_access()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'user_id',   u.id,
    'email',     u.email,
    'full_name', p.full_name,
    'organisations', coalesce((
      select jsonb_agg(jsonb_build_object(
        'organisation_id',   o.id,
        'organisation_name', o.name,
        'timezone',          o.timezone,
        'membership_id',     m.id,
        'role_id',           r.id,
        'role_key',          r.key,
        'role_name',         r.name,
        'is_owner',          r.key = 'owner',
        'all_outlets',       m.all_outlets,
        'permissions', case
          when r.key = 'owner' then (select jsonb_agg(pm.code order by pm.code) from public.permissions pm)
          else coalesce((select jsonb_agg(rp.permission_code order by rp.permission_code)
                         from public.role_permissions rp where rp.role_id = r.id), '[]'::jsonb)
        end,
        'outlets', coalesce((
          select jsonb_agg(jsonb_build_object('id', ou.id, 'name', ou.name, 'code', ou.code) order by ou.name)
          from public.outlets ou
          where ou.organisation_id = o.id and ou.is_active
            and (m.all_outlets or exists (
                   select 1 from public.membership_outlets mo
                   where mo.membership_id = m.id and mo.outlet_id = ou.id))), '[]'::jsonb)
      ) order by o.name)
      from public.memberships m
      join public.organisations o on o.id = m.organisation_id
      join public.roles r on r.id = m.role_id
      where m.user_id = u.id and m.is_active and o.is_active and r.is_active), '[]'::jsonb)
  )
  from auth.users u
  left join public.profiles p on p.id = u.id
  where u.id = auth.uid();
$$;

-- ---------------------------------------------------------------------------
-- Members of an organisation (user managers only)
-- ---------------------------------------------------------------------------
create or replace function public.list_members(p_organisation_id uuid)
returns table (
  membership_id uuid,
  user_id       uuid,
  email         text,
  full_name     text,
  role_id       uuid,
  role_key      text,
  role_name     text,
  all_outlets   boolean,
  outlet_ids    uuid[],
  is_active     boolean,
  created_at    timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.has_permission(p_organisation_id, 'users.manage') then
    raise exception 'You do not have permission to manage users' using errcode = '42501';
  end if;

  return query
  select m.id, m.user_id, u.email::text, p.full_name, r.id, r.key, r.name, m.all_outlets,
         coalesce((select array_agg(mo.outlet_id) from public.membership_outlets mo where mo.membership_id = m.id),
                  '{}'::uuid[]),
         m.is_active, m.created_at
  from public.memberships m
  join public.roles r on r.id = m.role_id
  join auth.users u on u.id = m.user_id
  left join public.profiles p on p.id = m.user_id
  where m.organisation_id = p_organisation_id
  order by r.sort_order, p.full_name nulls last, u.email;
end;
$$;

-- ---------------------------------------------------------------------------
-- Add a new login to an organisation
-- ---------------------------------------------------------------------------
-- Only a login that belongs to no organisation yet can be added, so this can
-- never pull someone else's existing account into another business.
create or replace function public.add_staff_member(
  p_organisation_id uuid,
  p_user_id         uuid,
  p_role_id         uuid,
  p_all_outlets     boolean,
  p_outlet_ids      uuid[] default '{}',
  p_full_name       text default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role public.roles;
  v_membership_id uuid;
begin
  if not private.has_permission(p_organisation_id, 'users.manage') then
    raise exception 'You do not have permission to add users' using errcode = '42501';
  end if;

  select * into v_role from public.roles where id = p_role_id and organisation_id = p_organisation_id;
  if not found then
    raise exception 'Role not found' using errcode = 'P0002';
  end if;
  if v_role.is_system then
    raise exception 'Choose a role other than owner' using errcode = '22023';
  end if;

  if not exists (select 1 from auth.users where id = p_user_id) then
    raise exception 'Login not found' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.memberships where user_id = p_user_id) then
    raise exception 'This login already belongs to a business' using errcode = '23505';
  end if;

  if not coalesce(p_all_outlets, false) and coalesce(cardinality(p_outlet_ids), 0) = 0 then
    raise exception 'Choose at least one outlet' using errcode = '22023';
  end if;

  insert into public.profiles (id, full_name)
  values (p_user_id, nullif(trim(p_full_name), ''))
  on conflict (id) do update set full_name = coalesce(excluded.full_name, public.profiles.full_name);

  insert into public.memberships (organisation_id, user_id, role_id, all_outlets, invited_by)
  values (p_organisation_id, p_user_id, p_role_id, coalesce(p_all_outlets, false), auth.uid())
  returning id into v_membership_id;

  if not coalesce(p_all_outlets, false) then
    insert into public.membership_outlets (organisation_id, membership_id, outlet_id)
    select p_organisation_id, v_membership_id, o
    from unnest(p_outlet_ids) as o;
  end if;

  return v_membership_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Costs
-- ---------------------------------------------------------------------------

-- Cost per base unit. A prep item made to order, or one with no cost yet, is
-- costed from its active recipe.
create or replace function private.item_cost(p_outlet_id uuid, p_item_id uuid, p_depth integer default 0)
returns numeric
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_item public.items;
  v_cost numeric;
  v_recipe public.recipes;
  v_sum numeric := 0;
  v_line record;
begin
  if p_depth > 10 then
    return 0;
  end if;

  select * into v_item from public.items where id = p_item_id;
  if not found then
    return 0;
  end if;

  if not (v_item.item_type = 'prep' and v_item.deduct_ingredients_on_sale) then
    v_cost := private.current_unit_cost(p_outlet_id, p_item_id);
  end if;

  if coalesce(v_cost, 0) = 0 and v_item.item_type = 'prep' then
    select * into v_recipe from public.recipes where prep_item_id = p_item_id and status = 'active';
    if found then
      for v_line in select rl.item_id, rl.quantity_in_base from public.recipe_lines rl where rl.recipe_id = v_recipe.id loop
        v_sum := v_sum + v_line.quantity_in_base * private.item_cost(p_outlet_id, v_line.item_id, p_depth + 1);
      end loop;
      v_cost := round(v_sum / v_recipe.yield_qty, 6);
    end if;
  end if;

  return coalesce(v_cost, 0);
end;
$$;

create or replace function public.item_costs(p_outlet_id uuid)
returns table (item_id uuid, unit_cost numeric)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from private.my_outlet_ids() as x(id) where x.id = p_outlet_id) then
    raise exception 'You do not work at this outlet' using errcode = '42501';
  end if;

  return query
  select i.id, private.item_cost(p_outlet_id, i.id)
  from public.items i
  join public.outlets o on o.organisation_id = i.organisation_id
  where o.id = p_outlet_id;
end;
$$;

create or replace function public.recipe_costs(p_outlet_id uuid)
returns table (
  recipe_id       uuid,
  menu_item_id    uuid,
  prep_item_id    uuid,
  version         integer,
  status          text,
  yield_qty       numeric,
  total_cost      numeric,
  cost_per_unit   numeric,
  selling_price   numeric,
  food_cost_pct   numeric)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from private.outlet_ids_with('recipes.view') as x(id) where x.id = p_outlet_id)
     and not exists (select 1 from private.outlet_ids_with('stock.view') as x(id) where x.id = p_outlet_id) then
    raise exception 'You do not have permission to see recipe costs here' using errcode = '42501';
  end if;

  return query
  with costs as (
    select r.id, r.menu_item_id, r.prep_item_id, r.version, r.status, r.yield_qty,
           round(coalesce(sum(rl.quantity_in_base * private.item_cost(p_outlet_id, rl.item_id)), 0), 2) as total
    from public.recipes r
    join public.outlets o on o.organisation_id = r.organisation_id and o.id = p_outlet_id
    left join public.recipe_lines rl on rl.recipe_id = r.id
    group by r.id
  )
  select c.id, c.menu_item_id, c.prep_item_id, c.version, c.status, c.yield_qty, c.total,
         round(c.total / c.yield_qty, 6),
         sp.price,
         case when sp.price > 0 then round(c.total / c.yield_qty / sp.price * 100, 1) end
  from costs c
  left join lateral (
    select coalesce(mio.selling_price, mi.selling_price) as price
    from public.menu_items mi
    left join public.menu_item_outlets mio on mio.menu_item_id = mi.id and mio.outlet_id = p_outlet_id
    where mi.id = c.menu_item_id
  ) sp on true;
end;
$$;

-- ---------------------------------------------------------------------------
-- Reports (run with the caller's rights, so row-level security applies)
-- ---------------------------------------------------------------------------
create or replace function public.movement_summary(
  p_outlet_id   uuid,
  p_from        timestamptz,
  p_to          timestamptz,
  p_location_id uuid default null)
returns table (
  item_id              uuid,
  opening_qty          numeric,
  opening_value        numeric,
  opening_entries      numeric,
  receipts             numeric,
  transfers_in         numeric,
  transfers_out        numeric,
  production           numeric,
  sales                numeric,
  prep_consumption     numeric,
  wastage              numeric,
  staff_meals          numeric,
  adjustments          numeric,
  count_variance       numeric,
  vendor_returns       numeric,
  sales_value          numeric,
  prep_consumption_value numeric,
  wastage_value        numeric,
  count_variance_value numeric,
  closing_qty          numeric,
  closing_value        numeric)
language sql
stable
set search_path = ''
as $$
  select
    l.item_id,
    coalesce(sum(l.quantity) filter (where l.occurred_at < p_from), 0),
    coalesce(sum(l.value)    filter (where l.occurred_at < p_from), 0),
    coalesce(sum(l.quantity) filter (where l.occurred_at >= p_from and l.occurred_at < p_to and l.movement_type = 'opening'), 0),
    coalesce(sum(l.quantity) filter (where l.occurred_at >= p_from and l.occurred_at < p_to and l.movement_type = 'receipt'), 0),
    coalesce(sum(l.quantity) filter (where l.occurred_at >= p_from and l.occurred_at < p_to and l.movement_type = 'transfer_in'), 0),
    coalesce(sum(l.quantity) filter (where l.occurred_at >= p_from and l.occurred_at < p_to and l.movement_type = 'transfer_out'), 0),
    coalesce(sum(l.quantity) filter (where l.occurred_at >= p_from and l.occurred_at < p_to and l.movement_type = 'prep_production'), 0),
    coalesce(sum(l.quantity) filter (where l.occurred_at >= p_from and l.occurred_at < p_to and l.movement_type = 'sale'), 0),
    coalesce(sum(l.quantity) filter (where l.occurred_at >= p_from and l.occurred_at < p_to and l.movement_type = 'prep_consumption'), 0),
    coalesce(sum(l.quantity) filter (where l.occurred_at >= p_from and l.occurred_at < p_to and l.movement_type = 'wastage'), 0),
    coalesce(sum(l.quantity) filter (where l.occurred_at >= p_from and l.occurred_at < p_to and l.movement_type = 'staff_meal'), 0),
    coalesce(sum(l.quantity) filter (where l.occurred_at >= p_from and l.occurred_at < p_to and l.movement_type = 'adjustment'), 0),
    coalesce(sum(l.quantity) filter (where l.occurred_at >= p_from and l.occurred_at < p_to and l.movement_type = 'count_variance'), 0),
    coalesce(sum(l.quantity) filter (where l.occurred_at >= p_from and l.occurred_at < p_to and l.movement_type = 'vendor_return'), 0),
    coalesce(sum(l.value)    filter (where l.occurred_at >= p_from and l.occurred_at < p_to and l.movement_type = 'sale'), 0),
    coalesce(sum(l.value)    filter (where l.occurred_at >= p_from and l.occurred_at < p_to and l.movement_type = 'prep_consumption'), 0),
    coalesce(sum(l.value)    filter (where l.occurred_at >= p_from and l.occurred_at < p_to and l.movement_type in ('wastage', 'staff_meal')), 0),
    coalesce(sum(l.value)    filter (where l.occurred_at >= p_from and l.occurred_at < p_to and l.movement_type = 'count_variance'), 0),
    coalesce(sum(l.quantity) filter (where l.occurred_at < p_to), 0),
    coalesce(sum(l.value)    filter (where l.occurred_at < p_to), 0)
  from public.stock_ledger l
  where l.outlet_id = p_outlet_id
    and (p_location_id is null or l.location_id = p_location_id)
  group by l.item_id;
$$;

create or replace function public.sales_by_item(p_outlet_id uuid, p_from date, p_to date)
returns table (
  menu_item_id uuid,
  item_name    text,
  quantity     numeric,
  amount       numeric,
  days         bigint)
language sql
stable
set search_path = ''
as $$
  select sl.menu_item_id, max(sl.item_name), sum(sl.quantity), sum(sl.amount),
         count(distinct si.business_date)
  from public.sales_lines sl
  join public.sales_imports si on si.id = sl.sales_import_id
  where si.outlet_id = p_outlet_id
    and si.status = 'posted'
    and si.business_date between p_from and p_to
  group by sl.menu_item_id, case when sl.menu_item_id is null then sl.item_name end;
$$;

-- ---------------------------------------------------------------------------
-- Who can call what
-- ---------------------------------------------------------------------------
revoke all on function private.item_cost(uuid, uuid, integer) from public;

revoke all on function public.my_access() from public, anon;
revoke all on function public.list_members(uuid) from public, anon;
revoke all on function public.add_staff_member(uuid, uuid, uuid, boolean, uuid[], text) from public, anon;
revoke all on function public.item_costs(uuid) from public, anon;
revoke all on function public.recipe_costs(uuid) from public, anon;
revoke all on function public.movement_summary(uuid, timestamptz, timestamptz, uuid) from public, anon;
revoke all on function public.sales_by_item(uuid, date, date) from public, anon;

grant execute on function public.my_access() to authenticated;
grant execute on function public.list_members(uuid) to authenticated;
grant execute on function public.add_staff_member(uuid, uuid, uuid, boolean, uuid[], text) to authenticated;
grant execute on function public.item_costs(uuid) to authenticated;
grant execute on function public.recipe_costs(uuid) to authenticated;
grant execute on function public.movement_summary(uuid, timestamptz, timestamptz, uuid) to authenticated;
grant execute on function public.sales_by_item(uuid, date, date) to authenticated;
