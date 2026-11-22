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
2. Work on a feature branch and open a pull request into `dev`.
3. Merging into `dev` makes Supabase's GitHub integration apply the new migrations to the dev project automatically.
4. When a release is ready, open a pull request from `dev` into `main`. Once the Mumbai project exists, merging deploys it to production.

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
supabase/
  config.toml      Supabase CLI and deploy configuration
  migrations/      SQL migrations, applied in filename order
  seed.sql         demo data for local and preview databases
CLAUDE.md          conventions for Claude Code sessions
```

`apps/web` (React web app) and `packages/core` (shared logic) arrive with Module 0.
