import { useMemo, useState } from 'react';
import { useAccess } from '../lib/access';
import { useRefData } from '../lib/refdata';
import { useLoad } from '../lib/hooks';
import { navigate, useRoute } from '../lib/router';
import { run, sb, selectAll } from '../lib/supabase';
import { addDays, dayStart, fmtDate, fmtDateTime, fmtMoney, fmtQty, fmtRate, humanize, isoDay, startOfMonth, toNum } from '../lib/format';
import { downloadCsv } from '../lib/csv';
import type { LedgerRow } from '../lib/types';
import { Badge, Button, ErrorNote, Field, PageHeader, Select, Stat, Toolbar } from '../components/ui';
import { ItemSelect, NeedsOutlet } from '../components/inputs';

export function useProfiles() {
  const { orgId } = useAccess();
  const q = useLoad(() => run<{ id: string; full_name: string | null }[]>(sb.from('profiles').select('id,full_name')), [orgId]);
  return useMemo(() => new Map((q.data ?? []).map(p => [p.id, p.full_name ?? ''])), [q.data]);
}

export default function StockCard() {
  return <NeedsOutlet><StockCardInner /></NeedsOutlet>;
}

function StockCardInner() {
  const { outletId, outlet } = useAccess();
  const ref = useRefData();
  const route = useRoute();
  const itemId = route.query.get('item') ?? '';
  const [location, setLocation] = useState(route.query.get('location') ?? '');
  const [from, setFrom] = useState(startOfMonth());
  const [to, setTo] = useState(isoDay());
  const people = useProfiles();
  const item = ref.item(itemId);

  const q = useLoad(async () => {
    if (!itemId) return [] as LedgerRow[];
    return selectAll<LedgerRow>((a, b) => sb.from('stock_ledger').select('*').eq('outlet_id', outletId).eq('item_id', itemId)
      .order('occurred_at').order('created_at').range(a, b));
  }, [outletId, itemId]);

  const view = useMemo(() => {
    const rows = (q.data ?? []).filter(r => !location || r.location_id === location);
    const start = new Date(dayStart(from)).getTime();
    const end = new Date(dayStart(addDays(to, 1))).getTime();
    let bal = 0;
    let val = 0;
    let opening = 0;
    let openingValue = 0;
    const shown: (LedgerRow & { balance: number })[] = [];
    for (const r of rows) {
      bal += toNum(r.quantity);
      val += toNum(r.value);
      const at = new Date(r.occurred_at).getTime();
      if (at < start) { opening = bal; openingValue = val; continue; }
      if (at >= end) continue;
      shown.push({ ...r, balance: bal });
    }
    const closing = shown.length ? shown[shown.length - 1].balance : opening;
    const inQty = shown.filter(r => toNum(r.quantity) > 0).reduce((s, r) => s + toNum(r.quantity), 0);
    const outQty = shown.filter(r => toNum(r.quantity) < 0).reduce((s, r) => s - toNum(r.quantity), 0);
    return { shown: shown.reverse(), opening, openingValue, closing, inQty, outQty, onHand: bal, value: val };
  }, [q.data, location, from, to]);

  const setItem = (id: string) => navigate(`/stock/card?item=${id}${location ? `&location=${location}` : ''}`);

  return (
    <div>
      <PageHeader title={item ? `Stock card · ${item.name}` : 'Stock card'} subtitle={`${outlet?.name} · every movement, newest first`}
        back={{ to: '/stock', label: 'Stock on hand' }}
        actions={item && <Button variant="secondary" onClick={() => downloadCsv(`stock-card-${item.name}.csv`,
          ['When', 'Movement', 'Location', 'Document', 'Quantity', 'Balance', 'Unit cost', 'Value', 'Note'],
          view.shown.map(r => [r.occurred_at, humanize(r.movement_type), ref.location(r.location_id)?.name, humanize(r.source_type), toNum(r.quantity), r.balance, toNum(r.unit_cost), toNum(r.value), r.note ?? '']))}>Export CSV</Button>} />
      <Toolbar>
        <Field label="Item" className="w-72"><ItemSelect value={itemId} onChange={setItem} includeInactive /></Field>
        <Field label="Location" className="w-44"><Select value={location} onChange={setLocation} placeholder="All locations" options={ref.outletLocations.map(l => ({ value: l.id, label: l.name }))} /></Field>
        <Field label="From"><input className="input" type="date" value={from} onChange={e => setFrom(e.target.value)} /></Field>
        <Field label="To"><input className="input" type="date" value={to} onChange={e => setTo(e.target.value)} /></Field>
      </Toolbar>
      <ErrorNote error={q.error} />
      {!item ? <p className="text-sm text-muted">Choose an item to see its movements.</p> : (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-5">
            <Stat label="Opening" value={fmtQty(view.opening, item.base_unit)} />
            <Stat label="In" value={fmtQty(view.inQty, item.base_unit)} tone="ok" />
            <Stat label="Out" value={fmtQty(view.outQty, item.base_unit)} />
            <Stat label="Closing" value={fmtQty(view.closing, item.base_unit)} tone={view.closing < 0 ? 'bad' : undefined} />
            <Stat label="On hand now" value={fmtQty(view.onHand, item.base_unit)} hint={fmtMoney(view.value)} />
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th>When</th><th>Movement</th><th>Location</th><th>Document</th><th className="num">Quantity</th><th className="num">Balance</th><th className="num">Unit cost</th><th className="num">Value</th><th>By</th></tr>
              </thead>
              <tbody>
                {view.shown.map(r => (
                  <tr key={r.id}>
                    <td className="whitespace-nowrap">{fmtDateTime(r.occurred_at)}</td>
                    <td>{humanize(r.movement_type)}{r.reverses_entry_id && <span className="ml-1"><Badge tone="red">Reversal</Badge></span>}</td>
                    <td>{ref.location(r.location_id)?.name}</td>
                    <td>{humanize(r.source_type)}{r.note && <div className="text-xs text-muted">{r.note}</div>}</td>
                    <td className={`num ${toNum(r.quantity) < 0 ? 'text-red-700' : 'text-green-700'}`}>{toNum(r.quantity) > 0 ? '+' : ''}{fmtQty(r.quantity, item.base_unit)}</td>
                    <td className="num">{fmtQty(r.balance, item.base_unit)}</td>
                    <td className="num">{fmtRate(r.unit_cost, item.base_unit)}</td>
                    <td className="num">{fmtMoney(r.value)}</td>
                    <td className="text-muted">{people.get(r.recorded_by ?? '') || '—'}</td>
                  </tr>
                ))}
                <tr><td colSpan={5} className="text-muted">Opening balance on {fmtDate(from)}</td><td className="num">{fmtQty(view.opening, item.base_unit)}</td><td /><td className="num">{fmtMoney(view.openingValue)}</td><td /></tr>
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
