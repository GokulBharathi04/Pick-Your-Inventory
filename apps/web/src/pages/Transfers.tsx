import { useState } from 'react';
import { useAccess } from '../lib/access';
import { useRefData } from '../lib/refdata';
import { useAction, useLoad } from '../lib/hooks';
import { useRoute } from '../lib/router';
import { run, sb } from '../lib/supabase';
import { fmtDateTime, fmtQty, toNum } from '../lib/format';
import { fromBase, toBase, stockUnit } from '../lib/units';
import type { Transfer, TransferLine } from '../lib/types';
import { Button, DataTable, ErrorNote, Field, FormGrid, Modal, Notice, PageHeader, ReasonModal, Select, StatusBadge, Toolbar, useToast } from '../components/ui';
import { ItemSelect, LocationSelect, NeedsOutlet, QtyInput, unitForItem } from '../components/inputs';

export default function Transfers() {
  return <NeedsOutlet><TransfersInner /></NeedsOutlet>;
}

function TransfersInner() {
  const { outletId, outlet, can } = useAccess();
  const ref = useRefData();
  const route = useRoute();
  const [status, setStatus] = useState('open');
  const [creating, setCreating] = useState(!!route.query.get('new'));
  const [openId, setOpenId] = useState<string | null>(null);

  const q = useLoad(async () => {
    let query = sb.from('stock_transfers').select('*').eq('outlet_id', outletId).order('created_at', { ascending: false }).limit(200);
    if (status === 'open') query = query.in('status', ['draft', 'sent']);
    else if (status !== 'all') query = query.eq('status', status);
    const transfers = await run<Transfer[]>(query);
    const lines = transfers.length
      ? await run<{ transfer_id: string }[]>(sb.from('stock_transfer_lines').select('transfer_id').in('transfer_id', transfers.map(t => t.id)))
      : [];
    const counts = new Map<string, number>();
    lines.forEach(l => counts.set(l.transfer_id, (counts.get(l.transfer_id) ?? 0) + 1));
    return { transfers, counts };
  }, [outletId, status]);

  return (
    <div>
      <PageHeader title="Transfers" subtitle={`${outlet?.name} · move stock between storage locations; the receiver confirms what arrived`}
        actions={can('stock.transfer') && <Button onClick={() => setCreating(true)}>New transfer</Button>} />
      <ErrorNote error={q.error} />
      <Toolbar>
        <Select className="max-w-44" value={status} onChange={setStatus} options={[
          { value: 'open', label: 'Draft and in transit' }, { value: 'received', label: 'Received' }, { value: 'cancelled', label: 'Cancelled' }, { value: 'all', label: 'All' }]} />
      </Toolbar>
      <DataTable rows={q.data?.transfers ?? []} rowKey={t => t.id} onRowClick={t => setOpenId(t.id)} empty={q.loading ? 'Loading…' : 'No transfers here'}
        columns={[
          { label: 'Created', render: t => fmtDateTime(t.created_at) },
          { label: 'From', render: t => ref.location(t.from_location_id)?.name },
          { label: 'To', render: t => ref.location(t.to_location_id)?.name },
          { label: 'Items', num: true, render: t => q.data?.counts.get(t.id) ?? 0 },
          { label: 'Sent', render: t => fmtDateTime(t.sent_at) },
          { label: 'Received', render: t => fmtDateTime(t.received_at) },
          { label: 'Status', render: t => <StatusBadge status={t.status} /> },
          { label: 'Note', render: t => <span className="text-muted">{t.note}</span> },
        ]} />
      {creating && <NewTransfer onClose={() => setCreating(false)} onSaved={id => { q.reload(); setOpenId(id); }} />}
      {openId && <TransferDetail id={openId} onClose={() => setOpenId(null)} onChanged={q.reload} />}
    </div>
  );
}

type Draft = { key: number; itemId: string; qty: string; unit: string };

function NewTransfer({ onClose, onSaved }: { onClose: () => void; onSaved: (id: string) => void }) {
  const { orgId, outletId } = useAccess();
  const ref = useRefData();
  const toast = useToast();
  const { busy, error, act } = useAction();
  const store = ref.outletLocations.find(l => l.kind === 'store' && l.is_active);
  const kitchen = ref.outletLocations.find(l => l.kind === 'kitchen' && l.is_active);
  const [from, setFrom] = useState(store?.id ?? ref.outletLocations[0]?.id ?? '');
  const [to, setTo] = useState(kitchen?.id ?? '');
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<Draft[]>([{ key: 1, itemId: '', qty: '', unit: '' }]);
  const setLine = (key: number, patch: Partial<Draft>) => setLines(ls => ls.map(l => (l.key === key ? { ...l, ...patch } : l)));

  const save = (send: boolean) => act(async () => {
    if (!from || !to || from === to) throw new Error('Choose two different locations');
    const filled = lines.filter(l => l.itemId && toNum(l.qty) > 0);
    if (filled.length === 0) throw new Error('Add at least one item and quantity');
    const merged = new Map<string, number>();
    for (const l of filled) {
      const it = ref.item(l.itemId)!;
      merged.set(l.itemId, (merged.get(l.itemId) ?? 0) + toBase(it, toNum(l.qty), l.unit, ref.units));
    }
    const t = await run<Transfer>(sb.from('stock_transfers').insert({ organisation_id: orgId, outlet_id: outletId, from_location_id: from, to_location_id: to, note: note.trim() || null }).select().single());
    await run(sb.from('stock_transfer_lines').insert(Array.from(merged.entries()).map(([item_id, quantity_sent]) => ({ organisation_id: orgId, outlet_id: outletId, transfer_id: t.id, item_id, quantity_sent }))));
    if (send) await run(sb.rpc('send_stock_transfer', { p_transfer_id: t.id }));
    toast(send ? 'Transfer sent. The receiving location confirms what arrives.' : 'Draft saved');
    onSaved(t.id);
    onClose();
  });

  return (
    <Modal open size="lg" title="New transfer" onClose={onClose}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="secondary" busy={busy} onClick={() => void save(false)}>Save draft</Button><Button busy={busy} onClick={() => void save(true)}>Send now</Button></>}>
      <ErrorNote error={error} />
      <FormGrid cols={3}>
        <Field label="From"><LocationSelect value={from} onChange={setFrom} /></Field>
        <Field label="To"><LocationSelect value={to} onChange={setTo} exclude={from} /></Field>
        <Field label="Note"><input className="input" value={note} onChange={e => setNote(e.target.value)} placeholder="Morning issue" /></Field>
      </FormGrid>
      <div className="mt-4 flex flex-col gap-2">
        {lines.map(l => (
          <div key={l.key} className="grid grid-cols-1 items-end gap-2 sm:grid-cols-[1fr_220px_auto]">
            <Field label="Item"><ItemSelect value={l.itemId} onChange={id => setLine(l.key, { itemId: id, unit: unitForItem(ref.item(id)) })} /></Field>
            <Field label="Quantity"><QtyInput item={ref.item(l.itemId)} qty={l.qty} unit={l.unit} onQty={v => setLine(l.key, { qty: v })} onUnit={v => setLine(l.key, { unit: v })} /></Field>
            <Button variant="ghost" onClick={() => setLines(ls => (ls.length > 1 ? ls.filter(x => x.key !== l.key) : ls))} aria-label="Remove line">Remove</Button>
          </div>
        ))}
        <div><Button variant="secondary" size="sm" onClick={() => setLines(ls => [...ls, { key: Date.now(), itemId: '', qty: '', unit: '' }])}>Add another item</Button></div>
      </div>
    </Modal>
  );
}

function TransferDetail({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { orgId, outletId, can } = useAccess();
  const ref = useRefData();
  const toast = useToast();
  const { busy, error, act } = useAction();
  const q = useLoad(async () => {
    const [t, lines] = await Promise.all([
      run<Transfer>(sb.from('stock_transfers').select('*').eq('id', id).single()),
      run<TransferLine[]>(sb.from('stock_transfer_lines').select('*').eq('transfer_id', id)),
    ]);
    return { t, lines };
  }, [id]);
  const [received, setReceived] = useState<Record<string, string>>({});
  const [cancelling, setCancelling] = useState(false);
  const [addItem, setAddItem] = useState('');
  const [addQty, setAddQty] = useState('');
  const [addUnit, setAddUnit] = useState('');

  const t = q.data?.t;
  const lines = q.data?.lines ?? [];
  const refresh = () => { q.reload(); onChanged(); };

  const send = () => act(async () => { await run(sb.rpc('send_stock_transfer', { p_transfer_id: id })); toast('Transfer sent'); refresh(); });
  const receive = () => act(async () => {
    const payload = lines.map(l => {
      const it = ref.item(l.item_id)!;
      const v = received[l.id];
      return { line_id: l.id, quantity: v === undefined || v === '' ? toNum(l.quantity_sent) : toBase(it, toNum(v), stockUnit(it), ref.units) };
    });
    await run(sb.rpc('receive_stock_transfer', { p_transfer_id: id, p_received: payload }));
    toast('Received. Stock is now in the receiving location.');
    refresh();
  });
  const removeLine = (lineId: string) => act(async () => { await run(sb.from('stock_transfer_lines').delete().eq('id', lineId)); refresh(); });
  const addLine = () => act(async () => {
    const it = ref.item(addItem);
    if (!it || toNum(addQty) <= 0) throw new Error('Choose an item and quantity');
    await run(sb.from('stock_transfer_lines').insert({ organisation_id: orgId, outlet_id: outletId, transfer_id: id, item_id: it.id, quantity_sent: toBase(it, toNum(addQty), addUnit, ref.units) }));
    setAddItem(''); setAddQty('');
    refresh();
  });

  return (
    <Modal open size="lg" onClose={onClose}
      title={t ? <>Transfer: {ref.location(t.from_location_id)?.name} → {ref.location(t.to_location_id)?.name} <StatusBadge status={t.status} /></> : 'Transfer'}
      footer={t && <>
        {can('stock.transfer') && (t.status === 'draft' || t.status === 'sent') && <Button variant="danger" className="mr-auto" onClick={() => setCancelling(true)}>Cancel transfer</Button>}
        <Button variant="secondary" onClick={onClose}>Close</Button>
        {can('stock.transfer') && t.status === 'draft' && <Button busy={busy} onClick={() => void send()}>Send</Button>}
        {can('stock.transfer') && t.status === 'sent' && <Button busy={busy} onClick={() => void receive()}>Confirm received</Button>}
      </>}>
      <ErrorNote error={error ?? q.error} />
      {t && (
        <>
          <p className="mb-3 text-sm text-muted">Created {fmtDateTime(t.created_at)}{t.sent_at && ` · sent ${fmtDateTime(t.sent_at)}`}{t.received_at && ` · received ${fmtDateTime(t.received_at)}`}{t.note && ` · ${t.note}`}</p>
          {t.status === 'sent' && <Notice>Enter what actually arrived if it differs from what was sent. Anything short is recorded as a loss in transit.</Notice>}
          <DataTable rows={lines} rowKey={l => l.id} empty="No items"
            columns={[
              { label: 'Item', render: l => ref.item(l.item_id)?.name },
              { label: 'Sent', num: true, render: l => fmtQty(l.quantity_sent, ref.item(l.item_id)?.base_unit) },
              {
                label: 'Received', num: true, render: l => {
                  const it = ref.item(l.item_id);
                  if (t.status === 'sent' && it) {
                    const u = stockUnit(it);
                    return (
                      <div className="flex items-center justify-end gap-1">
                        <input className="input w-28 text-right" type="number" min="0" step="any"
                          value={received[l.id] ?? String(fromBase(it, toNum(l.quantity_sent), u, ref.units))}
                          onChange={e => setReceived({ ...received, [l.id]: e.target.value })} />
                        <span className="w-8 text-left text-xs text-muted">{u}</span>
                      </div>
                    );
                  }
                  return l.quantity_received != null ? fmtQty(l.quantity_received, it?.base_unit) : '—';
                },
              },
              { label: '', render: l => t.status === 'draft' && can('stock.transfer') && lines.length > 1 && <Button size="sm" variant="ghost" onClick={() => void removeLine(l.id)}>Remove</Button> },
            ]} />
          {t.status === 'draft' && can('stock.transfer') && (
            <div className="mt-3 grid grid-cols-1 items-end gap-2 sm:grid-cols-[1fr_220px_auto]">
              <Field label="Add item"><ItemSelect value={addItem} onChange={v => { setAddItem(v); setAddUnit(unitForItem(ref.item(v))); }} filter={i => !lines.some(l => l.item_id === i.id)} /></Field>
              <Field label="Quantity"><QtyInput item={ref.item(addItem)} qty={addQty} unit={addUnit} onQty={setAddQty} onUnit={setAddUnit} /></Field>
              <Button variant="secondary" busy={busy} onClick={() => void addLine()}>Add</Button>
            </div>
          )}
        </>
      )}
      <ReasonModal open={cancelling} title="Cancel this transfer" label="Why?" confirmLabel="Cancel transfer" danger onClose={() => setCancelling(false)}
        onConfirm={async reason => { await run(sb.rpc('cancel_stock_transfer', { p_transfer_id: id, p_reason: reason })); toast('Transfer cancelled'); refresh(); }} />
    </Modal>
  );
}
