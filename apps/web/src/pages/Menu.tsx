import { useMemo, useState } from 'react';
import { useAccess } from '../lib/access';
import { useRefData } from '../lib/refdata';
import { useAction, useLoad } from '../lib/hooks';
import { navigate } from '../lib/router';
import { run, sb, selectAll } from '../lib/supabase';
import { fmtMoney, fmtPct, fmtQty, toNum } from '../lib/format';
import { toBase, stockUnit } from '../lib/units';
import type { Item, MenuCategory, MenuItem, MenuItemOutlet, Recipe, RecipeCost } from '../lib/types';
import { Badge, Button, Checkbox, DataTable, ErrorNote, Field, FormGrid, Modal, PageHeader, Select, Tabs, Toolbar, useToast } from '../components/ui';
import { RecipeEditor, RecipeStatus } from './Recipe';

export default function Menu() {
  const { orgId, outletId, can } = useAccess();
  const ref = useRefData();
  const [tab, setTab] = useState('dishes');
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [editing, setEditing] = useState<MenuItem | 'new' | null>(null);
  const [prep, setPrep] = useState<Item | null>(null);
  const [showCats, setShowCats] = useState(false);

  const q = useLoad(async () => {
    const [recipes, costs, outletRows] = await Promise.all([
      selectAll<Recipe>((a, b) => sb.from('recipes').select('*').eq('organisation_id', orgId).range(a, b)),
      outletId ? run<RecipeCost[]>(sb.rpc('recipe_costs', { p_outlet_id: outletId })) : Promise.resolve([] as RecipeCost[]),
      selectAll<MenuItemOutlet>((a, b) => sb.from('menu_item_outlets').select('*').eq('organisation_id', orgId).range(a, b)),
    ]);
    return { recipes, costs, outletRows };
  }, [orgId, outletId]);

  const recipesFor = (m: { menu?: string; prep?: string }) => (q.data?.recipes ?? []).filter(r => (m.menu ? r.menu_item_id === m.menu : r.prep_item_id === m.prep));
  const activeCost = (m: { menu?: string; prep?: string }) => (q.data?.costs ?? []).find(c => c.status === 'active' && (m.menu ? c.menu_item_id === m.menu : c.prep_item_id === m.prep));
  const catName = useMemo(() => new Map(ref.menuCategories.map(c => [c.id, c.name])), [ref.menuCategories]);

  const dishes = ref.menuItems.filter(m => {
    const s = search.trim().toLowerCase();
    return (!s || m.name.toLowerCase().includes(s) || (m.code ?? '').toLowerCase().includes(s)) && (!category || m.category_id === category);
  });
  const prepItems = ref.items.filter(i => i.item_type === 'prep' && i.is_active);
  const reloadAll = () => { q.reload(); void ref.reload(); };

  return (
    <div>
      <PageHeader title="Menu and recipes" subtitle="Dishes, what goes into them, and what they cost at this outlet"
        actions={can('recipes.edit') && tab === 'dishes' && <>
          <Button variant="secondary" onClick={() => setShowCats(true)}>Menu categories</Button>
          <Button variant="secondary" onClick={() => navigate('/import?type=menu')}>Import</Button>
          <Button onClick={() => setEditing('new')}>Add dish</Button>
        </>} />
      <ErrorNote error={q.error} />
      <Tabs tabs={[{ key: 'dishes', label: `Dishes (${ref.menuItems.length})` }, { key: 'prep', label: `Prep recipes (${prepItems.length})` }]} value={tab} onChange={setTab} />
      {tab === 'dishes' && (
        <>
          <Toolbar>
            <input className="input max-w-xs" placeholder="Search dish or code" value={search} onChange={e => setSearch(e.target.value)} />
            <Select className="max-w-48" value={category} onChange={setCategory} placeholder="All categories" options={ref.menuCategories.map(c => ({ value: c.id, label: c.name }))} />
          </Toolbar>
          <DataTable rows={dishes} rowKey={m => m.id} onRowClick={m => setEditing(m)} empty={ref.loading ? 'Loading…' : 'No dishes yet'}
            columns={[
              { label: 'Code', render: m => <span className="text-muted">{m.code ?? '—'}</span> },
              { label: 'Dish', render: m => <span className="font-medium">{m.name}</span> },
              { label: 'Category', render: m => catName.get(m.category_id ?? '') ?? '—' },
              { label: 'Price', num: true, render: m => fmtMoney(m.selling_price) },
              { label: 'Recipe', render: m => <RecipeStatus recipes={recipesFor({ menu: m.id })} /> },
              { label: 'Cost per portion', num: true, render: m => { const c = activeCost({ menu: m.id }); return c ? fmtMoney(c.cost_per_unit) : '—'; } },
              { label: 'Food cost', num: true, render: m => { const c = activeCost({ menu: m.id }); return c?.food_cost_pct != null ? <span className={toNum(c.food_cost_pct) > 35 ? 'text-red-700' : ''}>{fmtPct(c.food_cost_pct)}</span> : '—'; } },
              { label: 'Status', render: m => (m.is_active ? <Badge tone="green">On menu</Badge> : <Badge>Off menu</Badge>) },
            ]} />
        </>
      )}
      {tab === 'prep' && (
        <>
          <p className="mb-3 text-sm text-muted">Prep items are set up in Items with the type “Prep”. Give each one a recipe so batches and sales deduct the right ingredients.</p>
          <DataTable rows={prepItems} rowKey={i => i.id} onRowClick={i => setPrep(i)} empty="No prep items yet. Add one in Items with the type Prep."
            columns={[
              { label: 'Prep item', render: i => <span className="font-medium">{i.name}</span> },
              { label: 'How it’s used', render: i => (i.deduct_ingredients_on_sale ? 'Made to order' : 'Made in batches, kept in stock') },
              { label: 'Recipe', render: i => <RecipeStatus recipes={recipesFor({ prep: i.id })} /> },
              { label: 'Batch makes', num: true, render: i => { const c = activeCost({ prep: i.id }); return c ? fmtQty(c.yield_qty, i.base_unit) : '—'; } },
              { label: `Cost per kg / l / pc`, num: true, render: i => { const c = activeCost({ prep: i.id }); return c ? fmtMoney(toNum(c.cost_per_unit) * toBase(i, 1, stockUnit(i), ref.units)) : '—'; } },
            ]} />
        </>
      )}
      {editing && <DishEditor dish={editing === 'new' ? null : editing} outletRows={q.data?.outletRows ?? []} onClose={() => { setEditing(null); reloadAll(); }} onChanged={reloadAll} />}
      {prep && (
        <Modal open size="xl" title={`Recipe · ${prep.name}`} onClose={() => { setPrep(null); q.reload(); }} footer={<Button variant="secondary" onClick={() => { setPrep(null); q.reload(); }}>Close</Button>}>
          <RecipeEditor prepItem={prep} />
        </Modal>
      )}
      {showCats && <MenuCategories onClose={() => setShowCats(false)} />}
    </div>
  );
}

function DishEditor({ dish, outletRows, onClose, onChanged }: { dish: MenuItem | null; outletRows: MenuItemOutlet[]; onClose: () => void; onChanged: () => void }) {
  const [current, setCurrent] = useState<MenuItem | null>(dish);
  const [tab, setTab] = useState(dish ? 'recipe' : 'details');
  return (
    <Modal open size="xl" title={current ? current.name : 'Add dish'} onClose={onClose} footer={<Button variant="secondary" onClick={onClose}>Close</Button>}>
      <Tabs tabs={[{ key: 'details', label: 'Details' }, ...(current ? [{ key: 'recipe', label: 'Recipe' }, { key: 'outlets', label: 'Outlets and prices' }] : [])]} value={tab} onChange={setTab} />
      {tab === 'details' && <DishDetails dish={current} onSaved={m => { setCurrent(m); onChanged(); if (!current) setTab('recipe'); }} />}
      {tab === 'recipe' && current && <RecipeEditor menuItemId={current.id} sellingPrice={toNum(current.selling_price)} />}
      {tab === 'outlets' && current && <DishOutlets dish={current} rows={outletRows.filter(r => r.menu_item_id === current.id)} onChanged={onChanged} />}
    </Modal>
  );
}

function DishDetails({ dish, onSaved }: { dish: MenuItem | null; onSaved: (m: MenuItem) => void }) {
  const { orgId, can } = useAccess();
  const ref = useRefData();
  const toast = useToast();
  const { busy, error, act } = useAction();
  const [f, setF] = useState({
    code: dish?.code ?? '', name: dish?.name ?? '', category_id: dish?.category_id ?? '', selling_price: dish ? String(toNum(dish.selling_price)) : '',
    gst_rate: dish?.gst_rate != null ? String(toNum(dish.gst_rate)) : '5', is_active: dish?.is_active ?? true,
  });
  const set = (k: keyof typeof f) => (v: string) => setF(x => ({ ...x, [k]: v }));
  const save = () => act(async () => {
    if (!f.name.trim()) throw new Error('Give the dish a name');
    const values = { code: f.code.trim() || null, name: f.name.trim(), category_id: f.category_id || null, selling_price: toNum(f.selling_price), gst_rate: f.gst_rate === '' ? null : toNum(f.gst_rate) };
    const saved = dish
      ? await run<MenuItem>(sb.from('menu_items').update({ ...values, is_active: f.is_active }).eq('id', dish.id).select().single())
      : await run<MenuItem>(sb.from('menu_items').insert({ ...values, organisation_id: orgId }).select().single());
    toast(dish ? 'Dish saved' : 'Dish added');
    await ref.reload();
    onSaved(saved);
  });
  return (
    <div>
      <ErrorNote error={error} />
      <fieldset disabled={!can('recipes.edit')} className="contents">
        <FormGrid cols={3}>
          <Field label="Name" className="sm:col-span-2"><input className="input" value={f.name} onChange={e => set('name')(e.target.value)} autoFocus={!dish} /></Field>
          <Field label="Code" hint="Matches the POS item code later"><input className="input" value={f.code} onChange={e => set('code')(e.target.value)} /></Field>
          <Field label="Category"><Select value={f.category_id} onChange={set('category_id')} placeholder="No category" options={ref.menuCategories.map(c => ({ value: c.id, label: c.name }))} /></Field>
          <Field label="Selling price (₹)"><input className="input" type="number" min="0" step="any" value={f.selling_price} onChange={e => set('selling_price')(e.target.value)} /></Field>
          <Field label="GST %"><input className="input" type="number" min="0" max="100" step="any" value={f.gst_rate} onChange={e => set('gst_rate')(e.target.value)} /></Field>
        </FormGrid>
        <p className="mt-2 text-xs text-muted">Half and full portions are separate dishes, each with its own recipe.</p>
        {dish && <div className="mt-3"><Checkbox label="On the menu" checked={f.is_active} onChange={v => setF(x => ({ ...x, is_active: v }))} /></div>}
      </fieldset>
      {can('recipes.edit') && <div className="mt-4 flex justify-end"><Button busy={busy} onClick={() => void save()}>{dish ? 'Save dish' : 'Add dish'}</Button></div>}
    </div>
  );
}

function DishOutlets({ dish, rows, onChanged }: { dish: MenuItem; rows: MenuItemOutlet[]; onChanged: () => void }) {
  const { orgId, org, can } = useAccess();
  const toast = useToast();
  const { busy, error, act } = useAction();
  const [edits, setEdits] = useState<Record<string, { available: boolean; price: string }>>({});
  const outlets = org?.outlets ?? [];
  const valueFor = (outletId: string) => {
    const r = rows.find(x => x.outlet_id === outletId);
    return edits[outletId] ?? { available: r ? r.is_available : true, price: r?.selling_price != null ? String(toNum(r.selling_price)) : '' };
  };
  const save = () => act(async () => {
    for (const [outletId, v] of Object.entries(edits)) {
      const existing = rows.find(x => x.outlet_id === outletId);
      const values = { is_available: v.available, selling_price: v.price === '' ? null : toNum(v.price) };
      if (existing) await run(sb.from('menu_item_outlets').update(values).eq('menu_item_id', dish.id).eq('outlet_id', outletId));
      else await run(sb.from('menu_item_outlets').insert({ ...values, organisation_id: orgId, menu_item_id: dish.id, outlet_id: outletId }));
    }
    setEdits({});
    toast('Outlet prices saved');
    onChanged();
  });
  return (
    <div>
      <ErrorNote error={error} />
      <p className="mb-3 text-sm text-muted">Leave the price empty to use the menu price of {fmtMoney(dish.selling_price)}.</p>
      <DataTable rows={outlets} rowKey={o => o.id} empty="No outlets yet"
        columns={[
          { label: 'Outlet', render: o => o.name },
          { label: 'Sold here', render: o => <Checkbox label="" checked={valueFor(o.id).available} disabled={!can('recipes.edit')} onChange={v => setEdits({ ...edits, [o.id]: { ...valueFor(o.id), available: v } })} /> },
          { label: 'Price here (₹)', render: o => <input className="input w-32" type="number" min="0" step="any" value={valueFor(o.id).price} disabled={!can('recipes.edit')} placeholder={String(toNum(dish.selling_price))} onChange={e => setEdits({ ...edits, [o.id]: { ...valueFor(o.id), price: e.target.value } })} /> },
        ]} />
      {can('recipes.edit') && <div className="mt-3 flex justify-end"><Button busy={busy} disabled={Object.keys(edits).length === 0} onClick={() => void save()}>Save</Button></div>}
    </div>
  );
}

function MenuCategories({ onClose }: { onClose: () => void }) {
  const { orgId } = useAccess();
  const ref = useRefData();
  const { busy, error, act } = useAction();
  const [name, setName] = useState('');
  const add = () => act(async () => {
    if (!name.trim()) throw new Error('Enter a name');
    await run(sb.from('menu_categories').insert({ organisation_id: orgId, name: name.trim(), sort_order: (ref.menuCategories.length + 1) * 10 }));
    setName('');
    await ref.reload();
  });
  const toggle = (c: MenuCategory) => act(async () => { await run(sb.from('menu_categories').update({ is_active: !c.is_active }).eq('id', c.id)); await ref.reload(); });
  return (
    <Modal open title="Menu categories" onClose={onClose} footer={<Button variant="secondary" onClick={onClose}>Done</Button>}>
      <ErrorNote error={error} />
      <div className="flex flex-col divide-y divide-line rounded-md border border-line">
        {ref.menuCategories.length === 0 && <p className="p-3 text-sm text-muted">No categories yet.</p>}
        {ref.menuCategories.map(c => (
          <div key={c.id} className="flex items-center gap-2 px-3 py-2">
            <span className={c.is_active ? 'flex-1' : 'flex-1 text-muted line-through'}>{c.name}</span>
            <Button size="sm" variant="ghost" onClick={() => void toggle(c)}>{c.is_active ? 'Hide' : 'Show'}</Button>
          </div>
        ))}
      </div>
      <div className="mt-3 flex gap-2">
        <input className="input flex-1" placeholder="Starters, Biryani, Beverages…" value={name} onChange={e => setName(e.target.value)} />
        <Button busy={busy} onClick={() => void add()}>Add</Button>
      </div>
    </Modal>
  );
}
