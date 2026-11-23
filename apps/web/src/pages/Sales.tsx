import { useMemo, useState, type ChangeEvent } from 'react';
import { useAccess } from '../lib/access';
import { useRefData } from '../lib/refdata';
import { useAction, useLoad } from '../lib/hooks';
import { useRoute } from '../lib/router';
import { run, sb, selectAll } from '../lib/supabase';
import { fmtDate, fmtMoney, fmtNum, isoDay, toNum } from '../lib/format';
import { csvObjects, downloadCsv } from '../lib/csv';
import type { MenuItem, MenuItemOutlet, Recipe, SalesImport, SalesLine } from '../lib/types';
import { Badge, Button, DataTable, ErrorNote, Field, FormGrid, Modal, Notice, PageHeader, ReasonModal, Select, StatusBadge, Toolbar, useToast } from '../components/ui';
import { NeedsOutlet } from '../components/inputs';

export default function Sales() {
  return <NeedsOutlet><SalesInner /></NeedsOutlet>;
}

function SalesInner() {
  const { outletId, outlet, can } = useAccess();
  const route = useRoute();
  const [status, setStatus] = useState('all');
  const [creating, setCreating] = useState(!!route.query.get('new'));
  const [openId, setOpenId] = useState<string | null>(null);
  const q = useLoad(() => {
    let query = sb.from('sales_imports').select('*').eq('outlet_id', outletId).order('business_date', { ascending: false }).order('created_at', { ascending: false }).limit(120);
    if (status !== 'all') query = query.eq('status', status);
    return run<SalesImport[]>(query);
  }, [outletId, status]);

  return (
    <div>
      <PageHeader title="Sales" subtitle={`${outlet?.name} · daily sales per dish; posting deducts each dish’s recipe from stock`}
        actions={can('sales.record') && <Button onClick={() => setCreating(true)}>Enter sales</Button>} />
      <ErrorNote error={q.error} />
      <Toolbar>
        <Select className="max-w-40" value={status} onChange={setStatus} options={[
          { value: 'all', label: 'All' }, { value: 'draft', label: 'Not posted' }, { value: 'posted', label: 'Posted' }, { value: 'voided', label: 'Voided' }]} />
      </Toolbar>
      <DataTable rows={q.data ?? []} rowKey={s => s.id} onRowClick={s => setOpenId(s.id)} empty={q.loading ? 'Loading…' : 'No sales entered yet'}
        columns={[
          { label: 'Business date', render: s => <span className="font-medium">{fmtDate(s.business_date)}</span> },
          { label: 'Source', render: s => (s.source === 'csv' ? 'CSV upload' : s.source === 'pos' ? 'POS' : 'Entered by hand') },
          { label: 'Reference', render: s => s.source_ref ?? '—' },
          { label: 'Dishes', num: true, render: s => (s.status === 'draft' ? '—' : s.line_count) },
          { label: 'Total', num: true, render: s => (s.status === 'draft' ? '—' : fmtMoney(s.total_amount)) },
          { label: 'Status', render: s => <StatusBadge status={s.status === 'draft' ? 'draft' : s.status} /> },
        ]} />
      {creating && <NewSales onClose={() => setCreating(false)} onCreated={id => { q.reload(); setOpenId(id); }} />}
      {openId && <SalesDetail id={openId} onClose={() => { setOpenId(null); q.reload(); }} />}
    </div>
  );
}

function NewSales({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const { orgId, outletId } = useAccess();
  const { busy, error, act } = useAction();
  const [date, setDate] = useState(isoDay());
  const [source, setSource] = useState('manual');
  const [refText, setRefText] = useState('');
  const [note, setNote] = useState('');
  const create = () => act(async () => {
    const s = await run<SalesImport>(sb.from('sales_imports').insert({ organisation_id: orgId, outlet_id: outletId, business_date: date, source, source_ref: refText.trim() || null, note: note.trim() || null }).select().single());
    onCreated(s.id);
    onClose();
  });
  return (
    <Modal open title="Enter sales" onClose={onClose}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button busy={busy} onClick={() => void create()}>Continue</Button></>}>
      <ErrorNote error={error} />
      <FormGrid>
        <Field label="Business date"><input className="input" type="date" value={date} onChange={e => setDate(e.target.value)} /></Field>
        <Field label="How"><Select value={source} onChange={setSource} options={[{ value: 'manual', label: 'Type them in' }, { value: 'csv', label: 'Upload a CSV' }]} /></Field>
        <Field label="Reference" hint="Optional. Needed for a second entry on the same day, e.g. dinner"><input className="input" value={refText} onChange={e => setRefText(e.target.value)} /></Field>
        <Field label="Note"><input className="input" value={note} onChange={e => setNote(e.target.value)} /></Field>
      </FormGrid>
      <p className="mt-3 text-xs text-muted">The same date, source and reference can only be entered once, so no sale is deducted twice.</p>
    </Modal>
  );
}

function SalesDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const { orgId, outletId, can } = useAccess();
  const ref = useRefData();
  const toast = useToast();
  const { busy, error, setError, act } = useAction();
  const q = useLoad(async () => {
    const [s, lines, recipes, outletPrices] = await Promise.all([
      run<SalesImport>(sb.from('sales_imports').select('*').eq('id', id).single()),
      selectAll<SalesLine>((a, b) => sb.from('sales_lines').select('*').eq('sales_import_id', id).order('created_at').range(a, b)),
      run<Recipe[]>(sb.from('recipes').select('id,menu_item_id,status,version').eq('organisation_id', orgId).eq('status', 'active')),
      run<MenuItemOutlet[]>(sb.from('menu_item_outlets').select('*').eq('outlet_id', outletId)),
    ]);
    return { s, lines, recipes, outletPrices };
  }, [id]);
  const [dish, setDish] = useState('');
  const [qty, setQty] = useState('');
  const [price, setPrice] = useState('');
  const [voiding, setVoiding] = useState(false);

  const s = q.data?.s;
  const lines = q.data?.lines ?? [];
  const draft = s?.status === 'draft' && can('sales.record');
  const hasRecipe = useMemo(() => new Set((q.data?.recipes ?? []).map(r => r.menu_item_id)), [q.data]);
  const menuById = useMemo(() => new Map(ref.menuItems.map(m => [m.id, m])), [ref.menuItems]);
  const priceFor = (m: MenuItem | undefined) => {
    if (!m) return 0;
    const o = (q.data?.outletPrices ?? []).find(x => x.menu_item_id === m.id);
    return o?.selling_price != null ? toNum(o.selling_price) : toNum(m.selling_price);
  };
  const unmatched = lines.filter(l => !l.menu_item_id).length;
  const noRecipe = Array.from(new Set(lines.filter(l => l.menu_item_id && !hasRecipe.has(l.menu_item_id)).map(l => menuById.get(l.menu_item_id!)?.name ?? '')));
  const total = lines.reduce((t, l) => t + toNum(l.amount), 0);

  const addLine = () => act(async () => {
    const m = menuById.get(dish);
    if (!m || toNum(qty) <= 0) throw new Error('Choose a dish and how many were sold');
    const p = price === '' ? priceFor(m) : toNum(price);
    await run(sb.from('sales_lines').insert({ organisation_id: orgId, outlet_id: outletId, sales_import_id: id, menu_item_id: m.id, pos_item_code: m.code, item_name: m.name, quantity: toNum(qty), unit_price: p, amount: Math.round(p * toNum(qty) * 100) / 100 }));
    setDish(''); setQty(''); setPrice('');
    q.reload();
  });
  const match = (l: SalesLine, menuId: string) => act(async () => {
    const m = menuById.get(menuId);
    await run(sb.from('sales_lines').update({ menu_item_id: menuId || null, pos_item_code: m?.code ?? l.pos_item_code }).eq('id', l.id));
    q.reload();
  });
  const remove = (l: SalesLine) => act(async () => { await run(sb.from('sales_lines').delete().eq('id', l.id)); q.reload(); });
  const post = () => act(async () => {
    const n = await run<number>(sb.rpc('post_sales_import', { p_sales_import_id: id }));
    toast(`Posted. ${n} stock item${n === 1 ? '' : 's'} deducted.`);
    q.reload();
  });

  const onCsv = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError(null);
    const rows = csvObjects(await file.text());
    if (rows.length === 0) { setError('That file has no rows under its header.'); return; }
    const byCode = new Map(ref.menuItems.filter(m => m.code).map(m => [(m.code ?? '').toLowerCase(), m]));
    const byName = new Map(ref.menuItems.map(m => [m.name.toLowerCase(), m]));
    const insert = rows.filter(r => toNum(r.quantity) > 0).map(r => {
      const m = byCode.get((r.item_code ?? '').toLowerCase()) ?? byName.get((r.item_name ?? '').toLowerCase());
      const qn = toNum(r.quantity);
      const up = r.unit_price ? toNum(r.unit_price) : r.amount ? toNum(r.amount) / qn : priceFor(m);
      return {
        organisation_id: orgId, outlet_id: outletId, sales_import_id: id, menu_item_id: m?.id ?? null, pos_item_code: r.item_code || m?.code || null,
        item_name: (r.item_name || m?.name || r.item_code || 'Unknown').slice(0, 120), quantity: qn, unit_price: Math.round(up * 100) / 100,
        amount: r.amount ? toNum(r.amount) : Math.round(up * qn * 100) / 100,
      };
    });
    if (insert.length === 0) { setError('No rows with a quantity. Columns: item_code or item_name, quantity, unit_price or amount.'); return; }
    await act(async () => {
      await run(sb.from('sales_lines').insert(insert));
      toast(`${insert.length} lines added${insert.some(i => !i.menu_item_id) ? '; match the highlighted ones' : ''}`);
      q.reload();
    });
  };

  return (
    <Modal open size="xl" onClose={onClose}
      title={s ? <>Sales · {fmtDate(s.business_date)}{s.source_ref ? ` · ${s.source_ref}` : ''} <StatusBadge status={s.status} /></> : 'Sales'}
      footer={s && <>
        {s.status === 'posted' && can('sales.record') && <Button variant="danger" className="mr-auto" onClick={() => setVoiding(true)}>Void</Button>}
        <Button variant="secondary" onClick={onClose}>Close</Button>
        {draft && <Button busy={busy} disabled={lines.length === 0} onClick={() => void post()}>Post and deduct stock</Button>}
      </>}>
      <ErrorNote error={error ?? q.error} />
      {s?.status === 'posted' && <Notice tone="ok">Posted. Each dish’s recipe was deducted from stock at the kitchen on {fmtDate(s.business_date)}.</Notice>}
      {s?.status === 'voided' && <Notice tone="warn">Voided: {s.void_reason}. The deductions were reversed.</Notice>}
      {draft && unmatched > 0 && <Notice tone="warn">{unmatched} line{unmatched === 1 ? '' : 's'} not matched to a dish. Match them before posting.</Notice>}
      {draft && noRecipe.length > 0 && <Notice tone="warn">No active recipe yet for: {noRecipe.join(', ')}. Add one in Menu and recipes before posting.</Notice>}

      {draft && (
        <div className="mb-4 rounded-lg border border-line p-3">
          <div className="grid grid-cols-1 items-end gap-2 sm:grid-cols-[1fr_110px_140px_auto]">
            <Field label="Dish"><Select value={dish} onChange={v => { setDish(v); setPrice(''); }} placeholder="Choose a dish" options={ref.menuItems.filter(m => m.is_active).map(m => ({ value: m.id, label: m.code ? `${m.name} (${m.code})` : m.name }))} /></Field>
            <Field label="Sold"><input className="input" type="number" min="0" step="any" value={qty} onChange={e => setQty(e.target.value)} /></Field>
            <Field label="Price each (₹)"><input className="input" type="number" min="0" step="any" value={price} onChange={e => setPrice(e.target.value)} placeholder={dish ? String(priceFor(menuById.get(dish))) : ''} /></Field>
            <Button busy={busy} onClick={() => void addLine()}>Add</Button>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
            <label className="cursor-pointer text-teal-ink underline">Upload a CSV<input type="file" accept=".csv,text/csv" className="hidden" onChange={e => void onCsv(e)} /></label>
            <button type="button" className="text-muted underline" onClick={() => downloadCsv('sales-template.csv', ['item_code', 'item_name', 'quantity', 'unit_price', 'amount'], [['BIR-CHK', 'Chicken biryani', '10', '250', '2500']])}>Download the CSV template</button>
            <span className="text-xs text-muted">Same format the POS will send later.</span>
          </div>
        </div>
      )}

      <DataTable rows={lines} rowKey={l => l.id} empty="No dishes added yet"
        columns={[
          { label: 'Dish', render: l => (l.menu_item_id
            ? <span className="font-medium">{menuById.get(l.menu_item_id)?.name ?? l.item_name}{!hasRecipe.has(l.menu_item_id) && <span className="ml-1"><Badge tone="amber">No recipe</Badge></span>}</span>
            : <div className="flex flex-col gap-1"><span className="text-amber-800">{l.item_name} {l.pos_item_code && `(${l.pos_item_code})`}</span>
              {draft && <Select className="max-w-64" value="" onChange={v => void match(l, v)} placeholder="Match to a dish…" options={ref.menuItems.map(m => ({ value: m.id, label: m.name }))} />}</div>) },
          { label: 'Sold', num: true, render: l => fmtNum(l.quantity, 3) },
          { label: 'Price each', num: true, render: l => fmtMoney(l.unit_price) },
          { label: 'Amount', num: true, render: l => fmtMoney(l.amount) },
          { label: '', render: l => draft && <Button size="sm" variant="ghost" onClick={() => void remove(l)}>Remove</Button> },
        ]}
        footer={lines.length > 0 ? <tr><td className="font-medium">Total</td><td className="num">{fmtNum(lines.reduce((t, l) => t + toNum(l.quantity), 0), 3)}</td><td /><td className="num font-semibold">{fmtMoney(total)}</td><td /></tr> : undefined} />

      <ReasonModal open={voiding} title="Void these sales" label="Why?" confirmLabel="Void and reverse deductions" danger onClose={() => setVoiding(false)}
        onConfirm={async reason => { await run(sb.rpc('void_sales_import', { p_sales_import_id: id, p_reason: reason })); toast('Sales voided. Stock deductions reversed.'); q.reload(); }} />
    </Modal>
  );
}
