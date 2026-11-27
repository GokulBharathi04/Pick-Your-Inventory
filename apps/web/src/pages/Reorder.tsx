import { useEffect, useMemo, useState } from 'react';
import { useAccess } from '../lib/access';
import { useRefData } from '../lib/refdata';
import { useAction, useLoad } from '../lib/hooks';
import { Link, navigate } from '../lib/router';
import { run, sb } from '../lib/supabase';
import { fmtMoney, fmtQty, toNum } from '../lib/format';
import type { ReorderSuggestion } from '../lib/types';
import { Button, DataTable, Empty, ErrorNote, Field, Notice, PageHeader, Section, Stat, useToast } from '../components/ui';
import { NeedsOutlet, ReceivingSelect } from '../components/inputs';

export default function Reorder() {
  return <NeedsOutlet><ReorderInner /></NeedsOutlet>;
}

function ReorderInner() {
  const { outletId, outlet, can } = useAccess();
  const ref = useRefData();
  const toast = useToast();
  const { busy, error, act } = useAction();
  const q = useLoad(() => run<ReorderSuggestion[]>(sb.rpc('reorder_suggestions', { p_outlet_id: outletId })), [outletId]);
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [qty, setQty] = useState<Record<string, string>>({});
  const [storeId, setStoreId] = useState(ref.receivingLocations.find(l => l.is_active)?.id ?? '');

  const rows = useMemo(() => (q.data ?? []).slice().sort((a, b) =>
    (ref.vendor(a.vendor_id)?.name ?? '~').localeCompare(ref.vendor(b.vendor_id)?.name ?? '~') || (ref.item(a.item_id)?.name ?? '').localeCompare(ref.item(b.item_id)?.name ?? '')),
  [q.data, ref]);

  // Everything with a vendor is ticked to start with.
  useEffect(() => {
    setPicked(Object.fromEntries((q.data ?? []).filter(r => r.vendor_id).map(r => [r.item_id, true])));
    setQty(Object.fromEntries((q.data ?? []).filter(r => r.vendor_id).map(r => [r.item_id, String(toNum(r.suggested_units))])));
  }, [q.data]);

  const unitLabel = (r: ReorderSuggestion) => (r.pack_size_id ? ref.packSize(r.pack_size_id)?.name ?? 'pack' : r.unit ?? '');
  const chosen = rows.filter(r => r.vendor_id && picked[r.item_id] && toNum(qty[r.item_id]) > 0);
  // One order per vendor and delivery location: an item kept in a kitchen that
  // receives goods goes there, everything else to the store chosen above.
  const deliverTo = (r: ReorderSuggestion) => r.location_id ?? storeId;
  const orders = Array.from(new Map(chosen.map(r => [`${r.vendor_id}|${deliverTo(r)}`, { vendorId: r.vendor_id as string, locationId: deliverTo(r) }])).values());
  const vendors = Array.from(new Set(chosen.map(r => r.vendor_id as string)));
  const estimate = chosen.reduce((s, r) => s + toNum(qty[r.item_id]) * toNum(r.rate), 0);
  const noVendor = rows.filter(r => !r.vendor_id).length;

  const create = () => act(async () => {
    if (chosen.some(r => !r.location_id) && !storeId) throw new Error('Choose the store to deliver to');
    if (chosen.length === 0) throw new Error('Tick at least one item to order');
    for (const o of orders) {
      await run(sb.rpc('save_purchase_order', {
        p_purchase_order_id: null, p_outlet_id: outletId, p_vendor_id: o.vendorId, p_location_id: o.locationId,
        p_lines: chosen.filter(r => r.vendor_id === o.vendorId && deliverTo(r) === o.locationId).map(r => ({ item_id: r.item_id, pack_size_id: r.pack_size_id, unit: r.pack_size_id ? null : r.unit, quantity: toNum(qty[r.item_id]), rate: toNum(r.rate) })),
        p_note: 'From reorder planning',
      }));
    }
    toast(`${orders.length} draft order${orders.length > 1 ? 's' : ''} created. Check them and submit for approval.`);
    navigate('/purchase-orders');
  });

  return (
    <div>
      <PageHeader title="Reorder planning"
        subtitle={`${outlet?.name} · items whose stock where goods are received, plus what is on order, has reached the reorder level. That stock moves only with goods received, issues to departments and their returns.`} />
      <ErrorNote error={error ?? q.error} />
      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Stat label="Items to reorder" value={rows.length} tone={rows.length ? 'warn' : 'ok'} />
        <Stat label="Ticked to order" value={chosen.length} hint={orders.length ? `${orders.length} order${orders.length > 1 ? 's' : ''} to ${vendors.length} vendor${vendors.length > 1 ? 's' : ''}` : undefined} />
        <Stat label="Estimated cost" value={fmtMoney(estimate)} hint="Before GST, at current vendor prices" />
      </div>
      {noVendor > 0 && <Notice tone="warn">{noVendor} item{noVendor > 1 ? 's have' : ' has'} no vendor price, so {noVendor > 1 ? 'they' : 'it'} can’t be ordered from here. Add a rate in <Link to="/vendors" className="underline">Vendors</Link>.</Notice>}
      {!q.loading && rows.length === 0 ? (
        <Empty title="Nothing to reorder">Every item with a reorder level has enough in the store or on order. Set reorder levels on the <Link to="/items" className="text-teal-ink underline">Items</Link> screen.</Empty>
      ) : (
        <Section title="Suggested orders" subtitle="One order per vendor and delivery location. The vendor is the preferred one, otherwise the cheapest current price"
          actions={can('purchase.order') && <>
            <Field label="Other items go to" className="w-44"><ReceivingSelect value={storeId} onChange={setStoreId} /></Field>
            <Button className="self-end" busy={busy} disabled={chosen.length === 0} onClick={() => void create()}>Create {orders.length || ''} draft order{orders.length === 1 ? '' : 's'}</Button>
          </>}>
          <DataTable rows={rows} rowKey={r => r.item_id} empty={q.loading ? 'Loading…' : 'Nothing to reorder'}
            columns={[
              { label: '', render: r => <input type="checkbox" className="h-4 w-4 accent-teal" aria-label="Order this item" disabled={!r.vendor_id || !can('purchase.order')}
                  checked={!!picked[r.item_id]} onChange={e => setPicked({ ...picked, [r.item_id]: e.target.checked })} /> },
              { label: 'Item', render: r => <span className="font-medium">{ref.item(r.item_id)?.name}</span> },
              { label: 'In stock', num: true, render: r => <span className={toNum(r.on_hand) <= 0 ? 'text-red-700' : ''}>{fmtQty(r.on_hand, ref.item(r.item_id)?.base_unit)}</span> },
              { label: 'On order', num: true, render: r => fmtQty(r.on_order, ref.item(r.item_id)?.base_unit) },
              { label: 'Reorder level', num: true, render: r => fmtQty(r.reorder_level, ref.item(r.item_id)?.base_unit) },
              { label: 'Needed', num: true, render: r => fmtQty(r.suggested_base, ref.item(r.item_id)?.base_unit) },
              { label: 'Vendor', render: r => ref.vendor(r.vendor_id)?.name ?? <span className="text-muted">No price</span> },
              { label: 'Delivered to', render: r => ref.location(deliverTo(r))?.name ?? '—' },
              { label: 'Order', num: true, render: r => r.vendor_id ? (
                <div className="flex items-center justify-end gap-1">
                  <input className="input w-20 text-right" type="number" min="0" step="any" value={qty[r.item_id] ?? ''} disabled={!can('purchase.order')}
                    onChange={e => setQty({ ...qty, [r.item_id]: e.target.value })} />
                  <span className="w-14 text-left text-xs text-muted">{unitLabel(r)}</span>
                </div>
              ) : '—' },
              { label: 'Amount', num: true, render: r => (r.vendor_id ? fmtMoney(toNum(qty[r.item_id]) * toNum(r.rate)) : '—') },
            ]} />
        </Section>
      )}
    </div>
  );
}
