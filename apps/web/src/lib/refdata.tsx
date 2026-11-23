import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useAccess } from './access';
import { run, sb, selectAll } from './supabase';
import type { Category, Department, Item, MenuCategory, MenuItem, PackSize, StorageLocation, Unit, Vendor } from './types';

// Masters most screens need (items, units, locations, vendors, menu), loaded
// once per organisation and reloaded after edits.

type RefData = {
  loading: boolean;
  units: Unit[];
  categories: Category[];
  items: Item[];
  packSizes: PackSize[];
  vendors: Vendor[];
  locations: StorageLocation[];
  menuCategories: MenuCategory[];
  menuItems: MenuItem[];
  departments: Department[];
  item: (id: string | null | undefined) => Item | undefined;
  location: (id: string | null | undefined) => StorageLocation | undefined;
  vendor: (id: string | null | undefined) => Vendor | undefined;
  department: (id: string | null | undefined) => Department | undefined;
  packSize: (id: string | null | undefined) => PackSize | undefined;
  outletLocations: StorageLocation[];
  outletStores: StorageLocation[];
  outletDepartments: Department[];
  reload: () => Promise<void>;
};

const empty = {
  units: [] as Unit[], categories: [] as Category[], items: [] as Item[], packSizes: [] as PackSize[], vendors: [] as Vendor[],
  locations: [] as StorageLocation[], menuCategories: [] as MenuCategory[], menuItems: [] as MenuItem[], departments: [] as Department[],
};

const RefContext = createContext<RefData | null>(null);

export function RefDataProvider({ children }: { children: ReactNode }) {
  const { orgId, outletId } = useAccess();
  const [state, setState] = useState(empty);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    if (!orgId) { setState(empty); setLoading(false); return; }
    setLoading(true);
    try {
      const [units, categories, items, packSizes, vendors, locations, menuCategories, menuItems, departments] = await Promise.all([
        run<Unit[]>(sb.from('units').select('*').order('sort_order')),
        run<Category[]>(sb.from('item_categories').select('*').eq('organisation_id', orgId).order('sort_order').order('name')),
        selectAll<Item>((a, b) => sb.from('items').select('*').eq('organisation_id', orgId).order('name').range(a, b)),
        selectAll<PackSize>((a, b) => sb.from('item_pack_sizes').select('*').eq('organisation_id', orgId).order('name').range(a, b)),
        selectAll<Vendor>((a, b) => sb.from('vendors').select('*').eq('organisation_id', orgId).order('name').range(a, b)),
        run<StorageLocation[]>(sb.from('storage_locations').select('*').eq('organisation_id', orgId).order('name')),
        run<MenuCategory[]>(sb.from('menu_categories').select('*').eq('organisation_id', orgId).order('sort_order').order('name')),
        selectAll<MenuItem>((a, b) => sb.from('menu_items').select('*').eq('organisation_id', orgId).order('name').range(a, b)),
        run<Department[]>(sb.from('departments').select('*').eq('organisation_id', orgId).order('name')),
      ]);
      setState({ units, categories, items, packSizes, vendors, locations, menuCategories, menuItems, departments });
    } catch {
      // A role without masters access simply gets empty lists; screens show their own errors.
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => { void reload(); }, [reload]);

  const value = useMemo<RefData>(() => {
    const itemMap = new Map(state.items.map(i => [i.id, i]));
    const locMap = new Map(state.locations.map(l => [l.id, l]));
    const vendorMap = new Map(state.vendors.map(v => [v.id, v]));
    const deptMap = new Map(state.departments.map(d => [d.id, d]));
    const packMap = new Map(state.packSizes.map(p => [p.id, p]));
    const outletLocations = state.locations.filter(l => l.outlet_id === outletId);
    return {
      ...state,
      loading,
      item: id => (id ? itemMap.get(id) : undefined),
      location: id => (id ? locMap.get(id) : undefined),
      vendor: id => (id ? vendorMap.get(id) : undefined),
      department: id => (id ? deptMap.get(id) : undefined),
      packSize: id => (id ? packMap.get(id) : undefined),
      outletLocations,
      outletStores: outletLocations.filter(l => l.kind === 'store'),
      outletDepartments: state.departments.filter(d => d.outlet_id === outletId),
      reload,
    };
  }, [state, loading, outletId, reload]);

  return <RefContext.Provider value={value}>{children}</RefContext.Provider>;
}

export function useRefData(): RefData {
  const v = useContext(RefContext);
  if (!v) throw new Error('useRefData outside RefDataProvider');
  return v;
}

