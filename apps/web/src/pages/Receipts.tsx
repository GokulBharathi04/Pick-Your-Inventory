import { useEffect, useState } from 'react';
import { useAccess } from '../lib/access';
import { useRefData } from '../lib/refdata';
import { useAction, useLoad } from '../lib/hooks';
import { useRoute } from '../lib/router';
import { run, sb } from '../lib/supabase';
import { addDays, dayStart, fmtDate, fmtDateTime, fmtMoney, fmtNum, fmtQty, isoDay, localDateTimeValue, toNum } from '../lib/format';
import { round6, stockUnit, unitsFor } from '../lib/units';
import type { GoodsReceipt, GoodsReceiptLine, Item, PurchaseOrder, PurchaseOrderLine, Unit, VendorItem } from '../lib/types';
import { Badge, Button, Checkbox, DataTable, ErrorNote, Field, FormGrid, Modal, Notice, PageHeader, ReasonModal, Select, Tabs, Toolbar, useToast } from '../components/ui';
import { ItemSelect, NeedsOutlet, PurchaseUnitSelect, ReceivingSelect, VendorSelect, parsePurchaseUnit, purchaseUnitValue } from '../components/inputs';
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
      <PageHeader title="Goods receipts" subtitle={`${outlet?.name} · what vendors delivered, at the price on the bill`}
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
          { label: 'Delivered to', render: r => ref.location(r.location_id)?.name },
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
          toast('Receipt voided. Its stock is taken back out and the quantities are back on order.');
          q.reload();
        }} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Receive: against an approved order, or straight from a vendor
// ---------------------------------------------------------------------------
// For an item whose weight varies (whole chicken) a line has pieces and a
// weight instead of a quantity, and pu is what the bill is priced in (per
// piece or per kg).
type Line = {
  key: number; poLineId: string | null; itemId: string; pu: string; qty: string; rate: string; gst: string;
  pieces: string; weight: string;
  remaining?: number; orderedLabel?: string; polUnit?: string | null; polBpu?: number; polRate?: string;
};
const blankLine = (): Line => ({ key: Date.now() + Math.random(), poLineId: null, itemId: '', pu: '', qty: '', rate: '', gst: '', pieces: '', weight: '' });

// What a line adds up to, in the unit its rate is in, and in the order line's unit.
function lineAmounts(l: Line, it: Item | undefined, units: Unit[]): { billQty: number; inOrderUnit: number | null } {
  if (!it?.variable_weight) return { billQty: toNum(l.qty), inOrderUnit: toNum(l.qty) };
  const unit = (c: string | null | undefined) => units.find(u => u.code === c);
  const pu = unit(l.pu);
  const weightBase = toNum(l.weight) * toNum(unit(stockUnit(it))?.factor_to_base);
  const pieces = toNum(l.pieces);
  const billQty = !pu ? 0 : pu.base_code === it.base_unit ? weightBase / toNum(pu.factor_to_base) : pieces / toNum(pu.factor_to_base);
  if (!l.poLineId) return { billQty, inOrderUnit: null };
  const pol = unit(l.polUnit);
  const inOrderUnit = pol && pol.base_code === it.alt_unit ? pieces / toNum(pol.factor_to_base) : weightBase / (l.polBpu || 1);
  return { billQty, inOrderUnit };
}

function ReceiveGoods({ poId, onClose, onSaved }: { poId: string | null; onClose: () => void; onSaved: (id: string) => void }) {
  const { outletId } = useAccess();
  const ref = useRefData();
  const toast = useToast();
  const { busy, error, act } = useAction();
  const [mode, setMode] = useState('order');
  const [orderId, setOrderId] = useState(poId ?? '');
  const [vendorId, setVendorId] = useState('');
  const [storeId, setStoreId] = useState(ref.receivingLocations.find(l => l.is_active)?.id ?? '');
  const [invoiceNo, setInvoiceNo] = useState('');
  const [invoiceDate, setInvoiceDate] = useState(isoDay());
  const [when, setWhen] = useState(localDateTimeValue());
  const [note, setNote] = useState('');
  const [keepOpen, setKeepOpen] = useState(false);
  const [lines, setLines] = useState<Line[]>([]);
  const setLine = (key: number, patch: Partial<Line>) => setLines(ls => ls.map(l => (l.key === key ? { ...l, ...patch } : l)));
  const packName = (pid: string) => ref.packSize(pid)?.name;
  const unitByCode = (c: string | null | undefined) => ref.units.find(u => u.code === c);

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
    setKeepOpen(false);
    setLines((poLinesQ.data ?? []).map((l, i) => {
      const it = ref.item(l.item_id);
      const remaining = round6(Math.max(toNum(l.quantity_in_base) - toNum(l.received_in_base), 0) / toNum(l.base_per_unit));
      const pu = purchaseUnitValue({ packSizeId: l.pack_size_id, unit: l.unit });
      const byPiece = !!it?.variable_weight && unitByCode(l.unit)?.base_code === it.alt_unit;
      const variablePu = it?.variable_weight ? (l.unit && !l.pack_size_id ? l.unit : stockUnit(it)) : pu;
      return {
        key: i + 1, poLineId: l.id, itemId: l.item_id, pu: variablePu, rate: variablePu === l.unit ? String(toNum(l.rate)) : '',
        gst: l.gst_rate == null ? '' : String(toNum(l.gst_rate)),
        qty: !it?.variable_weight && remaining > 0 ? String(remaining) : '',
        pieces: byPiece && remaining > 0 ? String(round6(remaining * toNum(unitByCode(l.unit)?.factor_to_base))) : '',
        weight: '',
        remaining, orderedLabel: lineQty(l.quantity, l.pack_size_id, l.unit, packName),
        polUnit: l.pack_size_id ? null : l.unit, polBpu: toNum(l.base_per_unit), polRate: String(toNum(l.rate)),
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
    setKeepOpen(false);
    if (m === 'direct') { setOrderId(''); setLines([blankLine()]); }
    else setLines([]);
  };
  const addExtra = () => setLines(ls => [...ls, blankLine()]);
  const pickItem = (key: number, itemId: string) => {
    const it = ref.item(itemId);
    const vp = prices.find(v => v.item_id === itemId && (!it?.variable_weight || !v.pack_size_id));
    setLine(key, {
      itemId, pu: vp ? purchaseUnitValue({ packSizeId: vp.pack_size_id, unit: vp.price_unit }) : it ? stockUnit(it) : '',
      rate: vp ? String(toNum(vp.rate)) : '', gst: it?.gst_rate == null ? '' : String(toNum(it.gst_rate)), qty: '', pieces: '', weight: '',
    });
  };
  const pickUnit = (l: Line, pu: string) => {
    const p = parsePurchaseUnit(pu);
    const vp = prices.find(v => v.item_id === l.itemId && (p.packSizeId ? v.pack_size_id === p.packSizeId : v.price_unit === p.unit));
    const fromOrder = l.poLineId && pu === l.polUnit ? l.polRate : undefined;
    setLine(l.key, { pu, rate: fromOrder ?? (vp ? String(toNum(vp.rate)) : l.poLineId ? '' : l.rate) });
  };

  const rows = lines.map(l => {
    const it = ref.item(l.itemId);
    const { billQty, inOrderUnit } = lineAmounts(l, it, ref.units);
    const entered = it?.variable_weight ? toNum(l.weight) > 0 || toNum(l.pieces) > 0 : toNum(l.qty) > 0;
    return { l, it, billQty, inOrderUnit, entered };
  });
  const filled = rows.filter(r => r.l.itemId && r.entered);
  const subtotal = filled.reduce((s, r) => s + r.billQty * toNum(r.l.rate), 0);
  const tax = filled.reduce((s, r) => s + (r.billQty * toNum(r.l.rate) * toNum(r.l.gst)) / 100, 0);
  const orderRows = rows.filter(r => r.l.poLineId && r.l.remaining !== undefined);
  const short = mode === 'order' && orderRows.some(r => (r.inOrderUnit ?? 0) < (r.l.remaining ?? 0) - 1e-6);
  const extra = mode === 'order' && filled.some(r => !r.l.poLineId || (r.inOrderUnit ?? 0) > (r.l.remaining ?? 0) + 1e-6);

  const save = () => act(async () => {
    if (mode === 'order' && !orderId) throw new Error('Choose the purchase order');
    if (!vendorId || !storeId) throw new Error('Choose the vendor and where the goods were delivered');
    if (filled.length === 0) throw new Error('Enter what was received for at least one item');
    const partial = filled.find(r => r.it?.variable_weight && (toNum(r.l.pieces) <= 0 || toNum(r.l.weight) <= 0));
    if (partial) throw new Error(`${partial.it?.name}: enter how many pieces came and what they weighed`);
    const noRate = filled.find(r => r.l.rate === '' && (!r.l.poLineId || (r.it?.variable_weight && r.l.pu !== r.l.polUnit)));
    if (noRate) throw new Error(`Enter the rate on the bill for ${noRate.it?.name}`);
    const id = await run<string>(sb.rpc('post_goods_receipt', {
      p_outlet_id: outletId, p_vendor_id: vendorId, p_location_id: storeId,
      p_lines: filled.map(({ l, it }) => {
        const rate = l.rate === '' ? null : toNum(l.rate);
        const gst_rate = l.gst === '' ? null : toNum(l.gst);
        if (it?.variable_weight) {
          return { purchase_order_line_id: l.poLineId, item_id: l.itemId, unit: l.pu, pieces: toNum(l.pieces), weight: toNum(l.weight), weight_unit: stockUnit(it), rate, gst_rate };
        }
        const p = parsePurchaseUnit(l.pu);
        return { purchase_order_line_id: l.poLineId, item_id: l.itemId, pack_size_id: p.packSizeId, unit: p.unit, quantity: toNum(l.qty), rate, gst_rate };
      }),
      p_purchase_order_id: mode === 'order' ? orderId : null, p_invoice_no: invoiceNo.trim() || null, p_invoice_date: invoiceDate || null,
      p_note: note.trim() || null, p_received_at: new Date(when).toISOString(), p_keep_open: keepOpen,
    }));
    toast(`Received ${filled.length} item${filled.length > 1 ? 's' : ''} at ${ref.location(storeId)?.name}${short ? (keepOpen ? '. The rest stays on order.' : '. The order is closed; the rest is no longer expected.') : ''}`);
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
        <Field label="Delivered to"><ReceivingSelect value={storeId} onChange={setStoreId} /></Field>
        <Field label="Vendor’s invoice no."><input className="input" value={invoiceNo} onChange={e => setInvoiceNo(e.target.value)} /></Field>
        <Field label="Invoice date"><input className="input" type="date" value={invoiceDate} onChange={e => setInvoiceDate(e.target.value)} /></Field>
        <Field label="Received on"><input className="input" type="datetime-local" value={when} onChange={e => setWhen(e.target.value)} /></Field>
        <Field label="Note" className="sm:col-span-3"><input className="input" value={note} onChange={e => setNote(e.target.value)} placeholder="Optional, e.g. 2 crates damaged and sent back" /></Field>
      </FormGrid>

      {mode === 'order' && orderId && <p className="mt-4 mb-2 text-sm text-muted">Quantities are filled with what is still to come. Change them to what actually arrived, more or less; leave 0 for anything that didn’t come.</p>}
      <div className="mt-3 flex flex-col gap-2">
        {rows.map(({ l, it, billQty }) => {
          const name = l.poLineId
            ? <Field label="Item" hint={`Ordered ${l.orderedLabel}; still to come ${fmtNum(l.remaining ?? 0, 3)}`}>
                <div className="input flex items-center bg-slate-50">{it?.name}</div>
              </Field>
            : <Field label={mode === 'order' ? 'Extra item (not on the order)' : 'Item'}><ItemSelect value={l.itemId} onChange={id => pickItem(l.key, id)} /></Field>;
          const remove = !l.poLineId ? <Button variant="ghost" onClick={() => setLines(ls => ls.filter(x => x.key !== l.key))}>Remove</Button> : <span />;
          const gst = <Field label="GST %"><input className="input text-right" type="number" min="0" max="100" step="any" value={l.gst} disabled={!it} onChange={e => setLine(l.key, { gst: e.target.value })} /></Field>;
          const amount = <div className="pb-2 text-right text-sm tabular-nums">{fmtMoney(billQty * toNum(l.rate))}</div>;
          if (it?.variable_weight) {
            const each = toNum(l.pieces) > 0 && toNum(l.weight) > 0 ? toNum(l.weight) / toNum(l.pieces) : 0;
            return (
              <div key={l.key} className="grid grid-cols-1 items-end gap-2 sm:grid-cols-[1fr_90px_120px_200px_80px_110px_auto]">
                {name}
                <Field label="Pieces"><input className="input text-right" type="number" inputMode="numeric" min="0" step="any" value={l.pieces} placeholder="0" onChange={e => setLine(l.key, { pieces: e.target.value })} /></Field>
                <Field label={`Weight (${stockUnit(it)})`} hint={each ? `${fmtNum(each, 3)} ${stockUnit(it)} a piece` : undefined}>
                  <input className="input text-right" type="number" inputMode="decimal" min="0" step="any" value={l.weight} placeholder="0" onChange={e => setLine(l.key, { weight: e.target.value })} />
                </Field>
                <Field label="Rate (₹, before GST)">
                  <div className="flex gap-1.5">
                    <input className="input min-w-0 flex-1 text-right" type="number" min="0" step="any" value={l.rate} onChange={e => setLine(l.key, { rate: e.target.value })} />
                    <select className="input w-24 shrink-0" value={l.pu} onChange={e => pickUnit(l, e.target.value)} aria-label="Priced per">
                      {unitsFor(it, ref.units).map(u => <option key={u.code} value={u.code}>per {u.code}</option>)}
                    </select>
                  </div>
                </Field>
                {gst}{amount}{remove}
              </div>
            );
          }
          return (
            <div key={l.key} className="grid grid-cols-1 items-end gap-2 sm:grid-cols-[1fr_250px_120px_80px_110px_auto]">
              {name}
              <Field label="Received">
                <div className="flex gap-1.5">
                  <input className="input min-w-0 flex-1" type="number" inputMode="decimal" min="0" step="any" value={l.qty} disabled={!it} placeholder="0"
                    onChange={e => setLine(l.key, { qty: e.target.value })} />
                  <PurchaseUnitSelect item={it} value={l.pu} onChange={v => pickUnit(l, v)} disabled={!!l.poLineId} />
                </div>
              </Field>
              <Field label="Rate (₹, before GST)"><input className="input text-right" type="number" min="0" step="any" value={l.rate} disabled={!it} onChange={e => setLine(l.key, { rate: e.target.value })} /></Field>
              {gst}{amount}{remove}
            </div>
          );
        })}
        {(mode === 'direct' || orderId) && <div><Button variant="secondary" size="sm" onClick={addExtra}>{mode === 'order' ? 'Add an item that wasn’t ordered' : 'Add another item'}</Button></div>}
      </div>
      {extra && <div className="mt-3"><Notice tone="info">Some items are more than was ordered, or not on the order. They are received as extra.</Notice></div>}
      {short && (
        <div className="mt-3">
          <Notice tone="warn">Less than was ordered has come. Posting this receipt completes the order and the rest is no longer expected, unless more is coming.</Notice>
          <Checkbox label="More is coming: keep the rest on order" checked={keepOpen} onChange={setKeepOpen} />
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
            Received {fmtDateTime(r.received_at)} at {ref.location(r.location_id)?.name}
            {r.invoice_no && ` · invoice ${r.invoice_no}`}{r.invoice_date && ` of ${fmtDate(r.invoice_date)}`}{r.note && ` · ${r.note}`}
          </p>
          {r.voided_at && <Notice tone="warn">Voided: {r.void_reason}</Notice>}
          <DataTable rows={q.data?.lines ?? []} rowKey={l => l.id}
            columns={[
              { label: 'Item', render: l => <>{ref.item(l.item_id)?.name}{!l.purchase_order_line_id && r.purchase_order_id && <span className="ml-1 text-xs text-muted">(not ordered)</span>}</> },
              { label: 'Received', num: true, render: l => {
                const it = ref.item(l.item_id);
                if (l.pieces == null) return lineQty(l.quantity, l.pack_size_id, l.unit, packName);
                const each = toNum(l.quantity_in_base) / toNum(l.pieces);
                return <>{fmtNum(l.pieces, 3)} pcs · {fmtQty(l.quantity_in_base, it?.base_unit)}<div className="text-xs text-muted">{fmtQty(each, it?.base_unit)} a piece</div></>;
              } },
              { label: 'Rate', num: true, render: l => <>{fmtMoney(l.rate)}<span className="text-xs text-muted"> / {l.pack_size_id ? packName(l.pack_size_id) ?? 'pack' : l.unit}</span></> },
              { label: 'GST', num: true, render: l => (l.gst_rate == null ? '—' : `${toNum(l.gst_rate)}%`) },
              { label: 'Amount', num: true, render: l => fmtMoney(l.amount) },
            ]}
            footer={<tr><td colSpan={4} className="text-right text-muted">Before GST {fmtMoney(r.total_amount)} · GST {fmtMoney(r.tax_amount)}</td><td className="num font-semibold">{fmtMoney(toNum(r.total_amount) + toNum(r.tax_amount))}</td></tr>} />
        </>
      )}
    </Modal>
  );
}
