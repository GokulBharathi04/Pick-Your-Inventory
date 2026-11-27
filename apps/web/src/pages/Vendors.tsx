import { useMemo, useState } from 'react';
import { useAccess } from '../lib/access';
import { useRefData } from '../lib/refdata';
import { useAction, useLoad } from '../lib/hooks';
import { navigate, useRoute } from '../lib/router';
import { run, sb } from '../lib/supabase';
import { fmtDate, fmtNum, fmtRate, humanize, isoDay } from '../lib/format';
import type { Vendor, VendorItem } from '../lib/types';
import { Badge, Button, Checkbox, DataTable, ErrorNote, Field, FormGrid, Modal, PageHeader, ReasonModal, Select, Tabs, Toolbar, useToast } from '../components/ui';
import { RateForm, rateBasis } from './Items';

const channels = ['whatsapp', 'email', 'sms'].map(c => ({ value: c, label: c === 'whatsapp' ? 'WhatsApp' : c === 'sms' ? 'SMS' : 'Email' }));

export default function Vendors() {
  const { can } = useAccess();
  const ref = useRefData();
  const route = useRoute();
  const [search, setSearch] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState<Vendor | 'new' | null>(route.query.get('new') ? 'new' : null);
  const rows = useMemo(() => {
    const s = search.trim().toLowerCase();
    return ref.vendors.filter(v => (showInactive || v.is_active) && (!s || v.name.toLowerCase().includes(s) || (v.code ?? '').toLowerCase().includes(s) || (v.phone ?? '').includes(s)));
  }, [ref.vendors, search, showInactive]);

  return (
    <div>
      <PageHeader title="Vendors" subtitle="Who you buy from, how to reach them and their agreed rates"
        actions={can('masters.edit') && <>
          <Button variant="secondary" onClick={() => navigate('/import?type=vendors')}>Import</Button>
          <Button onClick={() => setEditing('new')}>Add vendor</Button>
        </>} />
      <Toolbar>
        <input className="input max-w-xs" placeholder="Search name, code or phone" value={search} onChange={e => setSearch(e.target.value)} />
        <Checkbox label="Show inactive" checked={showInactive} onChange={setShowInactive} />
      </Toolbar>
      <DataTable rows={rows} rowKey={v => v.id} onRowClick={v => setEditing(v)} empty={ref.loading ? 'Loading…' : 'No vendors yet'}
        columns={[
          { label: 'Code', render: v => <span className="text-muted tabular-nums">{v.code ?? '—'}</span> },
          { label: 'Vendor', render: v => <span className="font-medium">{v.name}</span> },
          { label: 'Contact', render: v => v.contact_person ?? '—' },
          { label: 'Phone', render: v => v.phone ?? '—' },
          { label: 'Sends by', render: v => channels.find(c => c.value === v.preferred_channel)?.label ?? humanize(v.preferred_channel) },
          { label: 'Pays in', render: v => (v.payment_terms_days ? `${v.payment_terms_days} days` : 'On delivery') },
          { label: 'Status', render: v => (v.is_active ? <Badge tone="green">Active</Badge> : <Badge>Inactive</Badge>) },
        ]} />
      {editing && <VendorEditor vendor={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function VendorEditor({ vendor, onClose }: { vendor: Vendor | null; onClose: () => void }) {
  const [current, setCurrent] = useState<Vendor | null>(vendor);
  const [tab, setTab] = useState('details');
  return (
    <Modal open size="lg" title={current ? current.name : 'Add vendor'} onClose={onClose} footer={<Button variant="secondary" onClick={onClose}>Close</Button>}>
      <Tabs tabs={[{ key: 'details', label: 'Details' }, ...(current ? [{ key: 'rates', label: 'Price list' }] : [])]} value={tab} onChange={setTab} />
      {tab === 'details' && <VendorDetails vendor={current} onSaved={v => { setCurrent(v); if (!current) setTab('rates'); }} />}
      {tab === 'rates' && current && <VendorRates vendor={current} />}
    </Modal>
  );
}

function VendorDetails({ vendor, onSaved }: { vendor: Vendor | null; onSaved: (v: Vendor) => void }) {
  const { orgId, can } = useAccess();
  const ref = useRefData();
  const toast = useToast();
  const { busy, error, act } = useAction();
  const s = (v: string | null | undefined) => v ?? '';
  const [f, setF] = useState({
    name: s(vendor?.name), contact_person: s(vendor?.contact_person), phone: s(vendor?.phone), whatsapp: s(vendor?.whatsapp),
    email: s(vendor?.email), gstin: s(vendor?.gstin), address_line1: s(vendor?.address_line1), address_line2: s(vendor?.address_line2),
    city: s(vendor?.city), state: s(vendor?.state), pincode: s(vendor?.pincode), payment_terms_days: String(vendor?.payment_terms_days ?? 0),
    preferred_channel: vendor?.preferred_channel ?? 'whatsapp', notes: s(vendor?.notes), is_active: vendor?.is_active ?? true,
  });
  const set = (k: keyof typeof f) => (v: string) => setF(x => ({ ...x, [k]: v }));
  const n = (v: string) => (v.trim() === '' ? null : v.trim());
  const save = () => act(async () => {
    if (!f.name.trim()) throw new Error('Enter the vendor’s name');
    const values = {
      name: f.name.trim(), contact_person: n(f.contact_person), phone: n(f.phone), whatsapp: n(f.whatsapp), email: n(f.email),
      gstin: n(f.gstin.toUpperCase()), address_line1: n(f.address_line1), address_line2: n(f.address_line2), city: n(f.city), state: n(f.state),
      pincode: n(f.pincode), payment_terms_days: Math.max(0, Math.round(Number(f.payment_terms_days) || 0)), preferred_channel: f.preferred_channel, notes: n(f.notes),
    };
    const saved = vendor
      ? await run<Vendor>(sb.from('vendors').update({ ...values, is_active: f.is_active }).eq('id', vendor.id).select().single())
      : await run<Vendor>(sb.from('vendors').insert({ ...values, organisation_id: orgId }).select().single());
    toast(vendor ? 'Vendor saved' : 'Vendor added');
    await ref.reload();
    onSaved(saved);
  });
  return (
    <div>
      <ErrorNote error={error} />
      <fieldset disabled={!can('masters.edit')} className="contents">
        <FormGrid cols={3}>
          <Field label="Name" className="sm:col-span-2"><input className="input" value={f.name} onChange={e => set('name')(e.target.value)} autoFocus={!vendor} /></Field>
          <Field label="Code" hint={vendor ? 'Given automatically' : 'Given when you add the vendor'}><input className="input" value={vendor?.code ?? 'Automatic'} readOnly disabled /></Field>
          <Field label="Contact person"><input className="input" value={f.contact_person} onChange={e => set('contact_person')(e.target.value)} /></Field>
          <Field label="Phone"><input className="input" inputMode="tel" value={f.phone} onChange={e => set('phone')(e.target.value)} /></Field>
          <Field label="WhatsApp number"><input className="input" inputMode="tel" value={f.whatsapp} onChange={e => set('whatsapp')(e.target.value)} /></Field>
          <Field label="Email"><input className="input" type="email" value={f.email} onChange={e => set('email')(e.target.value)} /></Field>
          <Field label="GSTIN"><input className="input uppercase" value={f.gstin} onChange={e => set('gstin')(e.target.value)} /></Field>
          <Field label="Send orders by"><Select value={f.preferred_channel} onChange={set('preferred_channel')} options={channels} /></Field>
          <Field label="Payment terms (days)" hint="0 means on delivery"><input className="input" type="number" min="0" max="365" value={f.payment_terms_days} onChange={e => set('payment_terms_days')(e.target.value)} /></Field>
          <Field label="Address"><input className="input" value={f.address_line1} onChange={e => set('address_line1')(e.target.value)} /></Field>
          <Field label="City"><input className="input" value={f.city} onChange={e => set('city')(e.target.value)} /></Field>
          <Field label="PIN code"><input className="input" value={f.pincode} onChange={e => set('pincode')(e.target.value)} /></Field>
          <Field label="Notes" className="sm:col-span-3"><textarea className="input" rows={2} value={f.notes} onChange={e => set('notes')(e.target.value)} /></Field>
        </FormGrid>
        {vendor && <div className="mt-3"><Checkbox label="Active" checked={f.is_active} onChange={v => setF(x => ({ ...x, is_active: v }))} /></div>}
      </fieldset>
      {can('masters.edit') && <div className="mt-4 flex justify-end"><Button busy={busy} onClick={() => void save()}>{vendor ? 'Save vendor' : 'Add vendor'}</Button></div>}
    </div>
  );
}

function VendorRates({ vendor }: { vendor: Vendor }) {
  const ref = useRefData();
  const { can } = useAccess();
  const toast = useToast();
  const [showOld, setShowOld] = useState(false);
  const [closing, setClosing] = useState<VendorItem | null>(null);
  const q = useLoad(() => run<VendorItem[]>(sb.from('vendor_items').select('*').eq('vendor_id', vendor.id).order('valid_from', { ascending: false })), [vendor.id]);
  const rows = (q.data ?? []).filter(v => showOld || !v.valid_to || v.valid_to >= isoDay());
  return (
    <div>
      <ErrorNote error={q.error} />
      <Toolbar><Checkbox label="Show past rates" checked={showOld} onChange={setShowOld} /></Toolbar>
      <DataTable rows={rows} rowKey={v => v.id} empty="No rates yet"
        columns={[
          { label: 'Item', render: v => ref.item(v.item_id)?.name ?? '—' },
          { label: 'Per', render: v => rateBasis(v, ref.item(v.item_id), ref.packSizes) },
          { label: 'Rate', num: true, render: v => `₹${fmtNum(v.rate, 2)}` },
          { label: 'Per base unit', num: true, render: v => fmtRate(v.rate_per_base, ref.item(v.item_id)?.base_unit) },
          { label: 'From', render: v => fmtDate(v.valid_from) },
          { label: 'Until', render: v => (v.valid_to ? fmtDate(v.valid_to) : <Badge tone="green">Current</Badge>) },
          { label: '', render: v => can('masters.edit') && !v.valid_to && <Button size="sm" variant="ghost" onClick={() => setClosing(v)}>End rate</Button> },
        ]} />
      {can('masters.edit') && <RateForm vendorId={vendor.id} onSaved={q.reload} />}
      <ReasonModal open={!!closing} title="End this rate today" label="Note (optional)" required={false} confirmLabel="End rate" onClose={() => setClosing(null)}
        onConfirm={async () => {
          if (!closing) return;
          await run(sb.from('vendor_items').update({ valid_to: isoDay() < closing.valid_from ? closing.valid_from : isoDay() }).eq('id', closing.id));
          toast('Rate ended');
          q.reload();
        }} />
    </div>
  );
}
