# Pick your inventory

Restaurant inventory, procurement and owner dashboard, built by Pick your Pixel.

- **Blueprint:** [Pick your inventory — Detailed build blueprint](https://claude.ai/artifact/6zHm58Lw3aPEpcTSZ1y5DK). It covers the modules, data model and build order.
- **Status:** the repo is connected to Supabase. Module 0 (Foundation) is next.

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

Copy `.env.example` to `apps/web/.env.local` once the web app exists (Module 0).

## Repository layout

```
.github/workflows/
  db-check.yml     checks migrations on every pull request
  db-deploy-dev.yml  applies migrations to the dev project on merge to dev
supabase/
  config.toml      Supabase CLI and deploy configuration
  migrations/      SQL migrations, applied in filename order
  seed.sql         demo data for local and preview databases
CLAUDE.md          conventions for Claude Code sessions
```

`apps/web` (React web app) and `packages/core` (shared logic) arrive with Module 0.
