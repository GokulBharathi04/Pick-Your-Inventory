import { useAccess } from '../lib/access';
import { useRefData } from '../lib/refdata';
import { useLoad } from '../lib/hooks';
import { Link } from '../lib/router';
import { run, sb, selectAll } from '../lib/supabase';
import { dayStart, fmtMoney, isoDay, toNum } from '../lib/format';
import type { LedgerRow, OutletStock } from '../lib/types';
import { Button, ErrorNote, PageHeader, Section, Stat } from '../components/ui';
import { navigate } from '../lib/router';

async function countOf(table: string, filters: Record<string, string>): Promise<number> {
  let q = sb.from(table).select('id', { count: 'exact', head: true });
  for (const [k, v] of Object.entries(filters)) q = q.eq(k, v);
  const { count, error } = await q;
  if (error) return 0;
  return count ?? 0;
}

export default function Home() {
  const { org, outlet, outletId, can, access } = useAccess();
  const { items, vendors, outletLocations, menuItems } = useRefData();

  const q = useLoad(async () => {
    if (!outletId) return null;
    const [stock, todayRows, pendingAdj, submittedCounts, inTransit, salesDrafts, openingRows, activeRecipes] = await Promise.all([
      can('stock.view') ? selectAll<OutletStock>((a, b) => sb.from('outlet_stock').select('*').eq('outlet_id', outletId).range(a, b)) : Promise.resolve([] as OutletStock[]),
      can('stock.view') ? run<LedgerRow[]>(sb.from('stock_ledger').select('movement_type,value').eq('outlet_id', outletId).gte('occurred_at', dayStart(isoDay()))) : Promise.resolve([] as LedgerRow[]),
      countOf('stock_adjustments', { outlet_id: outletId, status: 'pending' }),
      countOf('stock_counts', { outlet_id: outletId, status: 'submitted' }),
      countOf('stock_transfers', { outlet_id: outletId, status: 'sent' }),
      countOf('sales_imports', { outlet_id: outletId, status: 'draft' }),
      can('stock.view') ? run<LedgerRow[]>(sb.from('stock_ledger').select('id').eq('outlet_id', outletId).eq('movement_type', 'opening').limit(1)) : Promise.resolve([] as LedgerRow[]),
      run<{ id: string }[]>(sb.from('recipes').select('id').eq('organisation_id', org?.organisation_id ?? '').eq('status', 'active').limit(1)),
    ]);
    const value = stock.reduce((s, r) => s + toNum(r.value), 0);
    const below = stock.filter(r => r.below_reorder_level).length;
    const negative = stock.filter(r => r.is_negative).length;
    const wastedToday = -todayRows.filter(r => r.movement_type === 'wastage' || r.movement_type === 'staff_meal').reduce((s, r) => s + toNum(r.value), 0);
    const soldToday = -todayRows.filter(r => r.movement_type === 'sale').reduce((s, r) => s + toNum(r.value), 0);
    return { value, below, negative, wastedToday, soldToday, pendingAdj, submittedCounts, inTransit, salesDrafts, hasOpening: openingRows.length > 0, hasRecipes: activeRecipes.length > 0 };
  }, [outletId, org?.organisation_id]);

  const d = q.data;
  const steps = [
    { done: (org?.outlets.length ?? 0) > 0, label: 'Add an outlet', to: '/settings', show: can('organisation.manage') },
    { done: outletLocations.length > 0, label: 'Add storage locations (a store and a kitchen)', to: '/settings', show: can('organisation.manage') },
    { done: items.length > 0, label: 'Add items, or import them from a spreadsheet', to: '/items', show: can('masters.edit') },
    { done: vendors.length > 0, label: 'Add vendors and their rates', to: '/vendors', show: can('masters.edit') },
    { done: !!d?.hasOpening, label: 'Enter opening stock', to: '/adjustments', show: can('stock.adjust') },
    { done: menuItems.length > 0 && !!d?.hasRecipes, label: 'Add dishes and their recipes', to: '/menu', show: can('recipes.edit') },
  ].filter(s => s.show);
  const setupLeft = steps.filter(s => !s.done).length;

  return (
    <div>
      <PageHeader title={`Hello${access?.full_name ? ', ' + access.full_name.split(' ')[0] : ''}`}
        subtitle={outlet ? `${org?.organisation_name} · ${outlet.name}` : org?.organisation_name} />
      <ErrorNote error={q.error} />

      {setupLeft > 0 && (
        <Section title="Getting started" subtitle={`${steps.length - setupLeft} of ${steps.length} done`}>
          <ol className="flex flex-col gap-2">
            {steps.map(s => (
              <li key={s.label} className="flex items-center gap-2 text-sm">
                <span className={s.done ? 'text-green-700' : 'text-muted'} aria-hidden="true">{s.done ? '✓' : '○'}</span>
                {s.done ? <span className="text-muted line-through">{s.label}</span> : <Link to={s.to} className="text-teal-ink hover:underline">{s.label}</Link>}
              </li>
            ))}
          </ol>
        </Section>
      )}

      {outlet && d && (
        <>
          {can('stock.view') && (
            <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Stat label="Stock value" value={fmtMoney(d.value)} hint="At average cost" to="/stock" />
              <Stat label="Below reorder level" value={d.below} tone={d.below > 0 ? 'warn' : undefined} hint="Items to buy" to="/stock?filter=below" />
              <Stat label="Negative stock" value={d.negative} tone={d.negative > 0 ? 'bad' : undefined} hint="Sold before received" to="/stock?filter=negative" />
              <Stat label="Wasted today" value={fmtMoney(d.wastedToday)} hint={`Cost of sales today ${fmtMoney(d.soldToday)}`} to="/wastage" />
            </div>
          )}
          <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Adjustments to approve" value={d.pendingAdj} tone={d.pendingAdj > 0 ? 'warn' : undefined} to="/adjustments" />
            <Stat label="Counts to approve" value={d.submittedCounts} tone={d.submittedCounts > 0 ? 'warn' : undefined} to="/counts" />
            <Stat label="Transfers in transit" value={d.inTransit} tone={d.inTransit > 0 ? 'warn' : undefined} to="/transfers" />
            <Stat label="Sales not posted" value={d.salesDrafts} tone={d.salesDrafts > 0 ? 'warn' : undefined} to="/sales" />
          </div>
          <Section title="Quick actions">
            <div className="flex flex-wrap gap-2">
              {can('wastage.record') && <Button variant="secondary" onClick={() => navigate('/wastage?new=1')}>Record wastage</Button>}
              {can('stock.transfer') && <Button variant="secondary" onClick={() => navigate('/transfers?new=1')}>New transfer</Button>}
              {can('counts.count') && <Button variant="secondary" onClick={() => navigate('/counts?new=1')}>Start a count</Button>}
              {can('production.record') && <Button variant="secondary" onClick={() => navigate('/production?new=1')}>Record a prep batch</Button>}
              {can('sales.record') && <Button variant="secondary" onClick={() => navigate('/sales?new=1')}>Enter sales</Button>}
              {can('stock.adjust') && <Button variant="secondary" onClick={() => navigate('/adjustments?new=1')}>Request an adjustment</Button>}
            </div>
          </Section>
        </>
      )}
    </div>
  );
}
