import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { errorText, run, sb } from './supabase';
import { useStored } from './hooks';

export type OutletRef = { id: string; name: string; code: string | null };

export type OrgAccess = {
  organisation_id: string;
  organisation_name: string;
  timezone: string;
  membership_id: string;
  role_id: string;
  role_key: string;
  role_name: string;
  is_owner: boolean;
  all_outlets: boolean;
  permissions: string[];
  outlets: OutletRef[];
};

export type MyAccess = { user_id: string; email: string; full_name: string | null; organisations: OrgAccess[] };

type AccessValue = {
  session: Session | null;
  ready: boolean;
  access: MyAccess | null;
  accessError: string | null;
  org: OrgAccess | null;
  orgId: string;
  outlet: OutletRef | null;
  outletId: string;
  setOrgId: (id: string) => void;
  setOutletId: (id: string) => void;
  can: (permission: string) => boolean;
  refreshAccess: () => Promise<void>;
  signOut: () => Promise<void>;
};

const AccessContext = createContext<AccessValue | null>(null);

export function AccessProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [access, setAccess] = useState<MyAccess | null>(null);
  const [accessError, setAccessError] = useState<string | null>(null);
  const [storedOrg, setStoredOrg] = useStored<string>('piy.org', '');
  const [storedOutlet, setStoredOutlet] = useStored<string>('piy.outlet', '');

  const loadAccess = useCallback(async () => {
    try {
      const a = await run<MyAccess | null>(sb.rpc('my_access'));
      setAccess(a);
      setAccessError(null);
    } catch (e) {
      setAccessError(errorText(e));
    }
  }, []);

  useEffect(() => {
    let alive = true;
    sb.auth.getSession().then(async ({ data }) => {
      if (!alive) return;
      setSession(data.session);
      if (data.session) await loadAccess();
      if (alive) setReady(true);
    });
    const { data: sub } = sb.auth.onAuthStateChange((event, s) => {
      setSession(s);
      // Supabase calls made inside this callback can wait on its own lock, so defer them.
      if (event === 'SIGNED_IN') setTimeout(() => { void loadAccess(); }, 0);
      if (event === 'SIGNED_OUT') setAccess(null);
    });
    return () => { alive = false; sub.subscription.unsubscribe(); };
  }, [loadAccess]);

  const orgs = access?.organisations ?? [];
  const org = orgs.find(o => o.organisation_id === storedOrg) ?? orgs[0] ?? null;
  const outlet = org ? (org.outlets.find(o => o.id === storedOutlet) ?? org.outlets[0] ?? null) : null;

  const value = useMemo<AccessValue>(() => ({
    session,
    ready,
    access,
    accessError,
    org,
    orgId: org?.organisation_id ?? '',
    outlet,
    outletId: outlet?.id ?? '',
    setOrgId: setStoredOrg,
    setOutletId: setStoredOutlet,
    can: (p: string) => !!org && (org.is_owner || org.permissions.includes(p)),
    refreshAccess: loadAccess,
    signOut: async () => {
      await sb.auth.signOut();
      setAccess(null);
      window.location.hash = '/';
    },
  }), [session, ready, access, accessError, org, outlet, setStoredOrg, setStoredOutlet, loadAccess]);

  return <AccessContext.Provider value={value}>{children}</AccessContext.Provider>;
}

export function useAccess(): AccessValue {
  const v = useContext(AccessContext);
  if (!v) throw new Error('useAccess outside AccessProvider');
  return v;
}
