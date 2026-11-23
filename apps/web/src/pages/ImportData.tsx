import { useMemo, useState, type ChangeEvent } from 'react';
import { useAccess } from '../lib/access';
import { useRefData } from '../lib/refdata';
import { useRoute } from '../lib/router';
import { errorText, run, sb } from '../lib/supabase';
import { csvObjects, downloadCsv } from '../lib/csv';
import { isoDay, toNum } from '../lib/format';
import { toBase } from '../lib/units';
import type { Category, Item } from '../lib/types';
import { Badge, Button, ErrorNote, Field, Notice, PageHeader, Section, Select } from '../components/ui';

type Kind = 'items' | 'vendors' | 'rates' | 'opening';
type Row = { data: Record<string, string>; problem: string | null; status: 'ready' | 'done' | 'failed' | 'skipped'; message?: string };

const templates: Record<Kind, { title: string; columns: string[]; example: string[]; help: string }> = {
  items: {
    title: 'Items',
    columns: ['name', 'code', 'category', 'type', 'stock_unit', 'pack_name', 'pack_qty', 'pack_unit', 'yield_pct', 'shelf_life_days', 'hsn_code', 'gst_rate'],
    example: ['Tomato', 'VEG-TOM', 'Vegetables', 'raw', 'g', 'Crate', '12', 'kg', '95', '5', '0702', '0'],
    help: 'stock_unit is g, ml or pcs (kg and l are read as g and ml). type is raw, prep, packaging or consumable. New categories are created. Items whose name already exists are skipped.',
  },
  vendors: {
    title: 'Vendors',
    columns: ['name', 'code', 'contact_person', 'phone', 'whatsapp', 'email', 'gstin', 'city', 'payment_terms_days', 'preferred_channel'],
    example: ['Koyambedu Fresh', 'KOY', 'Ravi', '9840000000', '9840000000', '', '', 'Chennai', '7', 'whatsapp'],
    help: 'preferred_channel is whatsapp, email or sms. Vendors whose name already exists are skipped.',
  },
  rates: {
    title: 'Vendor rates',
    columns: ['vendor', 'item', 'pack', 'unit', 'rate', 'valid_from'],
    example: ['Koyambedu Fresh', 'Tomato', 'Crate', '', '480', isoDay()],
    help: 'Give either pack (a pack size name of the item) or unit (such as kg). rate is in rupees before GST. valid_from is YYYY-MM-DD and defaults to today.',
  },
  opening: {
    title: 'Opening stock',
    columns: ['item', 'location', 'quantity', 'unit', 'cost_per_unit'],
    example: ['Tomato', 'Main store', '24', 'kg', '40'],
    help: 'For the outlet selected at the top. cost_per_unit is rupees per unit given (₹40 a kg). Each row becomes an opening stock request that a manager approves.',
  },
};

const norm = (s: string | undefined) => (s ?? '').trim().toLowerCase();

export default function ImportData() {
  const route = useRoute();
  const { orgId, outletId, outlet, can } = useAccess();
  const ref = useRefData();
  const initial = (route.query.get('type') as Kind) || 'items';
  const [kind, setKind] = useState<Kind>(templates[initial] ? initial : 'items');
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const t = templates[kind];

  const lookups = useMemo(() => ({
    itemByName: new Map(ref.items.map(i => [norm(i.name), i])),
    itemByCode: new Map(ref.items.filter(i => i.code).map(i => [norm(i.code ?? ''), i])),
    vendorByName: new Map(ref.vendors.map(v => [norm(v.name), v])),
    locByName: new Map(ref.outletLocations.map(l => [norm(l.name), l])),
  }), [ref.items, ref.vendors, ref.outletLocations]);

  const findItem = (s: string): Item | undefined => lookups.itemByName.get(norm(s)) ?? lookups.itemByCode.get(norm(s));

  const check = (d: Record<string, string>): string | null => {
    if (kind === 'items') {
      if (!d.name) return 'name is missing';
      const u = norm(d.stock_unit);
      if (!['g', 'kg', 'ml', 'l', 'pcs'].includes(u)) return 'stock_unit must be g, ml or pcs';
      if (d.type && !['raw', 'prep', 'packaging', 'consumable'].includes(norm(d.type))) return 'type must be raw, prep, packaging or consumable';
      if (d.pack_name && toNum(d.pack_qty) <= 0) return 'pack_qty is missing';
      return null;
    }
    if (kind === 'vendors') {
      if (!d.name) return 'name is missing';
      if (d.preferred_channel && !['whatsapp', 'email', 'sms'].includes(norm(d.preferred_channel))) return 'preferred_channel must be whatsapp, email or sms';
      return null;
    }
    if (kind === 'rates') {
      if (!lookups.vendorByName.get(norm(d.vendor))) return `vendor "${d.vendor}" not found`;
      const it = findItem(d.item);
      if (!it) return `item "${d.item}" not found`;
      if (d.pack && !ref.packSizes.find(p => p.item_id === it.id && norm(p.name) === norm(d.pack))) return `pack "${d.pack}" not found for ${it.name}`;
      if (!d.pack && !d.unit) return 'give a pack or a unit';
      if (toNum(d.rate) <= 0) return 'rate is missing';
      return null;
    }
    const it = findItem(d.item);
    if (!it) return `item "${d.item}" not found`;
    if (!lookups.locByName.get(norm(d.location))) return `location "${d.location}" not found at ${outlet?.name ?? 'this outlet'}`;
    if (toNum(d.quantity) <= 0) return 'quantity is missing';
    try { toBase(it, 1, d.unit ? norm(d.unit) : it.base_unit, ref.units); } catch (e) { return errorText(e); }
    if (d.cost_per_unit === '' || toNum(d.cost_per_unit) < 0) return 'cost_per_unit is missing';
    return null;
  };

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    const text = await file.text();
    const objs = csvObjects(text);
    if (objs.length === 0) { setError('That file has no rows under its header.'); return; }
    const missing = t.columns.filter(c => !(c in objs[0]) && ['name', 'stock_unit', 'vendor', 'item', 'rate', 'location', 'quantity'].includes(c));
    if (missing.length) { setError(`The header is missing: ${missing.join(', ')}`); return; }
    setRows(objs.map(d => { const problem = check(d); return { data: d, problem, status: problem ? 'skipped' : 'ready' }; }));
    e.target.value = '';
  };

  const ensureCategory = async (name: string, cache: Map<string, Category>): Promise<string | null> => {
    if (!name.trim()) return null;
    const found = cache.get(norm(name)) ?? ref.categories.find(c => norm(c.name) === norm(name));
    if (found) return found.id;
    const c = await run<Category>(sb.from('item_categories').insert({ organisation_id: orgId, name: name.trim(), sort_order: 500 }).select().single());
    cache.set(norm(name), c);
    return c.id;
  };

  const runImport = async () => {
    setBusy(true);
    const cats = new Map<string, Category>();
    const next = [...rows];
    for (let i = 0; i < next.length; i++) {
      const r = next[i];
      if (r.status !== 'ready') continue;
      const d = r.data;
      try {
        if (kind === 'items') {
          if (lookups.itemByName.get(norm(d.name))) { next[i] = { ...r, status: 'skipped', message: 'Already exists' }; continue; }
          const unit = ({ kg: 'g', l: 'ml' } as Record<string, string>)[norm(d.stock_unit)] ?? norm(d.stock_unit);
          const item = await run<Item>(sb.from('items').insert({
            organisation_id: orgId, name: d.name.trim(), code: d.code || null, category_id: await ensureCategory(d.category ?? '', cats),
            item_type: norm(d.type) || 'raw', base_unit: unit, default_yield_pct: toNum(d.yield_pct) || 100,
            shelf_life_days: d.shelf_life_days ? Math.round(toNum(d.shelf_life_days)) : null, hsn_code: d.hsn_code || null,
            gst_rate: d.gst_rate === '' || d.gst_rate === undefined ? null : toNum(d.gst_rate),
          }).select().single());
          if (d.pack_name) {
            const packUnit = norm(d.pack_unit) || unit;
            await run(sb.from('item_pack_sizes').insert({ organisation_id: orgId, item_id: item.id, name: d.pack_name, quantity_in_base: toBase(item, toNum(d.pack_qty), packUnit, ref.units) }));
          }
        } else if (kind === 'vendors') {
          if (lookups.vendorByName.get(norm(d.name))) { next[i] = { ...r, status: 'skipped', message: 'Already exists' }; continue; }
          await run(sb.from('vendors').insert({
            organisation_id: orgId, name: d.name.trim(), code: d.code || null, contact_person: d.contact_person || null, phone: d.phone || null,
            whatsapp: d.whatsapp || null, email: d.email || null, gstin: d.gstin ? d.gstin.toUpperCase() : null, city: d.city || null,
            payment_terms_days: Math.round(toNum(d.payment_terms_days)), preferred_channel: norm(d.preferred_channel) || 'whatsapp',
          }));
        } else if (kind === 'rates') {
          const it = findItem(d.item)!;
          const pack = d.pack ? ref.packSizes.find(p => p.item_id === it.id && norm(p.name) === norm(d.pack)) : undefined;
          await run(sb.from('vendor_items').insert({
            organisation_id: orgId, vendor_id: lookups.vendorByName.get(norm(d.vendor))!.id, item_id: it.id, rate: toNum(d.rate),
            pack_size_id: pack?.id ?? null, price_unit: pack ? null : norm(d.unit), valid_from: d.valid_from || isoDay(),
          }));
        } else {
          const it = findItem(d.item)!;
          const unit = d.unit ? norm(d.unit) : it.base_unit;
          const perBase = toBase(it, 1, unit, ref.units);
          await run(sb.from('stock_adjustments').insert({
            organisation_id: orgId, outlet_id: outletId, location_id: lookups.locByName.get(norm(d.location))!.id, item_id: it.id,
            kind: 'opening', quantity: toBase(it, toNum(d.quantity), unit, ref.units), unit_cost: Math.round((toNum(d.cost_per_unit) / perBase) * 1e6) / 1e6,
            reason: 'Opening stock (imported)',
          }));
        }
        next[i] = { ...r, status: 'done', message: 'Imported' };
      } catch (e) {
        next[i] = { ...r, status: 'failed', message: errorText(e) };
      }
      setRows([...next]);
    }
    setRows([...next]);
    await ref.reload();
    setBusy(false);
  };

  const ready = rows.filter(r => r.status === 'ready').length;
  const done = rows.filter(r => r.status === 'done').length;
  const allowed = kind === 'opening' ? can('stock.adjust') : can('masters.edit');

  return (
    <div>
      <PageHeader title="Import from a spreadsheet" subtitle="Save your sheet as CSV, check the preview, then import"
        back={{ to: kind === 'vendors' || kind === 'rates' ? '/vendors' : kind === 'opening' ? '/adjustments' : '/items', label: 'Back' }} />
      <Section title="1. What are you importing?">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Import" className="w-56">
            <Select value={kind} onChange={v => { setKind(v as Kind); setRows([]); setError(null); }}
              options={(Object.keys(templates) as Kind[]).map(k => ({ value: k, label: templates[k].title }))} />
          </Field>
          <Button variant="secondary" onClick={() => downloadCsv(`${kind}-template.csv`, t.columns, [t.example])}>Download template</Button>
        </div>
        <p className="mt-3 text-sm text-muted">Columns: {t.columns.join(', ')}. {t.help}</p>
        {kind === 'opening' && !outletId && <div className="mt-3"><Notice tone="warn">Add an outlet in Settings first.</Notice></div>}
      </Section>
      {!allowed ? <Notice tone="warn">Your role can’t import {t.title.toLowerCase()}.</Notice> : (
        <Section title="2. Choose the CSV file">
          <ErrorNote error={error} />
          <input type="file" accept=".csv,text/csv" onChange={e => void onFile(e)} className="text-sm" />
        </Section>
      )}
      {rows.length > 0 && (
        <Section title="3. Check and import" subtitle={`${ready} ready · ${done} imported · ${rows.length - ready - done} need attention`}
          actions={<Button busy={busy} disabled={ready === 0} onClick={() => void runImport()}>Import {ready} rows</Button>}>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>#</th>{t.columns.map(c => <th key={c}>{c}</th>)}<th>Result</th></tr></thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    <td className="text-muted">{i + 1}</td>
                    {t.columns.map(c => <td key={c}>{r.data[c]}</td>)}
                    <td>
                      {r.status === 'ready' && <Badge tone="blue">Ready</Badge>}
                      {r.status === 'done' && <Badge tone="green">{r.message}</Badge>}
                      {r.status === 'failed' && <Badge tone="red">{r.message}</Badge>}
                      {r.status === 'skipped' && <Badge tone="amber">{r.problem ?? r.message}</Badge>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {kind === 'opening' && done > 0 && <p className="mt-3 text-sm text-muted">The opening stock is waiting for approval in Opening stock and adjustments.</p>}
        </Section>
      )}
    </div>
  );
}
