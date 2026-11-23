import { useMemo, type ReactNode } from 'react';
import { useAccess } from '../lib/access';
import { useRefData } from '../lib/refdata';
import { defaultUnit, unitsFor } from '../lib/units';
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
      .filter(i => (includeInactive || i.is_active || i.id === value) && (!filter || filter(i)))
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
  return item ? defaultUnit(item.base_unit) : '';
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
