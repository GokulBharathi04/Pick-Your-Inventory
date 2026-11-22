-- Private schema for internal helper functions, such as the membership checks
-- that row-level security policies call (added in Module 0).
-- It is not exposed through the Data API: browsers cannot call anything in it
-- directly; only policies, triggers and other database functions use it.

create schema if not exists private;

revoke all on schema private from public;

-- Policies run as the signed-in user, so that role needs to reach helper
-- functions here. It still cannot create objects in this schema.
grant usage on schema private to authenticated, service_role;

comment on schema private is
  'Internal helpers for RLS policies and triggers. Not exposed via the Data API.';
