import { useMemo, useState, type ReactNode } from 'react';
import { useAccess } from '../lib/access';
import { useRefData } from '../lib/refdata';
import { useLoad, useStored } from '../lib/hooks';
import { Link, navigate, useRoute } from '../lib/router';
import { run, sb, selectAll } from '../lib/supabase';
import { addDays, dayStart, fmtDate, fmtDateTime, fmtMoney, fmtNum, fmtPct, fmtQty, humanize, isoDay, startOfMonth, toNum } from '../lib/format';
import { downloadCsv } from '../lib/csv';
import type { CountLine, LedgerRow, MovementSummary, OutletStock, RecipeCost, StockCount, Wastage } from '../lib/types';
import { Badge, Button, DataTable, ErrorNote, Field, PageHeader, Select, Stat, Toolbar, type Column } from '../components/ui';
import { NeedsOutlet } from '../components/inputs';

type ReportDef = { key: string; title: string; about: string; needs?: string };

const reports: ReportDef[] = [
  { key: 'stock', title: 'Stock on hand', about: 'What is in stock now, by item or location, with value and reorder flags.' },
  { key: 'valuation', title: 'Stock valuation', about: 'Stock value by category at average cost.' },
  { key: 'card', title: 'Item stock card', about: 'Every movement of one item with a running balance.' },
  { key: 'summary', title: 'Movement summary', about: 'Opening, everything in and out by type, and closing, per item for a period.' },
  { key: 'movements', title: 'Movement history', about: 'Every stock ledger row, filtered by date, type, item or location.' },
  { key: 'consumption', title: 'Consumption', about: 'What sales and prep used, in quantity and cost.' },
  { key: 'usage', title: 'Theoretical against actual usage', about: 'What recipes say was used, against what wastage and counts show.' },
  { key: 'wastage', title: 'Wastage', about: 'Wastage and staff meals by reason, item and person.' },
  { key: 'variance', title: 'Count variance', about: 'Differences found by approved stock counts, with their value.' },
  { key: 'sales', title: 'Sales by dish', about: 'Quantity and amount sold per dish, with theoretical food cost.', needs: 'sales.view' },
  { key: 'food-cost', title: 'Food cost per dish', about: 'Cost per portion and food cost % of every active recipe.', needs: 'recipes.view' },
];

export default function Reports() {
  const route = useRoute();
  const key = route.segments[1];
  if (!key) return <ReportIndex />;
  const def = reports.find(r => r.key === key);
  const body: Record<string, ReactNode> = {
    valuation: <Valuation />, summary: <Summary />, movements: <Movements />, consumption: <Consumption />, usage: <Usage />,
    wastage: <WastageReport />, variance: <Variance />, sales: <SalesByDish />, 'food-cost': <FoodCost />,
  };
  return (
    <div>
      <PageHeader title={def?.title ?? 'Report'} subtitle={def?.about} back={{ to: '/reports', label: 'Reports' }} />
      <NeedsOutlet>{body[key] ?? <p>Report not found.</p>}</NeedsOutlet>
    </div>
  );
}

function ReportIndex() {
  const { can } = useAccess();
  return (
    <div>
      <PageHeader title="Reports" subtitle="For the outlet selected at the top. Every report exports to CSV." />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {reports.filter(r => !r.needs || can(r.needs)).map(r => (
          <Link key={r.key} to={r.key === 'stock' ? '/stock' : r.key === 'card' ? '/stock/card' : `/reports/${r.key}`} className="block rounded-lg border border-line bg-white p-4 hover:border-teal">
            <div className="font-medium text-ink">{r.title}</div>
            <div className="mt-1 text-sm text-muted">{r.about}</div>
          </Link>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------
function usePeriod(): { from: string; to: string; setFrom: (v: string) => void; setTo: (v: string) => void; picker: ReactNode } {
  const [period, setPeriod] = useStored<{ from: string; to: string }>('piy.report.period', { from: startOfMonth(), to: isoDay() });
  const setFrom = (v: string) => setPeriod({ ...period, from: v });
  const setTo = (v: string) => setPeriod({ ...period, to: v });
  const presets: Record<string, () => { from: string; to: string }> = {
    today: () => ({ from: isoDay(), to: isoDay() }),
    week: () => ({ from: addDays(isoDay(), -6), to: isoDay() }),
    month: () => ({ from: startOfMonth(), to: isoDay() }),
    last: () => { const d = new Date(); const first = new Date(d.getFullYear(), d.getMonth() - 1, 1); const last = new Date(d.getFullYear(), d.getMonth(), 0); return { from: isoDay(first), to: isoDay(last) }; },
  };
  const picker = (
    <>
      <Field label="From"><input className="input" type="date" value={period.from} onChange={e => setFrom(e.target.value)} /></Field>
      <Field label="To"><input className="input" type="date" value={period.to} onChange={e => setTo(e.target.value)} /></Field>
      <Field label="Quick pick">
        <Select className="w-36" value="" onChange={v => { if (presets[v]) setPeriod(presets[v]()); }} placeholder="Choose…"
          options={[{ value: 'today', label: 'Today' }, { value: 'week', label: 'Last 7 days' }, { value: 'month', label: 'This month' }, { value: 'last', label: 'Last month' }]} />
      </Field>
    </>
  );
  return { from: period.from, to: period.to, setFrom, setTo, picker };
}

function ExportButton({ name, head, rows }: { name: string; head: string[]; rows: unknown[][] }) {
  return <Button variant="secondary" onClick={() => downloadCsv(`${name}.csv`, head, rows)}>Export CSV</Button>;
}

function useSummary(from: string, to: string) {
  const { outletId } = useAccess();
  return useLoad(() => run<MovementSummary[]>(sb.rpc('movement_summary', { p_outlet_id: outletId, p_from: dayStart(from), p_to: dayStart(addDays(to, 1)) })), [outletId, from, to]);
}

function useItemFilter() {
  const ref = useRefData();
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const keep = (itemId: string) => {
    const it = ref.item(itemId);
    const s = search.trim().toLowerCase();
    return !!it && (!s || it.name.toLowerCase().includes(s)) && (!category || it.category_id === category);
  };
  const controls = (
    <>
      <Field label="Item"><input className="input w-48" placeholder="Search" value={search} onChange={e => setSearch(e.target.value)} /></Field>
      <Field label="Category"><Select className="w-44" value={category} onChange={setCategory} placeholder="All" options={ref.categories.map(c => ({ value: c.id, label: c.name }))} /></Field>
    </>
  );
  return { keep, controls };
}

const byName = (ref: ReturnType<typeof useRefData>) => (a: { item_id: string }, b: { item_id: string }) => (ref.item(a.item_id)?.name ?? '').localeCompare(ref.item(b.item_id)?.name ?? '');

// ---------------------------------------------------------------------------
// Stock valuation by category
// ---------------------------------------------------------------------------
function Valuation() {
  const { outletId, outlet } = useAccess();
  const ref = useRefData();
  const q = useLoad(() => selectAll<OutletStock>((a, b) => sb.from('outlet_stock').select('*').eq('outlet_id', outletId).range(a, b)), [outletId]);
  const rows = useMemo(() => {
    const m = new Map<string, { category: string; items: number; value: number; negative: number }>();
    for (const r of q.data ?? []) {
      if (toNum(r.quantity) === 0) continue;
      const cat = ref.categories.find(c => c.id === ref.item(r.item_id)?.category_id)?.name ?? 'No category';
      const e = m.get(cat) ?? { category: cat, items: 0, value: 0, negative: 0 };
      e.items++;
      e.value += toNum(r.value);
      if (toNum(r.quantity) < 0) e.negative++;
      m.set(cat, e);
    }
    return Array.from(m.values()).sort((a, b) => b.value - a.value);
  }, [q.data, ref.categories, ref.items]); // eslint-disable-line react-hooks/exhaustive-deps
  const total = rows.reduce((s, r) => s + r.value, 0);
  return (
    <>
      <Toolbar><span className="text-sm text-muted">As of now at {outlet?.name}</span><span className="ml-auto" /><ExportButton name="stock-valuation" head={['Category', 'Items in stock', 'Value', 'Share']} rows={rows.map(r => [r.category, r.items, r.value.toFixed(2), total ? ((r.value / total) * 100).toFixed(1) + '%' : ''])} /></Toolbar>
      <ErrorNote error={q.error} />
      <div className="mb-4 max-w-xs"><Stat label="Total stock value" value={fmtMoney(total)} /></div>
      <DataTable rows={rows} rowKey={r => r.category} empty={q.loading ? 'Loading…' : 'No stock yet'}
        columns={[
          { label: 'Category', render: r => <span className="font-medium">{r.category}</span> },
          { label: 'Items in stock', num: true, render: r => <>{r.items}{r.negative > 0 && <span className="ml-1"><Badge tone="red">{r.negative} negative</Badge></span>}</> },
          { label: 'Value', num: true, render: r => fmtMoney(r.value) },
          { label: 'Share', num: true, render: r => (total ? fmtPct((r.value / total) * 100) : '—') },
        ]} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Movement summary
// ---------------------------------------------------------------------------
function Summary() {
  const ref = useRefData();
  const { from, to, picker } = usePeriod();
  const { keep, controls } = useItemFilter();
  const q = useSummary(from, to);
  const rows = (q.data ?? []).filter(r => keep(r.item_id)).sort(byName(ref));
  const inQty = (r: MovementSummary) => toNum(r.opening_entries) + toNum(r.receipts) + toNum(r.transfers_in) + toNum(r.production);
  const outQty = (r: MovementSummary) => -(toNum(r.transfers_out) + toNum(r.sales) + toNum(r.prep_consumption) + toNum(r.wastage) + toNum(r.staff_meals) + toNum(r.vendor_returns));
  const adj = (r: MovementSummary) => toNum(r.adjustments) + toNum(r.count_variance);
  const unit = (id: string) => ref.item(id)?.base_unit;
  return (
    <>
      <Toolbar>{picker}{controls}<span className="ml-auto" />
        <ExportButton name={`movement-summary-${from}-${to}`} head={['Item', 'Unit', 'Opening', 'Opening entries', 'Received', 'Transfers in', 'Made', 'Transfers out', 'Sold', 'Used in prep', 'Wasted', 'Staff meals', 'Adjustments', 'Count variance', 'Closing', 'Closing value']}
          rows={rows.map(r => [ref.item(r.item_id)?.name, unit(r.item_id), toNum(r.opening_qty), toNum(r.opening_entries), toNum(r.receipts), toNum(r.transfers_in), toNum(r.production), toNum(r.transfers_out), toNum(r.sales), toNum(r.prep_consumption), toNum(r.wastage), toNum(r.staff_meals), toNum(r.adjustments), toNum(r.count_variance), toNum(r.closing_qty), toNum(r.closing_value)])} />
      </Toolbar>
      <ErrorNote error={q.error} />
      <DataTable rows={rows} rowKey={r => r.item_id} onRowClick={r => navigate(`/stock/card?item=${r.item_id}`)} empty={q.loading ? 'Loading…' : 'No movements'}
        columns={[
          { label: 'Item', render: r => <span className="font-medium">{ref.item(r.item_id)?.name}</span> },
          { label: 'Opening', num: true, render: r => fmtQty(r.opening_qty, unit(r.item_id)) },
          { label: 'In', num: true, render: r => <span className="text-green-700">{fmtQty(inQty(r), unit(r.item_id))}</span> },
          { label: 'Out', num: true, render: r => fmtQty(outQty(r), unit(r.item_id)) },
          { label: 'Adjusted', num: true, render: r => (adj(r) ? <span className={adj(r) < 0 ? 'text-red-700' : 'text-green-700'}>{fmtQty(adj(r), unit(r.item_id))}</span> : '—') },
          { label: 'Closing', num: true, render: r => <span className={toNum(r.closing_qty) < 0 ? 'text-red-700' : ''}>{fmtQty(r.closing_qty, unit(r.item_id))}</span> },
          { label: 'Closing value', num: true, render: r => fmtMoney(r.closing_value) },
        ]} />
      <p className="mt-2 text-xs text-muted">In: opening entries, receipts, transfers in and prep made. Out: transfers out, sales, prep use, wastage and staff meals. Click an item for its stock card.</p>
    </>
  );
}

// ---------------------------------------------------------------------------
// Movement history (ledger)
// ---------------------------------------------------------------------------
const movementTypes = ['opening', 'receipt', 'sale', 'prep_production', 'prep_consumption', 'transfer_out', 'transfer_in', 'wastage', 'staff_meal', 'adjustment', 'count_variance', 'vendor_return'];

function Movements() {
  const { outletId } = useAccess();
  const ref = useRefData();
  const { from, to, picker } = usePeriod();
  const [type, setType] = useState('');
  const [location, setLocation] = useState('');
  const { keep, controls } = useItemFilter();
  const q = useLoad(() => {
    let query = sb.from('stock_ledger').select('*').eq('outlet_id', outletId).gte('occurred_at', dayStart(from)).lt('occurred_at', dayStart(addDays(to, 1)))
      .order('occurred_at', { ascending: false }).order('created_at', { ascending: false }).limit(1000);
    if (type) query = query.eq('movement_type', type);
    if (location) query = query.eq('location_id', location);
    return run<LedgerRow[]>(query);
  }, [outletId, from, to, type, location]);
  const rows = (q.data ?? []).filter(r => keep(r.item_id));
  const unit = (id: string) => ref.item(id)?.base_unit;
  return (
    <>
      <Toolbar>{picker}{controls}
        <Field label="Movement"><Select className="w-44" value={type} onChange={setType} placeholder="All" options={movementTypes.map(t => ({ value: t, label: humanize(t) }))} /></Field>
        <Field label="Location"><Select className="w-40" value={location} onChange={setLocation} placeholder="All" options={ref.outletLocations.map(l => ({ value: l.id, label: l.name }))} /></Field>
        <span className="ml-auto" />
        <ExportButton name={`movements-${from}-${to}`} head={['When', 'Item', 'Location', 'Movement', 'Document', 'Quantity', 'Unit', 'Unit cost', 'Value', 'Reversal', 'Note']}
          rows={rows.map(r => [r.occurred_at, ref.item(r.item_id)?.name, ref.location(r.location_id)?.name, humanize(r.movement_type), humanize(r.source_type), toNum(r.quantity), unit(r.item_id), toNum(r.unit_cost), toNum(r.value), r.reverses_entry_id ? 'yes' : '', r.note ?? ''])} />
      </Toolbar>
      <ErrorNote error={q.error} />
      {(q.data ?? []).length === 1000 && <p className="mb-2 text-xs text-amber-800">Showing the latest 1,000 movements. Narrow the dates to see the rest.</p>}
      <DataTable rows={rows} rowKey={r => r.id} empty={q.loading ? 'Loading…' : 'No movements'}
        columns={[
          { label: 'When', render: r => <span className="whitespace-nowrap">{fmtDateTime(r.occurred_at)}</span> },
          { label: 'Item', render: r => ref.item(r.item_id)?.name },
          { label: 'Location', render: r => ref.location(r.location_id)?.name },
          { label: 'Movement', render: r => <>{humanize(r.movement_type)}{r.reverses_entry_id && <span className="ml-1"><Badge tone="red">Reversal</Badge></span>}</> },
          { label: 'Document', render: r => <span className="text-muted">{humanize(r.source_type)}</span> },
          { label: 'Quantity', num: true, render: r => <span className={toNum(r.quantity) < 0 ? 'text-red-700' : 'text-green-700'}>{toNum(r.quantity) > 0 ? '+' : ''}{fmtQty(r.quantity, unit(r.item_id))}</span> },
          { label: 'Value', num: true, render: r => fmtMoney(r.value) },
        ]} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Consumption
// ---------------------------------------------------------------------------
function Consumption() {
  const ref = useRefData();
  const { from, to, picker } = usePeriod();
  const { keep, controls } = useItemFilter();
  const q = useSummary(from, to);
  const rows = (q.data ?? []).filter(r => keep(r.item_id) && (toNum(r.sales) !== 0 || toNum(r.prep_consumption) !== 0))
    .map(r => ({ ...r, used: -(toNum(r.sales) + toNum(r.prep_consumption)), cost: -(toNum(r.sales_value) + toNum(r.prep_consumption_value)) }))
    .sort((a, b) => b.cost - a.cost);
  const total = rows.reduce((s, r) => s + r.cost, 0);
  const unit = (id: string) => ref.item(id)?.base_unit;
  return (
    <>
      <Toolbar>{picker}{controls}<span className="ml-auto" />
        <ExportButton name={`consumption-${from}-${to}`} head={['Item', 'Unit', 'Used by sales', 'Used in prep', 'Total used', 'Cost']}
          rows={rows.map(r => [ref.item(r.item_id)?.name, unit(r.item_id), -toNum(r.sales), -toNum(r.prep_consumption), r.used, r.cost.toFixed(2)])} />
      </Toolbar>
      <ErrorNote error={q.error} />
      <div className="mb-4 max-w-xs"><Stat label="Cost of what was used" value={fmtMoney(total)} /></div>
      <DataTable rows={rows} rowKey={r => r.item_id} empty={q.loading ? 'Loading…' : 'Nothing used in this period'}
        columns={[
          { label: 'Item', render: r => <span className="font-medium">{ref.item(r.item_id)?.name}</span> },
          { label: 'By sales', num: true, render: r => fmtQty(-toNum(r.sales), unit(r.item_id)) },
          { label: 'In prep', num: true, render: r => fmtQty(-toNum(r.prep_consumption), unit(r.item_id)) },
          { label: 'Total used', num: true, render: r => fmtQty(r.used, unit(r.item_id)) },
          { label: 'Cost', num: true, render: r => fmtMoney(r.cost) },
          { label: 'Share', num: true, render: r => (total ? fmtPct((r.cost / total) * 100) : '—') },
        ]} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Theoretical against actual usage
// ---------------------------------------------------------------------------
function Usage() {
  const ref = useRefData();
  const { from, to, picker } = usePeriod();
  const { keep, controls } = useItemFilter();
  const q = useSummary(from, to);
  const rows = (q.data ?? []).filter(r => keep(r.item_id))
    .map(r => {
      const theoretical = -(toNum(r.sales) + toNum(r.prep_consumption));
      const wasted = -(toNum(r.wastage) + toNum(r.staff_meals));
      const unexplained = -toNum(r.count_variance);
      const actual = theoretical + wasted + unexplained;
      return { ...r, theoretical, wasted, unexplained, actual, gapPct: theoretical > 0 ? ((actual - theoretical) / theoretical) * 100 : null };
    })
    .filter(r => r.theoretical !== 0 || r.wasted !== 0 || r.unexplained !== 0)
    .sort((a, b) => (b.gapPct ?? 0) - (a.gapPct ?? 0));
  const unit = (id: string) => ref.item(id)?.base_unit;
  return (
    <>
      <Toolbar>{picker}{controls}<span className="ml-auto" />
        <ExportButton name={`usage-${from}-${to}`} head={['Item', 'Unit', 'Theoretical (recipes)', 'Logged wastage', 'Count shortage', 'Actual', 'Gap %']}
          rows={rows.map(r => [ref.item(r.item_id)?.name, unit(r.item_id), r.theoretical, r.wasted, r.unexplained, r.actual, r.gapPct == null ? '' : r.gapPct.toFixed(1)])} />
      </Toolbar>
      <ErrorNote error={q.error} />
      <DataTable rows={rows} rowKey={r => r.item_id} empty={q.loading ? 'Loading…' : 'No usage in this period'}
        columns={[
          { label: 'Item', render: r => <span className="font-medium">{ref.item(r.item_id)?.name}</span> },
          { label: 'Theoretical', num: true, render: r => fmtQty(r.theoretical, unit(r.item_id)) },
          { label: 'Logged wastage', num: true, render: r => fmtQty(r.wasted, unit(r.item_id)) },
          { label: 'Count shortage', num: true, render: r => <span className={r.unexplained > 0 ? 'text-red-700' : r.unexplained < 0 ? 'text-green-700' : ''}>{fmtQty(r.unexplained, unit(r.item_id))}</span> },
          { label: 'Actual', num: true, render: r => fmtQty(r.actual, unit(r.item_id)) },
          { label: 'Gap', num: true, render: r => (r.gapPct == null ? '—' : <span className={r.gapPct > 5 ? 'font-medium text-red-700' : ''}>{fmtPct(r.gapPct)}</span>) },
        ]} />
      <p className="mt-2 text-xs text-muted">Theoretical is what recipes deducted for sales and prep. Actual adds logged wastage and the shortage found by counts. A large gap points to over-portioning, wastage nobody logged, or theft. A negative count shortage means more was found than expected.</p>
    </>
  );
}

// ---------------------------------------------------------------------------
// Wastage
// ---------------------------------------------------------------------------
function WastageReport() {
  const { outletId } = useAccess();
  const ref = useRefData();
  const { from, to, picker } = usePeriod();
  const [group, setGroup] = useState('reason');
  const q = useLoad(async () => {
    const start = dayStart(from); const end = dayStart(addDays(to, 1));
    const [entries, ledger, people] = await Promise.all([
      selectAll<Wastage>((a, b) => sb.from('wastage_entries').select('*').eq('outlet_id', outletId).is('voided_at', null).gte('occurred_at', start).lt('occurred_at', end).range(a, b)),
      selectAll<LedgerRow>((a, b) => sb.from('stock_ledger').select('source_id,value').eq('outlet_id', outletId).eq('source_type', 'wastage').gte('occurred_at', start).lt('occurred_at', end).range(a, b)),
      run<{ id: string; full_name: string | null }[]>(sb.from('profiles').select('id,full_name')),
    ]);
    const value = new Map(ledger.map(l => [l.source_id ?? '', -toNum(l.value)]));
    const names = new Map(people.map(p => [p.id, p.full_name ?? 'Unknown']));
    return entries.map(e => ({ ...e, value: value.get(e.id) ?? 0, by: names.get(e.recorded_by ?? '') ?? '—' }));
  }, [outletId, from, to]);
  const groups = useMemo(() => {
    const m = new Map<string, { key: string; entries: number; value: number }>();
    for (const e of q.data ?? []) {
      const k = group === 'reason' ? humanize(e.reason) : group === 'item' ? ref.item(e.item_id)?.name ?? '—' : group === 'person' ? e.by : fmtDate(e.occurred_at);
      const g = m.get(k) ?? { key: k, entries: 0, value: 0 };
      g.entries++; g.value += e.value;
      m.set(k, g);
    }
    return Array.from(m.values()).sort((a, b) => b.value - a.value);
  }, [q.data, group, ref.items]); // eslint-disable-line react-hooks/exhaustive-deps
  const total = groups.reduce((s, g) => s + g.value, 0);
  return (
    <>
      <Toolbar>{picker}
        <Field label="Group by"><Select className="w-36" value={group} onChange={setGroup} options={[{ value: 'reason', label: 'Reason' }, { value: 'item', label: 'Item' }, { value: 'person', label: 'Person' }, { value: 'day', label: 'Day' }]} /></Field>
        <span className="ml-auto" />
        <ExportButton name={`wastage-${from}-${to}`} head={['When', 'Item', 'Location', 'Quantity', 'Unit', 'Reason', 'Value', 'By', 'Note']}
          rows={(q.data ?? []).map(e => [e.occurred_at, ref.item(e.item_id)?.name, ref.location(e.location_id)?.name, toNum(e.quantity), ref.item(e.item_id)?.base_unit, humanize(e.reason), e.value.toFixed(2), e.by, e.note ?? ''])} />
      </Toolbar>
      <ErrorNote error={q.error} />
      <div className="mb-4 grid max-w-xl grid-cols-2 gap-3">
        <Stat label="Wastage value" value={fmtMoney(total)} tone={total > 0 ? 'warn' : undefined} />
        <Stat label="Entries" value={(q.data ?? []).length} />
      </div>
      <DataTable rows={groups} rowKey={g => g.key} empty={q.loading ? 'Loading…' : 'No wastage in this period'}
        columns={[
          { label: humanize(group), render: g => <span className="font-medium">{g.key}</span> },
          { label: 'Entries', num: true, render: g => g.entries },
          { label: 'Value', num: true, render: g => fmtMoney(g.value) },
          { label: 'Share', num: true, render: g => (total ? fmtPct((g.value / total) * 100) : '—') },
        ]} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Count variance
// ---------------------------------------------------------------------------
function Variance() {
  const { outletId } = useAccess();
  const ref = useRefData();
  const { from, to, picker } = usePeriod();
  const q = useLoad(async () => {
    const counts = await run<StockCount[]>(sb.from('stock_counts').select('*').eq('outlet_id', outletId).eq('status', 'approved')
      .gte('approved_at', dayStart(from)).lt('approved_at', dayStart(addDays(to, 1))).order('approved_at', { ascending: false }));
    const lines = counts.length ? await selectAll<CountLine>((a, b) => sb.from('stock_count_lines').select('*').in('count_id', counts.map(c => c.id)).not('counted_qty', 'is', null).range(a, b)) : [];
    const countById = new Map(counts.map(c => [c.id, c]));
    return lines.filter(l => toNum(l.variance_qty) !== 0).map(l => ({ ...l, count: countById.get(l.count_id), value: toNum(l.variance_qty) * toNum(l.unit_cost) }))
      .sort((a, b) => a.value - b.value);
  }, [outletId, from, to]);
  const rows = q.data ?? [];
  const short = rows.filter(r => r.value < 0).reduce((s, r) => s + r.value, 0);
  const over = rows.filter(r => r.value > 0).reduce((s, r) => s + r.value, 0);
  const unit = (id: string) => ref.item(id)?.base_unit;
  return (
    <>
      <Toolbar>{picker}<span className="ml-auto" />
        <ExportButton name={`count-variance-${from}-${to}`} head={['Approved', 'Item', 'Location', 'System', 'Counted', 'Difference', 'Unit', 'Unit cost', 'Value']}
          rows={rows.map(r => [r.count?.approved_at, ref.item(r.item_id)?.name, ref.location(r.location_id)?.name, toNum(r.system_qty), toNum(r.counted_qty), toNum(r.variance_qty), unit(r.item_id), toNum(r.unit_cost), r.value.toFixed(2)])} />
      </Toolbar>
      <ErrorNote error={q.error} />
      <div className="mb-4 grid max-w-2xl grid-cols-3 gap-3">
        <Stat label="Shortages" value={fmtMoney(short)} tone={short < 0 ? 'bad' : undefined} />
        <Stat label="Found extra" value={fmtMoney(over)} tone={over > 0 ? 'ok' : undefined} />
        <Stat label="Net" value={fmtMoney(short + over)} />
      </div>
      <DataTable rows={rows} rowKey={r => r.id} empty={q.loading ? 'Loading…' : 'No differences from approved counts in this period'}
        columns={[
          { label: 'Approved', render: r => fmtDate(r.count?.approved_at) },
          { label: 'Item', render: r => <span className="font-medium">{ref.item(r.item_id)?.name}</span> },
          { label: 'Location', render: r => ref.location(r.location_id)?.name },
          { label: 'System', num: true, render: r => fmtQty(r.system_qty, unit(r.item_id)) },
          { label: 'Counted', num: true, render: r => fmtQty(r.counted_qty, unit(r.item_id)) },
          { label: 'Difference', num: true, render: r => <span className={toNum(r.variance_qty) < 0 ? 'text-red-700' : 'text-green-700'}>{toNum(r.variance_qty) > 0 ? '+' : ''}{fmtQty(r.variance_qty, unit(r.item_id))}</span> },
          { label: 'Value', num: true, render: r => fmtMoney(r.value) },
        ]} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Sales by dish
// ---------------------------------------------------------------------------
type SalesRow = { menu_item_id: string | null; item_name: string; quantity: number | string; amount: number | string; days: number };

function SalesByDish() {
  const { outletId } = useAccess();
  const { from, to, picker } = usePeriod();
  const q = useLoad(async () => {
    const [rows, costs] = await Promise.all([
      run<SalesRow[]>(sb.rpc('sales_by_item', { p_outlet_id: outletId, p_from: from, p_to: to })),
      run<RecipeCost[]>(sb.rpc('recipe_costs', { p_outlet_id: outletId })).catch(() => [] as RecipeCost[]),
    ]);
    const cost = new Map(costs.filter(c => c.status === 'active' && c.menu_item_id).map(c => [c.menu_item_id as string, toNum(c.cost_per_unit)]));
    return rows.map(r => {
      const perPortion = r.menu_item_id ? cost.get(r.menu_item_id) : undefined;
      const foodCost = perPortion !== undefined ? perPortion * toNum(r.quantity) : null;
      return { ...r, foodCost, pct: foodCost !== null && toNum(r.amount) > 0 ? (foodCost / toNum(r.amount)) * 100 : null };
    }).sort((a, b) => toNum(b.amount) - toNum(a.amount));
  }, [outletId, from, to]);
  const rows = q.data ?? [];
  const totalAmount = rows.reduce((s, r) => s + toNum(r.amount), 0);
  const totalCost = rows.reduce((s, r) => s + (r.foodCost ?? 0), 0);
  const cols: Column<(typeof rows)[number]>[] = [
    { label: 'Dish', render: r => <span className="font-medium">{r.item_name}</span> },
    { label: 'Sold', num: true, render: r => fmtNum(r.quantity, 3) },
    { label: 'Amount', num: true, render: r => fmtMoney(r.amount) },
    { label: 'Average price', num: true, render: r => fmtMoney(toNum(r.quantity) ? toNum(r.amount) / toNum(r.quantity) : 0) },
    { label: 'Food cost', num: true, render: r => (r.foodCost == null ? '—' : fmtMoney(r.foodCost)) },
    { label: 'Food cost %', num: true, render: r => (r.pct == null ? '—' : <span className={r.pct > 35 ? 'text-red-700' : ''}>{fmtPct(r.pct)}</span>) },
  ];
  return (
    <>
      <Toolbar>{picker}<span className="ml-auto" />
        <ExportButton name={`sales-by-dish-${from}-${to}`} head={['Dish', 'Sold', 'Amount', 'Food cost', 'Food cost %']}
          rows={rows.map(r => [r.item_name, toNum(r.quantity), toNum(r.amount), r.foodCost == null ? '' : r.foodCost.toFixed(2), r.pct == null ? '' : r.pct.toFixed(1)])} />
      </Toolbar>
      <ErrorNote error={q.error} />
      <div className="mb-4 grid max-w-2xl grid-cols-3 gap-3">
        <Stat label="Sales" value={fmtMoney(totalAmount)} />
        <Stat label="Theoretical food cost" value={fmtMoney(totalCost)} />
        <Stat label="Food cost %" value={totalAmount ? fmtPct((totalCost / totalAmount) * 100) : '—'} />
      </div>
      <DataTable rows={rows} rowKey={r => r.menu_item_id ?? r.item_name} columns={cols} empty={q.loading ? 'Loading…' : 'No posted sales in this period'} />
      <p className="mt-2 text-xs text-muted">Only posted sales count. Food cost uses today’s recipe cost per portion.</p>
    </>
  );
}

// ---------------------------------------------------------------------------
// Food cost per dish
// ---------------------------------------------------------------------------
function FoodCost() {
  const { outletId } = useAccess();
  const ref = useRefData();
  const [target, setTarget] = useStored<number>('piy.foodcost.target', 35);
  const q = useLoad(() => run<RecipeCost[]>(sb.rpc('recipe_costs', { p_outlet_id: outletId })), [outletId]);
  const rows = (q.data ?? []).filter(c => c.status === 'active' && c.menu_item_id)
    .map(c => ({ ...c, dish: ref.menuItems.find(m => m.id === c.menu_item_id) }))
    .sort((a, b) => toNum(b.food_cost_pct) - toNum(a.food_cost_pct));
  const above = rows.filter(r => toNum(r.food_cost_pct) > target).length;
  const missing = ref.menuItems.filter(m => m.is_active && !rows.some(r => r.menu_item_id === m.id));
  return (
    <>
      <Toolbar>
        <Field label="Target food cost %"><input className="input w-28" type="number" min="1" max="100" value={target} onChange={e => setTarget(Number(e.target.value) || 35)} /></Field>
        <span className="ml-auto" />
        <ExportButton name="food-cost" head={['Dish', 'Code', 'Price', 'Cost per portion', 'Food cost %', 'Recipe version']}
          rows={rows.map(r => [r.dish?.name, r.dish?.code ?? '', toNum(r.selling_price), toNum(r.cost_per_unit), r.food_cost_pct ?? '', r.version])} />
      </Toolbar>
      <ErrorNote error={q.error} />
      <div className="mb-4 grid max-w-2xl grid-cols-3 gap-3">
        <Stat label="Dishes with a recipe" value={rows.length} />
        <Stat label={`Above ${target}%`} value={above} tone={above ? 'bad' : undefined} />
        <Stat label="Dishes without a recipe" value={missing.length} tone={missing.length ? 'warn' : undefined} />
      </div>
      <DataTable rows={rows} rowKey={r => r.recipe_id} onRowClick={() => navigate('/menu')} empty={q.loading ? 'Loading…' : 'No active recipes yet'}
        columns={[
          { label: 'Dish', render: r => <span className="font-medium">{r.dish?.name}</span> },
          { label: 'Price', num: true, render: r => fmtMoney(r.selling_price) },
          { label: 'Cost per portion', num: true, render: r => fmtMoney(r.cost_per_unit) },
          { label: 'Food cost', num: true, render: r => (r.food_cost_pct == null ? '—' : <span className={toNum(r.food_cost_pct) > target ? 'font-medium text-red-700' : 'text-green-700'}>{fmtPct(r.food_cost_pct)}</span>) },
          { label: 'Margin per portion', num: true, render: r => fmtMoney(toNum(r.selling_price) - toNum(r.cost_per_unit)) },
          { label: 'Recipe', render: r => <span className="text-muted">Version {r.version}</span> },
        ]} />
      {missing.length > 0 && <p className="mt-3 text-sm text-muted">Without a recipe: {missing.map(m => m.name).join(', ')}.</p>}
    </>
  );
}
