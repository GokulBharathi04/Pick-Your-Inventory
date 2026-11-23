import { useEffect, useState } from 'react';
import { useAccess } from '../lib/access';
import { useRefData } from '../lib/refdata';
import { useAction, useLoad } from '../lib/hooks';
import { run, sb } from '../lib/supabase';
import type { Organisation, Outlet, StorageLocation } from '../lib/types';
import { Badge, Button, Checkbox, DataTable, ErrorNote, Field, FormGrid, Loading, Modal, PageHeader, Section, Select, useToast } from '../components/ui';
import { humanize } from '../lib/format';

const kinds = ['store', 'kitchen', 'bar', 'cold_room', 'other'].map(k => ({ value: k, label: humanize(k) }));
const blank = (v: string | null | undefined) => v ?? '';
const orNull = (v: string) => (v.trim() === '' ? null : v.trim());

export default function Settings() {
  const { orgId, refreshAccess } = useAccess();
  const ref = useRefData();
  const orgQ = useLoad(() => run<Organisation>(sb.from('organisations').select('*').eq('id', orgId).single()), [orgId]);
  const outletsQ = useLoad(() => run<Outlet[]>(sb.from('outlets').select('*').eq('organisation_id', orgId).order('name')), [orgId]);
  const [editOutlet, setEditOutlet] = useState<Outlet | 'new' | null>(null);
  const [editLoc, setEditLoc] = useState<{ loc: StorageLocation | null; outletId: string } | null>(null);

  const afterOutletChange = async () => {
    outletsQ.reload();
    await refreshAccess();
    await ref.reload();
  };

  return (
    <div>
      <PageHeader title="Settings" subtitle="Your business, its outlets and where stock is kept" />
      {orgQ.data ? <OrgForm org={orgQ.data} onSaved={() => { orgQ.reload(); void refreshAccess(); }} /> : <Loading />}

      <Section title="Outlets and storage locations" actions={<Button size="sm" onClick={() => setEditOutlet('new')}>Add outlet</Button>}>
        <ErrorNote error={outletsQ.error} />
        {(outletsQ.data ?? []).length === 0 && !outletsQ.loading && <p className="text-sm text-muted">No outlets yet. Add your first one.</p>}
        <div className="flex flex-col gap-4">
          {(outletsQ.data ?? []).map(o => {
            const locs = ref.locations.filter(l => l.outlet_id === o.id);
            return (
              <div key={o.id} className="rounded-lg border border-line">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-slate-50 px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{o.name}</span>
                    {o.code && <span className="text-xs text-muted">{o.code}</span>}
                    {o.city && <span className="text-xs text-muted">· {o.city}</span>}
                    {!o.is_active && <Badge>Inactive</Badge>}
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" variant="secondary" onClick={() => setEditLoc({ loc: null, outletId: o.id })}>Add location</Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditOutlet(o)}>Edit outlet</Button>
                  </div>
                </div>
                <div className="p-3">
                  <DataTable rows={locs} rowKey={l => l.id} onRowClick={l => setEditLoc({ loc: l, outletId: o.id })}
                    empty="No storage locations yet. Add a store and a kitchen."
                    columns={[
                      { label: 'Location', render: l => l.name },
                      { label: 'Kind', render: l => humanize(l.kind) },
                      { label: 'Status', render: l => (l.is_active ? <Badge tone="green">Active</Badge> : <Badge>Inactive</Badge>) },
                    ]} />
                </div>
              </div>
            );
          })}
        </div>
      </Section>

      {editOutlet && <OutletModal outlet={editOutlet === 'new' ? null : editOutlet} onClose={() => setEditOutlet(null)} onSaved={afterOutletChange} />}
      {editLoc && <LocationModal loc={editLoc.loc} outletId={editLoc.outletId} onClose={() => setEditLoc(null)} onSaved={() => void ref.reload()} />}
    </div>
  );
}

function OrgForm({ org, onSaved }: { org: Organisation; onSaved: () => void }) {
  const toast = useToast();
  const { busy, error, act } = useAction();
  const [f, setF] = useState({
    name: org.name, legal_name: blank(org.legal_name), gstin: blank(org.gstin), phone: blank(org.phone), email: blank(org.email),
    address_line1: blank(org.address_line1), address_line2: blank(org.address_line2), city: blank(org.city), state: blank(org.state),
    pincode: blank(org.pincode), timezone: org.timezone,
  });
  useEffect(() => { setF(x => ({ ...x, name: org.name })); }, [org.name]);
  const set = (k: keyof typeof f) => (v: string) => setF(x => ({ ...x, [k]: v }));
  const save = () => act(async () => {
    await run(sb.from('organisations').update({
      name: f.name.trim(), legal_name: orNull(f.legal_name), gstin: orNull(f.gstin.toUpperCase()), phone: orNull(f.phone), email: orNull(f.email),
      address_line1: orNull(f.address_line1), address_line2: orNull(f.address_line2), city: orNull(f.city), state: orNull(f.state),
      pincode: orNull(f.pincode), timezone: f.timezone,
    }).eq('id', org.id));
    toast('Business details saved');
    onSaved();
  });
  return (
    <Section title="Business" actions={<Button size="sm" busy={busy} onClick={() => void save()}>Save</Button>}>
      <ErrorNote error={error} />
      <FormGrid cols={3}>
        <Field label="Name"><input className="input" value={f.name} onChange={e => set('name')(e.target.value)} /></Field>
        <Field label="Legal name"><input className="input" value={f.legal_name} onChange={e => set('legal_name')(e.target.value)} /></Field>
        <Field label="GSTIN"><input className="input uppercase" value={f.gstin} onChange={e => set('gstin')(e.target.value)} /></Field>
        <Field label="Phone"><input className="input" value={f.phone} onChange={e => set('phone')(e.target.value)} /></Field>
        <Field label="Email"><input className="input" type="email" value={f.email} onChange={e => set('email')(e.target.value)} /></Field>
        <Field label="Time zone"><input className="input" value={f.timezone} onChange={e => set('timezone')(e.target.value)} /></Field>
        <Field label="Address"><input className="input" value={f.address_line1} onChange={e => set('address_line1')(e.target.value)} /></Field>
        <Field label="Address line 2"><input className="input" value={f.address_line2} onChange={e => set('address_line2')(e.target.value)} /></Field>
        <Field label="City"><input className="input" value={f.city} onChange={e => set('city')(e.target.value)} /></Field>
        <Field label="State"><input className="input" value={f.state} onChange={e => set('state')(e.target.value)} /></Field>
        <Field label="PIN code"><input className="input" inputMode="numeric" value={f.pincode} onChange={e => set('pincode')(e.target.value)} /></Field>
      </FormGrid>
    </Section>
  );
}

function OutletModal({ outlet, onClose, onSaved }: { outlet: Outlet | null; onClose: () => void; onSaved: () => Promise<void> }) {
  const { orgId } = useAccess();
  const toast = useToast();
  const { busy, error, act } = useAction();
  const [f, setF] = useState({
    name: blank(outlet?.name), code: blank(outlet?.code), gstin: blank(outlet?.gstin), phone: blank(outlet?.phone),
    address_line1: blank(outlet?.address_line1), address_line2: blank(outlet?.address_line2), city: blank(outlet?.city),
    state: blank(outlet?.state), pincode: blank(outlet?.pincode), is_active: outlet?.is_active ?? true,
  });
  const [addDefaults, setAddDefaults] = useState(true);
  const set = (k: keyof typeof f) => (v: string) => setF(x => ({ ...x, [k]: v }));
  const save = () => act(async () => {
    if (!f.name.trim()) throw new Error('Give the outlet a name');
    const values = {
      name: f.name.trim(), code: orNull(f.code.toUpperCase()), gstin: orNull(f.gstin.toUpperCase()), phone: orNull(f.phone),
      address_line1: orNull(f.address_line1), address_line2: orNull(f.address_line2), city: orNull(f.city), state: orNull(f.state), pincode: orNull(f.pincode),
    };
    if (outlet) {
      await run(sb.from('outlets').update({ ...values, is_active: f.is_active }).eq('id', outlet.id));
    } else {
      const created = await run<Outlet>(sb.from('outlets').insert({ ...values, organisation_id: orgId }).select().single());
      if (addDefaults) {
        await run(sb.from('storage_locations').insert([
          { organisation_id: orgId, outlet_id: created.id, name: 'Main store', kind: 'store' },
          { organisation_id: orgId, outlet_id: created.id, name: 'Kitchen', kind: 'kitchen' },
        ]));
      }
    }
    toast(outlet ? 'Outlet saved' : 'Outlet added');
    await onSaved();
    onClose();
  });
  return (
    <Modal open title={outlet ? `Edit ${outlet.name}` : 'Add outlet'} onClose={onClose} size="lg"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button busy={busy} onClick={() => void save()}>Save</Button></>}>
      <ErrorNote error={error} />
      <FormGrid cols={3}>
        <Field label="Name"><input className="input" value={f.name} onChange={e => set('name')(e.target.value)} autoFocus /></Field>
        <Field label="Code" hint="Short, e.g. ANN"><input className="input uppercase" value={f.code} onChange={e => set('code')(e.target.value)} /></Field>
        <Field label="GSTIN"><input className="input uppercase" value={f.gstin} onChange={e => set('gstin')(e.target.value)} /></Field>
        <Field label="Phone"><input className="input" value={f.phone} onChange={e => set('phone')(e.target.value)} /></Field>
        <Field label="Address"><input className="input" value={f.address_line1} onChange={e => set('address_line1')(e.target.value)} /></Field>
        <Field label="Address line 2"><input className="input" value={f.address_line2} onChange={e => set('address_line2')(e.target.value)} /></Field>
        <Field label="City"><input className="input" value={f.city} onChange={e => set('city')(e.target.value)} /></Field>
        <Field label="State"><input className="input" value={f.state} onChange={e => set('state')(e.target.value)} /></Field>
        <Field label="PIN code"><input className="input" value={f.pincode} onChange={e => set('pincode')(e.target.value)} /></Field>
      </FormGrid>
      <div className="mt-3 flex flex-col gap-2">
        {outlet
          ? <Checkbox label="Active" checked={f.is_active} onChange={v => setF(x => ({ ...x, is_active: v }))} />
          : <Checkbox label="Also add a Main store and a Kitchen" checked={addDefaults} onChange={setAddDefaults} />}
      </div>
    </Modal>
  );
}

function LocationModal({ loc, outletId, onClose, onSaved }: { loc: StorageLocation | null; outletId: string; onClose: () => void; onSaved: () => void }) {
  const { orgId } = useAccess();
  const toast = useToast();
  const { busy, error, act } = useAction();
  const [name, setName] = useState(loc?.name ?? '');
  const [kind, setKind] = useState(loc?.kind ?? 'store');
  const [active, setActive] = useState(loc?.is_active ?? true);
  const save = () => act(async () => {
    if (!name.trim()) throw new Error('Give the location a name');
    if (loc) await run(sb.from('storage_locations').update({ name: name.trim(), kind, is_active: active }).eq('id', loc.id));
    else await run(sb.from('storage_locations').insert({ organisation_id: orgId, outlet_id: outletId, name: name.trim(), kind }));
    toast(loc ? 'Location saved' : 'Location added');
    onSaved();
    onClose();
  });
  return (
    <Modal open title={loc ? `Edit ${loc.name}` : 'Add storage location'} onClose={onClose}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button busy={busy} onClick={() => void save()}>Save</Button></>}>
      <ErrorNote error={error} />
      <FormGrid>
        <Field label="Name"><input className="input" value={name} onChange={e => setName(e.target.value)} autoFocus /></Field>
        <Field label="Kind" hint="Sales take stock from a kitchen or bar"><Select value={kind} onChange={setKind} options={kinds} /></Field>
      </FormGrid>
      {loc && <div className="mt-3"><Checkbox label="Active" checked={active} onChange={setActive} /></div>}
    </Modal>
  );
}
