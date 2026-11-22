-- Module 0 — Foundation, part 1 of 4: tables.
--
-- Tenancy: organisations -> outlets -> storage_locations.
-- Access:  profiles, permissions (catalogue), app_tabs (catalogue), roles,
--          role_permissions, memberships, membership_outlets, invitations.
--
-- Every business table carries organisation_id. Child tables reference their
-- parent through (id, organisation_id) so a row can never point at another
-- organisation's data. Row-level security is switched on here; the policies
-- that open access are in part 2.
--
-- Sync: the same schema runs in each outlet's local database and in the cloud.
-- Every synced table has sync_version, stamped from one counter per database
-- on each insert and update, so a sync sends only rows changed since the last
-- one. Which way each table syncs is recorded in private.sync_tables.

-- ---------------------------------------------------------------------------
-- Shared triggers
-- ---------------------------------------------------------------------------
create or replace function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create sequence private.sync_version_seq;

-- Runs with definer rights so signed-in users need no access to the counter.
create or replace function private.bump_sync_version()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.sync_version := nextval('private.sync_version_seq');
  return new;
end;
$$;

revoke all on function private.bump_sync_version() from public;

-- ---------------------------------------------------------------------------
-- Organisations: one client business
-- ---------------------------------------------------------------------------
create table public.organisations (
  id            uuid primary key default gen_random_uuid(),
  name          text not null check (length(trim(name)) between 1 and 120),
  legal_name    text check (legal_name is null or length(legal_name) <= 200),
  gstin         text check (gstin is null or gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  phone         text check (phone is null or length(phone) <= 20),
  email         text check (email is null or email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  address_line1 text,
  address_line2 text,
  city          text,
  state         text,
  pincode       text check (pincode is null or pincode ~ '^[1-9][0-9]{5}$'),
  timezone      text not null default 'Asia/Kolkata',
  currency      text not null default 'INR' check (currency ~ '^[A-Z]{3}$'),
  is_active     boolean not null default true,
  created_by    uuid references auth.users (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  sync_version  bigint not null default 0
);

comment on table public.organisations is 'A client business. Every business row belongs to one organisation.';

-- ---------------------------------------------------------------------------
-- Outlets: branches of an organisation
-- ---------------------------------------------------------------------------
create table public.outlets (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete restrict,
  name            text not null check (length(trim(name)) between 1 and 120),
  code            text check (code is null or code ~ '^[A-Z0-9-]{1,12}$'),
  gstin           text check (gstin is null or gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  phone           text check (phone is null or length(phone) <= 20),
  address_line1   text,
  address_line2   text,
  city            text,
  state           text,
  pincode         text check (pincode is null or pincode ~ '^[1-9][0-9]{5}$'),
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  sync_version    bigint not null default 0,
  unique (id, organisation_id),
  unique (organisation_id, code)
);

create unique index outlets_organisation_name_key on public.outlets (organisation_id, lower(name));

comment on table public.outlets is 'A branch of an organisation. Stock, sales and purchases are tracked per outlet.';

-- ---------------------------------------------------------------------------
-- Storage locations: where stock sits inside an outlet
-- ---------------------------------------------------------------------------
create table public.storage_locations (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null,
  outlet_id       uuid not null,
  name            text not null check (length(trim(name)) between 1 and 80),
  kind            text not null default 'store'
                  check (kind in ('store', 'kitchen', 'bar', 'cold_room', 'other')),
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  sync_version    bigint not null default 0,
  unique (id, organisation_id),
  unique (id, outlet_id),
  foreign key (outlet_id, organisation_id)
    references public.outlets (id, organisation_id) on delete restrict
);

create unique index storage_locations_outlet_name_key on public.storage_locations (outlet_id, lower(name));
create index storage_locations_organisation_id_idx on public.storage_locations (organisation_id);

comment on table public.storage_locations is 'A place stock is kept inside an outlet: main store, kitchen, bar, cold room.';

-- ---------------------------------------------------------------------------
-- Profiles: one per login, created automatically at sign-up (part 3)
-- ---------------------------------------------------------------------------
create table public.profiles (
  id                   uuid primary key references auth.users (id) on delete cascade,
  full_name            text check (full_name is null or length(full_name) <= 120),
  phone                text check (phone is null or length(phone) <= 20),
  last_organisation_id uuid references public.organisations (id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  sync_version         bigint not null default 0
);

comment on table public.profiles is 'Name and contact details for each login. last_organisation_id reopens the app where the user left off.';

-- ---------------------------------------------------------------------------
-- Permissions: catalogue of everything a role can be allowed to do.
-- Each later module adds its own codes in its own migration.
-- ---------------------------------------------------------------------------
create table public.permissions (
  code        text primary key check (code ~ '^[a-z_]+\.[a-z_]+$'),
  area        text not null,
  description text not null,
  sort_order  integer not null default 0
);

insert into public.permissions (code, area, description, sort_order) values
  ('organisation.manage', 'Settings', 'Edit the organisation, its outlets and storage locations', 10),
  ('users.manage',        'Users',    'Invite users, change their role and outlets, deactivate them', 20),
  ('roles.manage',        'Users',    'Edit roles and what each role can do and see', 30),
  ('audit.view',          'Settings', 'View the audit log', 40);

comment on table public.permissions is 'Catalogue of permission codes. Owners implicitly hold every permission.';

-- ---------------------------------------------------------------------------
-- App tabs: catalogue of side-menu tabs. A tab shows when the user's role
-- holds its view_permission (or it has none), so hiding a tab and blocking
-- its data are the same switch.
-- ---------------------------------------------------------------------------
create table public.app_tabs (
  key             text primary key check (key ~ '^[a-z_]+$'),
  label           text not null,
  path            text not null,
  section         text not null,
  view_permission text references public.permissions (code),
  sort_order      integer not null default 0
);

insert into public.app_tabs (key, label, path, section, view_permission, sort_order) values
  ('home',      'Home',           '/',          'General', null,                  10),
  ('users',     'Users',          '/users',     'Admin',   'users.manage',        900),
  ('roles',     'Roles',          '/roles',     'Admin',   'roles.manage',        910),
  ('settings',  'Settings',       '/settings',  'Admin',   'organisation.manage', 920),
  ('audit_log', 'Audit log',      '/audit-log', 'Admin',   'audit.view',          930);

comment on table public.app_tabs is 'Side-menu tabs. Visible when the role holds view_permission; null means everyone.';

-- ---------------------------------------------------------------------------
-- Roles per organisation. The owner role is a locked system role.
-- ---------------------------------------------------------------------------
create table public.roles (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete restrict,
  key             text not null check (key ~ '^[a-z][a-z0-9_]{1,39}$'),
  name            text not null check (length(trim(name)) between 1 and 60),
  description     text check (description is null or length(description) <= 200),
  is_system       boolean not null default false,
  is_active       boolean not null default true,
  sort_order      integer not null default 100,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  sync_version    bigint not null default 0,
  unique (organisation_id, key),
  unique (id, organisation_id)
);

comment on table public.roles is 'Roles of an organisation. The owner role (is_system) holds every permission and cannot be edited.';

create table public.role_permissions (
  organisation_id uuid not null,
  role_id         uuid not null,
  permission_code text not null references public.permissions (code) on delete cascade,
  created_at      timestamptz not null default now(),
  sync_version    bigint not null default 0,
  primary key (role_id, permission_code),
  foreign key (role_id, organisation_id)
    references public.roles (id, organisation_id) on delete cascade
);

create index role_permissions_organisation_id_idx on public.role_permissions (organisation_id);

-- ---------------------------------------------------------------------------
-- Memberships: a user in an organisation, with one role and their outlets
-- ---------------------------------------------------------------------------
create table public.memberships (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete restrict,
  user_id         uuid not null references auth.users (id) on delete cascade,
  role_id         uuid not null,
  all_outlets     boolean not null default false,
  is_active       boolean not null default true,
  invited_by      uuid references auth.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  sync_version    bigint not null default 0,
  unique (organisation_id, user_id),
  unique (id, organisation_id),
  foreign key (role_id, organisation_id)
    references public.roles (id, organisation_id) on delete restrict
);

create index memberships_user_id_idx on public.memberships (user_id) where is_active;
create index memberships_role_id_idx on public.memberships (role_id);

comment on table public.memberships is 'A user''s place in an organisation: one role, and either all outlets or the outlets listed in membership_outlets.';

create table public.membership_outlets (
  organisation_id uuid not null,
  membership_id   uuid not null,
  outlet_id       uuid not null,
  created_at      timestamptz not null default now(),
  sync_version    bigint not null default 0,
  primary key (membership_id, outlet_id),
  foreign key (membership_id, organisation_id)
    references public.memberships (id, organisation_id) on delete cascade,
  foreign key (outlet_id, organisation_id)
    references public.outlets (id, organisation_id) on delete cascade
);

create index membership_outlets_outlet_id_idx on public.membership_outlets (outlet_id);
create index membership_outlets_organisation_id_idx on public.membership_outlets (organisation_id);

-- ---------------------------------------------------------------------------
-- Invitations: pending access for an email address
-- ---------------------------------------------------------------------------
create table public.invitations (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  email           text not null
                  check (email = lower(trim(email)) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  role_id         uuid not null,
  all_outlets     boolean not null default false,
  outlet_ids      uuid[] not null default '{}',
  status          text not null default 'pending' check (status in ('pending', 'accepted', 'revoked')),
  invited_by      uuid references auth.users (id) on delete set null,
  expires_at      timestamptz not null default (now() + interval '7 days'),
  accepted_by     uuid references auth.users (id) on delete set null,
  accepted_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  foreign key (role_id, organisation_id)
    references public.roles (id, organisation_id) on delete cascade
);

create unique index invitations_one_pending_per_email
  on public.invitations (organisation_id, email) where status = 'pending';
create index invitations_pending_email_idx on public.invitations (email) where status = 'pending';
create index invitations_organisation_id_idx on public.invitations (organisation_id);

comment on table public.invitations is 'Invitation for an email address to join an organisation with a role. Valid for 7 days.';

-- ---------------------------------------------------------------------------
-- Default roles for new organisations (private: not reachable from the app).
-- Later modules add rows to default_role_permissions for their permissions.
-- ---------------------------------------------------------------------------
create table private.default_roles (
  key         text primary key,
  name        text not null,
  description text not null,
  is_system   boolean not null default false,
  sort_order  integer not null
);

insert into private.default_roles (key, name, description, is_system, sort_order) values
  ('owner',       'Owner',       'Full access to everything. Cannot be edited.', true, 10),
  ('admin',       'Admin',       'Manages settings, users and roles',            false, 20),
  ('manager',     'Manager',     'Runs one or more outlets day to day',          false, 30),
  ('storekeeper', 'Storekeeper', 'Receives, issues and counts stock',            false, 40),
  ('chef',        'Chef',        'Recipes, wastage and kitchen counts',          false, 50),
  ('purchase',    'Purchase',    'Raises and sends purchase requests',           false, 60),
  ('finance',     'Finance',     'Vendor bills and payments',                    false, 70);

create table private.default_role_permissions (
  role_key        text not null references private.default_roles (key) on delete cascade,
  permission_code text not null references public.permissions (code) on delete cascade,
  primary key (role_key, permission_code)
);

insert into private.default_role_permissions (role_key, permission_code) values
  ('admin', 'organisation.manage'),
  ('admin', 'users.manage'),
  ('admin', 'roles.manage'),
  ('admin', 'audit.view');

-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------
create trigger set_updated_at before update on public.organisations
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.outlets
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.storage_locations
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.profiles
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.roles
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.memberships
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.invitations
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- sync_version triggers (tables that sync between outlets and the cloud)
-- ---------------------------------------------------------------------------
create trigger bump_sync_version before insert or update on public.organisations
  for each row execute function private.bump_sync_version();
create trigger bump_sync_version before insert or update on public.outlets
  for each row execute function private.bump_sync_version();
create trigger bump_sync_version before insert or update on public.storage_locations
  for each row execute function private.bump_sync_version();
create trigger bump_sync_version before insert or update on public.profiles
  for each row execute function private.bump_sync_version();
create trigger bump_sync_version before insert or update on public.roles
  for each row execute function private.bump_sync_version();
create trigger bump_sync_version before insert or update on public.role_permissions
  for each row execute function private.bump_sync_version();
create trigger bump_sync_version before insert or update on public.memberships
  for each row execute function private.bump_sync_version();
create trigger bump_sync_version before insert or update on public.membership_outlets
  for each row execute function private.bump_sync_version();

-- ---------------------------------------------------------------------------
-- Row-level security on: nothing is reachable until part 2 adds policies
-- ---------------------------------------------------------------------------
alter table public.organisations      enable row level security;
alter table public.outlets            enable row level security;
alter table public.storage_locations  enable row level security;
alter table public.profiles           enable row level security;
alter table public.permissions        enable row level security;
alter table public.app_tabs           enable row level security;
alter table public.roles              enable row level security;
alter table public.role_permissions   enable row level security;
alter table public.memberships        enable row level security;
alter table public.membership_outlets enable row level security;
alter table public.invitations        enable row level security;
