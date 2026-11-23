import { useState } from 'react';
import { useAccess } from '../lib/access';
import { useRefData } from '../lib/refdata';
import { useAction, useLoad } from '../lib/hooks';
import { navigate, useRoute } from '../lib/router';
import { errorText, run, sb } from '../lib/supabase';
import { fmtDateTime, fmtMoney, fmtQty, fmtRate, toNum } from '../lib/format';
import { toBase } from '../lib/units';
import type { Adjustment } from '../lib/types';
import { Badge, Button, DataTable, ErrorNote, Field, FormGrid, Modal, PageHeader, ReasonModal, Select, StatusBadge, Toolbar, useToast } from '../components/ui';
import { ItemSelect, LocationSelect, NeedsOutlet, QtyInput, unitForItem } from '../components/inputs';
import { useProfiles } from './StockCard';

export default function Adjustments() {
  return <NeedsOutlet><AdjustmentsInner /></NeedsOutlet>;
}

function AdjustmentsInner() {
  const { outletId, outlet, can } = useAccess();
  const ref = useRefData();
  const route = useRoute();
  const toast = useToast();
  const people = useProfiles();
  const [status, setStatus] = useState('pending');
  const [creating, setCreating] = useState(!!route.query.get('new'));
  const [rejecting, setRejecting] = useState<Adjustment | null>(null);
  const { busy, error, act } = useAction();

  const q = useLoad(() => {
    let query = sb.from('stock_adjustments').select('*').eq('outlet_id', outletId).order('requested_at', { ascending: false }).limit(300);
    if (status !== 'all') query = query.eq('status', status);
    return run<Adjustment[]>(query);
  }, [outletId, status]);

  const approve = (a: Adjustment) => act(async () => {
    await run(sb.rpc('decide_stock_adjustment', { p_adjustment_id: a.id, p_approve: true }));
    toast('Approved and posted to the stock ledger');
    q.reload();
  });
  const approveAll = () => act(async () => {
    const pending = (q.data ?? []).filter(a => a.status === 'pending');
    let failed = 0;
    for (const a of pending) {
      const { error: err } = await sb.rpc('decide_stock_adjustment', { p_adjustment_id: a.id, p_approve: true });
      if (err) failed++;
    }
    toast(failed ? `${pending.length - failed} approved, ${failed} could not be approved` : `${pending.length} approved`, failed ? 'bad' : 'ok');
    q.reload();
  });

  const pendingCount = (q.data ?? []).filter(a => a.status === 'pending').length;

  return (
    <div>
      <PageHeader title="Opening stock and adjustments" subtitle={`${outlet?.name} · requested here, approved by a manager, then posted to the ledger`}
        actions={<>
          {can('stock.adjust') && <Button variant="secondary" onClick={() => navigate('/import?type=opening')}>Import opening stock</Button>}
          {can('stock.adjust') && <Button onClick={() => setCreating(true)}>New request</Button>}
        </>} />
      <ErrorNote error={error ?? q.error} />
      <Toolbar>
        <Select className="max-w-44" value={status} onChange={setStatus} options={[
          { value: 'pending', label: 'Waiting for approval' }, { value: 'posted', label: 'Posted' }, { value: 'rejected', label: 'Rejected' }, { value: 'all', label: 'All' }]} />
        {can('adjustments.approve') && status === 'pending' && pendingCount > 1 && (
          <Button variant="secondary" busy={busy} onClick={() => void approveAll()}>Approve all {pendingCount}</Button>
        )}
      </Toolbar>
      <DataTable rows={q.data ?? []} rowKey={a => a.id} empty={q.loading ? 'Loading…' : 'Nothing here'}
        columns={[
          { label: 'Requested', render: a => <><div className="whitespace-nowrap">{fmtDateTime(a.requested_at)}</div><div className="text-xs text-muted">{people.get(a.requested_by ?? '') || ''}</div></> },
          { label: 'Kind', render: a => (a.kind === 'opening' ? <Badge tone="teal">Opening</Badge> : <Badge>Adjustment</Badge>) },
          { label: 'Item', render: a => <span className="font-medium">{ref.item(a.item_id)?.name}</span> },
          { label: 'Location', render: a => ref.location(a.location_id)?.name },
          { label: 'Quantity', num: true, render: a => <span className={toNum(a.quantity) < 0 ? 'text-red-700' : ''}>{toNum(a.quantity) > 0 ? '+' : ''}{fmtQty(a.quantity, ref.item(a.item_id)?.base_unit)}</span> },
          { label: 'Cost', num: true, render: a => (a.unit_cost != null ? <>{fmtRate(a.unit_cost, ref.item(a.item_id)?.base_unit)}<div className="text-xs text-muted">{fmtMoney(toNum(a.unit_cost) * toNum(a.quantity))}</div></> : <span className="text-muted">Average</span>) },
          { label: 'Reason', render: a => <>{a.reason}{a.decision_note && <div className="text-xs text-muted">Decision: {a.decision_note}</div>}</> },
          { label: 'Status', render: a => <StatusBadge status={a.status} /> },
          { label: '', render: a => a.status === 'pending' && can('adjustments.approve') && (
            <div className="flex gap-1">
              <Button size="sm" busy={busy} onClick={() => void approve(a)}>Approve</Button>
              <Button size="sm" variant="danger" onClick={() => setRejecting(a)}>Reject</Button>
            </div>
          ) },
        ]} />
      {creating && <NewAdjustment onClose={() => setCreating(false)} onSaved={() => { setStatus('pending'); q.reload(); }} />}
      <ReasonModal open={!!rejecting} title="Reject this request" label="Why?" confirmLabel="Reject" danger onClose={() => setRejecting(null)}
        onConfirm={async reason => {
          if (!rejecting) return;
          await run(sb.rpc('decide_stock_adjustment', { p_adjustment_id: rejecting.id, p_approve: false, p_note: reason }));
          toast('Rejected');
          q.reload();
        }} />
    </div>
  );
}

function NewAdjustment({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { orgId, outletId } = useAccess();
  const ref = useRefData();
  const toast = useToast();
  const { busy, error, setError, act } = useAction();
  const [kind, setKind] = useState('opening');
  const [direction, setDirection] = useState('remove');
  const [locationId, setLocationId] = useState(ref.outletLocations[0]?.id ?? '');
  const [itemId, setItemId] = useState('');
  const [qty, setQty] = useState('');
  const [unit, setUnit] = useState('');
  const [cost, setCost] = useState('');
  const [reason, setReason] = useState('Opening stock');
  const [another, setAnother] = useState(0);
  const item = ref.item(itemId);

  const save = (keepOpen: boolean) => act(async () => {
    if (!item || !locationId) throw new Error('Choose a location and an item');
    if (toNum(qty) <= 0) throw new Error('Enter a quantity above zero');
    if (kind === 'opening' && cost === '') throw new Error('Opening stock needs a cost');
    if (!reason.trim()) throw new Error('Give a reason');
    let base: number;
    try { base = toBase(item, toNum(qty), unit, ref.units); } catch (e) { throw new Error(errorText(e)); }
    const perBase = toBase(item, 1, unit, ref.units);
    const unitCost = cost === '' ? null : Math.round((toNum(cost) / perBase) * 1e6) / 1e6;
    await run(sb.from('stock_adjustments').insert({
      organisation_id: orgId, outlet_id: outletId, location_id: locationId, item_id: item.id, kind,
      quantity: kind === 'adjustment' && direction === 'remove' ? -base : base, unit_cost: unitCost, reason: reason.trim(),
    }));
    toast('Request saved. A manager approves it to post it to stock.');
    onSaved();
    if (keepOpen) { setItemId(''); setQty(''); setCost(''); setAnother(n => n + 1); setError(null); } else onClose();
  });

  return (
    <Modal open title="Request opening stock or an adjustment" onClose={onClose}
      footer={<>
        <Button variant="secondary" onClick={onClose}>Close</Button>
        <Button variant="secondary" busy={busy} onClick={() => void save(true)}>Save and add another</Button>
        <Button busy={busy} onClick={() => void save(false)}>Save request</Button>
      </>}>
      <ErrorNote error={error} />
      {another > 0 && <p className="mb-2 text-xs text-green-700">{another} saved so far.</p>}
      <FormGrid>
        <Field label="Kind">
          <Select value={kind} onChange={v => { setKind(v); setReason(v === 'opening' ? 'Opening stock' : ''); }}
            options={[{ value: 'opening', label: 'Opening stock (first day)' }, { value: 'adjustment', label: 'Adjustment (correction)' }]} />
        </Field>
        <Field label="Location"><LocationSelect value={locationId} onChange={setLocationId} /></Field>
        <Field label="Item" className="sm:col-span-2"><ItemSelect value={itemId} onChange={id => { setItemId(id); setUnit(unitForItem(ref.item(id))); }} /></Field>
        {kind === 'adjustment' && (
          <Field label="Change">
            <Select value={direction} onChange={setDirection} options={[{ value: 'remove', label: 'Remove from stock' }, { value: 'add', label: 'Add to stock' }]} />
          </Field>
        )}
        <Field label="Quantity"><QtyInput item={item} qty={qty} unit={unit} onQty={setQty} onUnit={setUnit} /></Field>
        <Field label={`Cost per ${unit || 'unit'} (₹)`} hint={kind === 'opening' ? 'Required for opening stock' : 'Leave empty to use the average cost'}>
          <input className="input" type="number" min="0" step="any" value={cost} onChange={e => setCost(e.target.value)} />
        </Field>
        <Field label="Reason" className="sm:col-span-2"><input className="input" value={reason} onChange={e => setReason(e.target.value)} maxLength={200} /></Field>
      </FormGrid>
    </Modal>
  );
}
