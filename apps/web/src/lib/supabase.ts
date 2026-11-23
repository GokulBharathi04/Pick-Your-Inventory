import { createClient } from '@supabase/supabase-js';

// Vite fills these from apps/web/.env.local; the dev project is the fallback.
// The publishable key is meant for browsers: row-level security decides access.
const env = ((import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {});

export const SUPABASE_URL: string = env.VITE_SUPABASE_URL || 'https://ngfakbdneyluggrhijyq.supabase.co';
export const SUPABASE_KEY: string = env.VITE_SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_HruaUuku9f7uM2d3D5uX_A_t5lTGMpx';

export const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true },
});

// People sign in with a username; Supabase Auth needs an email, so map it.
export const LOGIN_DOMAIN = 'pick-your-inventory.local';
export const toEmail = (username: string) =>
  (username.includes('@') ? username : `${username}@${LOGIN_DOMAIN}`).trim().toLowerCase();
export const toUsername = (email?: string | null) => (email ?? '').replace('@' + LOGIN_DOMAIN, '');

type DbError = { message?: string; code?: string; details?: string | null; hint?: string | null };

// Turns a database or API error into a sentence for the screen.
export function errorText(e: unknown): string {
  if (!e) return 'Something went wrong. Try again.';
  if (typeof e === 'string') return e;
  const err = e as DbError;
  const msg = err.message ?? String(e);
  if (err.code === '42501') {
    return /permission denied|row-level security/i.test(msg) ? 'You don’t have permission to do this.' : msg;
  }
  if (err.code === '23505') {
    if (/name/i.test(msg)) return 'That name is already used.';
    if (/code/i.test(msg)) return 'That code is already used.';
    if (/idempotency/i.test(msg)) return 'Sales for this date, source and reference are already entered.';
    return /duplicate key/i.test(msg) ? 'This already exists.' : msg;
  }
  if (err.code === '23514') return 'Some values aren’t allowed. Check the form and try again.';
  if (err.code === '23503') return 'This is linked to something that doesn’t exist or can’t be removed.';
  if (/Failed to fetch|NetworkError/i.test(msg)) return 'Can’t reach the server. Check your connection.';
  return msg;
}

// The row type comes from the caller (run<Item[]>(…)), not from the query
// builder, so a query that selects only some columns still type-checks.
type Result = { data: unknown; error: unknown };

// Awaits a Supabase call and throws its error, so screens can use try/catch.
export async function run<T>(call: PromiseLike<Result>): Promise<T> {
  const { data, error } = await call;
  if (error) throw error;
  return data as T;
}

// Reads every row of a query, a thousand at a time (the API's page size).
export async function selectAll<T>(
  build: (from: number, to: number) => PromiseLike<Result>,
): Promise<T[]> {
  const page = 1000;
  const rows: T[] = [];
  for (let from = 0; ; from += page) {
    const chunk = await run<T[]>(build(from, from + page - 1));
    rows.push(...(chunk ?? []));
    if (!chunk || chunk.length < page) break;
  }
  return rows;
}
