import { useMemo, useState } from 'react';
import { useAccess } from '../lib/access';
import { useRefData } from '../lib/refdata';
import { useAction, useLoad } from '../lib/hooks';
import { useRoute } from '../lib/router';
import { run, sb, selectAll } from '../lib/supabase';
import { fmtDateTime, fmtMoney, fmtQty, toNum } from '../lib/format';
import { defaultUnit, fromBase, toBase } from '../lib/units';
import { downloadCsv } from '../lib/csv';
import type { CountLine, ItemOutletSettings, LocationStock, StockCount } from '../lib/types';
import { Button, Checkbox, DataTable, ErrorNote, Field, Modal, Notice, PageHeader, ReasonModal, Select, StatusBadge, Toolbar, useToast } from '../components/ui';
import { ItemSelect, LocationSelect, NeedsOutlet } from '../components/inputs';

export default function Counts() {
  return <NeedsOutlet><CountsInner /></NeedsOutlet>;
}

function CountsInner() {
  const { outletId, outlet, can } = useAccess();
  const ref = useRefData();
  const route = useRoute();
  const [status, setStatus] = useState('open');
  const [creating, setCreating] = useState(!!route.query.get('new'));
  const [openId, setOpenId] = useState<string | null>(null);

  const q = useLoad(async () => {
    let query = sb.from('stock_counts').select('*').eq('outlet_id', outletId).order('started_at', { ascending: false }).limit(100);
    if (status === 'open') query = query.in('status', ['in_progress', 'submitted']);
    else if (status !== 'all') query = query.eq('status', status);
    const counts = await run<StockCount[]>(query);
    const lines = counts.length
      ? await selectAll<{ count_id: string; counted_qty: number | null }>((a, b) => sb.from('stock_count_lines').select('count_id,counted_qty').in('count_id', counts.map(c => c.id)).range(a, b))
      : [];
    const progress = new Map<string, { total: number; counted: number }>();
    lines.forEach(l => {
      const p = progress.get(l.count_id) ?? { total: 0, counted: 0 };
      p.total++;
      if (l.counted_qty !== null) p.counted++;
      progress.set(l.count_id, p);
    });
    return { counts, progress };
  }, [outletId, status]);

  const catNames = (ids: string[]) => (ids.length ? ids.map(id => ref.categories.find(c => c.id === id)?.name ?? '').join(', ') : 'All categories');

  return (
    <div>
      <PageHeader title="Stock counts" subtitle={`${outlet?.name} · counts are blind: counters don’t see the system figure`}
        actions={can('counts.count') && <Button onClick={() => setCreating(true)}>Start a count</Button>} />
      <ErrorNote error={q.error} />
      <Toolbar>
        <Select className="max-w-48" value={status} onChange={setStatus} options={[
          { value: 'open', label: 'In progress and to approve' }, { value: 'approved', label: 'Approved' }, { value: 'cancelled', label: 'Cancelled' }, { value: 'all', label: 'All' }]} />
      </Toolbar>
      <DataTable rows={q.data?.counts ?? []} rowKey={c => c.id} onRowClick={c => setOpenId(c.id)} empty={q.loading ? 'Loading…' : 'No counts here'}
        columns={[
          { label: 'Started', render: c => fmtDateTime(c.started_at) },
          { label: 'Location', render: c => (c.location_id ? ref.location(c.location_id)?.name : 'Several') },
          { label: 'Categories', render: c => <span className="text-muted">{catNames(c.scope_category_ids)}</span> },
          { label: 'Counted', num: true, render: c => { const p = q.data?.progress.get(c.id); return p ? `${p.counted} of ${p.total}` : '0'; } },
          { label: 'Status', render: c => <StatusBadge status={c.status} /> },
        ]} />
      {creating && <StartCount onClose={() => setCreating(false)} onStarted={id => { q.reload(); setOpenId(id); }} />}
      {openId && <CountSheet id={openId} onClose={() => { setOpenId(null); q.reload(); }} />}
    </div>
  );
}

function StartCount({ onClose, onStarted }: { onClose: () => void; onStarted: (id: string) => void }) {
  const { orgId, outletId } = useAccess();
  const ref = useRefData();
  const toast = useToast();
  const { busy, error, act } = useAction();
  const [locationId, setLocationId] = useState(ref.outletLocations[0]?.id ?? '');
  const [cats, setCats] = useState<string[]>([]);
  const [scope, setScope] = useState('relevant');
  const [note, setNote] = useState('');

  const start = () => act(async () => {
    if (!locationId) throw new Error('Choose a location');
    const [stock, settings] = await Promise.all([
      selectAll<LocationStock>((a, b) => sb.from('stock_on_hand').select('item_id,quantity').eq('location_id', locationId).range(a, b)),
      selectAll<ItemOutletSettings>((a, b) => sb.from('item_outlet_settings').select('item_id,is_stocked,default_location_id').eq('outlet_id', outletId).range(a, b)),
    ]);
    const relevant = new Set<string>([
      ...stock.filter(s => toNum(s.quantity) !== 0).map(s => s.item_id),
      ...settings.filter(s => s.default_location_id === locationId && s.is_stocked).map(s => s.item_id),
    ]);
    const items = ref.items.filter(i => i.is_active && (cats.length === 0 || cats.includes(i.category_id ?? '')) && (scope === 'all' || relevant.has(i.id)));
    if (items.length === 0) throw new Error(scope === 'relevant' ? 'No items have stock here yet. Choose “All active items” instead.' : 'No items in these categories');
    const c = await run<StockCount>(sb.from('stock_counts').insert({ organisation_id: orgId, outlet_id: outletId, location_id: locationId, scope_category_ids: cats, note: note.trim() || null }).select().single());
    for (let i = 0; i < items.length; i += 500) {
      await run(sb.from('stock_count_lines').insert(items.slice(i, i + 500).map(it => ({ organisation_id: orgId, outlet_id: outletId, count_id: c.id, item_id: it.id, location_id: locationId }))));
    }
    toast(`Count started with ${items.length} items`);
    onStarted(c.id);
    onClose();
  });

  return (
    <Modal open title="Start a count" onClose={onClose}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button busy={busy} onClick={() => void start()}>Start count</Button></>}>
      <ErrorNote error={error} />
      <div className="flex flex-col gap-3">
        <Field label="Location"><LocationSelect value={locationId} onChange={setLocationId} /></Field>
        <Field label="Which items">
          <Select value={scope} onChange={setScope} options={[
            { value: 'relevant', label: 'Items with stock here, or kept here by default' }, { value: 'all', label: 'All active items' }]} />
        </Field>
        <div>
          <div className="mb-1 text-xs font-medium text-slate-700">Categories (none ticked means all)</div>
          <div className="flex flex-wrap gap-x-4 gap-y-2 rounded-md border border-line p-3">
            {ref.categories.filter(c => c.is_active).map(c => (
              <Checkbox key={c.id} label={c.name} checked={cats.includes(c.id)} onChange={v => setCats(v ? [...cats, c.id] : cats.filter(x => x !== c.id))} />
            ))}
          </div>
        </div>
        <Field label="Note"><input className="input" value={note} onChange={e => setNote(e.target.value)} placeholder="Weekly count" /></Field>
      </div>
    </Modal>
  );
}

function CountSheet({ id, onClose }: { id: string; onClose: () => void }) {
  const { orgId, outletId, can } = useAccess();
  const ref = useRefData();
  const toast = useToast();
  const { busy, error, act } = useAction();
  const q = useLoad(async () => {
    const [c, lines] = await Promise.all([
      run<StockCount>(sb.from('stock_counts').select('*').eq('id', id).single()),
      selectAll<CountLine>((a, b) => sb.from('stock_count_lines').select('*').eq('count_id', id).range(a, b)),
    ]);
    return { c, lines };
  }, [id]);
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<Record<string, 'saving' | 'saved' | 'error'>>({});
  const [onlyDiff, setOnlyDiff] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [addItem, setAddItem] = useState('');
  const [search, setSearch] = useState('');

  const c = q.data?.c;
  const lines = useMemo(() => {
    const catOrder = new Map(ref.categories.map((x, i) => [x.id, i]));
    const s = search.trim().toLowerCase();
    return (q.data?.lines ?? [])
      .filter(l => !s || (ref.item(l.item_id)?.name ?? '').toLowerCase().includes(s))
      .sort((a, b) => {
        const ia = ref.item(a.item_id); const ib = ref.item(b.item_id);
        return (catOrder.get(ia?.category_id ?? '') ?? 999) - (catOrder.get(ib?.category_id ?? '') ?? 999) || (ia?.name ?? '').localeCompare(ib?.name ?? '');
      });
  }, [q.data, ref.categories, ref.items, search]);

  const saveLine = async (line: CountLine, value: string) => {
    const it = ref.item(line.item_id);
    if (!it) return;
    const qty = value.trim() === '' ? null : toBase(it, toNum(value), defaultUnit(it.base_unit), ref.units);
    setSaving(s => ({ ...s, [line.id]: 'saving' }));
    const { error: err } = await sb.from('stock_count_lines').update({ counted_qty: qty }).eq('id', line.id);
    setSaving(s => ({ ...s, [line.id]: err ? 'error' : 'saved' }));
  };

  const submit = () => act(async () => {
    // Save anything typed that may still be saving from the last field.
    for (const l of q.data?.lines ?? []) {
      if (typed[l.id] !== undefined) await saveLine(l, typed[l.id]);
    }
    await run(sb.rpc('submit_stock_count', { p_count_id: id }));
    toast('Count submitted for approval');
    q.reload();
  });
  const approve = () => act(async () => {
    const n = await run<number>(sb.rpc('approve_stock_count', { p_count_id: id }));
    toast(`Approved. ${n} difference${n === 1 ? '' : 's'} posted to the stock ledger.`);
    q.reload();
  });
  const add = () => act(async () => {
    if (!addItem || !c) return;
    await run(sb.from('stock_count_lines').insert({ organisation_id: orgId, outlet_id: outletId, count_id: id, item_id: addItem, location_id: c.location_id ?? ref.outletLocations[0]?.id }));
    setAddItem('');
    q.reload();
  });

  const counted = (q.data?.lines ?? []).filter(l => l.counted_qty !== null || (typed[l.id] ?? '') !== '').length;
  const reviewRows = lines.filter(l => l.counted_qty !== null && (!onlyDiff || toNum(l.variance_qty) !== 0));
  const varianceValue = reviewRows.reduce((s, l) => s + toNum(l.variance_qty) * toNum(l.unit_cost), 0);

  return (
    <Modal open size="xl" onClose={onClose}
      title={c ? <>Count · {c.location_id ? ref.location(c.location_id)?.name : ''} <StatusBadge status={c.status} /></> : 'Count'}
      footer={c && <>
        {(c.status === 'in_progress' ? can('counts.count') : c.status === 'submitted' && can('counts.approve')) && (
          <Button variant="danger" className="mr-auto" onClick={() => setCancelling(true)}>Cancel count</Button>
        )}
        {c.status !== 'in_progress' && <Button variant="secondary" onClick={() => downloadCsv('count-variance.csv', ['Item', 'System', 'Counted', 'Variance', 'Unit cost', 'Variance value'],
          reviewRows.map(l => [ref.item(l.item_id)?.name, toNum(l.system_qty), toNum(l.counted_qty), toNum(l.variance_qty), toNum(l.unit_cost), toNum(l.variance_qty) * toNum(l.unit_cost)]))}>Export CSV</Button>}
        <Button variant="secondary" onClick={onClose}>Close</Button>
        {c.status === 'in_progress' && can('counts.count') && <Button busy={busy} onClick={() => void submit()}>Submit count</Button>}
        {c.status === 'submitted' && can('counts.approve') && <Button busy={busy} onClick={() => void approve()}>Approve and post differences</Button>}
      </>}>
      <ErrorNote error={error ?? q.error} />
      {c?.status === 'in_progress' && (
        <>
          <Notice>Count what is physically there and type it in. Each line saves when you leave it. Leave a line empty if you didn’t count it. {counted} of {q.data?.lines.length ?? 0} counted.</Notice>
          <Toolbar><input className="input max-w-xs" placeholder="Find an item" value={search} onChange={e => setSearch(e.target.value)} /></Toolbar>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Item</th><th>Category</th><th className="num">Counted</th><th /></tr></thead>
              <tbody>
                {lines.map(l => {
                  const it = ref.item(l.item_id);
                  const u = it ? defaultUnit(it.base_unit) : '';
                  const shown = typed[l.id] ?? (l.counted_qty !== null && it ? String(fromBase(it, toNum(l.counted_qty), u, ref.units)) : '');
                  return (
                    <tr key={l.id}>
                      <td className="font-medium">{it?.name}</td>
                      <td className="text-muted">{ref.categories.find(x => x.id === it?.category_id)?.name ?? '—'}</td>
                      <td className="num">
                        <div className="flex items-center justify-end gap-1">
                          <input className="input w-32 text-right" type="number" min="0" step="any" inputMode="decimal" value={shown}
                            onChange={e => setTyped({ ...typed, [l.id]: e.target.value })}
                            onBlur={e => { if (typed[l.id] !== undefined) void saveLine(l, e.target.value); }} disabled={!can('counts.count')} />
                          <span className="w-8 text-left text-xs text-muted">{u}</span>
                        </div>
                      </td>
                      <td className="w-16 text-xs">{saving[l.id] === 'saving' ? <span className="text-muted">Saving…</span> : saving[l.id] === 'saved' ? <span className="text-green-700">Saved</span> : saving[l.id] === 'error' ? <span className="text-red-700">Not saved</span> : null}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {can('counts.count') && (
            <div className="mt-3 flex items-end gap-2">
              <Field label="Add an item to this count" className="w-80"><ItemSelect value={addItem} onChange={setAddItem} filter={i => !(q.data?.lines ?? []).some(l => l.item_id === i.id)} /></Field>
              <Button variant="secondary" busy={busy} onClick={() => void add()}>Add</Button>
            </div>
          )}
        </>
      )}
      {c && c.status !== 'in_progress' && (
        <>
          {c.status === 'submitted' && <Notice tone="warn">Check the differences. Approving posts each one to the stock ledger at its average cost.</Notice>}
          <Toolbar>
            <Checkbox label="Only items with a difference" checked={onlyDiff} onChange={setOnlyDiff} />
            <span className="ml-auto text-sm">Net difference: <strong className={varianceValue < 0 ? 'text-red-700' : ''}>{fmtMoney(varianceValue)}</strong></span>
          </Toolbar>
          <DataTable rows={reviewRows} rowKey={l => l.id} empty="No counted lines"
            columns={[
              { label: 'Item', render: l => ref.item(l.item_id)?.name },
              { label: 'System', num: true, render: l => fmtQty(l.system_qty, ref.item(l.item_id)?.base_unit) },
              { label: 'Counted', num: true, render: l => fmtQty(l.counted_qty, ref.item(l.item_id)?.base_unit) },
              { label: 'Difference', num: true, render: l => <span className={toNum(l.variance_qty) < 0 ? 'text-red-700' : toNum(l.variance_qty) > 0 ? 'text-green-700' : ''}>{toNum(l.variance_qty) > 0 ? '+' : ''}{fmtQty(l.variance_qty, ref.item(l.item_id)?.base_unit)}</span> },
              { label: 'Value', num: true, render: l => fmtMoney(toNum(l.variance_qty) * toNum(l.unit_cost)) },
            ]} />
        </>
      )}
      <ReasonModal open={cancelling} title="Cancel this count" label="Note (optional)" required={false} confirmLabel="Cancel count" danger onClose={() => setCancelling(false)}
        onConfirm={async () => { await run(sb.rpc('cancel_stock_count', { p_count_id: id })); toast('Count cancelled'); q.reload(); }} />
    </Modal>
  );
}
