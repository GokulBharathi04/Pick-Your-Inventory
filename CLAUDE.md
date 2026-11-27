# Pick your inventory — notes for Claude Code

Restaurant inventory suite by Pick your Pixel. It has three parts: the existing POS (integrated last), the inventory module, and the owner dashboard.
Full plan: https://claude.ai/artifact/6zHm58Lw3aPEpcTSZ1y5DK. It is built module by module, in the order Module 0 Foundation → 1 Masters → 2 Stock ledger → 3 Recipes and sales → 4 Procurement → 5 Accounts payable → 6 Connectivity → 7 Owner dashboard → 8 Automation → 9 POS → 10 Windows and Android.

## Stack

- Backend: Supabase (Postgres 17, Auth, row-level security, Edge Functions, Cron, Storage).
- Web app: React + TypeScript + Vite + Tailwind, a static build with no server framework. Windows (Tauri) and Android (Capacitor) wrap the same build later.
- Dev Supabase project: `ngfakbdneyluggrhijyq` (Seoul). Production will be a separate Mumbai project.

## Branches

- `main` is production and `dev` is the dev environment. Feature branches open pull requests into `dev`.
- Always get the user's approval before committing in this repo. Show what changed and wait for a clear yes.
- GitHub Actions applies migrations: `db-check.yml` tests them on every pull request, and `db-deploy-dev.yml` runs `supabase db push` to the dev project on merge to `dev`. Never apply schema changes by hand in the dashboard or through the Supabase MCP `apply_migration` tool, because that breaks the migration history.
- The `private` schema holds internal helpers (RLS membership checks, trigger functions). It is not exposed through the Data API.

## Architecture: local-first, two-way sync

- Each outlet runs its own local system and database and works offline. The cloud hosts the owner dashboard and combines all outlets. For now everything is built and tested in Supabase.
- The same schema runs in both places. Every synced table has ONE direction, recorded in `private.sync_tables`:
  - `down` (cloud → outlet): organisation, outlets, users and access, items, vendors, prices, menu, recipes.
  - `up` (outlet → cloud): stock ledger, transfers, wastage, adjustments, counts, prep batches, sales.
- The sync engine is a later module. Its groundwork is in place: `public.sync_nodes`, `private.sync_cursors` and `private.sync_tombstones`.

## Planning stock and departments

- Planning stock (`public.planning_stock`) is the stock in an outlet's locations that receive goods (`storage_locations.receives_goods`: stores and cold rooms by default, and any kitchen or bar set to), counting every movement except `sale`, `prep_production` and `prep_consumption`. In practice it moves with goods receipts, department issues and returns, transfers, store wastage, adjustments and counts. Reorder levels and `reorder_suggestions()` use planning stock plus what is on open purchase orders.
- Departments (`public.departments`, per outlet) hold no stock. `post_department_movement` issues stock out of a store (`department_issue`, negative) or takes an end-of-day return back (`department_return`, positive). A return is capped at what that department was issued that business day, less what it has already returned. Issued minus returned is what the department used (`department_usage()`).
- Purchase orders, goods receipts, issues and returns use only locations that receive goods. An item's default location (if it receives goods) is where it is ordered to; the order screen offers only the items kept at the chosen location.
- A goods receipt against an order completes it: if less arrived, the order closes short (`Delivered short (GRN-…)`) unless the receiver keeps the rest on order (`p_keep_open`). More than ordered, and items not on the order, are always accepted. Voiding the receipt that closed an order opens it again.
- Items have a `stock_unit` (kg, g, l, ml, pcs, dozen) for display and entry; stock is still held in `base_unit`. An item with `variable_weight` (whole chicken) is kept by weight with `alt_unit` pcs at a typical weight; its receipt lines record `pieces` and the actual weight, are priced per piece or per weight, and count against a by-the-piece order line by pieces (`credited_in_base`). `piece_weights(outlet)` gives the recent average weight per piece.
- Vendor codes are given automatically per organisation (V0001, V0002, …) and can't be typed or changed.
- Issues, returns, purchase orders and goods receipts are written only by their functions. Their tables are read-only to `authenticated`. Document numbers come from `private.next_doc_no` (ISS-, RET-, PO-, GRN-).

## Database rules (do not break these)

- Every schema change is a NEW file in `supabase/migrations/` named `<UTC timestamp YYYYMMDDHHMMSS>_<snake_name>.sql`. Never edit a migration that has been merged.
- Every business table has `organisation_id` and row-level security enabled. Outlet-level tables also carry `outlet_id`. Child tables reference parents through `(id, organisation_id)` or `(id, outlet_id)`, so rows can't cross organisations or outlets.
- RLS policies use the helpers in `private`: `my_organisation_ids()`, `org_ids_with(permission)`, `outlet_ids_with(permission)`, `my_outlet_ids()`. Owners implicitly hold every permission.
- Table privileges are explicit: `anon` gets nothing, `authenticated` gets only the needed columns (column-level `grant insert (...)` / `grant update (...)`).
- Every synced table has `sync_version bigint` stamped by the `bump_sync_version` trigger, plus a row in `private.sync_tables`. Tables that allow DELETE (line tables) also get the `record_tombstone` trigger.
- `stock_ledger` is append-only: the database refuses UPDATE, DELETE and TRUNCATE, and corrections are reversing entries (`reverses_entry_id`). Stock on hand is the sum of the ledger (`stock_on_hand`, `outlet_stock` views). Users never insert ledger rows directly; posting functions do.
- Quantities are stored in the item's base unit (g, ml or pcs) as `numeric`. Use `private.to_base_qty(item, qty, unit)` to convert. Amounts are `numeric(14,2)` in rupees; rates per base unit are `numeric(18,6)`.
- Steps that must happen together (posting a receipt, deducting a sale, matching a bill) run as Postgres functions in one transaction.
- Deactivate rather than delete master data (items, vendors, users).
- A new module adds its permission codes to `public.permissions`, its default role grants to `private.default_role_permissions` (and backfills existing roles), and its side-menu tabs to `public.app_tabs`.
- Recipes are versioned: only drafts change, one version is active, activating retires the previous one.

## Web app and Edge Functions

- `apps/web` is the web app. One page per `public.app_tabs` key; a tab shows when the role holds its `view_permission`. Hash routing (`#/items`) so the static build works on GitHub Pages and in the wrappers.
- Screens never write stock rows: they call the posting functions (`post_wastage`, `send_stock_transfer`, `post_sales_import`, …). Masters are plain table writes that RLS and column grants check.
- Edge Functions live in `supabase/functions/` and deploy with `db-deploy-dev.yml` on merge to `dev`. They run with `verify_jwt = false` (the new API keys aren't JWTs), so each function checks the caller itself and does permission checks in the database as the caller.
- `web-check.yml` type-checks and builds the app on pull requests; the Pages workflow publishes it from `dev`.

## Tests

- pgTAP tests live in `supabase/tests/database/*.test.sql` and run in CI with `supabase test db`. Add tests for every new rule, especially RLS isolation between organisations and outlets.

## Writing style for UI text

Sentence case, plain words, Indian number formatting (₹1,25,000) and dates as DD MMM YYYY.
