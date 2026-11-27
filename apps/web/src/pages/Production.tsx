import { useState } from 'react';
import { useAccess } from '../lib/access';
import { useRefData } from '../lib/refdata';
import { useAction, useLoad } from '../lib/hooks';
import { useRoute } from '../lib/router';
import { run, sb } from '../lib/supabase';
import { addDays, dayStart, fmtDateTime, fmtNum, fmtQty, isoDay, localDateTimeValue, toNum } from '../lib/format';
import { toBase, stockUnit } from '../lib/units';
import type { PrepBatch, Recipe, RecipeLine } from '../lib/types';
import { Badge, Button, Checkbox, DataTable, ErrorNote, Field, FormGrid, Notice, PageHeader, ReasonModal, Section, Toolbar, useToast } from '../components/ui';
import { ItemSelect, LocationSelect, NeedsOutlet } from '../components/inputs';
import { useProfiles } from './StockCard';

export default function Production() {
  return <NeedsOutlet><ProductionInner /></NeedsOutlet>;
}

function ProductionInner() {
  const { outletId, outlet, can, orgId } = useAccess();
  const ref = useRefData();
  const toast = useToast();
  const people = useProfiles();
  const [from, setFrom] = useState(addDays(isoDay(), -6));
  const [to, setTo] = useState(isoDay());
  const [showVoided, setShowVoided] = useState(false);
  const [voiding, setVoiding] = useState<PrepBatch | null>(null);

  const recipesQ = useLoad(() => run<Recipe[]>(sb.from('recipes').select('*').eq('organisation_id', orgId).eq('status', 'active').not('prep_item_id', 'is', null)), [orgId]);
  const q = useLoad(() => run<PrepBatch[]>(sb.from('prep_batches').select('*').eq('outlet_id', outletId)
    .gte('produced_at', dayStart(from)).lt('produced_at', dayStart(addDays(to, 1))).order('produced_at', { ascending: false })), [outletId, from, to]);
  const rows = (q.data ?? []).filter(b => showVoided || !b.voided_at);

  return (
    <div>
      <PageHeader title="Prep production" subtitle={`${outlet?.name} · a batch takes its ingredients out of stock and puts the prep item in`} />
      {can('production.record') && <BatchForm recipes={recipesQ.data ?? []} onSaved={q.reload} />}
      <Section title="Batches made">
        <Toolbar>
          <Field label="From"><input className="input" type="date" value={from} onChange={e => setFrom(e.target.value)} /></Field>
          <Field label="To"><input className="input" type="date" value={to} onChange={e => setTo(e.target.value)} /></Field>
          <Checkbox label="Show voided" checked={showVoided} onChange={setShowVoided} />
        </Toolbar>
        <ErrorNote error={q.error} />
        <DataTable rows={rows} rowKey={b => b.id} empty={q.loading ? 'Loading…' : 'No batches in this period'}
          columns={[
            { label: 'When', render: b => fmtDateTime(b.produced_at) },
            { label: 'Prep item', render: b => <span className="font-medium">{ref.item(b.prep_item_id)?.name}</span> },
            { label: 'Batches', num: true, render: b => fmtNum(b.batches, 2) },
            { label: 'Made', num: true, render: b => fmtQty(b.quantity_produced, ref.item(b.prep_item_id)?.base_unit) },
            { label: 'Location', render: b => ref.location(b.location_id)?.name },
            { label: 'By', render: b => <span className="text-muted">{people.get(b.produced_by ?? '') || '—'}</span> },
            { label: '', render: b => b.voided_at
              ? <span title={b.void_reason ?? ''}><Badge tone="red">Voided</Badge></span>
              : can('production.record') && <Button size="sm" variant="ghost" onClick={() => setVoiding(b)}>Void</Button> },
          ]} />
      </Section>
      <ReasonModal open={!!voiding} title="Void this batch" label="Why?" confirmLabel="Void batch" danger onClose={() => setVoiding(null)}
        onConfirm={async reason => {
          if (!voiding) return;
          await run(sb.rpc('void_prep_batch', { p_prep_batch_id: voiding.id, p_reason: reason }));
          toast('Batch voided. Ingredients are back in stock.');
          q.reload();
        }} />
    </div>
  );
}

function BatchForm({ recipes, onSaved }: { recipes: Recipe[]; onSaved: () => void }) {
  const { outletId } = useAccess();
  const ref = useRefData();
  const toast = useToast();
  const route = useRoute();
  const { busy, error, act } = useAction();
  const kitchen = ref.outletLocations.find(l => l.kind === 'kitchen' && l.is_active) ?? ref.outletLocations[0];
  const [itemId, setItemId] = useState('');
  const [locationId, setLocationId] = useState(kitchen?.id ?? '');
  const [batches, setBatches] = useState('1');
  const [made, setMade] = useState('');
  const [note, setNote] = useState('');
  const [when, setWhen] = useState(localDateTimeValue());
  const item = ref.item(itemId);
  const recipe = recipes.find(r => r.prep_item_id === itemId);
  const linesQ = useLoad(async () => (recipe ? run<RecipeLine[]>(sb.from('recipe_lines').select('*').eq('recipe_id', recipe.id)) : []), [recipe?.id]);
  const u = item ? stockUnit(item) : '';
  const expected = recipe ? toNum(recipe.yield_qty) * toNum(batches) : 0;

  const save = () => act(async () => {
    if (!item || !recipe) throw new Error('Choose a prep item that has an active recipe');
    if (toNum(batches) <= 0) throw new Error('Enter how many batches were made');
    await run(sb.rpc('post_prep_batch', {
      p_outlet_id: outletId, p_location_id: locationId, p_prep_item_id: item.id, p_batches: toNum(batches),
      p_quantity_produced: made === '' ? null : toBase(item, toNum(made), u, ref.units), p_note: note.trim() || null,
      p_produced_at: new Date(when).toISOString(),
    }));
    toast(`${item.name}: ${fmtNum(batches)} batch${toNum(batches) === 1 ? '' : 'es'} recorded`);
    setMade(''); setNote(''); setBatches('1'); setWhen(localDateTimeValue());
    onSaved();
  });

  const withRecipe = new Set(recipes.map(r => r.prep_item_id));
  return (
    <Section title="Record a batch" className={route.query.get('new') ? 'ring-2 ring-teal/40' : undefined}>
      <ErrorNote error={error} />
      {recipes.length === 0 && <Notice tone="warn">No prep item has an active recipe yet. Add one in Menu and recipes → Prep recipes.</Notice>}
      <FormGrid cols={4}>
        <Field label="Prep item"><ItemSelect value={itemId} onChange={setItemId} filter={i => i.item_type === 'prep' && withRecipe.has(i.id)} /></Field>
        <Field label="Made at"><LocationSelect value={locationId} onChange={setLocationId} /></Field>
        <Field label="Batches"><input className="input" type="number" min="0" step="any" value={batches} onChange={e => setBatches(e.target.value)} /></Field>
        <Field label={`Actually made (${u || 'unit'})`} hint={recipe ? `Recipe gives ${fmtQty(expected, item?.base_unit)}` : undefined}>
          <input className="input" type="number" min="0" step="any" value={made} onChange={e => setMade(e.target.value)} placeholder="As per recipe" />
        </Field>
        <Field label="When"><input className="input" type="datetime-local" value={when} onChange={e => setWhen(e.target.value)} /></Field>
        <Field label="Note" className="sm:col-span-2"><input className="input" value={note} onChange={e => setNote(e.target.value)} placeholder="Optional" /></Field>
        <div className="flex items-end"><Button busy={busy} className="w-full" onClick={() => void save()}>Record batch</Button></div>
      </FormGrid>
      {recipe && (linesQ.data ?? []).length > 0 && (
        <p className="mt-3 text-sm text-muted">
          Takes out: {(linesQ.data ?? []).map(l => `${ref.item(l.item_id)?.name} ${fmtQty(toNum(l.quantity_in_base) * toNum(batches), ref.item(l.item_id)?.base_unit)}`).join(' · ')}
        </p>
      )}
    </Section>
  );
}
