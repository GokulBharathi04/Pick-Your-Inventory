# Web preview

A throwaway two-page preview that runs against the **dev** Supabase project. It is plain HTML and JavaScript with no build step. The real web app (React + TypeScript + Vite + Tailwind in `apps/web`) replaces it in Module 0.

| Page | What it does |
| --- | --- |
| `index.html` | Sign in with a username and password (Supabase Auth). |
| `items.html` | Item master: add items with category, type, stock unit, yield, pack sizes, HSN/GST and shelf life. Items are saved to `public.items` and `public.item_pack_sizes`, and the list updates live (Supabase Realtime) when anyone in the organisation adds one. |

## How it works

- `assets/supabase.js` holds the dev project URL and its publishable key. That key is meant for browsers: row-level security and column grants decide what a signed-in user can read or write.
- Usernames map to Supabase Auth emails as `<username>@pick-your-inventory.local`.
- New items leave `is_active` to its database default, because the insert grant on `public.items` doesn't include that column.

## Publishing

Merging changes under `apps/web-preview/` into `dev` runs **Deploy web preview (Pages)**, which publishes this folder to GitHub Pages.

## Run locally

```sh
python -m http.server 8000 --directory apps/web-preview
```

Then open http://localhost:8000/.

The original design prototype and its review screenshots are in `design/prototypes/`.
