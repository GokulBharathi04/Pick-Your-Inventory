/* Shared Supabase client for every page.
   The publishable key is meant for browsers: Row Level Security in the database decides access. */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

export const SUPABASE_URL = 'https://ngfakbdneyluggrhijyq.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_HruaUuku9f7uM2d3D5uX_A_t5lTGMpx';

/* Users sign in with a plain username; Supabase Auth needs an email, so map it. */
export const LOGIN_DOMAIN = 'pick-your-inventory.local';
export const toEmail = u => (u.includes('@') ? u : `${u}@${LOGIN_DOMAIN}`).trim().toLowerCase();
export const toUsername = email => (email || '').replace('@' + LOGIN_DOMAIN, '');

export const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true },
});
