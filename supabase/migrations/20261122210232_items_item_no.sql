-- Human-readable item number (1000, 1001, ...) from public.item_id_seq.
-- items.id stays a UUID: eleven tables reference it and the sync design
-- needs ids that outlets can create offline without clashing.
--
-- item_no is assigned by the cloud database only. Users can read it but not
-- set or change it: it is not in the column-level INSERT or UPDATE grants.
--
-- The sequence was first created on dev by hand, so this is written to be
-- safe when it already exists.

create sequence if not exists public.item_id_seq as bigint start with 1000;

alter table public.items add column if not exists item_no bigint;
alter sequence public.item_id_seq owned by public.items.item_no;

-- Number existing items in the order they were created.
update public.items i
set item_no = s.n
from (
  select id, nextval('public.item_id_seq') as n
  from (select id from public.items where item_no is null order by created_at, id) ordered
) s
where i.id = s.id;

alter table public.items
  alter column item_no set default nextval('public.item_id_seq'),
  alter column item_no set not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'items_item_no_key' and conrelid = 'public.items'::regclass) then
    alter table public.items add constraint items_item_no_key unique (item_no);
  end if;
end $$;

-- The column default calls nextval() as the inserting user, so signed-in
-- users need USAGE on the sequence. Row-level security still decides
-- whether the insert is allowed.
grant usage on sequence public.item_id_seq to authenticated;

comment on column public.items.item_no is
  'Human-readable item number from item_id_seq, starting at 1000. Assigned by the cloud database; not editable.';
