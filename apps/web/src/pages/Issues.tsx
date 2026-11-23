import { useMemo, useState } from 'react';
import { useAccess } from '../lib/access';
import { useRefData } from '../lib/refdata';
import { useAction, useLoad } from '../lib/hooks';
import { Link, useRoute } from '../lib/router';
import { run, sb, selectAll } from '../lib/supabase';
import { addDays, fmtDate, fmtDateTime, fmtMoney, fmtQty, isoDay, toNum } from '../lib/format';
import { defaultUnit, fromBase, toBase } from '../lib/units';
import { downloadCsv } from '../lib/csv';
import type { DepartmentIssue, DepartmentIssueLine, DepartmentUsage, PlanningStock } from '../lib/types';
import { Badge, Button, DataTable, Empty, ErrorNote, Field, FormGrid, Modal, Notice, PageHeader, ReasonModal, Section, Select, StatusBadge, Tabs, Toolbar, useToast } from '../components/ui';
import { DepartmentSelect, ItemSelect, NeedsOutlet, QtyInput, StoreSelect, unitForItem } from '../components/inputs';
import { useProfiles } from './StockCard';

export default function Issues() {
  return <NeedsOutlet><IssuesInner /></NeedsOutlet>;
}

function IssuesInner() {
  const { outlet, can } = useAccess();
  const ref = useRefData();
  const route = useRoute();
  const [mode, setMode] = useState(route.query.get('mode') === 'return' ? 'return' : 'issue');
  const [tick, setTick] = useState(0);
  const changed = () => setTick(t => t + 1);

  if (ref.outletDepartments.filter(d => d.is_active).length === 0 || ref.outletStores.length === 0) {
    return (
      <div>
        <PageHeader title="Issues and returns" />
        <Empty title={ref.outletStores.length === 0 ? `${outlet?.name} has no store location` : `${outlet?.name} has no departments yet`}>
          {can('organisation.manage')
            ? <>Add {ref.outletStores.length === 0 ? 'a store location' : 'departments such as Tandoor, Chinese or Bar'} in <Link to="/settings" className="text-teal-ink underline">Settings</Link>.</>
            : 'Ask your manager to set them up in Settings.'}
        </Empty>
      </div>
    );
  }

  return (
    <div>
      <PageHeader title="Issues and returns"
        subtitle={`${outlet?.name} · departments take stock out of the store during the day and hand back what is left at the end of it. What isn’t returned counts as used.`} />
      <Section>
        <Tabs value={mode} onChange={setMode} tabs={[{ key: 'issue', label: 'Issue to a department' }, { key: 'return', label: 'End-of-day return' }]} />
        {mode === 'issue' ? <IssueForm onSaved={changed} /> : <ReturnForm onSaved={changed} key={tick} />}
      </Section>
      <History tick={tick} onChanged={changed} />
      <Usage tick={tick} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Issue: several items to one department
// ---------------------------------------------------------------------------
type Draft = { key: number; itemId: string; qty: string; unit: string };

function IssueForm({ onSaved }: { onSaved: () => void }) {
  const { outletId } = useAccess();
  const ref = useRefData();
  const toast = useToast();
  const { busy, error, act } = useAction();
  const [deptId, setDeptId] = useState(ref.outletDepartments.find(d => d.is_active)?.id ?? '');
  const [storeId, setStoreId] = useState(ref.outletStores.find(l => l.is_active)?.id ?? '');
  const [day, setDay] = useState(isoDay());
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<Draft[]>([{ key: 1, itemId: '', qty: '', unit: '' }]);
  const setLine = (key: number, patch: Partial<Draft>) => setLines(ls => ls.map(l => (l.key === key ? { ...l, ...patch } : l)));

  const stockQ = useLoad(() => selectAll<PlanningStock>((a, b) => sb.from('planning_stock').select('*').eq('outlet_id', outletId).range(a, b)), [outletId]);
  const onHand = useMemo(() => new Map((stockQ.data ?? []).map(s => [s.item_id, toNum(s.quantity)])), [stockQ.data]);

  const save = () => act(async () => {
    if (!deptId || !storeId) throw new Error('Choose the department and the store');
    const filled = lines.filter(l => l.itemId && toNum(l.qty) > 0);
    if (filled.length === 0) throw new Error('Add at least one item and quantity');
    await run(sb.rpc('post_department_movement', {
      p_outlet_id: outletId, p_department_id: deptId, p_location_id: storeId, p_kind: 'issue',
      p_lines: filled.map(l => ({ item_id: l.itemId, quantity: toNum(l.qty), unit: l.unit })),
      p_note: note.trim() || null, p_business_date: day,
    }));
    toast(`Issued ${filled.length} item${filled.length > 1 ? 's' : ''} to ${ref.department(deptId)?.name}`);
    setLines([{ key: Date.now(), itemId: '', qty: '', unit: '' }]);
    setNote('');
    stockQ.reload();
    onSaved();
  });

  return (
    <div>
      <ErrorNote error={error} />
      <FormGrid cols={4}>
        <Field label="Department"><DepartmentSelect value={deptId} onChange={setDeptId} /></Field>
        <Field label="From store"><StoreSelect value={storeId} onChange={setStoreId} /></Field>
        <Field label="Business day"><input className="input" type="date" value={day} max={isoDay()} onChange={e => setDay(e.target.value)} /></Field>
        <Field label="Note"><input className="input" value={note} onChange={e => setNote(e.target.value)} placeholder="Optional, e.g. lunch service" /></Field>
      </FormGrid>
      <div className="mt-4 flex flex-col gap-2">
        {lines.map(l => {
          const it = ref.item(l.itemId);
          const have = it ? onHand.get(it.id) ?? 0 : null;
          return (
            <div key={l.key} className="grid grid-cols-1 items-end gap-2 sm:grid-cols-[1fr_220px_140px_auto]">
              <Field label="Item"><ItemSelect value={l.itemId} onChange={id => setLine(l.key, { itemId: id, unit: unitForItem(ref.item(id)) })} /></Field>
              <Field label="Quantity"><QtyInput item={it} qty={l.qty} unit={l.unit} onQty={v => setLine(l.key, { qty: v })} onUnit={v => setLine(l.key, { unit: v })} /></Field>
              <div className="pb-2 text-xs text-muted">{have !== null && <>In store: <span className={have <= 0 ? 'text-red-700' : ''}>{fmtQty(have, it?.base_unit)}</span></>}</div>
              <Button variant="ghost" onClick={() => setLines(ls => (ls.length > 1 ? ls.filter(x => x.key !== l.key) : ls))}>Remove</Button>
            </div>
          );
        })}
        <div className="flex flex-wrap justify-between gap-2">
          <Button variant="secondary" size="sm" onClick={() => setLines(ls => [...ls, { key: Date.now(), itemId: '', qty: '', unit: '' }])}>Add another item</Button>
          <Button busy={busy} onClick={() => void save()}>Issue stock</Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// End-of-day return: what the department still holds, and what comes back
// ---------------------------------------------------------------------------
function ReturnForm({ onSaved }: { onSaved: () => void }) {
  const { outletId } = useAccess();
  const ref = useRefData();
  const toast = useToast();
  const { busy, error, act } = useAction();
  const [deptId, setDeptId] = useState(ref.outletDepartments.find(d => d.is_active)?.id ?? '');
  const [storeId, setStoreId] = useState(ref.outletStores.find(l => l.is_active)?.id ?? '');
  const [day, setDay] = useState(isoDay());
  const [note, setNote] = useState('');
  const [back, setBack] = useState<Record<string, string>>({});

  const q = useLoad(async () => {
    if (!deptId) return [] as DepartmentUsage[];
    const rows = await run<DepartmentUsage[]>(sb.rpc('department_usage', { p_outlet_id: outletId, p_from: day, p_to: day, p_department_id: deptId }));
    return rows.filter(r => toNum(r.issued) > 0);
  }, [outletId, deptId, day]);

  const rows = (q.data ?? []).slice().sort((a, b) => (ref.item(a.item_id)?.name ?? '').localeCompare(ref.item(b.item_id)?.name ?? ''));

  const save = () => act(async () => {
    if (!deptId || !storeId) throw new Error('Choose the department and the store');
    const lines = rows
      .filter(r => toNum(back[r.item_id]) > 0)
      .map(r => {
        const it = ref.item(r.item_id)!;
        return { item_id: r.item_id, quantity: toBase(it, toNum(back[r.item_id]), defaultUnit(it.base_unit), ref.units) };
      });
    if (lines.length === 0) throw new Error('Enter what is being returned for at least one item');
    await run(sb.rpc('post_department_movement', {
      p_outlet_id: outletId, p_department_id: deptId, p_location_id: storeId, p_kind: 'return',
      p_lines: lines, p_note: note.trim() || null, p_business_date: day,
    }));
    toast(`Return recorded. ${lines.length} item${lines.length > 1 ? 's are' : ' is'} back in the store.`);
    setBack({});
    setNote('');
    q.reload();
    onSaved();
  });

  return (
    <div>
      <ErrorNote error={error ?? q.error} />
      <FormGrid cols={4}>
        <Field label="Department"><DepartmentSelect value={deptId} onChange={v => { setDeptId(v); setBack({}); }} /></Field>
        <Field label="Back to store"><StoreSelect value={storeId} onChange={setStoreId} /></Field>
        <Field label="Business day"><input className="input" type="date" value={day} max={isoDay()} onChange={e => { setDay(e.target.value); setBack({}); }} /></Field>
        <Field label="Note"><input className="input" value={note} onChange={e => setNote(e.target.value)} placeholder="Optional" /></Field>
      </FormGrid>
      <div className="mt-4">
        {!q.loading && rows.length === 0
          ? <Notice>Nothing was issued to {ref.department(deptId)?.name ?? 'this department'} on {fmtDate(day)}, so there is nothing to return.</Notice>
          : (
            <>
              <p className="mb-2 text-sm text-muted">Enter what is left over and going back to the store. Anything not returned is counted as used on {fmtDate(day)}.</p>
              <DataTable rows={rows} rowKey={r => r.item_id} empty={q.loading ? 'Loading…' : 'Nothing issued'}
                columns={[
                  { label: 'Item', render: r => <span className="font-medium">{ref.item(r.item_id)?.name}</span> },
                  { label: 'Issued', num: true, render: r => fmtQty(r.issued, ref.item(r.item_id)?.base_unit) },
                  { label: 'Already returned', num: true, render: r => fmtQty(r.returned, ref.item(r.item_id)?.base_unit) },
                  { label: 'Still with department', num: true, render: r => fmtQty(r.used, ref.item(r.item_id)?.base_unit) },
                  {
                    label: 'Returning now', num: true, render: r => {
                      const it = ref.item(r.item_id);
                      if (!it) return null;
                      const u = defaultUnit(it.base_unit);
                      const max = fromBase(it, toNum(r.used), u, ref.units);
                      return (
                        <div className="flex items-center justify-end gap-1">
                          <input className="input w-28 text-right" type="number" min="0" max={max} step="any" placeholder="0"
                            value={back[r.item_id] ?? ''} disabled={max <= 0}
                            onChange={e => setBack({ ...back, [r.item_id]: e.target.value })} />
                          <span className="w-8 text-left text-xs text-muted">{u}</span>
                        </div>
                      );
                    },
                  },
                ]} />
              <div className="mt-3 flex justify-end"><Button busy={busy} onClick={() => void save()}>Record return</Button></div>
            </>
          )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Documents in a period
// ---------------------------------------------------------------------------
function History({ tick, onChanged }: { tick: number; onChanged: () => void }) {
  const { outletId, can } = useAccess();
  const ref = useRefData();
  const toast = useToast();
  const people = useProfiles();
  const [from, setFrom] = useState(isoDay());
  const [to, setTo] = useState(isoDay());
  const [dept, setDept] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [voiding, setVoiding] = useState<DepartmentIssue | null>(null);

  const q = useLoad(async () => {
    let query = sb.from('department_issues').select('*').eq('outlet_id', outletId).gte('business_date', from).lte('business_date', to)
      .order('occurred_at', { ascending: false }).limit(500);
    if (dept) query = query.eq('department_id', dept);
    const docs = await run<DepartmentIssue[]>(query);
    const lines = docs.length ? await run<{ issue_id: string }[]>(sb.from('department_issue_lines').select('issue_id').in('issue_id', docs.map(d => d.id))) : [];
    const counts = new Map<string, number>();
    lines.forEach(l => counts.set(l.issue_id, (counts.get(l.issue_id) ?? 0) + 1));
    return { docs, counts };
  }, [outletId, from, to, dept, tick]);

  return (
    <Section title="Issues and returns recorded">
      <Toolbar>
        <Field label="From"><input className="input" type="date" value={from} onChange={e => setFrom(e.target.value)} /></Field>
        <Field label="To"><input className="input" type="date" value={to} onChange={e => setTo(e.target.value)} /></Field>
        <Field label="Department"><Select className="max-w-48" value={dept} onChange={setDept} placeholder="All departments" options={ref.outletDepartments.map(d => ({ value: d.id, label: d.name }))} /></Field>
      </Toolbar>
      <ErrorNote error={q.error} />
      <DataTable rows={q.data?.docs ?? []} rowKey={d => d.id} onRowClick={d => setOpenId(d.id)} empty={q.loading ? 'Loading…' : 'Nothing recorded in this period'}
        columns={[
          { label: 'No.', render: d => <span className="font-medium">{d.doc_no}</span> },
          { label: 'Kind', render: d => <StatusBadge status={d.kind} /> },
          { label: 'Day', render: d => fmtDate(d.business_date) },
          { label: 'Department', render: d => ref.department(d.department_id)?.name },
          { label: 'Store', render: d => ref.location(d.location_id)?.name },
          { label: 'Items', num: true, render: d => q.data?.counts.get(d.id) ?? 0 },
          { label: 'Recorded', render: d => <>{fmtDateTime(d.occurred_at)}<div className="text-xs text-muted">{people.get(d.recorded_by ?? '') || ''}</div></> },
          { label: '', render: d => d.voided_at
            ? <span title={d.void_reason ?? ''}><Badge tone="red">Voided</Badge></span>
            : can('stock.adjust') && <Button size="sm" variant="ghost" onClick={e => { e.stopPropagation(); setVoiding(d); }}>Void</Button> },
        ]} />
      {openId && <IssueDetail id={openId} onClose={() => setOpenId(null)} />}
      <ReasonModal open={!!voiding} title={`Void this ${voiding?.kind ?? ''}`} label="Why?" confirmLabel="Void" danger onClose={() => setVoiding(null)}
        onConfirm={async reason => {
          if (!voiding) return;
          await run(sb.rpc('void_department_movement', { p_issue_id: voiding.id, p_reason: reason }));
          toast(voiding.kind === 'issue' ? 'Issue voided. The stock is back in the store.' : 'Return voided. The stock is out of the store again.');
          onChanged();
        }} />
    </Section>
  );
}

function IssueDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const ref = useRefData();
  const q = useLoad(async () => {
    const [doc, lines] = await Promise.all([
      run<DepartmentIssue>(sb.from('department_issues').select('*').eq('id', id).single()),
      run<DepartmentIssueLine[]>(sb.from('department_issue_lines').select('*').eq('issue_id', id)),
    ]);
    return { doc, lines };
  }, [id]);
  const d = q.data?.doc;
  return (
    <Modal open onClose={onClose} title={d ? <>{d.doc_no} · {d.kind === 'issue' ? 'Issue to' : 'Return from'} {ref.department(d.department_id)?.name} <StatusBadge status={d.voided_at ? 'voided' : d.kind} /></> : 'Issue'}
      footer={<Button variant="secondary" onClick={onClose}>Close</Button>}>
      <ErrorNote error={q.error} />
      {d && (
        <>
          <p className="mb-3 text-sm text-muted">{fmtDate(d.business_date)} · {ref.location(d.location_id)?.name}{d.note && ` · ${d.note}`}{d.voided_at && ` · voided: ${d.void_reason}`}</p>
          <DataTable rows={q.data?.lines ?? []} rowKey={l => l.id}
            columns={[
              { label: 'Item', render: l => ref.item(l.item_id)?.name },
              { label: 'Quantity', num: true, render: l => fmtQty(l.quantity, ref.item(l.item_id)?.base_unit) },
            ]} />
        </>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Usage: issued − returned, per department and item
// ---------------------------------------------------------------------------
function Usage({ tick }: { tick: number }) {
  const { outletId, outlet } = useAccess();
  const ref = useRefData();
  const [from, setFrom] = useState(addDays(isoDay(), -6));
  const [to, setTo] = useState(isoDay());
  const [dept, setDept] = useState('');

  const q = useLoad(() => run<DepartmentUsage[]>(sb.rpc('department_usage', { p_outlet_id: outletId, p_from: from, p_to: to, p_department_id: dept || null })),
    [outletId, from, to, dept, tick]);

  const rows = useMemo(() => {
    const m = new Map<string, { department_id: string; item_id: string; issued: number; returned: number; used: number; value: number }>();
    for (const r of q.data ?? []) {
      const k = `${r.department_id}:${r.item_id}`;
      const x = m.get(k) ?? { department_id: r.department_id, item_id: r.item_id, issued: 0, returned: 0, used: 0, value: 0 };
      x.issued += toNum(r.issued); x.returned += toNum(r.returned); x.used += toNum(r.used); x.value += toNum(r.used_value);
      m.set(k, x);
    }
    return Array.from(m.values())
      .filter(x => x.issued !== 0 || x.returned !== 0)
      .sort((a, b) => (ref.department(a.department_id)?.name ?? '').localeCompare(ref.department(b.department_id)?.name ?? '') || b.value - a.value);
  }, [q.data, ref]);
  const total = rows.reduce((s, r) => s + r.value, 0);

  const exportCsv = () => downloadCsv(`department-usage-${outlet?.name ?? ''}-${from}-to-${to}.csv`,
    ['Department', 'Item', 'Unit', 'Issued', 'Returned', 'Used', 'Value used'],
    rows.map(r => { const it = ref.item(r.item_id); return [ref.department(r.department_id)?.name, it?.name, it?.base_unit, r.issued, r.returned, r.used, r.value]; }));

  return (
    <Section title="What each department used" subtitle={`Issued less returned · ${fmtMoney(total)} in this period`}
      actions={<Button size="sm" variant="secondary" onClick={exportCsv} disabled={rows.length === 0}>Export CSV</Button>}>
      <Toolbar>
        <Field label="From"><input className="input" type="date" value={from} onChange={e => setFrom(e.target.value)} /></Field>
        <Field label="To"><input className="input" type="date" value={to} onChange={e => setTo(e.target.value)} /></Field>
        <Field label="Department"><Select className="max-w-48" value={dept} onChange={setDept} placeholder="All departments" options={ref.outletDepartments.map(d => ({ value: d.id, label: d.name }))} /></Field>
      </Toolbar>
      <ErrorNote error={q.error} />
      <DataTable rows={rows} rowKey={r => `${r.department_id}:${r.item_id}`} empty={q.loading ? 'Loading…' : 'Nothing issued in this period'}
        columns={[
          { label: 'Department', render: r => ref.department(r.department_id)?.name },
          { label: 'Item', render: r => <span className="font-medium">{ref.item(r.item_id)?.name}</span> },
          { label: 'Issued', num: true, render: r => fmtQty(r.issued, ref.item(r.item_id)?.base_unit) },
          { label: 'Returned', num: true, render: r => fmtQty(r.returned, ref.item(r.item_id)?.base_unit) },
          { label: 'Used', num: true, render: r => <span className="font-medium">{fmtQty(r.used, ref.item(r.item_id)?.base_unit)}</span> },
          { label: 'Value used', num: true, render: r => fmtMoney(r.value) },
        ]} />
    </Section>
  );
}
