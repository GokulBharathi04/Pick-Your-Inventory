-- Sync groundwork: how outlet systems and the cloud keep each other up to date.
--
-- Each outlet runs its own local database. On each sync:
--   down  (cloud -> outlet): organisation, outlets, users and access, items,
--                            vendors, prices, menu and recipes
--   up    (outlet -> cloud): stock movements, wastage, counts, prep, sales
-- Every table has exactly one direction, so the two sides never edit the same
-- record. The sync engine itself is a later module; this migration adds the
-- tables it needs:
--   public.sync_nodes        each outlet's local system, registered with the cloud
--   private.sync_cursors     how far each node has synced each table
--   private.sync_tombstones  deleted rows, so deletions sync too
--   private.sync_tables      which way each table syncs

-- ---------------------------------------------------------------------------
-- Nodes: one active local system per outlet
-- ---------------------------------------------------------------------------
create table public.sync_nodes (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null,
  outlet_id       uuid not null,
  name            text not null check (length(trim(name)) between 1 and 80),
  api_key_hash    text,
  app_version     text,
  last_push_at    timestamptz,
  last_pull_at    timestamptz,
  last_seen_at    timestamptz,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  foreign key (outlet_id, organisation_id)
    references public.outlets (id, organisation_id) on delete restrict
);

create unique index sync_nodes_one_active_per_outlet on public.sync_nodes (outlet_id) where is_active;
create index sync_nodes_organisation_id_idx on public.sync_nodes (organisation_id);

create trigger set_updated_at before update on public.sync_nodes
  for each row execute function private.set_updated_at();

comment on table public.sync_nodes is 'Local system of an outlet, registered with the cloud. Written only by the sync engine.';

alter table public.sync_nodes enable row level security;

revoke all on table public.sync_nodes from anon, authenticated;
grant select (id, organisation_id, outlet_id, name, app_version, last_push_at, last_pull_at,
              last_seen_at, is_active, created_at, updated_at)
  on public.sync_nodes to authenticated;

create policy "Organisation managers can see sync status"
  on public.sync_nodes for select to authenticated
  using (organisation_id in (select private.org_ids_with('organisation.manage')));

-- ---------------------------------------------------------------------------
-- Which way each table syncs
-- ---------------------------------------------------------------------------
create table private.sync_tables (
  table_name text primary key,
  direction  text not null check (direction in ('down', 'up')),
  scope      text not null check (scope in ('organisation', 'outlet')),
  note       text
);

insert into private.sync_tables (table_name, direction, scope, note) values
  ('organisations',      'down', 'organisation', null),
  ('outlets',            'down', 'organisation', null),
  ('storage_locations',  'down', 'organisation', null),
  ('profiles',           'down', 'organisation', 'Profiles of members only'),
  ('roles',              'down', 'organisation', null),
  ('role_permissions',   'down', 'organisation', null),
  ('memberships',        'down', 'organisation', null),
  ('membership_outlets', 'down', 'organisation', null);

-- ---------------------------------------------------------------------------
-- Cursors: the last sync_version each node has sent (up) or received (down)
-- ---------------------------------------------------------------------------
create table private.sync_cursors (
  node_id           uuid not null references public.sync_nodes (id) on delete cascade,
  direction         text not null check (direction in ('down', 'up')),
  table_name        text not null references private.sync_tables (table_name),
  last_sync_version bigint not null default 0,
  updated_at        timestamptz not null default now(),
  primary key (node_id, direction, table_name)
);

-- ---------------------------------------------------------------------------
-- Tombstones: a record of deleted rows (only link tables allow deletes;
-- everything else is deactivated instead)
-- ---------------------------------------------------------------------------
create table private.sync_tombstones (
  id              bigint generated always as identity primary key,
  table_name      text not null,
  record_key      jsonb not null,
  organisation_id uuid,
  outlet_id       uuid,
  sync_version    bigint not null default nextval('private.sync_version_seq'),
  deleted_at      timestamptz not null default now()
);

create index sync_tombstones_version_idx on private.sync_tombstones (table_name, sync_version);

-- Trigger arguments: the primary-key column names of the table.
create or replace function private.record_tombstone()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old jsonb := to_jsonb(old);
  v_key jsonb := '{}'::jsonb;
  v_col text;
begin
  foreach v_col in array tg_argv loop
    v_key := v_key || jsonb_build_object(v_col, v_old -> v_col);
  end loop;
  insert into private.sync_tombstones (table_name, record_key, organisation_id, outlet_id)
  values (tg_table_name, v_key, (v_old ->> 'organisation_id')::uuid, (v_old ->> 'outlet_id')::uuid);
  return old;
end;
$$;

revoke all on function private.record_tombstone() from public;

create trigger record_tombstone after delete on public.role_permissions
  for each row execute function private.record_tombstone('role_id', 'permission_code');
create trigger record_tombstone after delete on public.membership_outlets
  for each row execute function private.record_tombstone('membership_id', 'outlet_id');

-- The sync engine runs as service_role.
grant usage on schema private to service_role;
grant select on private.sync_tables to service_role;
grant select, insert, update, delete on private.sync_cursors to service_role;
grant select on private.sync_tombstones to service_role;
grant usage, select on sequence private.sync_version_seq to service_role;
