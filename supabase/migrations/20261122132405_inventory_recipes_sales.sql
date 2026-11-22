-- Inventory, part 3 of 3: menu, recipes, prep production and sales (Module 3).
--
-- Menu items and recipes are set in the cloud and sync DOWN. Recipes are
-- versioned: only a draft can be edited, one version is active at a time,
-- and a sale records the version it used. A recipe line can use a prep item
-- (gravy base, marinade), whose own recipe is expanded when stock is deducted.
--
-- Prep batches and sales are recorded at the outlet and sync UP. Deducting
-- ingredients from the ledger happens in posting functions (next step).

-- ---------------------------------------------------------------------------
-- Menu
-- ---------------------------------------------------------------------------
create table public.menu_categories (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete restrict,
  name            text not null check (length(trim(name)) between 1 and 60),
  sort_order      integer not null default 100,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  sync_version    bigint not null default 0,
  unique (id, organisation_id)
);

create unique index menu_categories_organisation_name_key
  on public.menu_categories (organisation_id, lower(name));

create table public.menu_items (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete restrict,
  category_id     uuid,
  code            text check (code is null or code ~ '^[A-Za-z0-9_.-]{1,30}$'),
  name            text not null check (length(trim(name)) between 1 and 120),
  selling_price   numeric(14,2) not null default 0 check (selling_price >= 0),
  gst_rate        numeric(5,2) check (gst_rate is null or (gst_rate >= 0 and gst_rate <= 100)),
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  sync_version    bigint not null default 0,
  unique (id, organisation_id),
  unique (organisation_id, code),
  foreign key (category_id, organisation_id)
    references public.menu_categories (id, organisation_id) on delete restrict
);

create unique index menu_items_organisation_name_key on public.menu_items (organisation_id, lower(name));
create index menu_items_category_id_idx on public.menu_items (category_id);

comment on column public.menu_items.code is 'Matches the POS item code (Module 9). Portion sizes such as half and full are separate menu items.';

-- Which outlets sell an item, with an optional outlet price.
create table public.menu_item_outlets (
  organisation_id uuid not null,
  menu_item_id    uuid not null,
  outlet_id       uuid not null,
  selling_price   numeric(14,2) check (selling_price is null or selling_price >= 0),
  is_available    boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  sync_version    bigint not null default 0,
  primary key (menu_item_id, outlet_id),
  foreign key (menu_item_id, organisation_id)
    references public.menu_items (id, organisation_id) on delete restrict,
  foreign key (outlet_id, organisation_id)
    references public.outlets (id, organisation_id) on delete restrict
);

create index menu_item_outlets_outlet_id_idx on public.menu_item_outlets (outlet_id);
create index menu_item_outlets_organisation_id_idx on public.menu_item_outlets (organisation_id);

-- ---------------------------------------------------------------------------
-- Recipes (versioned) and recipe lines
-- ---------------------------------------------------------------------------
create table public.recipes (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null,
  menu_item_id    uuid,
  prep_item_id    uuid,
  version         integer not null default 1 check (version > 0),
  -- Menu recipe: portions made (usually 1). Prep recipe: base units of the
  -- prep item one batch yields, e.g. 5000 g of gravy base.
  yield_qty       numeric not null default 1 check (yield_qty > 0),
  status          text not null default 'draft' check (status in ('draft', 'active', 'retired')),
  activated_at    timestamptz,
  note            text,
  created_by      uuid default auth.uid() references auth.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  sync_version    bigint not null default 0,
  unique (id, organisation_id),
  unique (id, prep_item_id),
  check (num_nonnulls(menu_item_id, prep_item_id) = 1),
  foreign key (menu_item_id, organisation_id)
    references public.menu_items (id, organisation_id) on delete restrict,
  foreign key (prep_item_id, organisation_id)
    references public.items (id, organisation_id) on delete restrict
);

create unique index recipes_menu_item_version_key on public.recipes (menu_item_id, version)
  where menu_item_id is not null;
create unique index recipes_prep_item_version_key on public.recipes (prep_item_id, version)
  where prep_item_id is not null;
create unique index recipes_one_active_per_menu_item on public.recipes (menu_item_id)
  where status = 'active' and menu_item_id is not null;
create unique index recipes_one_active_per_prep_item on public.recipes (prep_item_id)
  where status = 'active' and prep_item_id is not null;
create index recipes_organisation_id_idx on public.recipes (organisation_id);

create table public.recipe_lines (
  id               uuid primary key default gen_random_uuid(),
  organisation_id  uuid not null,
  recipe_id        uuid not null,
  item_id          uuid not null,
  quantity         numeric not null check (quantity > 0),
  unit             text not null references public.units (code),
  -- Overrides the item's default usable yield for this recipe.
  yield_pct        numeric(5,2) check (yield_pct is null or (yield_pct > 0 and yield_pct <= 100)),
  -- Gross base units deducted per recipe yield, including yield loss.
  quantity_in_base numeric not null check (quantity_in_base > 0),
  sort_order       integer not null default 100,
  note             text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  sync_version     bigint not null default 0,
  unique (recipe_id, item_id),
  foreign key (recipe_id, organisation_id)
    references public.recipes (id, organisation_id) on delete cascade,
  foreign key (item_id, organisation_id)
    references public.items (id, organisation_id) on delete restrict
);

create index recipe_lines_item_id_idx on public.recipe_lines (item_id);
create index recipe_lines_organisation_id_idx on public.recipe_lines (organisation_id);

-- A prep recipe must be for a prep item. Only drafts change; activating a
-- version retires the previous active one; retired is final.
create or replace function private.guard_recipe()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.prep_item_id is not null
     and not exists (select 1 from public.items i where i.id = new.prep_item_id and i.item_type = 'prep') then
    raise exception 'A prep recipe must be for an item of type prep' using errcode = '22023';
  end if;

  if tg_op = 'UPDATE' then
    if old.status = 'retired' then
      raise exception 'A retired recipe cannot change; create a new version' using errcode = '55000';
    end if;
    if old.status = 'active' and (
         new.status not in ('active', 'retired')
         or new.yield_qty is distinct from old.yield_qty
         or new.menu_item_id is distinct from old.menu_item_id
         or new.prep_item_id is distinct from old.prep_item_id
         or new.version is distinct from old.version) then
      raise exception 'An active recipe cannot be edited; create a new version' using errcode = '55000';
    end if;
  end if;

  if new.status = 'active' and (tg_op = 'INSERT' or old.status <> 'active') then
    new.activated_at := now();
    update public.recipes r set status = 'retired'
    where r.status = 'active' and r.id <> new.id
      and ((new.menu_item_id is not null and r.menu_item_id = new.menu_item_id)
        or (new.prep_item_id is not null and r.prep_item_id = new.prep_item_id));
  end if;

  return new;
end;
$$;

revoke all on function private.guard_recipe() from public;

create trigger guard_recipe before insert or update on public.recipes
  for each row execute function private.guard_recipe();

create or replace function private.recipe_is_draft(p_recipe_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select r.status = 'draft' from public.recipes r where r.id = p_recipe_id), false);
$$;

-- Converts a recipe line to gross base units and blocks prep-item cycles
-- (gravy uses masala, masala uses gravy).
create or replace function private.prepare_recipe_line()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_target_prep uuid;
  v_yield numeric;
begin
  select coalesce(new.yield_pct, i.default_yield_pct) into v_yield
  from public.items i where i.id = new.item_id;

  new.quantity_in_base := round(private.to_base_qty(new.item_id, new.quantity, new.unit) * 100 / v_yield, 6);

  select r.prep_item_id into v_target_prep from public.recipes r where r.id = new.recipe_id;

  if v_target_prep is not null then
    if new.item_id = v_target_prep then
      raise exception 'A prep recipe cannot use its own prep item' using errcode = '22023';
    end if;

    if exists (
      with recursive used(item_id) as (
        select new.item_id
        union
        select rl.item_id
        from used u
        join public.recipes r on r.prep_item_id = u.item_id and r.status in ('draft', 'active')
        join public.recipe_lines rl on rl.recipe_id = r.id
      )
      select 1 from used where item_id = v_target_prep
    ) then
      raise exception 'This would make a loop: the ingredient''s own recipe already uses this prep item'
        using errcode = '22023';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function private.prepare_recipe_line() from public;

create trigger prepare_recipe_line before insert or update on public.recipe_lines
  for each row execute function private.prepare_recipe_line();

-- ---------------------------------------------------------------------------
-- Prep production (posted by a function with its ledger rows)
-- ---------------------------------------------------------------------------
create table public.prep_batches (
  id                uuid primary key default gen_random_uuid(),
  organisation_id   uuid not null,
  outlet_id         uuid not null,
  location_id       uuid not null,
  prep_item_id      uuid not null,
  recipe_id         uuid not null,
  batches           numeric not null check (batches > 0),
  quantity_produced numeric not null check (quantity_produced > 0),
  note              text,
  produced_by       uuid default auth.uid() references auth.users (id) on delete set null,
  produced_at       timestamptz not null default now(),
  voided_at         timestamptz,
  voided_by         uuid references auth.users (id) on delete set null,
  void_reason       text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  sync_version      bigint not null default 0,
  check (voided_at is null or void_reason is not null),
  foreign key (outlet_id, organisation_id)
    references public.outlets (id, organisation_id) on delete restrict,
  foreign key (location_id, outlet_id)
    references public.storage_locations (id, outlet_id) on delete restrict,
  foreign key (prep_item_id, organisation_id)
    references public.items (id, organisation_id) on delete restrict,
  foreign key (recipe_id, prep_item_id)
    references public.recipes (id, prep_item_id) on delete restrict
);

create index prep_batches_outlet_time_idx on public.prep_batches (outlet_id, produced_at);
create index prep_batches_organisation_id_idx on public.prep_batches (organisation_id);

-- ---------------------------------------------------------------------------
-- Sales entry: manual or CSV now, the POS feed later (same tables)
-- ---------------------------------------------------------------------------
create table public.sales_imports (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null,
  outlet_id       uuid not null,
  business_date   date not null,
  source          text not null default 'manual' check (source in ('manual', 'csv', 'pos')),
  source_ref      text check (source_ref is null or length(source_ref) <= 120),
  -- One import per outlet, source, date and reference: a repeat is refused,
  -- so the same sales are never deducted twice.
  idempotency_key text not null,
  status          text not null default 'draft' check (status in ('draft', 'posted', 'voided')),
  line_count      integer not null default 0 check (line_count >= 0),
  total_amount    numeric(14,2) not null default 0,
  note            text,
  created_by      uuid default auth.uid() references auth.users (id) on delete set null,
  posted_by       uuid references auth.users (id) on delete set null,
  posted_at       timestamptz,
  voided_by       uuid references auth.users (id) on delete set null,
  voided_at       timestamptz,
  void_reason     text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  sync_version    bigint not null default 0,
  unique (id, outlet_id),
  unique (outlet_id, idempotency_key),
  check (voided_at is null or void_reason is not null),
  foreign key (outlet_id, organisation_id)
    references public.outlets (id, organisation_id) on delete restrict
);

create index sales_imports_outlet_date_idx on public.sales_imports (outlet_id, business_date);
create index sales_imports_organisation_id_idx on public.sales_imports (organisation_id);

create or replace function private.set_sales_import_key()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.idempotency_key := new.source || ':' || to_char(new.business_date, 'YYYY-MM-DD')
                         || ':' || coalesce(new.source_ref, '');
  return new;
end;
$$;

create trigger set_sales_import_key before insert or update of source, business_date, source_ref
  on public.sales_imports
  for each row execute function private.set_sales_import_key();

create table public.sales_lines (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null,
  outlet_id       uuid not null,
  sales_import_id uuid not null,
  menu_item_id    uuid,
  pos_item_code   text,
  item_name       text not null check (length(trim(item_name)) between 1 and 120),
  quantity        numeric not null check (quantity > 0),
  unit_price      numeric(14,2) not null default 0 check (unit_price >= 0),
  amount          numeric(14,2) not null default 0 check (amount >= 0),
  recipe_id       uuid,
  sold_at         timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  sync_version    bigint not null default 0,
  foreign key (sales_import_id, outlet_id)
    references public.sales_imports (id, outlet_id) on delete cascade,
  foreign key (outlet_id, organisation_id)
    references public.outlets (id, organisation_id) on delete restrict,
  foreign key (menu_item_id, organisation_id)
    references public.menu_items (id, organisation_id) on delete restrict,
  foreign key (recipe_id, organisation_id)
    references public.recipes (id, organisation_id) on delete restrict
);

create index sales_lines_import_id_idx on public.sales_lines (sales_import_id);
create index sales_lines_menu_item_id_idx on public.sales_lines (menu_item_id);
create index sales_lines_organisation_id_idx on public.sales_lines (organisation_id);

comment on column public.sales_lines.menu_item_id is 'Null until the line is matched to a menu item; unmatched lines are held, not deducted.';
comment on column public.sales_lines.recipe_id is 'Recipe version used for the deduction, set when the import is posted.';

create or replace function private.sales_import_is_draft(p_sales_import_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select s.status = 'draft' from public.sales_imports s where s.id = p_sales_import_id), false);
$$;

revoke all on function private.recipe_is_draft(uuid) from public;
revoke all on function private.sales_import_is_draft(uuid) from public;
grant execute on function private.recipe_is_draft(uuid) to authenticated, service_role;
grant execute on function private.sales_import_is_draft(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Triggers: updated_at, sync_version, tombstones for deletable lines
-- ---------------------------------------------------------------------------
create trigger set_updated_at before update on public.menu_categories
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.menu_items
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.menu_item_outlets
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.recipes
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.recipe_lines
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.prep_batches
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.sales_imports
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.sales_lines
  for each row execute function private.set_updated_at();

create trigger bump_sync_version before insert or update on public.menu_categories
  for each row execute function private.bump_sync_version();
create trigger bump_sync_version before insert or update on public.menu_items
  for each row execute function private.bump_sync_version();
create trigger bump_sync_version before insert or update on public.menu_item_outlets
  for each row execute function private.bump_sync_version();
create trigger bump_sync_version before insert or update on public.recipes
  for each row execute function private.bump_sync_version();
create trigger bump_sync_version before insert or update on public.recipe_lines
  for each row execute function private.bump_sync_version();
create trigger bump_sync_version before insert or update on public.prep_batches
  for each row execute function private.bump_sync_version();
create trigger bump_sync_version before insert or update on public.sales_imports
  for each row execute function private.bump_sync_version();
create trigger bump_sync_version before insert or update on public.sales_lines
  for each row execute function private.bump_sync_version();

create trigger record_tombstone after delete on public.recipe_lines
  for each row execute function private.record_tombstone('id');
create trigger record_tombstone after delete on public.sales_lines
  for each row execute function private.record_tombstone('id');

insert into private.sync_tables (table_name, direction, scope) values
  ('menu_categories',   'down', 'organisation'),
  ('menu_items',        'down', 'organisation'),
  ('menu_item_outlets', 'down', 'organisation'),
  ('recipes',           'down', 'organisation'),
  ('recipe_lines',      'down', 'organisation'),
  ('prep_batches',      'up',   'outlet'),
  ('sales_imports',     'up',   'outlet'),
  ('sales_lines',       'up',   'outlet');

-- ---------------------------------------------------------------------------
-- Privileges and row-level security
-- ---------------------------------------------------------------------------
alter table public.menu_categories   enable row level security;
alter table public.menu_items        enable row level security;
alter table public.menu_item_outlets enable row level security;
alter table public.recipes           enable row level security;
alter table public.recipe_lines      enable row level security;
alter table public.prep_batches      enable row level security;
alter table public.sales_imports     enable row level security;
alter table public.sales_lines       enable row level security;

revoke all on table
  public.menu_categories, public.menu_items, public.menu_item_outlets, public.recipes,
  public.recipe_lines, public.prep_batches, public.sales_imports, public.sales_lines
from anon, authenticated;

grant select on public.menu_categories to authenticated;
grant insert (organisation_id, name, sort_order) on public.menu_categories to authenticated;
grant update (name, sort_order, is_active) on public.menu_categories to authenticated;

grant select on public.menu_items to authenticated;
grant insert (organisation_id, category_id, code, name, selling_price, gst_rate) on public.menu_items to authenticated;
grant update (category_id, code, name, selling_price, gst_rate, is_active) on public.menu_items to authenticated;

grant select on public.menu_item_outlets to authenticated;
grant insert (organisation_id, menu_item_id, outlet_id, selling_price, is_available)
  on public.menu_item_outlets to authenticated;
grant update (selling_price, is_available) on public.menu_item_outlets to authenticated;

grant select on public.recipes to authenticated;
grant insert (organisation_id, menu_item_id, prep_item_id, version, yield_qty, note)
  on public.recipes to authenticated;
grant update (yield_qty, status, note) on public.recipes to authenticated;

grant select, delete on public.recipe_lines to authenticated;
grant insert (organisation_id, recipe_id, item_id, quantity, unit, yield_pct, sort_order, note)
  on public.recipe_lines to authenticated;
grant update (quantity, unit, yield_pct, sort_order, note) on public.recipe_lines to authenticated;

grant select on public.prep_batches to authenticated;

grant select on public.sales_imports to authenticated;
grant insert (organisation_id, outlet_id, business_date, source, source_ref, note)
  on public.sales_imports to authenticated;
grant update (business_date, source_ref, note) on public.sales_imports to authenticated;

grant select, delete on public.sales_lines to authenticated;
grant insert (organisation_id, outlet_id, sales_import_id, menu_item_id, pos_item_code, item_name,
              quantity, unit_price, amount, sold_at)
  on public.sales_lines to authenticated;
grant update (menu_item_id, pos_item_code, item_name, quantity, unit_price, amount, sold_at)
  on public.sales_lines to authenticated;

-- Menu: readable by recipe viewers and by people who enter or view sales.
create policy "Menu readers can read menu categories"
  on public.menu_categories for select to authenticated
  using (organisation_id in (select private.org_ids_with('recipes.view'))
         or organisation_id in (select private.org_ids_with('sales.record'))
         or organisation_id in (select private.org_ids_with('sales.view')));
create policy "Recipe editors can add menu categories"
  on public.menu_categories for insert to authenticated
  with check (organisation_id in (select private.org_ids_with('recipes.edit')));
create policy "Recipe editors can edit menu categories"
  on public.menu_categories for update to authenticated
  using (organisation_id in (select private.org_ids_with('recipes.edit')))
  with check (organisation_id in (select private.org_ids_with('recipes.edit')));

create policy "Menu readers can read menu items"
  on public.menu_items for select to authenticated
  using (organisation_id in (select private.org_ids_with('recipes.view'))
         or organisation_id in (select private.org_ids_with('sales.record'))
         or organisation_id in (select private.org_ids_with('sales.view')));
create policy "Recipe editors can add menu items"
  on public.menu_items for insert to authenticated
  with check (organisation_id in (select private.org_ids_with('recipes.edit')));
create policy "Recipe editors can edit menu items"
  on public.menu_items for update to authenticated
  using (organisation_id in (select private.org_ids_with('recipes.edit')))
  with check (organisation_id in (select private.org_ids_with('recipes.edit')));

create policy "Menu readers can read outlet menus"
  on public.menu_item_outlets for select to authenticated
  using (organisation_id in (select private.org_ids_with('recipes.view'))
         or outlet_id in (select private.outlet_ids_with('sales.record'))
         or outlet_id in (select private.outlet_ids_with('sales.view')));
create policy "Recipe editors can set outlet menus"
  on public.menu_item_outlets for insert to authenticated
  with check (organisation_id in (select private.org_ids_with('recipes.edit')));
create policy "Recipe editors can edit outlet menus"
  on public.menu_item_outlets for update to authenticated
  using (organisation_id in (select private.org_ids_with('recipes.edit')))
  with check (organisation_id in (select private.org_ids_with('recipes.edit')));

-- Recipes: recipe viewers read; editors create versions, edit drafts,
-- activate and retire. Lines change only while the recipe is a draft.
create policy "Recipe viewers can read recipes"
  on public.recipes for select to authenticated
  using (organisation_id in (select private.org_ids_with('recipes.view'))
         or organisation_id in (select private.org_ids_with('recipes.edit')));
create policy "Recipe editors can create recipe versions"
  on public.recipes for insert to authenticated
  with check (organisation_id in (select private.org_ids_with('recipes.edit')) and status = 'draft');
create policy "Recipe editors can update recipes"
  on public.recipes for update to authenticated
  using (organisation_id in (select private.org_ids_with('recipes.edit')))
  with check (organisation_id in (select private.org_ids_with('recipes.edit')));

create policy "Recipe viewers can read recipe lines"
  on public.recipe_lines for select to authenticated
  using (organisation_id in (select private.org_ids_with('recipes.view'))
         or organisation_id in (select private.org_ids_with('recipes.edit')));
create policy "Recipe editors can add lines to draft recipes"
  on public.recipe_lines for insert to authenticated
  with check (organisation_id in (select private.org_ids_with('recipes.edit'))
              and private.recipe_is_draft(recipe_id));
create policy "Recipe editors can edit lines of draft recipes"
  on public.recipe_lines for update to authenticated
  using (organisation_id in (select private.org_ids_with('recipes.edit'))
         and private.recipe_is_draft(recipe_id))
  with check (organisation_id in (select private.org_ids_with('recipes.edit'))
              and private.recipe_is_draft(recipe_id));
create policy "Recipe editors can remove lines of draft recipes"
  on public.recipe_lines for delete to authenticated
  using (organisation_id in (select private.org_ids_with('recipes.edit'))
         and private.recipe_is_draft(recipe_id));

create policy "Producers and stock viewers can read prep batches"
  on public.prep_batches for select to authenticated
  using (outlet_id in (select private.outlet_ids_with('production.record'))
         or outlet_id in (select private.outlet_ids_with('stock.view')));

-- Sales: viewers read; recorders create drafts and edit them until posted.
create policy "Sales viewers and recorders can read sales imports"
  on public.sales_imports for select to authenticated
  using (outlet_id in (select private.outlet_ids_with('sales.view'))
         or outlet_id in (select private.outlet_ids_with('sales.record')));
create policy "Sales recorders can start sales imports"
  on public.sales_imports for insert to authenticated
  with check (outlet_id in (select private.outlet_ids_with('sales.record')) and status = 'draft');
create policy "Sales recorders can edit draft sales imports"
  on public.sales_imports for update to authenticated
  using (outlet_id in (select private.outlet_ids_with('sales.record')) and status = 'draft')
  with check (outlet_id in (select private.outlet_ids_with('sales.record')) and status = 'draft');

create policy "Sales viewers and recorders can read sales lines"
  on public.sales_lines for select to authenticated
  using (outlet_id in (select private.outlet_ids_with('sales.view'))
         or outlet_id in (select private.outlet_ids_with('sales.record')));
create policy "Sales recorders can add lines to draft imports"
  on public.sales_lines for insert to authenticated
  with check (outlet_id in (select private.outlet_ids_with('sales.record'))
              and private.sales_import_is_draft(sales_import_id));
create policy "Sales recorders can edit lines of draft imports"
  on public.sales_lines for update to authenticated
  using (outlet_id in (select private.outlet_ids_with('sales.record'))
         and private.sales_import_is_draft(sales_import_id))
  with check (outlet_id in (select private.outlet_ids_with('sales.record'))
              and private.sales_import_is_draft(sales_import_id));
create policy "Sales recorders can remove lines of draft imports"
  on public.sales_lines for delete to authenticated
  using (outlet_id in (select private.outlet_ids_with('sales.record'))
         and private.sales_import_is_draft(sales_import_id));
