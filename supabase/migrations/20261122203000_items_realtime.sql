-- Broadcast changes to public.items over Supabase Realtime, so the item master
-- list updates live when anyone in the organisation adds or edits an item.
-- Realtime still applies the table's row-level security: a user only receives
-- rows from organisations they can read.
--
-- Idempotent: this was first applied to the dev project by hand on 22 Nov 2026,
-- so it must not fail when the table is already in the publication.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'items'
  ) then
    alter publication supabase_realtime add table public.items;
  end if;
end $$;
