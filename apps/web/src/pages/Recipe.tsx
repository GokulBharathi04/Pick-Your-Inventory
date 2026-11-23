import { useEffect, useMemo, useState } from 'react';
import { useAccess } from '../lib/access';
import { useRefData } from '../lib/refdata';
import { useAction, useLoad } from '../lib/hooks';
import { run, sb } from '../lib/supabase';
import { fmtDate, fmtMoney, fmtNum, fmtPct, fmtQty, fmtRate, toNum } from '../lib/format';
import { defaultUnit, fromBase, toBase, unitsFor } from '../lib/units';
import type { Item, ItemCost, Recipe, RecipeLine } from '../lib/types';
import { Badge, Button, DataTable, ErrorNote, Field, Notice, StatusBadge, useToast } from '../components/ui';
import { ItemSelect, QtyInput } from '../components/inputs';

// Recipe builder for a dish (menu item) or a prep item. Only a draft changes;
// activating a draft retires the version before it.
export function RecipeEditor({ menuItemId, prepItem, sellingPrice }: { menuItemId?: string; prepItem?: Item; sellingPrice?: number }) {
  const { orgId, outletId, can } = useAccess();
  const ref = useRefData();
  const toast = useToast();
  const { busy, error, act } = useAction();
  const editable = can('recipes.edit');

  const recipesQ = useLoad(() => {
    const qy = sb.from('recipes').select('*').order('version', { ascending: false });
    return run<Recipe[]>(menuItemId ? qy.eq('menu_item_id', menuItemId) : qy.eq('prep_item_id', prepItem?.id ?? ''));
  }, [menuItemId, prepItem?.id]);
  const costsQ = useLoad(async () => (outletId ? run<ItemCost[]>(sb.rpc('item_costs', { p_outlet_id: outletId })) : []), [outletId]);
  const costOf = useMemo(() => new Map((costsQ.data ?? []).map(c => [c.item_id, toNum(c.unit_cost)])), [costsQ.data]);

  const recipes = recipesQ.data ?? [];
  const [versionId, setVersionId] = useState('');
  const recipe = recipes.find(r => r.id === versionId) ?? recipes.find(r => r.status === 'draft') ?? recipes.find(r => r.status === 'active') ?? recipes[0];
  const linesQ = useLoad(async () => (recipe ? run<RecipeLine[]>(sb.from('recipe_lines').select('*').eq('recipe_id', recipe.id).order('sort_order').order('created_at')) : []), [recipe?.id]);
  const lines = linesQ.data ?? [];
  const isDraft = recipe?.status === 'draft' && editable;

  // Yield: portions for a dish; amount one batch makes for a prep item.
  const yieldUnit = prepItem ? defaultUnit(prepItem.base_unit) : '';
  const [yieldText, setYieldText] = useState('');
  useEffect(() => {
    if (!recipe) return;
    setYieldText(prepItem ? String(fromBase(prepItem, toNum(recipe.yield_qty), yieldUnit, ref.units)) : String(toNum(recipe.yield_qty)));
  }, [recipe?.id, recipe?.yield_qty]); // eslint-disable-line react-hooks/exhaustive-deps

  const total = lines.reduce((s, l) => s + toNum(l.quantity_in_base) * (costOf.get(l.item_id) ?? 0), 0);
  const perUnit = recipe && toNum(recipe.yield_qty) > 0 ? total / toNum(recipe.yield_qty) : 0;

  const reload = () => { recipesQ.reload(); linesQ.reload(); costsQ.reload(); };

  const create = () => act(async () => {
    const yieldQty = prepItem ? toBase(prepItem, toNum(yieldText) || 1, yieldUnit, ref.units) : Math.max(toNum(yieldText), 1);
    const r = await run<Recipe>(sb.from('recipes').insert({ organisation_id: orgId, menu_item_id: menuItemId ?? null, prep_item_id: prepItem?.id ?? null, version: 1, yield_qty: yieldQty }).select().single());
    setVersionId(r.id);
    reload();
  });
  const newVersion = () => act(async () => {
    if (!recipe) return;
    const next = Math.max(...recipes.map(r => r.version)) + 1;
    const r = await run<Recipe>(sb.from('recipes').insert({ organisation_id: orgId, menu_item_id: menuItemId ?? null, prep_item_id: prepItem?.id ?? null, version: next, yield_qty: recipe.yield_qty, note: recipe.note }).select().single());
    if (lines.length) {
      await run(sb.from('recipe_lines').insert(lines.map(l => ({ organisation_id: orgId, recipe_id: r.id, item_id: l.item_id, quantity: l.quantity, unit: l.unit, yield_pct: l.yield_pct, sort_order: l.sort_order, note: l.note }))));
    }
    setVersionId(r.id);
    toast(`Version ${next} created as a draft`);
    reload();
  });
  const saveYield = () => act(async () => {
    if (!recipe) return;
    const yieldQty = prepItem ? toBase(prepItem, toNum(yieldText), yieldUnit, ref.units) : toNum(yieldText);
    if (yieldQty <= 0) throw new Error('The yield must be above zero');
    await run(sb.from('recipes').update({ yield_qty: yieldQty }).eq('id', recipe.id));
    reload();
  });
  const activate = () => act(async () => {
    if (!recipe) return;
    if (lines.length === 0) throw new Error('Add at least one ingredient before activating');
    await run(sb.from('recipes').update({ status: 'active' }).eq('id', recipe.id));
    toast(`Version ${recipe.version} is now active. Future sales use it.`);
    reload();
  });
  const removeLine = (l: RecipeLine) => act(async () => { await run(sb.from('recipe_lines').delete().eq('id', l.id)); reload(); });

  if (recipesQ.loading && !recipesQ.data) return <p className="text-sm text-muted">Loading…</p>;

  if (!recipe) {
    return (
      <div>
        <ErrorNote error={error ?? recipesQ.error} />
        <p className="mb-3 text-sm text-muted">No recipe yet. {prepItem ? 'How much does one batch make?' : 'How many portions does the recipe make? Usually 1.'}</p>
        {editable && (
          <div className="flex items-end gap-2">
            <Field label={prepItem ? `One batch makes (${yieldUnit})` : 'Portions'}><input className="input w-36" type="number" min="0" step="any" value={yieldText} onChange={e => setYieldText(e.target.value)} placeholder={prepItem ? '5' : '1'} /></Field>
            <Button busy={busy} onClick={() => void create()}>Start recipe</Button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div>
      <ErrorNote error={error ?? recipesQ.error ?? linesQ.error} />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {recipes.map(r => (
          <button key={r.id} type="button" onClick={() => setVersionId(r.id)}
            className={`rounded-md border px-2.5 py-1 text-xs ${r.id === recipe.id ? 'border-teal bg-teal-wash text-teal-ink' : 'border-line bg-white'}`}>
            Version {r.version} · {r.status}
          </button>
        ))}
        <span className="ml-auto" />
        {editable && recipe.status !== 'draft' && !recipes.some(r => r.status === 'draft') && <Button size="sm" variant="secondary" busy={busy} onClick={() => void newVersion()}>Edit as new version</Button>}
        {isDraft && <Button size="sm" busy={busy} onClick={() => void activate()}>Activate this version</Button>}
      </div>
      {recipe.status === 'active' && <Notice tone="ok">Version {recipe.version} is active{recipe.activated_at ? ` since ${fmtDate(recipe.activated_at)}` : ''}. To change it, edit it as a new version.</Notice>}
      {recipe.status === 'retired' && <Notice>This version is retired. Past sales keep using it; new sales don’t.</Notice>}

      <div className="mb-3 flex flex-wrap items-end gap-3">
        <Field label={prepItem ? `One batch makes (${yieldUnit})` : 'Portions made'}>
          <input className="input w-36" type="number" min="0" step="any" value={yieldText} onChange={e => setYieldText(e.target.value)} disabled={!isDraft} onBlur={() => { if (isDraft) void saveYield(); }} />
        </Field>
        <div className="flex flex-wrap gap-4 pb-1.5 text-sm">
          <span>Ingredients cost: <strong>{fmtMoney(total)}</strong></span>
          {prepItem
            ? <span>Cost per {yieldUnit}: <strong>{fmtMoney(perUnit * toBase(prepItem, 1, yieldUnit, ref.units))}</strong></span>
            : <>
              <span>Per portion: <strong>{fmtMoney(perUnit)}</strong></span>
              {sellingPrice ? <span>Food cost: <strong className={perUnit / sellingPrice > 0.35 ? 'text-red-700' : 'text-green-700'}>{fmtPct((perUnit / sellingPrice) * 100)}</strong> of {fmtMoney(sellingPrice)}</span> : null}
            </>}
        </div>
      </div>

      <DataTable rows={lines} rowKey={l => l.id} empty="No ingredients yet"
        columns={[
          { label: 'Ingredient', render: l => { const it = ref.item(l.item_id); return <>{it?.name}{it?.item_type === 'prep' && <span className="ml-1"><Badge tone="teal">{it.deduct_ingredients_on_sale ? 'Prep, made to order' : 'Prep'}</Badge></span>}</>; } },
          { label: 'Amount', num: true, render: l => `${fmtNum(l.quantity, 3)} ${l.unit}` },
          { label: 'Usable %', num: true, render: l => (l.yield_pct != null ? `${fmtNum(l.yield_pct, 1)}%` : <span className="text-muted">{fmtNum(ref.item(l.item_id)?.default_yield_pct, 1)}%</span>) },
          { label: 'Deducted', num: true, render: l => fmtQty(l.quantity_in_base, ref.item(l.item_id)?.base_unit) },
          { label: 'Unit cost', num: true, render: l => fmtRate(costOf.get(l.item_id) ?? 0, ref.item(l.item_id)?.base_unit) },
          { label: 'Cost', num: true, render: l => fmtMoney(toNum(l.quantity_in_base) * (costOf.get(l.item_id) ?? 0)) },
          { label: '', render: l => isDraft && <Button size="sm" variant="ghost" onClick={() => void removeLine(l)}>Remove</Button> },
        ]} />
      {isDraft && <AddLine recipe={recipe} exclude={[...(prepItem ? [prepItem.id] : []), ...lines.map(l => l.item_id)]} onAdded={reload} />}
      {(costsQ.data ?? []).length > 0 && <p className="mt-2 text-xs text-muted">Costs use the current average cost at this outlet, or the vendor rate where there’s no stock yet.</p>}
    </div>
  );
}

function AddLine({ recipe, exclude, onAdded }: { recipe: Recipe; exclude: string[]; onAdded: () => void }) {
  const { orgId } = useAccess();
  const ref = useRefData();
  const { busy, error, act } = useAction();
  const [itemId, setItemId] = useState('');
  const [qty, setQty] = useState('');
  const [unit, setUnit] = useState('');
  const [yieldPct, setYieldPct] = useState('');
  const item = ref.item(itemId);
  const add = () => act(async () => {
    if (!item || toNum(qty) <= 0) throw new Error('Choose an ingredient and an amount');
    if (!unitsFor(item, ref.units).some(u => u.code === unit)) throw new Error('Choose a unit');
    await run(sb.from('recipe_lines').insert({ organisation_id: orgId, recipe_id: recipe.id, item_id: item.id, quantity: toNum(qty), unit, yield_pct: yieldPct === '' ? null : toNum(yieldPct), sort_order: 100 }));
    setItemId(''); setQty(''); setYieldPct('');
    onAdded();
  });
  return (
    <div className="mt-3 rounded-lg border border-line p-3">
      <ErrorNote error={error} />
      <div className="grid grid-cols-1 items-end gap-2 sm:grid-cols-[1fr_200px_110px_auto]">
        <Field label="Ingredient"><ItemSelect value={itemId} onChange={v => { setItemId(v); setUnit(ref.item(v)?.base_unit ?? ''); }} filter={i => !exclude.includes(i.id)} /></Field>
        <Field label="Amount per recipe"><QtyInput item={item} qty={qty} unit={unit} onQty={setQty} onUnit={setUnit} /></Field>
        <Field label="Usable %" hint="Optional"><input className="input" type="number" min="1" max="100" step="any" value={yieldPct} onChange={e => setYieldPct(e.target.value)} placeholder={item ? String(toNum(item.default_yield_pct)) : ''} /></Field>
        <Button busy={busy} onClick={() => void add()}>Add</Button>
      </div>
    </div>
  );
}

export function RecipeStatus({ recipes }: { recipes: Recipe[] }) {
  const active = recipes.find(r => r.status === 'active');
  const draft = recipes.find(r => r.status === 'draft');
  if (active) return <span className="inline-flex items-center gap-1"><StatusBadge status="active" /><span className="text-xs text-muted">v{active.version}{draft ? ', draft open' : ''}</span></span>;
  if (draft) return <StatusBadge status="draft" />;
  return <span className="text-xs text-muted">No recipe</span>;
}
