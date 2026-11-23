import { useEffect, useMemo, useState, type ComponentType } from 'react';
import { AccessProvider, useAccess } from './lib/access';
import { RefDataProvider } from './lib/refdata';
import { useLoad } from './lib/hooks';
import { Link, useRoute } from './lib/router';
import { run, sb, toUsername } from './lib/supabase';
import type { AppTab } from './lib/types';
import { Button, Empty, ErrorNote, Loading, ToastProvider, cx } from './components/ui';
import { NoAccess } from './components/inputs';
import Login from './pages/Login';
import Home from './pages/Home';
import Settings from './pages/Settings';
import Users from './pages/Users';
import Roles from './pages/Roles';
import Items from './pages/Items';
import Vendors from './pages/Vendors';
import ImportData from './pages/ImportData';
import StockOnHand from './pages/StockOnHand';
import StockCard from './pages/StockCard';
import Adjustments from './pages/Adjustments';
import Transfers from './pages/Transfers';
import Wastage from './pages/Wastage';
import Counts from './pages/Counts';
import Menu from './pages/Menu';
import Production from './pages/Production';
import Sales from './pages/Sales';
import Reports from './pages/Reports';

// Screens for each side-menu tab (public.app_tabs). Tabs without a screen yet
// (such as the audit log) stay hidden.
const screens: Record<string, ComponentType> = {
  home: Home,
  items: Items,
  vendors: Vendors,
  stock: StockOnHand,
  adjustments: Adjustments,
  transfers: Transfers,
  wastage: Wastage,
  counts: Counts,
  menu: Menu,
  production: Production,
  sales: Sales,
  reports: Reports,
  users: Users,
  roles: Roles,
  settings: Settings,
};

export default function App() {
  return (
    <ToastProvider>
      <AccessProvider>
        <Root />
      </AccessProvider>
    </ToastProvider>
  );
}

function Root() {
  const { ready, session, access, accessError, signOut } = useAccess();
  if (!ready) return <Loading label="Opening Pick your inventory…" />;
  if (!session) return <Login />;
  if (accessError) {
    return (
      <div className="mx-auto max-w-md p-8">
        <ErrorNote error={accessError} />
        <Button variant="secondary" onClick={() => void signOut()}>Sign out</Button>
      </div>
    );
  }
  if (!access) return <Loading />;
  if (access.organisations.length === 0) {
    return (
      <div className="mx-auto max-w-md p-8">
        <Empty title="Your login isn’t part of a business yet">Ask the owner to add you, then sign in again.</Empty>
        <div className="mt-4 text-center"><Button variant="secondary" onClick={() => void signOut()}>Sign out</Button></div>
      </div>
    );
  }
  return (
    <RefDataProvider>
      <Shell />
    </RefDataProvider>
  );
}

function Shell() {
  const { access, org, outlet, setOrgId, setOutletId, can, signOut } = useAccess();
  const route = useRoute();
  const [menuOpen, setMenuOpen] = useState(false);
  const tabsQ = useLoad(() => run<AppTab[]>(sb.from('app_tabs').select('*').order('sort_order')), []);

  useEffect(() => { setMenuOpen(false); }, [route.path]);

  const tabs = useMemo(() => (tabsQ.data ?? []).filter(t => screens[t.key] && (!t.view_permission || can(t.view_permission))), [tabsQ.data, can]);
  const sections = useMemo(() => {
    const out: { name: string; tabs: AppTab[] }[] = [];
    for (const t of tabs) {
      const s = out.find(x => x.name === t.section);
      if (s) s.tabs.push(t); else out.push({ name: t.section, tabs: [t] });
    }
    return out;
  }, [tabs]);

  const key = route.segments[0] ?? 'home';
  const tab = (tabsQ.data ?? []).find(t => t.key === key);
  let Screen: ComponentType | undefined = screens[key];
  let allowed = !tab?.view_permission || can(tab.view_permission);
  if (key === 'import') { Screen = ImportData; allowed = can('masters.edit') || can('stock.adjust'); }
  if (key === 'stock' && route.segments[1] === 'card') { Screen = StockCard; allowed = can('stock.view'); }

  const name = access?.full_name || toUsername(access?.email);

  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-40 flex h-13 items-center gap-3 bg-navy px-3 text-white sm:px-5">
        <button type="button" className="rounded p-1.5 hover:bg-navy-soft lg:hidden" onClick={() => setMenuOpen(o => !o)} aria-label="Menu">☰</button>
        <Link to="/" className="flex items-center gap-2 font-semibold">
          <span className="grid h-6 w-6 place-items-center rounded bg-teal text-xs font-bold" aria-hidden="true">P</span>
          <span className="hidden sm:inline">Pick your inventory</span>
        </Link>
        <div className="ml-auto flex min-w-0 items-center gap-2 text-sm">
          {access && access.organisations.length > 1 && (
            <select className="h-8 max-w-40 rounded bg-navy-soft px-2 text-white" value={org?.organisation_id ?? ''} onChange={e => setOrgId(e.target.value)} aria-label="Business">
              {access.organisations.map(o => <option key={o.organisation_id} value={o.organisation_id}>{o.organisation_name}</option>)}
            </select>
          )}
          {org && org.outlets.length > 0 && (
            <select className="h-8 max-w-44 rounded bg-navy-soft px-2 text-white" value={outlet?.id ?? ''} onChange={e => setOutletId(e.target.value)} aria-label="Outlet">
              {org.outlets.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          )}
          <span className="hidden truncate text-white/80 md:inline" title={access?.email}>{name} · {org?.role_name}</span>
          <button type="button" onClick={() => void signOut()} className="rounded px-2 py-1 text-white/90 hover:bg-navy-soft">Sign out</button>
        </div>
      </header>

      <div className="flex flex-1">
        <nav className={cx('fixed inset-y-0 top-13 left-0 z-30 w-60 shrink-0 overflow-y-auto border-r border-line bg-white px-2 py-3 lg:sticky lg:block lg:h-[calc(100vh-3.25rem)]', menuOpen ? 'block' : 'hidden')}>
          <div className="mb-3 px-2">
            <div className="truncate text-sm font-semibold">{org?.organisation_name}</div>
            <div className="truncate text-xs text-muted">{outlet ? outlet.name : 'No outlet yet'}</div>
          </div>
          {sections.map(s => (
            <div key={s.name} className="mb-3">
              <div className="px-2 pb-1 text-[11px] font-semibold tracking-wide text-muted uppercase">{s.name}</div>
              {s.tabs.map(t => (
                <Link key={t.key} to={t.path}
                  className={cx('block rounded-md px-2 py-1.5 text-sm', t.key === key ? 'bg-teal-wash font-medium text-teal-ink' : 'text-ink hover:bg-slate-100')}>
                  {t.label}
                </Link>
              ))}
            </div>
          ))}
        </nav>
        <main className="min-w-0 flex-1 px-3 py-5 sm:px-6">
          <div className="mx-auto max-w-7xl">
            {tabsQ.loading && !tabsQ.data ? <Loading /> : !Screen ? <Empty title="Page not found"><Link to="/" className="text-teal-ink underline">Go home</Link></Empty> : !allowed ? <NoAccess /> : <Screen />}
          </div>
        </main>
      </div>
    </div>
  );
}
