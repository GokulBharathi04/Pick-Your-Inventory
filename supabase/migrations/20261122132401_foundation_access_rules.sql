-- Module 0 — Foundation, part 2 of 4: who can see and change what.
--
-- 1. Helper functions in the private schema answer "which organisations am I
--    in?", "where do I hold permission X?" and "which outlets can I see?".
--    They run with the definer's rights so policies never recurse into RLS.
-- 2. Table privileges: browsers (anon) get nothing; signed-in users get only
--    the operations and columns each table needs. Creating organisations,
--    memberships and invitations goes through functions (part 3).
-- 3. Row-level security policies on every table.

-- ---------------------------------------------------------------------------
-- 1. Helper functions
-- ---------------------------------------------------------------------------

-- Organisations where the current user has an active membership.
create or replace function private.my_organisation_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.organisation_id
  from public.memberships m
  join public.organisations o on o.id = m.organisation_id
  where m.user_id = (select auth.uid())
    and m.is_active
    and o.is_active;
$$;

-- Organisations where the current user's role holds a permission.
-- Owners hold every permission, including ones added by later modules.
create or replace function private.org_ids_with(p_permission text)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.organisation_id
  from public.memberships m
  join public.roles r on r.id = m.role_id
  join public.organisations o on o.id = m.organisation_id
  where m.user_id = (select auth.uid())
    and m.is_active
    and r.is_active
    and o.is_active
    and (
      r.key = 'owner'
      or exists (
        select 1 from public.role_permissions rp
        where rp.role_id = r.id and rp.permission_code = p_permission
      )
    );
$$;

-- True when the current user holds a permission in one organisation.
create or replace function private.has_permission(p_organisation_id uuid, p_permission text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from private.org_ids_with(p_permission) as o(id)
    where o.id = p_organisation_id
  );
$$;

-- True when the current user is an active owner of the organisation.
create or replace function private.is_owner(p_organisation_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.memberships m
    join public.roles r on r.id = m.role_id
    where m.user_id = (select auth.uid())
      and m.organisation_id = p_organisation_id
      and m.is_active
      and r.key = 'owner'
  );
$$;

-- Active outlets the current user works in: all outlets of the organisation
-- when the membership has all_outlets, otherwise the assigned ones.
create or replace function private.my_outlet_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select ou.id
  from public.outlets ou
  join public.memberships m on m.organisation_id = ou.organisation_id
  join public.organisations o on o.id = ou.organisation_id
  where m.user_id = (select auth.uid())
    and m.is_active
    and o.is_active
    and (
      m.all_outlets
      or exists (
        select 1 from public.membership_outlets mo
        where mo.membership_id = m.id and mo.outlet_id = ou.id
      )
    );
$$;

-- The current user's own membership ids.
create or replace function private.my_membership_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.id from public.memberships m where m.user_id = (select auth.uid());
$$;

-- People who share an active organisation with the current user.
create or replace function private.my_coworker_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select distinct m.user_id
  from public.memberships m
  where m.organisation_id in (select private.my_organisation_ids());
$$;

-- True for the locked owner role.
create or replace function private.is_system_role(p_role_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select r.is_system from public.roles r where r.id = p_role_id), false);
$$;

-- Outlets the current user works in AND where their role holds a permission.
-- Used by every outlet-level table (stock, wastage, counts, sales).
create or replace function private.outlet_ids_with(p_permission text)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select ou.id
  from private.my_outlet_ids() as ou(id)
  join public.outlets o on o.id = ou.id
  where o.organisation_id in (select private.org_ids_with(p_permission));
$$;

-- Creates the default roles and their permissions for a new organisation.
-- Called by onboarding (and by tests); not callable from the app.
create or replace function private.create_default_roles(p_organisation_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.roles (organisation_id, key, name, description, is_system, sort_order)
  select p_organisation_id, d.key, d.name, d.description, d.is_system, d.sort_order
  from private.default_roles d
  on conflict (organisation_id, key) do nothing;

  insert into public.role_permissions (organisation_id, role_id, permission_code)
  select r.organisation_id, r.id, drp.permission_code
  from private.default_role_permissions drp
  join public.roles r on r.key = drp.role_key and r.organisation_id = p_organisation_id
  on conflict (role_id, permission_code) do nothing;
$$;

revoke all on function private.outlet_ids_with(text)           from public;
revoke all on function private.create_default_roles(uuid)      from public;
grant execute on function private.outlet_ids_with(text)        to authenticated, service_role;
grant execute on function private.create_default_roles(uuid)   to service_role;

revoke all on function private.my_organisation_ids()           from public;
revoke all on function private.org_ids_with(text)              from public;
revoke all on function private.has_permission(uuid, text)      from public;
revoke all on function private.is_owner(uuid)                  from public;
revoke all on function private.my_outlet_ids()                 from public;
revoke all on function private.my_membership_ids()             from public;
revoke all on function private.my_coworker_ids()               from public;
revoke all on function private.is_system_role(uuid)            from public;

grant execute on function private.my_organisation_ids()        to authenticated, service_role;
grant execute on function private.org_ids_with(text)           to authenticated, service_role;
grant execute on function private.has_permission(uuid, text)   to authenticated, service_role;
grant execute on function private.is_owner(uuid)               to authenticated, service_role;
grant execute on function private.my_outlet_ids()              to authenticated, service_role;
grant execute on function private.my_membership_ids()          to authenticated, service_role;
grant execute on function private.my_coworker_ids()            to authenticated, service_role;
grant execute on function private.is_system_role(uuid)         to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Table privileges
-- ---------------------------------------------------------------------------
revoke all on table
  public.organisations, public.outlets, public.storage_locations, public.profiles,
  public.permissions, public.app_tabs, public.roles, public.role_permissions,
  public.memberships, public.membership_outlets, public.invitations
from anon, authenticated;

grant select on public.organisations to authenticated;
grant update (name, legal_name, gstin, phone, email, address_line1, address_line2,
              city, state, pincode, timezone)
  on public.organisations to authenticated;

grant select on public.outlets to authenticated;
grant insert (organisation_id, name, code, gstin, phone, address_line1, address_line2,
              city, state, pincode)
  on public.outlets to authenticated;
grant update (name, code, gstin, phone, address_line1, address_line2, city, state,
              pincode, is_active)
  on public.outlets to authenticated;

grant select on public.storage_locations to authenticated;
grant insert (organisation_id, outlet_id, name, kind) on public.storage_locations to authenticated;
grant update (name, kind, is_active) on public.storage_locations to authenticated;

grant select on public.profiles to authenticated;
grant update (full_name, phone, last_organisation_id) on public.profiles to authenticated;

grant select on public.permissions to authenticated;
grant select on public.app_tabs to authenticated;

grant select on public.roles to authenticated;
grant insert (organisation_id, key, name, description, sort_order) on public.roles to authenticated;
grant update (name, description, is_active, sort_order) on public.roles to authenticated;

grant select, delete on public.role_permissions to authenticated;
grant insert (organisation_id, role_id, permission_code) on public.role_permissions to authenticated;

grant select on public.memberships to authenticated;
grant update (role_id, all_outlets, is_active) on public.memberships to authenticated;

grant select, delete on public.membership_outlets to authenticated;
grant insert (organisation_id, membership_id, outlet_id) on public.membership_outlets to authenticated;

grant select on public.invitations to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Row-level security policies
-- ---------------------------------------------------------------------------

-- Organisations: members read; organisation.manage edits. New organisations
-- are created by public.create_organisation (part 3). Never deleted.
create policy "Members can read their organisations"
  on public.organisations for select to authenticated
  using (id in (select private.my_organisation_ids()));

create policy "Organisation managers can edit the organisation"
  on public.organisations for update to authenticated
  using (id in (select private.org_ids_with('organisation.manage')))
  with check (id in (select private.org_ids_with('organisation.manage')));

-- Outlets: people see the outlets they work in; organisation and user
-- managers see every outlet so they can set up and assign them.
create policy "Members can read their outlets"
  on public.outlets for select to authenticated
  using (
    id in (select private.my_outlet_ids())
    or organisation_id in (select private.org_ids_with('organisation.manage'))
    or organisation_id in (select private.org_ids_with('users.manage'))
  );

create policy "Organisation managers can add outlets"
  on public.outlets for insert to authenticated
  with check (organisation_id in (select private.org_ids_with('organisation.manage')));

create policy "Organisation managers can edit outlets"
  on public.outlets for update to authenticated
  using (organisation_id in (select private.org_ids_with('organisation.manage')))
  with check (organisation_id in (select private.org_ids_with('organisation.manage')));

-- Storage locations: follow their outlet.
create policy "Members can read storage locations of their outlets"
  on public.storage_locations for select to authenticated
  using (
    outlet_id in (select private.my_outlet_ids())
    or organisation_id in (select private.org_ids_with('organisation.manage'))
  );

create policy "Organisation managers can add storage locations"
  on public.storage_locations for insert to authenticated
  with check (organisation_id in (select private.org_ids_with('organisation.manage')));

create policy "Organisation managers can edit storage locations"
  on public.storage_locations for update to authenticated
  using (organisation_id in (select private.org_ids_with('organisation.manage')))
  with check (organisation_id in (select private.org_ids_with('organisation.manage')));

-- Profiles: your own, plus people you work with. Only you edit yours.
create policy "Users can read their own and coworkers' profiles"
  on public.profiles for select to authenticated
  using (
    id = (select auth.uid())
    or id in (select private.my_coworker_ids())
  );

create policy "Users can edit their own profile"
  on public.profiles for update to authenticated
  using (id = (select auth.uid()))
  with check (
    id = (select auth.uid())
    and (last_organisation_id is null
         or last_organisation_id in (select private.my_organisation_ids()))
  );

-- Catalogues: readable by every signed-in user.
create policy "Signed-in users can read permissions"
  on public.permissions for select to authenticated
  using (true);

create policy "Signed-in users can read app tabs"
  on public.app_tabs for select to authenticated
  using (true);

-- Roles: members read; roles.manage adds and edits. The owner role is locked.
create policy "Members can read roles"
  on public.roles for select to authenticated
  using (organisation_id in (select private.my_organisation_ids()));

create policy "Role managers can add roles"
  on public.roles for insert to authenticated
  with check (
    organisation_id in (select private.org_ids_with('roles.manage'))
    and key <> 'owner'
    and not is_system
  );

create policy "Role managers can edit roles except the owner role"
  on public.roles for update to authenticated
  using (
    organisation_id in (select private.org_ids_with('roles.manage'))
    and not is_system
  )
  with check (
    organisation_id in (select private.org_ids_with('roles.manage'))
    and not is_system
  );

create policy "Members can read role permissions"
  on public.role_permissions for select to authenticated
  using (organisation_id in (select private.my_organisation_ids()));

create policy "Role managers can grant permissions except on the owner role"
  on public.role_permissions for insert to authenticated
  with check (
    organisation_id in (select private.org_ids_with('roles.manage'))
    and not private.is_system_role(role_id)
  );

create policy "Role managers can remove permissions except on the owner role"
  on public.role_permissions for delete to authenticated
  using (
    organisation_id in (select private.org_ids_with('roles.manage'))
    and not private.is_system_role(role_id)
  );

-- Memberships: you see your own; users.manage sees and edits everyone's.
-- New memberships come only from create_organisation and accept_invitation.
-- Extra rules (owners, self-changes, last owner) are enforced by a trigger
-- in part 3.
create policy "Users see their own memberships; user managers see all"
  on public.memberships for select to authenticated
  using (
    user_id = (select auth.uid())
    or organisation_id in (select private.org_ids_with('users.manage'))
  );

create policy "User managers can edit memberships"
  on public.memberships for update to authenticated
  using (organisation_id in (select private.org_ids_with('users.manage')))
  with check (organisation_id in (select private.org_ids_with('users.manage')));

create policy "Users see their own outlet assignments; user managers see all"
  on public.membership_outlets for select to authenticated
  using (
    membership_id in (select private.my_membership_ids())
    or organisation_id in (select private.org_ids_with('users.manage'))
  );

create policy "User managers can assign outlets"
  on public.membership_outlets for insert to authenticated
  with check (organisation_id in (select private.org_ids_with('users.manage')));

create policy "User managers can unassign outlets"
  on public.membership_outlets for delete to authenticated
  using (organisation_id in (select private.org_ids_with('users.manage')));

-- Invitations: only user managers read them. Invitees use my_invitations();
-- all changes go through invite_member / accept_invitation / revoke_invitation.
create policy "User managers can read invitations"
  on public.invitations for select to authenticated
  using (organisation_id in (select private.org_ids_with('users.manage')));
