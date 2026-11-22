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

## Tests

- pgTAP tests live in `supabase/tests/database/*.test.sql` and run in CI with `supabase test db`. Add tests for every new rule, especially RLS isolation between organisations and outlets.

## Writing style for UI text

Sentence case, plain words, Indian number formatting (₹1,25,000) and dates as DD MMM YYYY.
