import { useMemo, useState } from 'react';
import { useAccess } from '../lib/access';
import { useRefData } from '../lib/refdata';
import { useAction, useLoad } from '../lib/hooks';
import { navigate, useRoute } from '../lib/router';
import { run, sb } from '../lib/supabase';
import { addDays, fmtDate, fmtDateTime, fmtMoney, fmtQty, isoDay, toNum } from '../lib/format';
import { defaultUnit } from '../lib/units';
import type { PurchaseOrder, PurchaseOrderLine, VendorItem } from '../lib/types';
import { Button, DataTable, ErrorNote, Field, FormGrid, Modal, Notice, PageHeader, ReasonModal, Select, StatusBadge, Toolbar, useToast } from '../components/ui';
import { ItemSelect, NeedsOutlet, PurchaseUnitSelect, StoreSelect, VendorSelect, parsePurchaseUnit, purchaseUnitValue } from '../components/inputs';

export const OPEN_PO = ['draft', 'submitted', 'approved', 'partially_received'];

// "2 Crate" or "25 kg": an order or receipt line's quantity in the pack or unit it was bought in.
export function lineQty(qty: unknown, packSizeId: string | null, unit: string | null, packName: (id: string) => string | undefined): string {
  const n = toNum(qty);
  const label = packSizeId ? packName(packSizeId) ?? 'pack' : unit ?? '';
  return `${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 3 }).format(n)} ${label}`;
}

export default function PurchaseOrders() {
  return <NeedsOutlet><PurchaseOrdersInner /></NeedsOutlet>;
}

function PurchaseOrdersInner() {
  const { outletId, outlet, can } = useAccess();
  const ref = useRefData();
  const route = useRoute();
  const [status, setStatus] = useState('open');
  const [vendor, setVendor] = useState('');
  const [editing, setEditing] = useState<PurchaseOrder | 'new' | null>(route.query.get('new') ? 'new' : null);
  const [openId, setOpenId] = useState<string | null>(route.query.get('open'));

  const q = useLoad(async () => {
    let query = sb.from('purchase_orders').select('*').eq('outlet_id', outletId).order('created_at', { ascending: false }).limit(300);
    if (status === 'open') query = query.in('status', OPEN_PO);
    else if (status !== 'all') query = query.eq('status', status);
    if (vendor) query = query.eq('vendor_id', vendor);
    const orders = await run<PurchaseOrder[]>(query);
    const lines = orders.length ? await run<{ purchase_order_id: string }[]>(sb.from('purchase_order_lines').select('purchase_order_id').in('purchase_order_id', orders.map(o => o.id))) : [];
    const counts = new Map<string, number>();
    lines.forEach(l => counts.set(l.purchase_order_id, (counts.get(l.purchase_order_id) ?? 0) + 1));
    return { orders, counts };
  }, [outletId, status, vendor]);

  return (
    <div>
      <PageHeader title="Purchase orders" subtitle={`${outlet?.name} · raise, approve and track orders to vendors; goods are received into the store`}
        actions={can('purchase.order') && <Button onClick={() => setEditing('new')}>New purchase order</Button>} />
      <ErrorNote error={q.error} />
      <Toolbar>
        <Select className="max-w-52" value={status} onChange={setStatus} options={[
          { value: 'open', label: 'Open orders' }, { value: 'draft', label: 'Drafts' }, { value: 'submitted', label: 'Waiting for approval' },
          { value: 'approved', label: 'Approved' }, { value: 'partially_received', label: 'Part received' }, { value: 'received', label: 'Received' },
          { value: 'closed', label: 'Closed short' }, { value: 'cancelled', label: 'Cancelled' }, { value: 'all', label: 'All' }]} />
        <Select className="max-w-52" value={vendor} onChange={setVendor} placeholder="All vendors" options={ref.vendors.map(v => ({ value: v.id, label: v.name }))} />
      </Toolbar>
      <DataTable rows={q.data?.orders ?? []} rowKey={o => o.id} onRowClick={o => setOpenId(o.id)} empty={q.loading ? 'Loading…' : 'No purchase orders here'}
        columns={[
          { label: 'Order', render: o => <span className="font-medium">{o.po_no}</span> },
          { label: 'Vendor', render: o => ref.vendor(o.vendor_id)?.name },
          { label: 'Ordered', render: o => fmtDate(o.order_date) },
          { label: 'Expected', render: o => fmtDate(o.expected_date) },
          { label: 'Items', num: true, render: o => q.data?.counts.get(o.id) ?? 0 },
          { label: 'Amount', num: true, render: o => fmtMoney(toNum(o.total_amount) + toNum(o.tax_amount)) },
          { label: 'Status', render: o => <StatusBadge status={o.status} /> },
        ]} />
      {editing && <OrderEditor order={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={id => { q.reload(); setOpenId(id); }} />}
      {openId && <OrderDetail id={openId} onClose={() => setOpenId(null)} onChanged={q.reload} onEdit={o => { setOpenId(null); setEditing(o); }} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create or edit a draft
// ---------------------------------------------------------------------------
type Draft = { key: number; itemId: string; pu: string; qty: string; rate: string; gst: string };

function OrderEditor({ order, onClose, onSaved }: { order: PurchaseOrder | null; onClose: () => void; onSaved: (id: string) => void }) {
  const { outletId, can } = useAccess();
  const ref = useRefData();
  const toast = useToast();
  const { busy, error, act } = useAction();
  const [vendorId, setVendorId] = useState(order?.vendor_id ?? '');
  const [storeId, setStoreId] = useState(order?.deliver_to_location_id ?? ref.outletStores.find(l => l.is_active)?.id ?? '');
  const [expected, setExpected] = useState(order?.expected_date ?? addDays(isoDay(), 1));
  const [note, setNote] = useState(order?.note ?? '');
  const [lines, setLines] = useState<Draft[]>([{ key: 1, itemId: '', pu: '', qty: '', rate: '', gst: '' }]);
  const setLine = (key: number, patch: Partial<Draft>) => setLines(ls => ls.map(l => (l.key === key ? { ...l, ...patch } : l)));

  // Existing lines of a draft being edited
  useLoad(async () => {
    if (!order) return null;
    const existing = await run<PurchaseOrderLine[]>(sb.from('purchase_order_lines').select('*').eq('purchase_order_id', order.id));
    if (existing.length) {
      setLines(existing.map((l, i) => ({
        key: i + 1, itemId: l.item_id, pu: purchaseUnitValue({ packSizeId: l.pack_size_id, unit: l.unit }),
        qty: String(toNum(l.quantity)), rate: String(toNum(l.rate)), gst: l.gst_rate == null ? '' : String(toNum(l.gst_rate)),
      })));
    }
    return null;
  }, [order?.id]);

  const pricesQ = useLoad(async () => (vendorId
    ? run<VendorItem[]>(sb.from('vendor_items').select('*').eq('vendor_id', vendorId).is('valid_to', null))
    : [] as VendorItem[]), [vendorId]);
  const prices = pricesQ.data ?? [];
  const priceFor = (itemId: string, pu: string) => {
    const p = parsePurchaseUnit(pu);
    return prices.find(v => v.item_id === itemId && (p.packSizeId ? v.pack_size_id === p.packSizeId : v.price_unit === p.unit));
  };

  const pickItem = (key: number, itemId: string) => {
    const it = ref.item(itemId);
    const vp = prices.find(v => v.item_id === itemId);
    const pu = vp ? purchaseUnitValue({ packSizeId: vp.pack_size_id, unit: vp.price_unit }) : it ? defaultUnit(it.base_unit) : '';
    setLine(key, { itemId, pu, rate: vp ? String(toNum(vp.rate)) : '', gst: it?.gst_rate == null ? '' : String(toNum(it.gst_rate)) });
  };
  const pickUnit = (key: number, itemId: string, pu: string) => {
    const vp = priceFor(itemId, pu);
    setLine(key, { pu, ...(vp ? { rate: String(toNum(vp.rate)) } : {}) });
  };

  const filled = lines.filter(l => l.itemId && toNum(l.qty) > 0);
  const subtotal = filled.reduce((s, l) => s + toNum(l.qty) * toNum(l.rate), 0);
  const tax = filled.reduce((s, l) => s + (toNum(l.qty) * toNum(l.rate) * toNum(l.gst)) / 100, 0);

  const save = (submit: boolean) => act(async () => {
    if (!vendorId || !storeId) throw new Error('Choose the vendor and the store to deliver to');
    if (filled.length === 0) throw new Error('Add at least one item and quantity');
    const missing = filled.find(l => l.rate === '');
    if (missing) throw new Error(`Enter a rate for ${ref.item(missing.itemId)?.name}`);
    const id = await run<string>(sb.rpc('save_purchase_order', {
      p_purchase_order_id: order?.id ?? null, p_outlet_id: outletId, p_vendor_id: vendorId, p_location_id: storeId,
      p_lines: filled.map(l => {
        const p = parsePurchaseUnit(l.pu);
        return { item_id: l.itemId, pack_size_id: p.packSizeId, unit: p.unit, quantity: toNum(l.qty), rate: toNum(l.rate), gst_rate: l.gst === '' ? null : toNum(l.gst) };
      }),
      p_expected_date: expected || null, p_note: note.trim() || null,
    }));
    if (submit) await run(sb.rpc('submit_purchase_order', { p_purchase_order_id: id }));
    toast(submit ? 'Order submitted for approval' : 'Draft saved');
    onSaved(id);
    onClose();
  });

  return (
    <Modal open size="xl" title={order ? `Edit ${order.po_no}` : 'New purchase order'} onClose={onClose}
      footer={<>
        <span className="mr-auto self-center text-sm text-muted">Before GST {fmtMoney(subtotal)} · GST {fmtMoney(tax)} · <span className="font-semibold text-ink">Total {fmtMoney(subtotal + tax)}</span></span>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button variant="secondary" busy={busy} onClick={() => void save(false)}>Save draft</Button>
        {can('purchase.order') && <Button busy={busy} onClick={() => void save(true)}>Save and submit</Button>}
      </>}>
      <ErrorNote error={error ?? pricesQ.error} />
      {order?.decision_note && <Notice tone="warn">Sent back: {order.decision_note}</Notice>}
      <FormGrid cols={4}>
        <Field label="Vendor"><VendorSelect value={vendorId} onChange={setVendorId} /></Field>
        <Field label="Deliver to"><StoreSelect value={storeId} onChange={setStoreId} /></Field>
        <Field label="Expected on"><input className="input" type="date" value={expected} min={isoDay()} onChange={e => setExpected(e.target.value)} /></Field>
        <Field label="Note"><input className="input" value={note} onChange={e => setNote(e.target.value)} placeholder="Optional" /></Field>
      </FormGrid>
      <div className="mt-4 flex flex-col gap-2">
        {lines.map(l => {
          const it = ref.item(l.itemId);
          const sells = !!prices.find(v => v.item_id === l.itemId);
          return (
            <div key={l.key} className="grid grid-cols-1 items-end gap-2 sm:grid-cols-[1fr_250px_120px_90px_110px_auto]">
              <Field label="Item" hint={l.itemId && vendorId && !sells ? 'This vendor has no price for it' : undefined}>
                <ItemSelect value={l.itemId} onChange={id => pickItem(l.key, id)} />
              </Field>
              <Field label="Quantity">
                <div className="flex gap-1.5">
                  <input className="input min-w-0 flex-1" type="number" inputMode="decimal" min="0" step="any" value={l.qty} disabled={!it} onChange={e => setLine(l.key, { qty: e.target.value })} placeholder="0" />
                  <PurchaseUnitSelect item={it} value={l.pu} onChange={v => pickUnit(l.key, l.itemId, v)} />
                </div>
              </Field>
              <Field label="Rate (₹, before GST)"><input className="input text-right" type="number" min="0" step="any" value={l.rate} disabled={!it} onChange={e => setLine(l.key, { rate: e.target.value })} /></Field>
              <Field label="GST %"><input className="input text-right" type="number" min="0" max="100" step="any" value={l.gst} disabled={!it} onChange={e => setLine(l.key, { gst: e.target.value })} /></Field>
              <div className="pb-2 text-right text-sm tabular-nums">{fmtMoney(toNum(l.qty) * toNum(l.rate))}</div>
              <Button variant="ghost" onClick={() => setLines(ls => (ls.length > 1 ? ls.filter(x => x.key !== l.key) : ls))}>Remove</Button>
            </div>
          );
        })}
        <div><Button variant="secondary" size="sm" onClick={() => setLines(ls => [...ls, { key: Date.now(), itemId: '', pu: '', qty: '', rate: '', gst: '' }])}>Add another item</Button></div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// One order: lines, what has arrived, and the next step
// ---------------------------------------------------------------------------
function OrderDetail({ id, onClose, onChanged, onEdit }: { id: string; onClose: () => void; onChanged: () => void; onEdit: (o: PurchaseOrder) => void }) {
  const { can } = useAccess();
  const ref = useRefData();
  const toast = useToast();
  const { busy, error, act } = useAction();
  const q = useLoad(async () => {
    const [po, lines] = await Promise.all([
      run<PurchaseOrder>(sb.from('purchase_orders').select('*').eq('id', id).single()),
      run<PurchaseOrderLine[]>(sb.from('purchase_order_lines').select('*').eq('purchase_order_id', id).order('created_at')),
    ]);
    return { po, lines };
  }, [id]);
  const [ask, setAsk] = useState<'reject' | 'cancel' | 'close' | null>(null);
  const po = q.data?.po;
  const lines = q.data?.lines ?? [];
  const refresh = () => { q.reload(); onChanged(); };
  const packName = (pid: string) => ref.packSize(pid)?.name;

  const submit = () => act(async () => { await run(sb.rpc('submit_purchase_order', { p_purchase_order_id: id })); toast('Order submitted for approval'); refresh(); });
  const approve = () => act(async () => { await run(sb.rpc('decide_purchase_order', { p_purchase_order_id: id, p_approve: true })); toast('Order approved. It can now be sent to the vendor and received.'); refresh(); });

  const asks = useMemo(() => ({
    reject: { title: 'Send this order back', label: 'What needs changing?', confirm: 'Send back', rpc: 'decide_purchase_order', args: (r: string) => ({ p_purchase_order_id: id, p_approve: false, p_note: r }), done: 'Order sent back to draft' },
    cancel: { title: 'Cancel this order', label: 'Why?', confirm: 'Cancel order', rpc: 'cancel_purchase_order', args: (r: string) => ({ p_purchase_order_id: id, p_reason: r }), done: 'Order cancelled' },
    close: { title: 'Close this order short', label: 'Why won’t the rest come?', confirm: 'Close short', rpc: 'close_purchase_order', args: (r: string) => ({ p_purchase_order_id: id, p_reason: r }), done: 'Order closed. The rest is no longer on order.' },
  }), [id]);

  return (
    <Modal open size="xl" onClose={onClose}
      title={po ? <>{po.po_no} · {ref.vendor(po.vendor_id)?.name} <StatusBadge status={po.status} /></> : 'Purchase order'}
      footer={po && <>
        {can('purchase.order') && ['draft', 'submitted', 'approved'].includes(po.status) && <Button variant="danger" className="mr-auto" onClick={() => setAsk('cancel')}>Cancel order</Button>}
        {can('purchase.approve') && po.status === 'partially_received' && <Button variant="danger" className="mr-auto" onClick={() => setAsk('close')}>Close short</Button>}
        <Button variant="secondary" onClick={onClose}>Close</Button>
        {can('purchase.order') && po.status === 'draft' && <Button variant="secondary" onClick={() => onEdit(po)}>Edit</Button>}
        {can('purchase.order') && po.status === 'draft' && <Button busy={busy} onClick={() => void submit()}>Submit for approval</Button>}
        {can('purchase.approve') && po.status === 'submitted' && <Button variant="secondary" onClick={() => setAsk('reject')}>Send back</Button>}
        {can('purchase.approve') && po.status === 'submitted' && <Button busy={busy} onClick={() => void approve()}>Approve</Button>}
        {can('purchase.receive') && ['approved', 'partially_received'].includes(po.status) && <Button onClick={() => navigate(`/receipts?po=${po.id}`)}>Receive goods</Button>}
      </>}>
      <ErrorNote error={error ?? q.error} />
      {po && (
        <>
          <p className="mb-3 text-sm text-muted">
            Ordered {fmtDate(po.order_date)}{po.expected_date && ` · expected ${fmtDate(po.expected_date)}`} · deliver to {ref.location(po.deliver_to_location_id)?.name}
            {po.submitted_at && ` · submitted ${fmtDateTime(po.submitted_at)}`}{po.decided_at && po.status !== 'draft' && ` · approved ${fmtDateTime(po.decided_at)}`}
            {po.note && ` · ${po.note}`}
          </p>
          {po.decision_note && <Notice tone={po.status === 'draft' ? 'warn' : 'info'}>{po.status === 'draft' ? 'Sent back: ' : 'Approver’s note: '}{po.decision_note}</Notice>}
          {po.close_reason && <Notice tone="warn">{po.status === 'cancelled' ? 'Cancelled' : 'Closed short'}: {po.close_reason}</Notice>}
          <DataTable rows={lines} rowKey={l => l.id} empty="No items"
            columns={[
              { label: 'Item', render: l => <span className="font-medium">{ref.item(l.item_id)?.name}</span> },
              { label: 'Ordered', num: true, render: l => lineQty(l.quantity, l.pack_size_id, l.unit, packName) },
              { label: 'Rate', num: true, render: l => fmtMoney(l.rate) },
              { label: 'GST', num: true, render: l => (l.gst_rate == null ? '—' : `${toNum(l.gst_rate)}%`) },
              { label: 'Amount', num: true, render: l => fmtMoney(l.amount) },
              { label: 'Received', num: true, render: l => {
                const it = ref.item(l.item_id);
                const got = toNum(l.received_in_base);
                const want = toNum(l.quantity_in_base);
                const tone = got === 0 ? 'text-muted' : got < want ? 'text-amber-700' : got > want ? 'text-sky-700' : 'text-green-700';
                return <span className={tone}>{fmtQty(got, it?.base_unit)} of {fmtQty(want, it?.base_unit)}</span>;
              } },
            ]}
            footer={<tr>
              <td colSpan={4} className="text-right text-muted">Before GST {fmtMoney(po.total_amount)} · GST {fmtMoney(po.tax_amount)}</td>
              <td className="num font-semibold">{fmtMoney(toNum(po.total_amount) + toNum(po.tax_amount))}</td>
              <td />
            </tr>} />
        </>
      )}
      {ask && (
        <ReasonModal open title={asks[ask].title} label={asks[ask].label} confirmLabel={asks[ask].confirm} danger={ask !== 'reject'} onClose={() => setAsk(null)}
          onConfirm={async reason => { await run(sb.rpc(asks[ask].rpc, asks[ask].args(reason))); toast(asks[ask].done); refresh(); }} />
      )}
    </Modal>
  );
}
