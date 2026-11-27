import { useMemo, useState } from 'react';
import { useAccess } from '../lib/access';
import { useRefData } from '../lib/refdata';
import { useAction, useLoad } from '../lib/hooks';
import { navigate, useRoute } from '../lib/router';
import { run, sb, selectAll } from '../lib/supabase';
import { fmtDate, fmtNum, fmtQty, fmtRate, humanize, isoDay, toNum } from '../lib/format';
import { fromBase, toBase, unitsFor, stockUnit } from '../lib/units';
import type { Category, Item, ItemOutletSettings, Num, OutletStock, PackSize, VendorItem } from '../lib/types';
import { Badge, Button, Checkbox, DataTable, ErrorNote, Field, FormGrid, Modal, PageHeader, Select, Tabs, Toolbar, useToast } from '../components/ui';
import { QtyInput } from '../components/inputs';

const types = ['raw', 'prep', 'packaging', 'consumable'].map(t => ({ value: t, label: humanize(t) }));
const stockUnitLabels: Record<string, string> = {
  kg: 'Kilograms (kg)', g: 'Grams (g)', l: 'Litres (l)', ml: 'Millilitres (ml)', pcs: 'Pieces (pcs)', dozen: 'Dozens',
};
type PieceWeight = { item_id: string; receipts: number; pieces: Num; weight_in_base: Num; average_in_base: Num };
const gstRates = ['', '0', '5', '12', '18', '28'].map(r => ({ value: r, label: r === '' ? 'Not set' : `${r}%` }));

export default function Items() {
  const { outletId, can } = useAccess();
  const ref = useRefData();
  const route = useRoute();
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [type, setType] = useState('');
  const [status, setStatus] = useState('active');
  const [editing, setEditing] = useState<Item | 'new' | null>(route.query.get('new') ? 'new' : null);
  const [showCategories, setShowCategories] = useState(false);

  const outletQ = useLoad(async () => {
    if (!outletId) return { stock: new Map<string, OutletStock>(), settings: new Map<string, ItemOutletSettings>() };
    const [stock, settings] = await Promise.all([
      can('stock.view') ? selectAll<OutletStock>((a, b) => sb.from('outlet_stock').select('*').eq('outlet_id', outletId).range(a, b)) : Promise.resolve([] as OutletStock[]),
      selectAll<ItemOutletSettings>((a, b) => sb.from('item_outlet_settings').select('*').eq('outlet_id', outletId).range(a, b)),
    ]);
    return { stock: new Map(stock.map(s => [s.item_id, s])), settings: new Map(settings.map(s => [s.item_id, s])) };
  }, [outletId]);

  const catName = useMemo(() => new Map(ref.categories.map(c => [c.id, c.name])), [ref.categories]);
  const rows = useMemo(() => {
    const s = search.trim().toLowerCase();
    return ref.items.filter(i =>
      (!s || i.name.toLowerCase().includes(s) || (i.code ?? '').toLowerCase().includes(s) || String(i.item_no ?? '').includes(s)) &&
      (!category || i.category_id === category) && (!type || i.item_type === type) &&
      (status === 'all' || (status === 'active' ? i.is_active : !i.is_active)));
  }, [ref.items, search, category, type, status]);

  return (
    <div>
      <PageHeader title="Items" subtitle="Everything you buy or make, with its units, pack sizes and reorder levels"
        actions={can('masters.edit') && <>
          <Button variant="secondary" onClick={() => setShowCategories(true)}>Categories</Button>
          <Button variant="secondary" onClick={() => navigate('/import?type=items')}>Import</Button>
          <Button onClick={() => setEditing('new')}>Add item</Button>
        </>} />
      <Toolbar>
        <input className="input max-w-xs" placeholder="Search name, code or number" value={search} onChange={e => setSearch(e.target.value)} />
        <Select className="max-w-48" value={category} onChange={setCategory} placeholder="All categories" options={ref.categories.map(c => ({ value: c.id, label: c.name }))} />
        <Select className="max-w-40" value={type} onChange={setType} placeholder="All types" options={types} />
        <Select className="max-w-36" value={status} onChange={setStatus} options={[{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }, { value: 'all', label: 'All' }]} />
        <span className="ml-auto text-xs text-muted">{rows.length} items</span>
      </Toolbar>
      <DataTable rows={rows} rowKey={i => i.id} onRowClick={i => setEditing(i)}
        empty={ref.loading ? 'Loading…' : 'No items match'}
        columns={[
          { label: 'No.', render: i => <span className="text-muted tabular-nums">{i.item_no ?? '—'}</span> },
          { label: 'Item', render: i => <span className="font-medium">{i.name}{i.code && <span className="ml-1 text-xs text-muted">{i.code}</span>}</span> },
          { label: 'Category', render: i => catName.get(i.category_id ?? '') ?? '—' },
          { label: 'Type', render: i => <>{humanize(i.item_type)}{i.item_type === 'prep' && i.deduct_ingredients_on_sale && <span className="ml-1 text-xs text-muted">(made to order)</span>}</> },
          { label: 'Unit', render: i => <>{stockUnit(i)}{i.variable_weight && <span className="ml-1 text-xs text-muted">(weight varies)</span>}</> },
          { label: 'Stock here', num: true, render: i => { const st = outletQ.data?.stock.get(i.id); return st ? <span className={toNum(st.quantity) < 0 ? 'text-red-700' : ''}>{fmtQty(st.quantity, i.base_unit)}</span> : '—'; } },
          { label: 'Reorder level', num: true, render: i => { const s = outletQ.data?.settings.get(i.id); return s?.reorder_level != null ? fmtQty(s.reorder_level, i.base_unit) : '—'; } },
          { label: 'Status', render: i => (i.is_active ? <Badge tone="green">Active</Badge> : <Badge>Inactive</Badge>) },
        ]} />
      {editing && (
        <ItemEditor item={editing === 'new' ? null : editing} onClose={() => setEditing(null)}
          onChanged={() => { void ref.reload(); outletQ.reload(); }} />
      )}
      {showCategories && <CategoriesModal onClose={() => setShowCategories(false)} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Item editor
// ---------------------------------------------------------------------------
export function ItemEditor({ item, onClose, onChanged }: { item: Item | null; onClose: () => void; onChanged: () => void }) {
  const ref = useRefData();
  const { can } = useAccess();
  const [current, setCurrent] = useState<Item | null>(item);
  const [tab, setTab] = useState('details');
  const live = current ? ref.item(current.id) ?? current : null;
  const tabs = [
    { key: 'details', label: 'Details' },
    ...(live ? [{ key: 'packs', label: 'Pack sizes' }, { key: 'outlet', label: 'This outlet' }, { key: 'rates', label: 'Vendor rates' }] : []),
  ];
  return (
    <Modal open size="lg" onClose={onClose} title={live ? `${live.name}${live.item_no ? ` · No. ${live.item_no}` : ''}` : 'Add item'}
      footer={<>
        {live && can('stock.view') && <Button variant="ghost" className="mr-auto" onClick={() => navigate(`/stock/card?item=${live.id}`)}>Stock card</Button>}
        <Button variant="secondary" onClick={onClose}>Close</Button>
      </>}>
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      {tab === 'details' && <ItemDetails item={live} onSaved={i => { setCurrent(i); onChanged(); if (!live) setTab('packs'); }} />}
      {tab === 'packs' && live && <PackSizes item={live} onChanged={onChanged} />}
      {tab === 'outlet' && live && <OutletSettings item={live} onChanged={onChanged} />}
      {tab === 'rates' && live && <ItemRates item={live} />}
    </Modal>
  );
}

function ItemDetails({ item, onSaved }: { item: Item | null; onSaved: (i: Item) => void }) {
  const { orgId, outletId, outlet, can } = useAccess();
  const ref = useRefData();
  const toast = useToast();
  const { busy, error, act } = useAction();
  const editable = can('masters.edit');
  const unitOf = (code: string) => ref.units.find(u => u.code === code);
  const factor = (code: string) => toNum(unitOf(code)?.factor_to_base) || 1;
  const stock0 = item ? stockUnit(item) : 'kg';
  const typical0 = item?.variable_weight && toNum(item.alt_per_base) > 0 ? String(Math.round((1 / toNum(item.alt_per_base) / factor(stock0)) * 1000) / 1000) : '';
  const [f, setF] = useState({
    name: item?.name ?? '', code: item?.code ?? '', category_id: item?.category_id ?? '', item_type: item?.item_type ?? 'raw',
    stock_unit: stock0, variable_weight: item?.variable_weight ?? false, typical: typical0,
    alt: !!item?.alt_unit && !item?.variable_weight, alt_unit: item?.variable_weight ? '' : item?.alt_unit ?? '',
    alt_per_base: item?.alt_per_base != null && !item.variable_weight ? String(item.alt_per_base) : '',
    default_yield_pct: item ? String(item.default_yield_pct) : '100', shelf_life_days: item?.shelf_life_days != null ? String(item.shelf_life_days) : '',
    track_expiry: item?.track_expiry ?? false, hsn_code: item?.hsn_code ?? '', gst_rate: item?.gst_rate != null ? String(toNum(item.gst_rate)) : '',
    deduct_ingredients_on_sale: item?.deduct_ingredients_on_sale ?? false, is_active: item?.is_active ?? true,
  });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF(x => ({ ...x, [k]: v }));
  const base = unitOf(f.stock_unit)?.base_code ?? 'g';
  const weighed = base === 'g';
  const altChoices = ['g', 'ml', 'pcs'].filter(u => u !== base).map(u => ({ value: u, label: u }));
  const stockChoices = ref.units.map(u => ({ value: u.code, label: stockUnitLabels[u.code] ?? u.name }));

  // Average weight per piece from recent receipts at this outlet.
  const weightsQ = useLoad(async () => {
    if (!item?.variable_weight || !outletId) return null;
    const rows = await run<PieceWeight[]>(sb.rpc('piece_weights', { p_outlet_id: outletId }));
    return rows.find(r => r.item_id === item.id) ?? null;
  }, [item?.id, item?.variable_weight, outletId]);
  const avg = weightsQ.data;

  const save = () => act(async () => {
    if (!f.name.trim()) throw new Error('Give the item a name');
    const variable = weighed && f.variable_weight;
    if (variable && toNum(f.typical) <= 0) throw new Error(`Enter the typical weight of one piece, in ${f.stock_unit}`);
    if (!variable && f.alt && (!f.alt_unit || toNum(f.alt_per_base) <= 0)) throw new Error('Fill in the conversion, e.g. 1 pcs = 50 g');
    const values = {
      name: f.name.trim(), code: f.code.trim() || null, category_id: f.category_id || null, item_type: f.item_type,
      base_unit: base, stock_unit: f.stock_unit, variable_weight: variable,
      alt_unit: variable ? 'pcs' : f.alt ? f.alt_unit : null,
      alt_per_base: variable ? 1 / (toNum(f.typical) * factor(f.stock_unit)) : f.alt ? toNum(f.alt_per_base) : null,
      default_yield_pct: toNum(f.default_yield_pct) || 100, shelf_life_days: f.shelf_life_days ? Math.round(toNum(f.shelf_life_days)) : null,
      track_expiry: f.track_expiry, hsn_code: f.hsn_code.trim() || null, gst_rate: f.gst_rate === '' ? null : toNum(f.gst_rate),
      deduct_ingredients_on_sale: f.item_type === 'prep' ? f.deduct_ingredients_on_sale : false,
    };
    const saved = item
      ? await run<Item>(sb.from('items').update({ ...values, is_active: f.is_active }).eq('id', item.id).select().single())
      : await run<Item>(sb.from('items').insert({ ...values, organisation_id: orgId }).select().single());
    toast(item ? 'Item saved' : 'Item added');
    onSaved(saved);
  });

  return (
    <div>
      <ErrorNote error={error} />
      <fieldset disabled={!editable} className="contents">
        <FormGrid cols={3}>
          <Field label="Name" className="sm:col-span-2"><input className="input" value={f.name} onChange={e => set('name', e.target.value)} autoFocus={!item} /></Field>
          <Field label="Code" hint="Optional, unique"><input className="input" value={f.code} onChange={e => set('code', e.target.value)} /></Field>
          <Field label="Category"><Select value={f.category_id} onChange={v => set('category_id', v)} placeholder="No category" options={ref.categories.filter(c => c.is_active || c.id === f.category_id).map(c => ({ value: c.id, label: c.name }))} /></Field>
          <Field label="Type" hint={f.item_type === 'prep' ? 'Made in the kitchen from a recipe' : undefined}><Select value={f.item_type} onChange={v => set('item_type', v as Item['item_type'])} options={types} /></Field>
          <Field label="Stock unit" hint={item ? 'kg ↔ g or l ↔ ml any time; weight, volume or pieces only before it has stock' : 'Stock is shown and counted in this unit'}>
            <Select value={f.stock_unit} onChange={v => set('stock_unit', v)} options={stockChoices} />
          </Field>
          <Field label="Usable yield %" hint="e.g. 85 for onions after peeling"><input className="input" type="number" min="1" max="100" step="any" value={f.default_yield_pct} onChange={e => set('default_yield_pct', e.target.value)} /></Field>
          <Field label="Shelf life (days)"><input className="input" type="number" min="1" value={f.shelf_life_days} onChange={e => set('shelf_life_days', e.target.value)} /></Field>
          <Field label="HSN code"><input className="input" inputMode="numeric" value={f.hsn_code} onChange={e => set('hsn_code', e.target.value)} /></Field>
          <Field label="GST rate"><Select value={f.gst_rate} onChange={v => set('gst_rate', v)} options={gstRates} /></Field>
        </FormGrid>
        <div className="mt-4 flex flex-col gap-3">
          {weighed && (
            <div>
              <Checkbox label="Weight varies piece to piece (e.g. whole chicken)" checked={f.variable_weight} onChange={v => set('variable_weight', v)} />
              {f.variable_weight && (
                <div className="mt-2 flex flex-col gap-2 pl-6 text-sm">
                  <p className="text-muted">Stock is kept by weight. Order and count it in pieces; each receipt records how many pieces came and what they weighed, so stock and cost follow the real weight.</p>
                  <div className="flex flex-wrap items-center gap-2">
                    Typical weight of 1 piece
                    <input className="input w-28" type="number" min="0" step="any" value={f.typical} onChange={e => set('typical', e.target.value)} aria-label="Typical weight of 1 piece" />
                    {f.stock_unit}
                  </div>
                  {avg && toNum(avg.pieces) > 0 && (
                    <div className="flex flex-wrap items-center gap-2 text-muted">
                      Recent average at {outlet?.name}: <span className="font-medium text-ink">{fmtQty(avg.average_in_base, 'g')}</span> a piece
                      ({fmtNum(avg.pieces, 0)} pieces over {avg.receipts} {avg.receipts === 1 ? 'receipt' : 'receipts'})
                      {editable && <Button size="sm" variant="ghost" onClick={() => set('typical', String(Math.round((toNum(avg.average_in_base) / factor(f.stock_unit)) * 1000) / 1000))}>Use this</Button>}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
          {!(weighed && f.variable_weight) && <>
            <Checkbox label="Also measured in another unit (e.g. eggs in pieces and grams)" checked={f.alt} onChange={v => set('alt', v)} />
            {f.alt && (
              <div className="flex flex-wrap items-center gap-2 pl-6 text-sm">
                1 {base} =
                <input className="input w-28" type="number" min="0" step="any" value={f.alt_per_base} onChange={e => set('alt_per_base', e.target.value)} />
                <Select className="w-24" value={f.alt_unit} onChange={v => set('alt_unit', v)} options={altChoices} placeholder="unit" />
              </div>
            )}
          </>}
          <Checkbox label="Track expiry dates" checked={f.track_expiry} onChange={v => set('track_expiry', v)} />
          {f.item_type === 'prep' && (
            <Checkbox label="Made to order: a sale deducts its ingredients instead of its own stock" checked={f.deduct_ingredients_on_sale} onChange={v => set('deduct_ingredients_on_sale', v)} />
          )}
          {item && <Checkbox label="Active" checked={f.is_active} onChange={v => set('is_active', v)} />}
        </div>
      </fieldset>
      {editable && <div className="mt-4 flex justify-end"><Button busy={busy} onClick={() => void save()}>{item ? 'Save details' : 'Add item'}</Button></div>}
    </div>
  );
}

function PackSizes({ item, onChanged }: { item: Item; onChanged: () => void }) {
  const { orgId, can } = useAccess();
  const ref = useRefData();
  const toast = useToast();
  const { busy, error, act } = useAction();
  const [name, setName] = useState('');
  const [qty, setQty] = useState('');
  const [unit, setUnit] = useState(stockUnit(item));
  const packs = ref.packSizes.filter(p => p.item_id === item.id);

  const add = () => act(async () => {
    if (!name.trim() || toNum(qty) <= 0) throw new Error('Enter a pack name and how much it holds');
    await run(sb.from('item_pack_sizes').insert({ organisation_id: orgId, item_id: item.id, name: name.trim(), quantity_in_base: toBase(item, toNum(qty), unit, ref.units) }));
    setName(''); setQty('');
    toast('Pack size added');
    onChanged();
  });
  const toggle = (p: PackSize) => act(async () => {
    await run(sb.from('item_pack_sizes').update({ is_active: !p.is_active }).eq('id', p.id));
    onChanged();
  });

  return (
    <div>
      <p className="mb-3 text-sm text-muted">How vendors sell {item.name}, such as a crate of 12 kg. Receipts and rates can use these packs.</p>
      <ErrorNote error={error} />
      <DataTable rows={packs} rowKey={p => p.id} empty="No pack sizes yet"
        columns={[
          { label: 'Pack', render: p => p.name },
          { label: 'Holds', num: true, render: p => fmtQty(p.quantity_in_base, item.base_unit) },
          { label: 'Status', render: p => (p.is_active ? <Badge tone="green">Active</Badge> : <Badge>Inactive</Badge>) },
          { label: '', render: p => can('masters.edit') && <Button size="sm" variant="ghost" onClick={() => void toggle(p)}>{p.is_active ? 'Deactivate' : 'Reactivate'}</Button> },
        ]} />
      {can('masters.edit') && (
        <div className="mt-4 grid grid-cols-1 items-end gap-2 sm:grid-cols-[1fr_1fr_auto]">
          <Field label="Pack name"><input className="input" placeholder="Crate" value={name} onChange={e => setName(e.target.value)} /></Field>
          <Field label="Holds"><QtyInput item={item} qty={qty} unit={unit} onQty={setQty} onUnit={setUnit} /></Field>
          <Button busy={busy} onClick={() => void add()}>Add pack</Button>
        </div>
      )}
    </div>
  );
}

function OutletSettings({ item, onChanged }: { item: Item; onChanged: () => void }) {
  const { orgId, outlet, outletId, can } = useAccess();
  const ref = useRefData();
  const toast = useToast();
  const { busy, error, act } = useAction();
  const unit0 = stockUnit(item);
  const q = useLoad(() => run<ItemOutletSettings[]>(sb.from('item_outlet_settings').select('*').eq('outlet_id', outletId).eq('item_id', item.id)), [outletId, item.id]);
  const existing = q.data?.[0];
  const [f, setF] = useState<null | { is_stocked: boolean; preferred_vendor_id: string; default_location_id: string; reorder_level: string; reorder_unit: string; reorder_qty: string; reorder_qty_unit: string; max_level: string; lead_time_days: string }>(null);
  const form = f ?? {
    is_stocked: existing?.is_stocked ?? true, preferred_vendor_id: existing?.preferred_vendor_id ?? '', default_location_id: existing?.default_location_id ?? '',
    reorder_level: existing?.reorder_level != null ? String(fromBase(item, toNum(existing.reorder_level), unit0, ref.units)) : '', reorder_unit: unit0,
    reorder_qty: existing?.reorder_qty != null ? String(fromBase(item, toNum(existing.reorder_qty), unit0, ref.units)) : '', reorder_qty_unit: unit0,
    max_level: existing?.max_level != null ? String(fromBase(item, toNum(existing.max_level), unit0, ref.units)) : '',
    lead_time_days: existing?.lead_time_days != null ? String(existing.lead_time_days) : '',
  };
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setF({ ...form, [k]: v });

  if (!outlet) return <p className="text-sm text-muted">Add an outlet first.</p>;
  if (q.loading && !q.data) return <p className="text-sm text-muted">Loading…</p>;

  const save = () => act(async () => {
    const values = {
      is_stocked: form.is_stocked, preferred_vendor_id: form.preferred_vendor_id || null, default_location_id: form.default_location_id || null,
      reorder_level: form.reorder_level === '' ? null : toBase(item, toNum(form.reorder_level), form.reorder_unit, ref.units),
      reorder_qty: form.reorder_qty === '' || toNum(form.reorder_qty) <= 0 ? null : toBase(item, toNum(form.reorder_qty), form.reorder_qty_unit, ref.units),
      max_level: form.max_level === '' ? null : toBase(item, toNum(form.max_level), unit0, ref.units),
      lead_time_days: form.lead_time_days === '' ? null : Math.round(toNum(form.lead_time_days)),
    };
    if (existing) await run(sb.from('item_outlet_settings').update(values).eq('outlet_id', outletId).eq('item_id', item.id));
    else await run(sb.from('item_outlet_settings').insert({ ...values, organisation_id: orgId, outlet_id: outletId, item_id: item.id }));
    toast(`Saved for ${outlet.name}`);
    setF(null);
    q.reload();
    onChanged();
  });

  return (
    <div>
      <p className="mb-3 text-sm text-muted">Settings for {outlet.name}. When stock falls to the reorder level, Module 4 will draft a purchase request.</p>
      <ErrorNote error={error} />
      <fieldset disabled={!can('masters.edit')} className="contents">
        <FormGrid>
          <Field label="Preferred vendor"><Select value={form.preferred_vendor_id} onChange={v => set('preferred_vendor_id', v)} placeholder="None" options={ref.vendors.filter(v => v.is_active).map(v => ({ value: v.id, label: v.name }))} /></Field>
          <Field label="Default storage location" hint="A kitchen or bar here is where sales take it from"><Select value={form.default_location_id} onChange={v => set('default_location_id', v)} placeholder="None" options={ref.outletLocations.map(l => ({ value: l.id, label: l.name }))} /></Field>
          <Field label="Reorder level"><QtyInput item={item} qty={form.reorder_level} unit={form.reorder_unit} onQty={v => set('reorder_level', v)} onUnit={v => set('reorder_unit', v)} /></Field>
          <Field label="Reorder quantity"><QtyInput item={item} qty={form.reorder_qty} unit={form.reorder_qty_unit} onQty={v => set('reorder_qty', v)} onUnit={v => set('reorder_qty_unit', v)} /></Field>
          <Field label={`Maximum level (${unit0})`}><input className="input" type="number" min="0" step="any" value={form.max_level} onChange={e => set('max_level', e.target.value)} /></Field>
          <Field label="Vendor lead time (days)"><input className="input" type="number" min="0" max="90" value={form.lead_time_days} onChange={e => set('lead_time_days', e.target.value)} /></Field>
        </FormGrid>
        <div className="mt-3"><Checkbox label={`Stocked at ${outlet.name}`} checked={form.is_stocked} onChange={v => set('is_stocked', v)} /></div>
      </fieldset>
      {can('masters.edit') && <div className="mt-4 flex justify-end"><Button busy={busy} onClick={() => void save()}>Save for this outlet</Button></div>}
    </div>
  );
}

export function RateForm({ item, vendorId, onSaved }: { item?: Item; vendorId?: string; onSaved: () => void }) {
  const { orgId } = useAccess();
  const ref = useRefData();
  const toast = useToast();
  const { busy, error, act } = useAction();
  const [itemId, setItemId] = useState(item?.id ?? '');
  const [vendor, setVendor] = useState(vendorId ?? '');
  const [buyBy, setBuyBy] = useState('');
  const [rate, setRate] = useState('');
  const [from, setFrom] = useState(isoDay());
  const it = item ?? ref.item(itemId);
  const packs = ref.packSizes.filter(p => p.item_id === it?.id && p.is_active);
  const buyOptions = [
    ...packs.map(p => ({ value: `pack:${p.id}`, label: `Per ${p.name} (${fmtQty(p.quantity_in_base, it?.base_unit)})` })),
    ...unitsFor(it, ref.units).map(u => ({ value: `unit:${u.code}`, label: `Per ${u.code}` })),
  ];
  const save = () => act(async () => {
    if (!it || !vendor || !buyBy || toNum(rate) <= 0) throw new Error('Choose the item, vendor, how it is sold and the rate');
    const [kind, ref_] = buyBy.split(':');
    await run(sb.from('vendor_items').insert({
      organisation_id: orgId, vendor_id: vendor, item_id: it.id, rate: toNum(rate), valid_from: from,
      pack_size_id: kind === 'pack' ? ref_ : null, price_unit: kind === 'unit' ? ref_ : null,
    }));
    toast('Rate saved. Any earlier open rate now ends the day before.');
    setRate('');
    onSaved();
  });
  return (
    <div className="mt-4 rounded-lg border border-line p-3">
      <div className="mb-2 text-sm font-medium">Add a rate</div>
      <ErrorNote error={error} />
      <div className="grid grid-cols-1 items-end gap-2 sm:grid-cols-2 lg:grid-cols-5">
        {!item && <Field label="Item"><Select value={itemId} onChange={v => { setItemId(v); setBuyBy(''); }} placeholder="Choose" options={ref.items.filter(i => i.is_active).map(i => ({ value: i.id, label: i.name }))} /></Field>}
        {!vendorId && <Field label="Vendor"><Select value={vendor} onChange={setVendor} placeholder="Choose" options={ref.vendors.filter(v => v.is_active).map(v => ({ value: v.id, label: v.name }))} /></Field>}
        <Field label="Sold by"><Select value={buyBy} onChange={setBuyBy} placeholder="Choose" options={buyOptions} /></Field>
        <Field label="Rate (₹, before GST)"><input className="input" type="number" min="0" step="any" value={rate} onChange={e => setRate(e.target.value)} /></Field>
        <Field label="From"><input className="input" type="date" value={from} onChange={e => setFrom(e.target.value)} /></Field>
        <Button busy={busy} onClick={() => void save()}>Save rate</Button>
      </div>
    </div>
  );
}

export function rateBasis(v: VendorItem, item: Item | undefined, packs: PackSize[]): string {
  if (v.pack_size_id) {
    const p = packs.find(x => x.id === v.pack_size_id);
    return p ? `${p.name} (${fmtQty(p.quantity_in_base, item?.base_unit)})` : 'Pack';
  }
  return v.price_unit ?? '—';
}

function ItemRates({ item }: { item: Item }) {
  const ref = useRefData();
  const { can } = useAccess();
  const q = useLoad(() => run<VendorItem[]>(sb.from('vendor_items').select('*').eq('item_id', item.id).order('valid_from', { ascending: false })), [item.id]);
  const vendorName = (id: string) => ref.vendors.find(v => v.id === id)?.name ?? '—';
  return (
    <div>
      <ErrorNote error={q.error} />
      <DataTable rows={q.data ?? []} rowKey={v => v.id} empty="No vendor rates yet"
        columns={[
          { label: 'Vendor', render: v => vendorName(v.vendor_id) },
          { label: 'Per', render: v => rateBasis(v, item, ref.packSizes) },
          { label: 'Rate', num: true, render: v => `₹${fmtNum(v.rate, 2)}` },
          { label: 'Per base unit', num: true, render: v => fmtRate(v.rate_per_base, item.base_unit) },
          { label: 'From', render: v => fmtDate(v.valid_from) },
          { label: 'Until', render: v => (v.valid_to ? fmtDate(v.valid_to) : <Badge tone="green">Current</Badge>) },
        ]} />
      {can('masters.edit') && <RateForm item={item} onSaved={q.reload} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------
function CategoriesModal({ onClose }: { onClose: () => void }) {
  const { orgId } = useAccess();
  const ref = useRefData();
  const { busy, error, act } = useAction();
  const [name, setName] = useState('');
  const [editing, setEditing] = useState<Record<string, string>>({});
  const add = () => act(async () => {
    if (!name.trim()) throw new Error('Enter a name');
    await run(sb.from('item_categories').insert({ organisation_id: orgId, name: name.trim(), sort_order: (ref.categories.length + 1) * 10 }));
    setName('');
    await ref.reload();
  });
  const update = (c: Category, values: Partial<Category>) => act(async () => {
    await run(sb.from('item_categories').update(values).eq('id', c.id));
    setEditing(e => { const n = { ...e }; delete n[c.id]; return n; });
    await ref.reload();
  });
  return (
    <Modal open title="Item categories" onClose={onClose} footer={<Button variant="secondary" onClick={onClose}>Done</Button>}>
      <ErrorNote error={error} />
      <div className="flex flex-col divide-y divide-line rounded-md border border-line">
        {ref.categories.map(c => (
          <div key={c.id} className="flex items-center gap-2 px-3 py-2">
            {editing[c.id] !== undefined
              ? <>
                <input className="input flex-1" value={editing[c.id]} onChange={e => setEditing({ ...editing, [c.id]: e.target.value })} />
                <Button size="sm" onClick={() => void update(c, { name: editing[c.id].trim() })}>Save</Button>
              </>
              : <>
                <span className={c.is_active ? 'flex-1' : 'flex-1 text-muted line-through'}>{c.name}</span>
                <Button size="sm" variant="ghost" onClick={() => setEditing({ ...editing, [c.id]: c.name })}>Rename</Button>
                <Button size="sm" variant="ghost" onClick={() => void update(c, { is_active: !c.is_active })}>{c.is_active ? 'Hide' : 'Show'}</Button>
              </>}
          </div>
        ))}
      </div>
      <div className="mt-3 flex gap-2">
        <input className="input flex-1" placeholder="New category" value={name} onChange={e => setName(e.target.value)} />
        <Button busy={busy} onClick={() => void add()}>Add</Button>
      </div>
    </Modal>
  );
}
