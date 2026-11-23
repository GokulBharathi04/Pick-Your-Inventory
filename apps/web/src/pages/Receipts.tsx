import { useEffect, useState } from 'react';
import { useAccess } from '../lib/access';
import { useRefData } from '../lib/refdata';
import { useAction, useLoad } from '../lib/hooks';
import { useRoute } from '../lib/router';
import { run, sb } from '../lib/supabase';
import { addDays, dayStart, fmtDate, fmtDateTime, fmtMoney, isoDay, localDateTimeValue, toNum } from '../lib/format';
import { defaultUnit, round6 } from '../lib/units';
import type { GoodsReceipt, GoodsReceiptLine, PurchaseOrder, PurchaseOrderLine, VendorItem } from '../lib/types';
import { Badge, Button, Checkbox, DataTable, ErrorNote, Field, FormGrid, Modal, Notice, PageHeader, ReasonModal, Select, Tabs, Toolbar, useToast } from '../components/ui';
import { ItemSelect, NeedsOutlet, PurchaseUnitSelect, StoreSelect, VendorSelect, parsePurchaseUnit, purchaseUnitValue } from '../components/inputs';
import { lineQty } from './PurchaseOrders';
import { useProfiles } from './StockCard';

export default function Receipts() {
  return <NeedsOutlet><ReceiptsInner /></NeedsOutlet>;
}

function ReceiptsInner() {
  const { outletId, outlet, can } = useAccess();
  const ref = useRefData();
  const route = useRoute();
  const toast = useToast();
  const people = useProfiles();
  const [from, setFrom] = useState(addDays(isoDay(), -29));
  const [to, setTo] = useState(isoDay());
  const [vendor, setVendor] = useState('');
  const [receiving, setReceiving] = useState<string | null>(route.query.get('po') ?? (route.query.get('new') ? '' : null));
  const [openId, setOpenId] = useState<string | null>(null);
  const [voiding, setVoiding] = useState<GoodsReceipt | null>(null);

  const q = useLoad(async () => {
    let query = sb.from('goods_receipts').select('*').eq('outlet_id', outletId)
      .gte('received_at', dayStart(from)).lt('received_at', dayStart(addDays(to, 1))).order('received_at', { ascending: false }).limit(300);
    if (vendor) query = query.eq('vendor_id', vendor);
    const receipts = await run<GoodsReceipt[]>(query);
    const poIds = Array.from(new Set(receipts.map(r => r.purchase_order_id).filter((x): x is string => !!x)));
    const pos = poIds.length ? await run<{ id: string; po_no: string | null }[]>(sb.from('purchase_orders').select('id,po_no').in('id', poIds)) : [];
    return { receipts, poNo: new Map(pos.map(p => [p.id, p.po_no])) };
  }, [outletId, from, to, vendor]);

  return (
    <div>
      <PageHeader title="Goods receipts" subtitle={`${outlet?.name} · what vendors delivered into the store, at the price on the bill`}
        actions={can('purchase.receive') && <Button onClick={() => setReceiving('')}>Receive goods</Button>} />
      <ErrorNote error={q.error} />
      <Toolbar>
        <Field label="From"><input className="input" type="date" value={from} onChange={e => setFrom(e.target.value)} /></Field>
        <Field label="To"><input className="input" type="date" value={to} onChange={e => setTo(e.target.value)} /></Field>
        <Field label="Vendor"><Select className="max-w-52" value={vendor} onChange={setVendor} placeholder="All vendors" options={ref.vendors.map(v => ({ value: v.id, label: v.name }))} /></Field>
      </Toolbar>
      <DataTable rows={q.data?.receipts ?? []} rowKey={r => r.id} onRowClick={r => setOpenId(r.id)} empty={q.loading ? 'Loading…' : 'Nothing received in this period'}
        columns={[
          { label: 'Receipt', render: r => <span className="font-medium">{r.grn_no}</span> },
          { label: 'Received', render: r => <>{fmtDateTime(r.received_at)}<div className="text-xs text-muted">{people.get(r.received_by ?? '') || ''}</div></> },
          { label: 'Vendor', render: r => ref.vendor(r.vendor_id)?.name },
          { label: 'Order', render: r => (r.purchase_order_id ? q.data?.poNo.get(r.purchase_order_id) : <span className="text-muted">No order</span>) },
          { label: 'Invoice', render: r => <>{r.invoice_no ?? '—'}{r.invoice_date && <div className="text-xs text-muted">{fmtDate(r.invoice_date)}</div>}</> },
          { label: 'Store', render: r => ref.location(r.location_id)?.name },
          { label: 'Amount', num: true, render: r => fmtMoney(toNum(r.total_amount) + toNum(r.tax_amount)) },
          { label: '', render: r => r.voided_at
            ? <span title={r.void_reason ?? ''}><Badge tone="red">Voided</Badge></span>
            : can('purchase.approve') && <Button size="sm" variant="ghost" onClick={e => { e.stopPropagation(); setVoiding(r); }}>Void</Button> },
        ]} />
      {receiving !== null && <ReceiveGoods poId={receiving || null} onClose={() => setReceiving(null)} onSaved={id => { q.reload(); setOpenId(id); }} />}
      {openId && <ReceiptDetail id={openId} onClose={() => setOpenId(null)} />}
      <ReasonModal open={!!voiding} title="Void this receipt" label="Why?" confirmLabel="Void" danger onClose={() => setVoiding(null)}
        onConfirm={async reason => {
          if (!voiding) return;
          await run(sb.rpc('void_goods_receipt', { p_receipt_id: voiding.id, p_reason: reason }));
          toast('Receipt voided. The stock is out of the store and back on order.');
          q.reload();
        }} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Receive: against an approved order, or straight from a vendor
// ---------------------------------------------------------------------------
type Line = { key: number; poLineId: string | null; itemId: string; pu: string; qty: string; rate: string; gst: string; remaining?: number; orderedLabel?: string };

function ReceiveGoods({ poId, onClose, onSaved }: { poId: string | null; onClose: () => void; onSaved: (id: string) => void }) {
  const { outletId } = useAccess();
  const ref = useRefData();
  const toast = useToast();
  const { busy, error, act } = useAction();
  const [mode, setMode] = useState('order');
  const [orderId, setOrderId] = useState(poId ?? '');
  const [vendorId, setVendorId] = useState('');
  const [storeId, setStoreId] = useState(ref.outletStores.find(l => l.is_active)?.id ?? '');
  const [invoiceNo, setInvoiceNo] = useState('');
  const [invoiceDate, setInvoiceDate] = useState(isoDay());
  const [when, setWhen] = useState(localDateTimeValue());
  const [note, setNote] = useState('');
  const [acceptExtra, setAcceptExtra] = useState(false);
  const [lines, setLines] = useState<Line[]>([]);
  const setLine = (key: number, patch: Partial<Line>) => setLines(ls => ls.map(l => (l.key === key ? { ...l, ...patch } : l)));
  const packName = (pid: string) => ref.packSize(pid)?.name;

  const openQ = useLoad(() => run<PurchaseOrder[]>(sb.from('purchase_orders').select('*').eq('outlet_id', outletId)
    .in('status', ['approved', 'partially_received']).order('order_date')), [outletId]);
  const po = (openQ.data ?? []).find(o => o.id === orderId);

  // Lines of the chosen order, filled with what is still to come
  const poLinesQ = useLoad(async () => (orderId
    ? run<PurchaseOrderLine[]>(sb.from('purchase_order_lines').select('*').eq('purchase_order_id', orderId).order('created_at'))
    : [] as PurchaseOrderLine[]), [orderId]);
  useEffect(() => {
    if (mode !== 'order') return;
    if (po) { setVendorId(po.vendor_id); setStoreId(po.deliver_to_location_id); }
    setLines((poLinesQ.data ?? []).map((l, i) => {
      const remaining = Math.max(toNum(l.quantity_in_base) - toNum(l.received_in_base), 0) / toNum(l.base_per_unit);
      return {
        key: i + 1, poLineId: l.id, itemId: l.item_id, pu: purchaseUnitValue({ packSizeId: l.pack_size_id, unit: l.unit }),
        qty: remaining > 0 ? String(round6(remaining)) : '', rate: String(toNum(l.rate)), gst: l.gst_rate == null ? '' : String(toNum(l.gst_rate)),
        remaining: round6(remaining), orderedLabel: lineQty(l.quantity, l.pack_size_id, l.unit, packName),
      };
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [poLinesQ.data, po?.id, mode]);

  const pricesQ = useLoad(async () => (vendorId
    ? run<VendorItem[]>(sb.from('vendor_items').select('*').eq('vendor_id', vendorId).is('valid_to', null))
    : [] as VendorItem[]), [vendorId]);
  const prices = pricesQ.data ?? [];

  const switchMode = (m: string) => {
    setMode(m);
    setAcceptExtra(false);
    if (m === 'direct') { setOrderId(''); setLines([{ key: Date.now(), poLineId: null, itemId: '', pu: '', qty: '', rate: '', gst: '' }]); }
    else setLines([]);
  };
  const addExtra = () => setLines(ls => [...ls, { key: Date.now(), poLineId: null, itemId: '', pu: '', qty: '', rate: '', gst: '' }]);
  const pickItem = (key: number, itemId: string) => {
    const it = ref.item(itemId);
    const vp = prices.find(v => v.item_id === itemId);
    setLine(key, {
      itemId, pu: vp ? purchaseUnitValue({ packSizeId: vp.pack_size_id, unit: vp.price_unit }) : it ? defaultUnit(it.base_unit) : '',
      rate: vp ? String(toNum(vp.rate)) : '', gst: it?.gst_rate == null ? '' : String(toNum(it.gst_rate)),
    });
  };
  const pickUnit = (key: number, itemId: string, pu: string) => {
    const p = parsePurchaseUnit(pu);
    const vp = prices.find(v => v.item_id === itemId && (p.packSizeId ? v.pack_size_id === p.packSizeId : v.price_unit === p.unit));
    setLine(key, { pu, ...(vp ? { rate: String(toNum(vp.rate)) } : {}) });
  };

  const filled = lines.filter(l => l.itemId && toNum(l.qty) > 0);
  const subtotal = filled.reduce((s, l) => s + toNum(l.qty) * toNum(l.rate), 0);
  const tax = filled.reduce((s, l) => s + (toNum(l.qty) * toNum(l.rate) * toNum(l.gst)) / 100, 0);
  const over = filled.some(l => (l.poLineId && l.remaining !== undefined && toNum(l.qty) > l.remaining + 1e-9) || (mode === 'order' && !l.poLineId));

  const save = () => act(async () => {
    if (mode === 'order' && !orderId) throw new Error('Choose the purchase order');
    if (!vendorId || !storeId) throw new Error('Choose the vendor and the store');
    if (filled.length === 0) throw new Error('Enter the quantity received for at least one item');
    const noRate = filled.find(l => !l.poLineId && l.rate === '');
    if (noRate) throw new Error(`Enter the rate for ${ref.item(noRate.itemId)?.name}`);
    if (over && !acceptExtra) throw new Error('Some items are more than was ordered, or not on the order. Tick “accept extra” to receive them.');
    const id = await run<string>(sb.rpc('post_goods_receipt', {
      p_outlet_id: outletId, p_vendor_id: vendorId, p_location_id: storeId,
      p_lines: filled.map(l => {
        const p = parsePurchaseUnit(l.pu);
        return { purchase_order_line_id: l.poLineId, item_id: l.itemId, pack_size_id: p.packSizeId, unit: p.unit, quantity: toNum(l.qty), rate: l.rate === '' ? null : toNum(l.rate), gst_rate: l.gst === '' ? null : toNum(l.gst) };
      }),
      p_purchase_order_id: mode === 'order' ? orderId : null, p_invoice_no: invoiceNo.trim() || null, p_invoice_date: invoiceDate || null,
      p_note: note.trim() || null, p_received_at: new Date(when).toISOString(), p_accept_excess: acceptExtra,
    }));
    toast(`Received ${filled.length} item${filled.length > 1 ? 's' : ''} into ${ref.location(storeId)?.name}`);
    onSaved(id);
    onClose();
  });

  return (
    <Modal open size="xl" title="Receive goods" onClose={onClose}
      footer={<>
        <span className="mr-auto self-center text-sm text-muted">Before GST {fmtMoney(subtotal)} · GST {fmtMoney(tax)} · <span className="font-semibold text-ink">Total {fmtMoney(subtotal + tax)}</span></span>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button busy={busy} onClick={() => void save()}>Post receipt</Button>
      </>}>
      <Tabs value={mode} onChange={switchMode} tabs={[{ key: 'order', label: 'Against a purchase order' }, { key: 'direct', label: 'Without an order' }]} />
      <ErrorNote error={error ?? openQ.error ?? poLinesQ.error} />
      <FormGrid cols={4}>
        {mode === 'order'
          ? <Field label="Purchase order"><Select value={orderId} onChange={setOrderId} placeholder={(openQ.data ?? []).length ? 'Choose an approved order' : 'No approved orders'}
              options={(openQ.data ?? []).map(o => ({ value: o.id, label: `${o.po_no} · ${ref.vendor(o.vendor_id)?.name ?? ''}` }))} /></Field>
          : <Field label="Vendor"><VendorSelect value={vendorId} onChange={setVendorId} /></Field>}
        <Field label="Into store"><StoreSelect value={storeId} onChange={setStoreId} /></Field>
        <Field label="Vendor’s invoice no."><input className="input" value={invoiceNo} onChange={e => setInvoiceNo(e.target.value)} /></Field>
        <Field label="Invoice date"><input className="input" type="date" value={invoiceDate} onChange={e => setInvoiceDate(e.target.value)} /></Field>
        <Field label="Received at"><input className="input" type="datetime-local" value={when} onChange={e => setWhen(e.target.value)} /></Field>
        <Field label="Note" className="sm:col-span-3"><input className="input" value={note} onChange={e => setNote(e.target.value)} placeholder="Optional, e.g. 2 crates damaged and sent back" /></Field>
      </FormGrid>

      {mode === 'order' && orderId && <p className="mt-4 mb-2 text-sm text-muted">Quantities are filled with what is still to come. Change them to what actually arrived; leave 0 for anything that didn’t.</p>}
      <div className="mt-3 flex flex-col gap-2">
        {lines.map(l => {
          const it = ref.item(l.itemId);
          return (
            <div key={l.key} className="grid grid-cols-1 items-end gap-2 sm:grid-cols-[1fr_250px_120px_90px_110px_auto]">
              {l.poLineId
                ? <Field label="Item" hint={`Ordered ${l.orderedLabel}; still to come ${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 3 }).format(l.remaining ?? 0)}`}>
                    <div className="input flex items-center bg-slate-50">{it?.name}</div>
                  </Field>
                : <Field label={mode === 'order' ? 'Extra item (not on the order)' : 'Item'}><ItemSelect value={l.itemId} onChange={id => pickItem(l.key, id)} /></Field>}
              <Field label="Received">
                <div className="flex gap-1.5">
                  <input className="input min-w-0 flex-1" type="number" inputMode="decimal" min="0" step="any" value={l.qty} disabled={!it} placeholder="0"
                    onChange={e => setLine(l.key, { qty: e.target.value })} />
                  <PurchaseUnitSelect item={it} value={l.pu} onChange={v => pickUnit(l.key, l.itemId, v)} disabled={!!l.poLineId} />
                </div>
              </Field>
              <Field label="Rate (₹, before GST)"><input className="input text-right" type="number" min="0" step="any" value={l.rate} disabled={!it} onChange={e => setLine(l.key, { rate: e.target.value })} /></Field>
              <Field label="GST %"><input className="input text-right" type="number" min="0" max="100" step="any" value={l.gst} disabled={!it} onChange={e => setLine(l.key, { gst: e.target.value })} /></Field>
              <div className="pb-2 text-right text-sm tabular-nums">{fmtMoney(toNum(l.qty) * toNum(l.rate))}</div>
              {!l.poLineId ? <Button variant="ghost" onClick={() => setLines(ls => ls.filter(x => x.key !== l.key))}>Remove</Button> : <span />}
            </div>
          );
        })}
        {(mode === 'direct' || orderId) && <div><Button variant="secondary" size="sm" onClick={addExtra}>{mode === 'order' ? 'Add an item that wasn’t ordered' : 'Add another item'}</Button></div>}
      </div>
      {mode === 'order' && (over || acceptExtra) && (
        <div className="mt-3">
          <Notice tone="warn">Some items are more than was ordered, or not on the order.</Notice>
          <Checkbox label="Accept extra: receive more than was ordered" checked={acceptExtra} onChange={setAcceptExtra} />
        </div>
      )}
    </Modal>
  );
}

function ReceiptDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const ref = useRefData();
  const q = useLoad(async () => {
    const [r, lines] = await Promise.all([
      run<GoodsReceipt>(sb.from('goods_receipts').select('*').eq('id', id).single()),
      run<GoodsReceiptLine[]>(sb.from('goods_receipt_lines').select('*').eq('receipt_id', id).order('created_at')),
    ]);
    return { r, lines };
  }, [id]);
  const r = q.data?.r;
  const packName = (pid: string) => ref.packSize(pid)?.name;
  return (
    <Modal open size="lg" onClose={onClose} title={r ? <>{r.grn_no} · {ref.vendor(r.vendor_id)?.name} {r.voided_at && <Badge tone="red">Voided</Badge>}</> : 'Goods receipt'}
      footer={<Button variant="secondary" onClick={onClose}>Close</Button>}>
      <ErrorNote error={q.error} />
      {r && (
        <>
          <p className="mb-3 text-sm text-muted">
            Received {fmtDateTime(r.received_at)} into {ref.location(r.location_id)?.name}
            {r.invoice_no && ` · invoice ${r.invoice_no}`}{r.invoice_date && ` of ${fmtDate(r.invoice_date)}`}{r.note && ` · ${r.note}`}
          </p>
          {r.voided_at && <Notice tone="warn">Voided: {r.void_reason}</Notice>}
          <DataTable rows={q.data?.lines ?? []} rowKey={l => l.id}
            columns={[
              { label: 'Item', render: l => <>{ref.item(l.item_id)?.name}{!l.purchase_order_line_id && r.purchase_order_id && <span className="ml-1 text-xs text-muted">(not ordered)</span>}</> },
              { label: 'Received', num: true, render: l => lineQty(l.quantity, l.pack_size_id, l.unit, packName) },
              { label: 'Rate', num: true, render: l => fmtMoney(l.rate) },
              { label: 'GST', num: true, render: l => (l.gst_rate == null ? '—' : `${toNum(l.gst_rate)}%`) },
              { label: 'Amount', num: true, render: l => fmtMoney(l.amount) },
            ]}
            footer={<tr><td colSpan={4} className="text-right text-muted">Before GST {fmtMoney(r.total_amount)} · GST {fmtMoney(r.tax_amount)}</td><td className="num font-semibold">{fmtMoney(toNum(r.total_amount) + toNum(r.tax_amount))}</td></tr>} />
        </>
      )}
    </Modal>
  );
}
