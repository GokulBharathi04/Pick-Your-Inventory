import { useMemo, type ReactNode } from 'react';
import { useAccess } from '../lib/access';
import { useRefData } from '../lib/refdata';
import { unitsFor, stockUnit } from '../lib/units';
import type { Item } from '../lib/types';
import { Empty, Select, type Option } from './ui';
import { Link } from '../lib/router';

// Items as a grouped dropdown (by category), optionally filtered.
export function ItemSelect({ value, onChange, filter, placeholder = 'Choose an item', disabled, includeInactive }: {
  value: string; onChange: (id: string) => void; filter?: (i: Item) => boolean; placeholder?: string; disabled?: boolean; includeInactive?: boolean;
}) {
  const { items, categories } = useRefData();
  const options = useMemo<Option[]>(() => {
    const cat = new Map(categories.map(c => [c.id, c.name]));
    return items
      .filter(i => i.id === value || ((includeInactive || i.is_active) && (!filter || filter(i))))
      .map(i => ({ value: i.id, label: i.code ? `${i.name} (${i.code})` : i.name, group: cat.get(i.category_id ?? '') ?? 'No category' }))
      .sort((a, b) => (a.group ?? '').localeCompare(b.group ?? '') || a.label.localeCompare(b.label));
  }, [items, categories, filter, includeInactive, value]);
  return <Select value={value} onChange={onChange} options={options} placeholder={placeholder} disabled={disabled} />;
}

// Quantity plus the unit it is typed in (kg, g, l, ml, pcs, dozen).
export function QtyInput({ item, qty, unit, onQty, onUnit, disabled, placeholder }: {
  item: Item | undefined; qty: string; unit: string; onQty: (v: string) => void; onUnit: (u: string) => void; disabled?: boolean; placeholder?: string;
}) {
  const { units } = useRefData();
  const choices = unitsFor(item, units);
  return (
    <div className="flex gap-1.5">
      <input className="input min-w-0 flex-1" type="number" inputMode="decimal" step="any" min="0" value={qty}
        onChange={e => onQty(e.target.value)} disabled={disabled || !item} placeholder={placeholder ?? '0'} />
      <select className="input w-24 shrink-0" value={unit} onChange={e => onUnit(e.target.value)} disabled={disabled || !item}>
        {choices.length === 0 && <option value="">—</option>}
        {choices.map(u => <option key={u.code} value={u.code}>{u.code}</option>)}
      </select>
    </div>
  );
}

// Picks the usual entry unit when the item changes.
export function unitForItem(item: Item | undefined): string {
  return item ? stockUnit(item) : '';
}

export function LocationSelect({ value, onChange, placeholder = 'Choose a location', exclude }: {
  value: string; onChange: (id: string) => void; placeholder?: string; exclude?: string;
}) {
  const { outletLocations } = useRefData();
  const options = outletLocations
    .filter(l => (l.is_active || l.id === value) && l.id !== exclude)
    .map(l => ({ value: l.id, label: l.name }));
  return <Select value={value} onChange={onChange} options={options} placeholder={placeholder} />;
}

// Locations of the outlet that receive goods (stores, and any kitchen or cold
// room set to): orders, receipts, issues and returns use only these.
export function ReceivingSelect({ value, onChange, placeholder = 'Choose a location' }: { value: string; onChange: (id: string) => void; placeholder?: string }) {
  const { receivingLocations } = useRefData();
  const options = receivingLocations.filter(l => l.is_active || l.id === value).map(l => ({ value: l.id, label: l.name }));
  return <Select value={value} onChange={onChange} options={options} placeholder={placeholder} />;
}

export function DepartmentSelect({ value, onChange, placeholder = 'Choose a department' }: { value: string; onChange: (id: string) => void; placeholder?: string }) {
  const { outletDepartments } = useRefData();
  const options = outletDepartments.filter(d => d.is_active || d.id === value).map(d => ({ value: d.id, label: d.name }));
  return <Select value={value} onChange={onChange} options={options} placeholder={placeholder} />;
}

export function VendorSelect({ value, onChange, placeholder = 'Choose a vendor', disabled }: { value: string; onChange: (id: string) => void; placeholder?: string; disabled?: boolean }) {
  const { vendors } = useRefData();
  const options = vendors.filter(v => v.is_active || v.id === value).map(v => ({ value: v.id, label: v.name }));
  return <Select value={value} onChange={onChange} options={options} placeholder={placeholder} disabled={disabled} />;
}

// How an item is bought: one of its pack sizes ("pack:<id>") or a unit code.
export type PurchaseUnit = { packSizeId: string | null; unit: string | null };
export const purchaseUnitValue = (p: PurchaseUnit) => (p.packSizeId ? `pack:${p.packSizeId}` : p.unit ?? '');
export const parsePurchaseUnit = (v: string): PurchaseUnit => (v.startsWith('pack:') ? { packSizeId: v.slice(5), unit: null } : { packSizeId: null, unit: v || null });

export function PurchaseUnitSelect({ item, value, onChange, disabled }: { item: Item | undefined; value: string; onChange: (v: string) => void; disabled?: boolean }) {
  const { units, packSizes } = useRefData();
  const packs = item ? packSizes.filter(p => p.item_id === item.id && (p.is_active || `pack:${p.id}` === value)) : [];
  const unitChoices = unitsFor(item, units);
  return (
    <select className="input w-36 shrink-0" value={value} onChange={e => onChange(e.target.value)} disabled={disabled || !item}>
      {!item && <option value="">—</option>}
      {packs.map(p => <option key={p.id} value={`pack:${p.id}`}>{p.name}</option>)}
      {unitChoices.map(u => <option key={u.code} value={u.code}>{u.code}</option>)}
    </select>
  );
}

// Screens that work on one outlet show this until an outlet exists.
export function NeedsOutlet({ children }: { children: ReactNode }) {
  const { outlet, can } = useAccess();
  const { outletLocations, loading } = useRefData();
  if (!outlet) {
    return (
      <Empty title="No outlet yet">
        {can('organisation.manage')
          ? <>Add your first outlet and its storage locations in <Link to="/settings" className="text-teal-ink underline">Settings</Link>.</>
          : 'Ask your manager to give you access to an outlet.'}
      </Empty>
    );
  }
  if (!loading && outletLocations.length === 0) {
    return (
      <Empty title={`${outlet.name} has no storage locations`}>
        {can('organisation.manage')
          ? <>Add a store and a kitchen in <Link to="/settings" className="text-teal-ink underline">Settings</Link>.</>
          : 'Ask your manager to add storage locations.'}
      </Empty>
    );
  }
  return <>{children}</>;
}

export function NoAccess() {
  return <Empty title="You don’t have access to this page">Ask the owner to change your role if you need it.</Empty>;
}
