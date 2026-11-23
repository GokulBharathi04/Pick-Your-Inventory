import { useMemo, useState } from 'react';
import { useAccess } from '../lib/access';
import { useRefData } from '../lib/refdata';
import { useAction, useLoad } from '../lib/hooks';
import { useRoute } from '../lib/router';
import { run, sb } from '../lib/supabase';
import { addDays, dayStart, fmtDateTime, fmtMoney, fmtQty, humanize, isoDay, localDateTimeValue, toNum } from '../lib/format';
import type { LedgerRow, Wastage as WastageRow } from '../lib/types';
import { Badge, Button, Checkbox, DataTable, ErrorNote, Field, FormGrid, PageHeader, ReasonModal, Section, Select, Toolbar, useToast } from '../components/ui';
import { ItemSelect, LocationSelect, NeedsOutlet, QtyInput, unitForItem } from '../components/inputs';
import { useProfiles } from './StockCard';

export const wasteReasons = ['spoiled', 'expired', 'burnt', 'dropped', 'overproduced', 'staff_meal', 'tasting', 'other'];

export default function Wastage() {
  return <NeedsOutlet><WastageInner /></NeedsOutlet>;
}

function WastageInner() {
  const { outletId, outlet, can } = useAccess();
  const ref = useRefData();
  const toast = useToast();
  const people = useProfiles();
  const [from, setFrom] = useState(addDays(isoDay(), -6));
  const [to, setTo] = useState(isoDay());
  const [showVoided, setShowVoided] = useState(false);
  const [voiding, setVoiding] = useState<WastageRow | null>(null);

  const q = useLoad(async () => {
    const start = dayStart(from);
    const end = dayStart(addDays(to, 1));
    const [entries, ledger] = await Promise.all([
      run<WastageRow[]>(sb.from('wastage_entries').select('*').eq('outlet_id', outletId).gte('occurred_at', start).lt('occurred_at', end).order('occurred_at', { ascending: false })),
      run<LedgerRow[]>(sb.from('stock_ledger').select('source_id,value,reverses_entry_id').eq('outlet_id', outletId).eq('source_type', 'wastage').gte('occurred_at', start).lt('occurred_at', end)),
    ]);
    const value = new Map<string, number>();
    ledger.forEach(l => { if (l.source_id && !l.reverses_entry_id) value.set(l.source_id, -toNum(l.value)); });
    return { entries, value };
  }, [outletId, from, to]);

  const rows = (q.data?.entries ?? []).filter(w => showVoided || !w.voided_at);
  const byReason = useMemo(() => {
    const m = new Map<string, number>();
    (q.data?.entries ?? []).filter(w => !w.voided_at).forEach(w => m.set(w.reason, (m.get(w.reason) ?? 0) + (q.data?.value.get(w.id) ?? 0)));
    return Array.from(m.entries()).sort((a, b) => b[1] - a[1]);
  }, [q.data]);
  const total = byReason.reduce((s, [, v]) => s + v, 0);

  return (
    <div>
      <PageHeader title="Wastage and staff meals" subtitle={`${outlet?.name} · each entry takes stock out at its average cost`} />
      {can('wastage.record') && <WastageForm onSaved={q.reload} />}
      <Section title="Recorded" subtitle={`${fmtMoney(total)} in this period`}>
        <Toolbar>
          <Field label="From"><input className="input" type="date" value={from} onChange={e => setFrom(e.target.value)} /></Field>
          <Field label="To"><input className="input" type="date" value={to} onChange={e => setTo(e.target.value)} /></Field>
          <Checkbox label="Show voided" checked={showVoided} onChange={setShowVoided} />
        </Toolbar>
        {byReason.length > 0 && (
          <div className="mb-3 flex flex-wrap gap-2">{byReason.map(([r, v]) => <Badge key={r} tone="amber">{humanize(r)}: {fmtMoney(v)}</Badge>)}</div>
        )}
        <ErrorNote error={q.error} />
        <DataTable rows={rows} rowKey={w => w.id} empty={q.loading ? 'Loading…' : 'No wastage in this period'}
          columns={[
            { label: 'When', render: w => fmtDateTime(w.occurred_at) },
            { label: 'Item', render: w => <span className="font-medium">{ref.item(w.item_id)?.name}</span> },
            { label: 'Location', render: w => ref.location(w.location_id)?.name },
            { label: 'Quantity', num: true, render: w => fmtQty(w.quantity, ref.item(w.item_id)?.base_unit) },
            { label: 'Value', num: true, render: w => fmtMoney(q.data?.value.get(w.id) ?? 0) },
            { label: 'Reason', render: w => <>{humanize(w.reason)}{w.note && <div className="text-xs text-muted">{w.note}</div>}</> },
            { label: 'By', render: w => <span className="text-muted">{people.get(w.recorded_by ?? '') || '—'}</span> },
            { label: '', render: w => w.voided_at
              ? <span title={w.void_reason ?? ''}><Badge tone="red">Voided</Badge></span>
              : can('stock.adjust') && <Button size="sm" variant="ghost" onClick={() => setVoiding(w)}>Void</Button> },
          ]} />
      </Section>
      <ReasonModal open={!!voiding} title="Void this wastage entry" label="Why?" confirmLabel="Void" danger onClose={() => setVoiding(null)}
        onConfirm={async reason => {
          if (!voiding) return;
          await run(sb.rpc('void_wastage', { p_wastage_id: voiding.id, p_reason: reason }));
          toast('Voided. The stock is back.');
          q.reload();
        }} />
    </div>
  );
}

function WastageForm({ onSaved }: { onSaved: () => void }) {
  const { outletId } = useAccess();
  const ref = useRefData();
  const toast = useToast();
  const route = useRoute();
  const { busy, error, act } = useAction();
  const kitchen = ref.outletLocations.find(l => l.kind === 'kitchen' && l.is_active) ?? ref.outletLocations[0];
  const [locationId, setLocationId] = useState(kitchen?.id ?? '');
  const [itemId, setItemId] = useState('');
  const [qty, setQty] = useState('');
  const [unit, setUnit] = useState('');
  const [reason, setReason] = useState('spoiled');
  const [note, setNote] = useState('');
  const [when, setWhen] = useState(localDateTimeValue());
  const item = ref.item(itemId);

  const save = () => act(async () => {
    if (!item || !locationId) throw new Error('Choose a location and an item');
    if (toNum(qty) <= 0) throw new Error('Enter a quantity above zero');
    await run(sb.rpc('post_wastage', {
      p_outlet_id: outletId, p_location_id: locationId, p_item_id: item.id, p_quantity: toNum(qty), p_reason: reason,
      p_unit: unit, p_note: note.trim() || null, p_occurred_at: new Date(when).toISOString(),
    }));
    toast(`${humanize(reason)} recorded: ${qty} ${unit} of ${item.name}`);
    setItemId(''); setQty(''); setNote(''); setWhen(localDateTimeValue());
    onSaved();
  });

  return (
    <Section title="Record wastage or a staff meal" className={route.query.get('new') ? 'ring-2 ring-teal/40' : undefined}>
      <ErrorNote error={error} />
      <FormGrid cols={4}>
        <Field label="Location"><LocationSelect value={locationId} onChange={setLocationId} /></Field>
        <Field label="Item"><ItemSelect value={itemId} onChange={id => { setItemId(id); setUnit(unitForItem(ref.item(id))); }} /></Field>
        <Field label="Quantity"><QtyInput item={item} qty={qty} unit={unit} onQty={setQty} onUnit={setUnit} /></Field>
        <Field label="Reason"><Select value={reason} onChange={setReason} options={wasteReasons.map(r => ({ value: r, label: humanize(r) }))} /></Field>
        <Field label="When"><input className="input" type="datetime-local" value={when} onChange={e => setWhen(e.target.value)} /></Field>
        <Field label="Note" className="sm:col-span-2"><input className="input" value={note} onChange={e => setNote(e.target.value)} placeholder="Optional" /></Field>
        <div className="flex items-end"><Button busy={busy} className="w-full" onClick={() => void save()}>Record</Button></div>
      </FormGrid>
    </Section>
  );
}
