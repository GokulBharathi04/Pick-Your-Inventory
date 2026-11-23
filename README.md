# Pick your inventory

Restaurant inventory, procurement and owner dashboard, built by Pick your Pixel.

- **Blueprint:** [Pick your inventory — Detailed build blueprint](https://claude.ai/artifact/6zHm58Lw3aPEpcTSZ1y5DK). It covers the modules, data model and build order.
- **Status:** the database for Modules 0 to 3 (foundation, masters, stock ledger, recipes and sales) is on the dev project, and the web app in `apps/web` covers every inventory form and report for testing. Module 4 (procurement: reorder planning, purchase orders, goods receipts) and department issues and end-of-day returns are built; store stock is now the planning stock. Accounts payable (Module 5) is next.

## Environments

| Environment | Git branch | Supabase project | Region |
| --- | --- | --- | --- |
| Dev | `dev` | `ngfakbdneyluggrhijyq` | Seoul (ap-northeast-2) |
| Production | `main` | To be created before the first client | Mumbai (ap-south-1) |

Dev API URL: `https://ngfakbdneyluggrhijyq.supabase.co`

## How database changes reach Supabase

1. Every change is a new SQL file in `supabase/migrations/`, named `<timestamp>_<what_it_does>.sql`. No one edits tables by hand in the Supabase dashboard.
2. Work on a feature branch and open a pull request into `dev`. The **Check database migrations** workflow applies every migration to a fresh database and must pass.
3. Merging into `dev` runs **Deploy database (dev)**, which applies the new migrations to the dev project with the Supabase CLI.
4. When a release is ready, open a pull request from `dev` into `main`. A production deploy workflow for the Mumbai project is added when that project is created.

### One-time setup: repository secrets

The deploy workflow needs two secrets under GitHub **Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Where to get it |
| --- | --- |
| `SUPABASE_ACCESS_TOKEN_GIT` | Supabase dashboard → your avatar → **Account preferences → Access tokens → Generate new token** |
| `DEV_DB_PASSWORD` | The database password chosen when the dev project was created. If it's lost, reset it in **Project Settings → Database**. |

Run the workflow by hand at any time from the **Actions** tab (**Deploy database (dev) → Run workflow**).

## Local setup (optional)

Requires the [Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started) and Docker.

```bash
supabase start                                   # local Postgres, Auth and Studio
supabase db reset                                # rebuild local DB from migrations + seed.sql
supabase link --project-ref ngfakbdneyluggrhijyq # link to the dev project
```

Copy `.env.example` to `apps/web/.env.local` to point the web app at a different project. See `apps/web/README.md`.

## Repository layout

```
.github/workflows/
  db-check.yml     checks migrations on every pull request
  db-deploy-dev.yml  applies migrations and deploys Edge Functions to the dev project on merge to dev
  web-check.yml    type-checks and builds the web app on every pull request
  web-preview-pages.yml  publishes apps/web to GitHub Pages on merge to dev (old preview under /preview/)
apps/web/          the web app: React + TypeScript + Vite + Tailwind
apps/web-preview/  the first two-page HTML preview, kept under /preview/
design/prototypes/ design prototypes and review screenshots
supabase/
  config.toml      Supabase CLI and deploy configuration
  functions/       Edge Functions (create-staff-user)
  migrations/      SQL migrations, applied in filename order
  tests/database/  pgTAP tests, run in CI
  seed.sql         demo data for local and preview databases
CLAUDE.md          conventions for Claude Code sessions
```

`packages/core` (shared logic for the sync engine and the desktop and mobile wrappers) comes later.
