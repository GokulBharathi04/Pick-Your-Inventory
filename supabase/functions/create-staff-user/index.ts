// Creates a staff login and adds it to an organisation with a role and outlets.
//
// Called from the web app's Users screen by someone who can manage users.
// 1. Checks the caller's session.
// 2. Creates the login (<username>@pick-your-inventory.local) with the admin API.
// 3. Calls public.add_staff_member as the caller, so the database checks the
//    caller's permission and the role and outlets. If that fails, the new
//    login is deleted again.
//
// verify_jwt is off for this function (see supabase/config.toml): the new API
// keys are not JWTs, so the caller is checked here instead.
import { createClient } from 'npm:@supabase/supabase-js@2';

const LOGIN_DOMAIN = 'pick-your-inventory.local';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function reply(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

function readKey(jsonVar: string, legacyVar: string): string {
  const json = Deno.env.get(jsonVar);
  if (json) {
    try {
      const keys = JSON.parse(json) as Record<string, string>;
      if (keys['default']) return keys['default'];
    } catch {
      // fall through to the legacy key
    }
  }
  return Deno.env.get(legacyVar) ?? '';
}

type Body = {
  organisation_id?: string;
  username?: string;
  password?: string;
  full_name?: string;
  role_id?: string;
  all_outlets?: boolean;
  outlet_ids?: string[];
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return reply(405, { error: 'Use POST' });

  const url = Deno.env.get('SUPABASE_URL') ?? '';
  const secretKey = readKey('SUPABASE_SECRET_KEYS', 'SUPABASE_SERVICE_ROLE_KEY');
  const publishableKey = readKey('SUPABASE_PUBLISHABLE_KEYS', 'SUPABASE_ANON_KEY');
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) return reply(401, { error: 'Sign in first' });

  const admin = createClient(url, secretKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: who, error: whoError } = await admin.auth.getUser(token);
  if (whoError || !who?.user) return reply(401, { error: 'Your session has expired. Sign in again.' });

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return reply(400, { error: 'Send the details as JSON' });
  }

  const username = (body.username ?? '').trim().toLowerCase();
  const password = body.password ?? '';
  const fullName = (body.full_name ?? '').trim();
  if (!/^[a-z0-9][a-z0-9._-]{2,29}$/.test(username)) {
    return reply(400, { error: 'Usernames are 3 to 30 letters or numbers, and may use . _ or -' });
  }
  if (password.length < 8) return reply(400, { error: 'Passwords need at least 8 characters' });
  if (!body.organisation_id || !body.role_id) return reply(400, { error: 'Choose an organisation and a role' });

  // The caller's own client: the database checks their permission.
  const caller = createClient(url, publishableKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email: `${username}@${LOGIN_DOMAIN}`,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName, username },
  });
  if (createError || !created?.user) {
    const taken = /already|exists|registered/i.test(createError?.message ?? '');
    return reply(400, { error: taken ? 'That username is taken' : (createError?.message ?? 'Could not create the login') });
  }

  const { data: membershipId, error: addError } = await caller.rpc('add_staff_member', {
    p_organisation_id: body.organisation_id,
    p_user_id: created.user.id,
    p_role_id: body.role_id,
    p_all_outlets: body.all_outlets ?? false,
    p_outlet_ids: body.outlet_ids ?? [],
    p_full_name: fullName,
  });
  if (addError) {
    await admin.auth.admin.deleteUser(created.user.id);
    const status = addError.code === '42501' ? 403 : 400;
    return reply(status, { error: addError.message });
  }

  return reply(200, { user_id: created.user.id, membership_id: membershipId, username });
});
