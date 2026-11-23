import { useMemo, useState } from 'react';
import { useAccess } from '../lib/access';
import { useRefData } from '../lib/refdata';
import { useLoad } from '../lib/hooks';
import { navigate, useRoute } from '../lib/router';
import { sb, selectAll } from '../lib/supabase';
import { fmtDateTime, fmtMoney, fmtQty, fmtRate, toNum } from '../lib/format';
import { downloadCsv } from '../lib/csv';
import type { LocationStock, OutletStock, PlanningStock } from '../lib/types';
import { Badge, Button, DataTable, ErrorNote, PageHeader, Select, Stat, Tabs, Toolbar } from '../components/ui';
import { NeedsOutlet } from '../components/inputs';

export default function StockOnHand() {
  return <NeedsOutlet><StockOnHandInner /></NeedsOutlet>;
}

function StockOnHandInner() {
  const { outletId, outlet } = useAccess();
  const ref = useRefData();
  const route = useRoute();
  const [view, setView] = useState('planning');
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [location, setLocation] = useState('');
  const [filter, setFilter] = useState(route.query.get('filter') ?? 'all');

  const q = useLoad(async () => {
    const [outletRows, locRows, planRows] = await Promise.all([
      selectAll<OutletStock>((a, b) => sb.from('outlet_stock').select('*').eq('outlet_id', outletId).range(a, b)),
      selectAll<LocationStock>((a, b) => sb.from('stock_on_hand').select('*').eq('outlet_id', outletId).range(a, b)),
      selectAll<PlanningStock>((a, b) => sb.from('planning_stock').select('*').eq('outlet_id', outletId).range(a, b)),
    ]);
    return { outletRows, locRows, planRows };
  }, [outletId]);

  const catName = useMemo(() => new Map(ref.categories.map(c => [c.id, c.name])), [ref.categories]);
  const matches = (itemId: string) => {
    const it = ref.item(itemId);
    if (!it) return false;
    const s = search.trim().toLowerCase();
    return (!s || it.name.toLowerCase().includes(s) || (it.code ?? '').toLowerCase().includes(s)) && (!category || it.category_id === category);
  };

  const outletRows = useMemo(() => (q.data?.outletRows ?? [])
    .filter(r => matches(r.item_id))
    .filter(r => filter === 'all' || (filter === 'below' && r.below_reorder_level) || (filter === 'negative' && r.is_negative) || (filter === 'instock' && toNum(r.quantity) > 0))
    .sort((a, b) => (ref.item(a.item_id)?.name ?? '').localeCompare(ref.item(b.item_id)?.name ?? '')),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [q.data, search, category, filter, ref.items]);

  const locRows = useMemo(() => (q.data?.locRows ?? [])
    .filter(r => matches(r.item_id) && (!location || r.location_id === location))
    .filter(r => filter === 'all' || (filter === 'negative' && toNum(r.quantity) < 0) || (filter === 'instock' && toNum(r.quantity) > 0) || filter === 'below')
    .sort((a, b) => (ref.item(a.item_id)?.name ?? '').localeCompare(ref.item(b.item_id)?.name ?? '') || (ref.location(a.location_id)?.name ?? '').localeCompare(ref.location(b.location_id)?.name ?? '')),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [q.data, search, category, location, filter, ref.items, ref.locations]);

  const planRows = useMemo(() => (q.data?.planRows ?? [])
    .filter(r => matches(r.item_id))
    .filter(r => filter === 'all' || (filter === 'below' && r.below_reorder_level) || (filter === 'negative' && r.is_negative) || (filter === 'instock' && toNum(r.quantity) > 0))
    .sort((a, b) => (ref.item(a.item_id)?.name ?? '').localeCompare(ref.item(b.item_id)?.name ?? '')),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [q.data, search, category, filter, ref.items]);

  const total = (view === 'planning' ? planRows : view === 'outlet' ? outletRows : locRows).reduce((s, r) => s + toNum(r.value), 0);
  // Reorder flags come from planning stock: store stock plus what is on order.
  const below = (q.data?.planRows ?? []).filter(r => r.below_reorder_level).length;
  const negative = (view === 'planning' ? q.data?.planRows ?? [] : q.data?.outletRows ?? []).filter(r => r.is_negative).length;

  const exportCsv = () => {
    if (view === 'planning') {
      downloadCsv(`store-stock-${outlet?.name ?? ''}.csv`, ['Item', 'Code', 'Category', 'Unit', 'In store', 'On order', 'Average cost per unit', 'Value', 'Reorder level', 'Below reorder level'],
        planRows.map(r => { const it = ref.item(r.item_id); return [it?.name, it?.code, catName.get(it?.category_id ?? ''), it?.base_unit, toNum(r.quantity), toNum(r.on_order), r.average_cost ?? '', toNum(r.value), r.reorder_level ?? '', r.below_reorder_level ? 'yes' : '']; }));
    } else if (view === 'outlet') {
      downloadCsv(`stock-on-hand-${outlet?.name ?? ''}.csv`, ['Item', 'Code', 'Category', 'Unit', 'On hand', 'Average cost per unit', 'Value', 'Reorder level', 'Below reorder level', 'Negative'],
        outletRows.map(r => { const it = ref.item(r.item_id); return [it?.name, it?.code, catName.get(it?.category_id ?? ''), it?.base_unit, toNum(r.quantity), r.average_cost ?? '', toNum(r.value), r.reorder_level ?? '', r.below_reorder_level ? 'yes' : '', r.is_negative ? 'yes' : '']; }));
    } else {
      downloadCsv(`stock-by-location-${outlet?.name ?? ''}.csv`, ['Item', 'Location', 'Unit', 'On hand', 'Value', 'Last movement'],
        locRows.map(r => { const it = ref.item(r.item_id); return [it?.name, ref.location(r.location_id)?.name, it?.base_unit, toNum(r.quantity), toNum(r.value), r.last_movement_at]; }));
    }
  };

  return (
    <div>
      <PageHeader title="Stock on hand" subtitle={`${outlet?.name} · always the sum of the stock ledger`}
        actions={<Button variant="secondary" onClick={exportCsv}>Export CSV</Button>} />
      <ErrorNote error={q.error} />
      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Stat label="Stock value shown" value={fmtMoney(total)} />
        <Stat label="Below reorder level" value={below} tone={below ? 'warn' : undefined} />
        <Stat label="Negative stock" value={negative} tone={negative ? 'bad' : undefined} />
      </div>
      <Tabs tabs={[{ key: 'planning', label: 'Store (planning)' }, { key: 'outlet', label: 'By item, all locations' }, { key: 'location', label: 'By storage location' }]} value={view} onChange={setView} />
      {view === 'planning' && <p className="mb-3 text-sm text-muted">Stock in the store, moved only by goods received, issues to departments, their end-of-day returns, transfers, wastage, adjustments and counts. Sales don’t change it. Reorder levels are checked against this plus what is on order.</p>}
      <Toolbar>
        <input className="input max-w-xs" placeholder="Search item" value={search} onChange={e => setSearch(e.target.value)} />
        <Select className="max-w-48" value={category} onChange={setCategory} placeholder="All categories" options={ref.categories.map(c => ({ value: c.id, label: c.name }))} />
        {view === 'location' && <Select className="max-w-44" value={location} onChange={setLocation} placeholder="All locations" options={ref.outletLocations.map(l => ({ value: l.id, label: l.name }))} />}
        <Select className="max-w-48" value={filter} onChange={setFilter} options={[
          { value: 'all', label: 'All items' }, { value: 'instock', label: 'In stock' },
          { value: 'below', label: 'Below reorder level' }, { value: 'negative', label: 'Negative stock' }]} />
      </Toolbar>
      {view === 'planning' ? (
        <DataTable rows={planRows} rowKey={r => r.item_id} onRowClick={r => navigate(`/stock/card?item=${r.item_id}`)}
          empty={q.loading ? 'Loading…' : 'Nothing in the store yet. Receive goods or enter opening stock to start.'}
          columns={[
            { label: 'Item', render: r => <span className="font-medium">{ref.item(r.item_id)?.name ?? '—'}</span> },
            { label: 'Category', render: r => catName.get(ref.item(r.item_id)?.category_id ?? '') ?? '—' },
            { label: 'In store', num: true, render: r => <span className={toNum(r.quantity) < 0 ? 'text-red-700' : ''}>{fmtQty(r.quantity, ref.item(r.item_id)?.base_unit)}</span> },
            { label: 'On order', num: true, render: r => (toNum(r.on_order) ? fmtQty(r.on_order, ref.item(r.item_id)?.base_unit) : '—') },
            { label: 'Average cost', num: true, render: r => (r.average_cost != null ? fmtRate(r.average_cost, ref.item(r.item_id)?.base_unit) : '—') },
            { label: 'Value', num: true, render: r => fmtMoney(r.value) },
            { label: 'Reorder level', num: true, render: r => (r.reorder_level != null ? fmtQty(r.reorder_level, ref.item(r.item_id)?.base_unit) : '—') },
            { label: '', render: r => (r.is_negative ? <Badge tone="red">Negative</Badge> : r.below_reorder_level ? <Badge tone="amber">Reorder</Badge> : null) },
          ]} />
      ) : view === 'outlet' ? (
        <DataTable rows={outletRows} rowKey={r => r.item_id} onRowClick={r => navigate(`/stock/card?item=${r.item_id}`)}
          empty={q.loading ? 'Loading…' : 'No stock yet. Enter opening stock to start.'}
          columns={[
            { label: 'Item', render: r => <span className="font-medium">{ref.item(r.item_id)?.name ?? '—'}</span> },
            { label: 'Category', render: r => catName.get(ref.item(r.item_id)?.category_id ?? '') ?? '—' },
            { label: 'On hand', num: true, render: r => <span className={toNum(r.quantity) < 0 ? 'text-red-700' : ''}>{fmtQty(r.quantity, ref.item(r.item_id)?.base_unit)}</span> },
            { label: 'Average cost', num: true, render: r => (r.average_cost != null ? fmtRate(r.average_cost, ref.item(r.item_id)?.base_unit) : '—') },
            { label: 'Value', num: true, render: r => fmtMoney(r.value) },
            { label: 'Reorder level', num: true, render: r => (r.reorder_level != null ? fmtQty(r.reorder_level, ref.item(r.item_id)?.base_unit) : '—') },
            { label: '', render: r => (r.is_negative ? <Badge tone="red">Negative</Badge> : r.below_reorder_level ? <Badge tone="amber">Reorder</Badge> : null) },
          ]} />
      ) : (
        <DataTable rows={locRows} rowKey={r => `${r.location_id}:${r.item_id}`} onRowClick={r => navigate(`/stock/card?item=${r.item_id}&location=${r.location_id}`)}
          empty={q.loading ? 'Loading…' : 'No stock in these locations'}
          columns={[
            { label: 'Item', render: r => <span className="font-medium">{ref.item(r.item_id)?.name ?? '—'}</span> },
            { label: 'Location', render: r => ref.location(r.location_id)?.name ?? '—' },
            { label: 'On hand', num: true, render: r => <span className={toNum(r.quantity) < 0 ? 'text-red-700' : ''}>{fmtQty(r.quantity, ref.item(r.item_id)?.base_unit)}</span> },
            { label: 'Value', num: true, render: r => fmtMoney(r.value) },
            { label: 'Last movement', render: r => fmtDateTime(r.last_movement_at) },
          ]} />
      )}
    </div>
  );
}
