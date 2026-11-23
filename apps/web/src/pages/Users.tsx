import { useState } from 'react';
import { useAccess } from '../lib/access';
import { useAction, useLoad } from '../lib/hooks';
import { run, sb, toUsername } from '../lib/supabase';
import { fmtDate } from '../lib/format';
import type { Member, Role } from '../lib/types';
import { Badge, Button, Checkbox, DataTable, ErrorNote, Field, FormGrid, Modal, Notice, PageHeader, Select, useToast } from '../components/ui';

export default function Users() {
  const { orgId, org } = useAccess();
  const membersQ = useLoad(() => run<Member[]>(sb.rpc('list_members', { p_organisation_id: orgId })), [orgId]);
  const rolesQ = useLoad(() => run<Role[]>(sb.from('roles').select('*').eq('organisation_id', orgId).order('sort_order')), [orgId]);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Member | null>(null);
  const outlets = org?.outlets ?? [];
  const outletName = (id: string) => outlets.find(o => o.id === id)?.name ?? 'Inactive outlet';

  return (
    <div>
      <PageHeader title="Users" subtitle="Who can sign in, their role and the outlets they work at"
        actions={<Button onClick={() => setAdding(true)}>Add staff login</Button>} />
      <ErrorNote error={membersQ.error} />
      <DataTable rows={membersQ.data ?? []} rowKey={m => m.membership_id}
        onRowClick={m => (m.role_key === 'owner' ? undefined : setEditing(m))}
        empty="No users yet"
        columns={[
          { label: 'Name', render: m => <span className="font-medium">{m.full_name || '—'}</span> },
          { label: 'Username', render: m => toUsername(m.email) },
          { label: 'Role', render: m => m.role_name },
          { label: 'Outlets', render: m => (m.all_outlets ? 'All outlets' : m.outlet_ids.map(outletName).join(', ') || '—') },
          { label: 'Added', render: m => fmtDate(m.created_at) },
          { label: 'Status', render: m => (m.is_active ? <Badge tone="green">Active</Badge> : <Badge>Deactivated</Badge>) },
        ]} />
      {adding && <AddStaff roles={rolesQ.data ?? []} onClose={() => setAdding(false)} onSaved={membersQ.reload} />}
      {editing && <EditMember member={editing} roles={rolesQ.data ?? []} onClose={() => setEditing(null)} onSaved={membersQ.reload} />}
    </div>
  );
}

function OutletPicker({ all, setAll, ids, setIds }: { all: boolean; setAll: (v: boolean) => void; ids: string[]; setIds: (v: string[]) => void }) {
  const { org } = useAccess();
  return (
    <div className="flex flex-col gap-2">
      <Checkbox label="All outlets, including ones added later" checked={all} onChange={setAll} />
      {!all && (
        <div className="flex flex-wrap gap-x-4 gap-y-2 rounded-md border border-line p-3">
          {(org?.outlets ?? []).map(o => (
            <Checkbox key={o.id} label={o.name} checked={ids.includes(o.id)}
              onChange={v => setIds(v ? [...ids, o.id] : ids.filter(x => x !== o.id))} />
          ))}
          {(org?.outlets ?? []).length === 0 && <span className="text-sm text-muted">Add an outlet in Settings first.</span>}
        </div>
      )}
    </div>
  );
}

function roleOptions(roles: Role[]) {
  return roles.filter(r => !r.is_system && r.is_active).map(r => ({ value: r.id, label: r.name }));
}

function AddStaff({ roles, onClose, onSaved }: { roles: Role[]; onClose: () => void; onSaved: () => void }) {
  const { orgId } = useAccess();
  const toast = useToast();
  const { busy, error, act } = useAction();
  const [fullName, setFullName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [roleId, setRoleId] = useState('');
  const [all, setAll] = useState(false);
  const [ids, setIds] = useState<string[]>([]);

  const save = () => act(async () => {
    if (!fullName.trim()) throw new Error('Enter their name');
    if (!roleId) throw new Error('Choose a role');
    if (!all && ids.length === 0) throw new Error('Choose at least one outlet');
    const { data, error: err } = await sb.functions.invoke('create-staff-user', {
      body: { organisation_id: orgId, username: username.trim().toLowerCase(), password, full_name: fullName.trim(), role_id: roleId, all_outlets: all, outlet_ids: ids },
    });
    if (err) {
      // The function replies with { error } and a 4xx status; show its message.
      const ctx = (err as { context?: Response }).context;
      let message = err.message;
      try { if (ctx && typeof ctx.json === 'function') message = ((await ctx.json()) as { error?: string }).error ?? message; } catch { /* keep the generic message */ }
      throw new Error(message);
    }
    if (data && (data as { error?: string }).error) throw new Error((data as { error: string }).error);
    toast(`Login created for ${fullName.trim()}`);
    onSaved();
    onClose();
  });

  return (
    <Modal open title="Add staff login" onClose={onClose}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button busy={busy} onClick={() => void save()}>Create login</Button></>}>
      <ErrorNote error={error} />
      <Notice>Share the username and password with them. They sign in with the username; no email is needed.</Notice>
      <FormGrid>
        <Field label="Name"><input className="input" value={fullName} onChange={e => setFullName(e.target.value)} autoFocus /></Field>
        <Field label="Username" hint="3 to 30 letters or numbers"><input className="input" autoCapitalize="none" value={username} onChange={e => setUsername(e.target.value)} /></Field>
        <Field label="Password" hint="At least 8 characters"><input className="input" type="text" autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} /></Field>
        <Field label="Role"><Select value={roleId} onChange={setRoleId} options={roleOptions(roles)} placeholder="Choose a role" /></Field>
      </FormGrid>
      <div className="mt-3"><OutletPicker all={all} setAll={setAll} ids={ids} setIds={setIds} /></div>
    </Modal>
  );
}

function EditMember({ member, roles, onClose, onSaved }: { member: Member; roles: Role[]; onClose: () => void; onSaved: () => void }) {
  const { orgId } = useAccess();
  const toast = useToast();
  const { busy, error, act } = useAction();
  const [roleId, setRoleId] = useState(member.role_id);
  const [all, setAll] = useState(member.all_outlets);
  const [ids, setIds] = useState<string[]>(member.outlet_ids);
  const [active, setActive] = useState(member.is_active);

  const save = () => act(async () => {
    if (!all && ids.length === 0) throw new Error('Choose at least one outlet');
    await run(sb.from('memberships').update({ role_id: roleId, all_outlets: all, is_active: active }).eq('id', member.membership_id));
    const add = all ? [] : ids.filter(id => !member.outlet_ids.includes(id));
    const remove = all ? member.outlet_ids : member.outlet_ids.filter(id => !ids.includes(id));
    if (add.length) await run(sb.from('membership_outlets').insert(add.map(outlet_id => ({ organisation_id: orgId, membership_id: member.membership_id, outlet_id }))));
    if (remove.length) await run(sb.from('membership_outlets').delete().eq('membership_id', member.membership_id).in('outlet_id', remove));
    toast('User saved');
    onSaved();
    onClose();
  });

  return (
    <Modal open title={member.full_name || toUsername(member.email)} onClose={onClose}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button busy={busy} onClick={() => void save()}>Save</Button></>}>
      <ErrorNote error={error} />
      <p className="mb-3 text-sm text-muted">Username: {toUsername(member.email)}</p>
      <FormGrid cols={1}>
        <Field label="Role"><Select value={roleId} onChange={setRoleId} options={roleOptions(roles)} /></Field>
      </FormGrid>
      <div className="mt-3"><OutletPicker all={all} setAll={setAll} ids={ids} setIds={setIds} /></div>
      <div className="mt-3"><Checkbox label="Can sign in (untick to deactivate)" checked={active} onChange={setActive} /></div>
    </Modal>
  );
}
