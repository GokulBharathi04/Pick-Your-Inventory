# Pick your inventory — notes for Claude Code

Restaurant inventory suite by Pick your Pixel. It has three parts: the existing POS (integrated last), the inventory module, and the owner dashboard.
Full plan: https://claude.ai/artifact/6zHm58Lw3aPEpcTSZ1y5DK. It is built module by module, in the order Module 0 Foundation → 1 Masters → 2 Stock ledger → 3 Recipes and sales → 4 Procurement → 5 Accounts payable → 6 Connectivity → 7 Owner dashboard → 8 Automation → 9 POS → 10 Windows and Android.

## Stack

- Backend: Supabase (Postgres 17, Auth, row-level security, Edge Functions, Cron, Storage).
- Web app: React + TypeScript + Vite + Tailwind, a static build with no server framework. Windows (Tauri) and Android (Capacitor) wrap the same build later.
- Dev Supabase project: `ngfakbdneyluggrhijyq` (Seoul). Production will be a separate Mumbai project.

## Branches

- `main` is production and `dev` is the dev environment. Feature branches open pull requests into `dev`.
- Supabase's GitHub integration applies migrations on merge. Never apply schema changes by hand in the dashboard.

## Database rules (do not break these)

- Every schema change is a NEW file in `supabase/migrations/` named `<UTC timestamp YYYYMMDDHHMMSS>_<snake_name>.sql`. Never edit a migration that has been merged.
- Every business table has `organisation_id` and row-level security enabled, with policies that check the user's membership.
- `stock_ledger` is append-only: no UPDATE or DELETE, and corrections are reversing entries. Stock on hand is the sum of the ledger.
- Quantities are stored in the item's base unit (g, ml or pcs) as `numeric`. Money is stored as `numeric(14,2)` in rupees.
- Steps that must happen together (posting a receipt, deducting a sale, matching a bill) run as Postgres functions in one transaction.
- Deactivate rather than delete master data (items, vendors, users).

## Writing style for UI text

Sentence case, plain words, Indian number formatting (₹1,25,000) and dates as DD MMM YYYY.
