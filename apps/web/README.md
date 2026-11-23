# Web app

React + TypeScript + Vite + Tailwind. A static build with no server: it talks
to Supabase directly, and row-level security decides what each person sees.
Windows (Tauri) and Android (Capacitor) wrap this same build later.

## Run it

```sh
cd apps/web
npm install
npm run dev        # http://localhost:5173, against the dev project
npm run build      # type-check and build into dist/
```

It reads `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` from
`apps/web/.env.local` (see `.env.example`) and falls back to the dev project.

## What's in it (inventory, standalone)

| Area | Screens |
| --- | --- |
| Setup | Sign in, home with getting-started checklist, settings (business, outlets, storage locations, departments), users (staff logins), roles (permissions and the tabs they open) |
| Masters | Items (details, pack sizes, per-outlet reorder settings, vendor rates), item categories, vendors and price lists, CSV import (items, vendors, rates, opening stock) |
| Stock | Stock on hand (store planning stock, by item, by location), stock card, issues to departments and end-of-day returns (with what each department used), opening stock and adjustments (request and approve), transfers (send, receive, cancel), wastage and staff meals (record, void), counts (blind count sheet, submit, approve) |
| Purchasing | Reorder planning (items at their reorder level, one draft order per vendor), purchase orders (draft, submit, approve or send back, cancel, close short), goods receipts (against an order or without one, extra quantities, void) |
| Kitchen and sales | Menu and recipes (versioned recipe builder with live cost), prep recipes, prep production, sales entry and CSV upload with matching |
| Reports | Stock valuation, movement summary, movement history, consumption, theoretical against actual usage, wastage, count variance, sales by dish, food cost per dish; every report exports to CSV |

## How it's built

- `src/lib/` — Supabase client and error text, signed-in user's access (`my_access()`), masters cache, units, formatting (₹1,25,000, DD MMM YYYY), CSV, hash router.
- `src/components/` — shared UI (buttons, fields, tables, dialogs, toasts) and inputs (item picker, quantity with unit).
- `src/pages/` — one file per side-menu tab. Tabs come from `public.app_tabs` and show only when the role holds the tab's permission.
- Stock never changes from the browser directly: screens call the posting functions (`post_wastage`, `send_stock_transfer`, `post_sales_import`, …), which write the stock ledger.
- Staff logins are created by the `create-staff-user` Edge Function (`supabase/functions/`), which then calls `add_staff_member` as the signed-in manager.
