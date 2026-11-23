import { useEffect, useMemo, useState } from 'react';
import { useAccess } from '../lib/access';
import { useAction, useLoad } from '../lib/hooks';
import { run, sb } from '../lib/supabase';
import type { AppTab, Permission, Role } from '../lib/types';
import { Badge, Button, Checkbox, ErrorNote, Field, Loading, Modal, PageHeader, Section, cx, useToast } from '../components/ui';

type RolePermission = { role_id: string; permission_code: string };

export default function Roles() {
  const { orgId, refreshAccess } = useAccess();
  const toast = useToast();
  const q = useLoad(async () => {
    const [roles, perms, granted, tabs] = await Promise.all([
      run<Role[]>(sb.from('roles').select('*').eq('organisation_id', orgId).order('sort_order')),
      run<Permission[]>(sb.from('permissions').select('*').order('sort_order')),
      run<RolePermission[]>(sb.from('role_permissions').select('role_id,permission_code').eq('organisation_id', orgId)),
      run<AppTab[]>(sb.from('app_tabs').select('*').order('sort_order')),
    ]);
    return { roles, perms, granted, tabs };
  }, [orgId]);
  const [roleId, setRoleId] = useState('');
  const [adding, setAdding] = useState(false);
  const { error, act } = useAction();
  const [pending, setPending] = useState<string | null>(null);
  // Shows a tick change at once; cleared when the saved permissions reload.
  const [optimistic, setOptimistic] = useState<Record<string, boolean>>({});
  useEffect(() => { setOptimistic({}); }, [q.data]);

  const role = q.data?.roles.find(r => r.id === roleId) ?? q.data?.roles.find(r => !r.is_system) ?? q.data?.roles[0];
  const has = useMemo(() => new Set((q.data?.granted ?? []).filter(g => g.role_id === role?.id).map(g => g.permission_code)), [q.data, role]);
  const areas = useMemo(() => {
    const out: { area: string; perms: Permission[] }[] = [];
    for (const p of q.data?.perms ?? []) {
      const a = out.find(x => x.area === p.area);
      if (a) a.perms.push(p); else out.push({ area: p.area, perms: [p] });
    }
    return out;
  }, [q.data]);

  if (!q.data) return <><PageHeader title="Roles" /><ErrorNote error={q.error} /><Loading /></>;

  const toggle = (code: string, on: boolean) => act(async () => {
    if (!role) return;
    setPending(code);
    setOptimistic(o => ({ ...o, [code]: on }));
    try {
      if (on) await run(sb.from('role_permissions').insert({ organisation_id: orgId, role_id: role.id, permission_code: code }));
      else await run(sb.from('role_permissions').delete().eq('role_id', role.id).eq('permission_code', code));
      q.reload();
      await refreshAccess();
    } catch (e) {
      setOptimistic(o => { const n = { ...o }; delete n[code]; return n; });
      throw e;
    } finally {
      setPending(null);
    }
  });

  const tabsSeen = role ? q.data.tabs.filter(t => !t.view_permission || role.is_system || has.has(t.view_permission)) : [];

  return (
    <div>
      <PageHeader title="Roles" subtitle="What each role can do. A tab shows when the role can see its data."
        actions={<Button onClick={() => setAdding(true)}>Add role</Button>} />
      <ErrorNote error={error ?? q.error} />
      <div className="grid gap-5 lg:grid-cols-[220px_1fr]">
        <div className="flex flex-col gap-1">
          {q.data.roles.map(r => (
            <button key={r.id} type="button" onClick={() => setRoleId(r.id)}
              className={cx('flex items-center justify-between rounded-md px-3 py-2 text-left text-sm', r.id === role?.id ? 'bg-teal-wash font-medium text-teal-ink' : 'hover:bg-white')}>
              {r.name}
              {r.is_system && <Badge>Locked</Badge>}
            </button>
          ))}
        </div>
        {role && (
          <div>
            <Section title={role.name} subtitle={role.is_system ? 'The owner can do everything. This role cannot be changed.' : role.description ?? undefined}>
              <div className="grid gap-5 md:grid-cols-2">
                {areas.map(a => (
                  <div key={a.area}>
                    <h3 className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">{a.area}</h3>
                    <div className="flex flex-col gap-2">
                      {a.perms.map(p => (
                        <Checkbox key={p.code} label={<span>{p.description} <span className="text-xs text-muted">({p.code})</span></span>}
                          checked={role.is_system || (optimistic[p.code] ?? has.has(p.code))} disabled={role.is_system || pending === p.code}
                          onChange={v => { void toggle(p.code, v).then(ok => { if (ok) toast(v ? 'Permission given' : 'Permission removed'); }); }} />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </Section>
            <Section title="Tabs this role sees">
              <div className="flex flex-wrap gap-2">{tabsSeen.map(t => <Badge key={t.key} tone="teal">{t.label}</Badge>)}</div>
            </Section>
          </div>
        )}
      </div>
      {adding && <AddRole onClose={() => setAdding(false)} onSaved={(id) => { q.reload(); setRoleId(id); }} />}
    </div>
  );
}

function AddRole({ onClose, onSaved }: { onClose: () => void; onSaved: (id: string) => void }) {
  const { orgId } = useAccess();
  const { busy, error, act } = useAction();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const save = () => act(async () => {
    const key = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
    if (key.length < 2 || !/^[a-z]/.test(key)) throw new Error('Give the role a name that starts with a letter');
    const r = await run<Role>(sb.from('roles').insert({ organisation_id: orgId, key, name: name.trim(), description: description.trim() || null, sort_order: 200 }).select().single());
    onSaved(r.id);
    onClose();
  });
  return (
    <Modal open title="Add role" onClose={onClose}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button busy={busy} onClick={() => void save()}>Add role</Button></>}>
      <ErrorNote error={error} />
      <div className="flex flex-col gap-3">
        <Field label="Name"><input className="input" value={name} onChange={e => setName(e.target.value)} autoFocus /></Field>
        <Field label="Description"><input className="input" value={description} onChange={e => setDescription(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}
