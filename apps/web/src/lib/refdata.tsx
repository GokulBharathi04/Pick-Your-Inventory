import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useAccess } from './access';
import { run, sb, selectAll } from './supabase';
import type { Category, Item, MenuCategory, MenuItem, PackSize, StorageLocation, Unit, Vendor } from './types';

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
  item: (id: string | null | undefined) => Item | undefined;
  location: (id: string | null | undefined) => StorageLocation | undefined;
  outletLocations: StorageLocation[];
  reload: () => Promise<void>;
};

const empty = {
  units: [] as Unit[], categories: [] as Category[], items: [] as Item[], packSizes: [] as PackSize[], vendors: [] as Vendor[],
  locations: [] as StorageLocation[], menuCategories: [] as MenuCategory[], menuItems: [] as MenuItem[],
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
      const [units, categories, items, packSizes, vendors, locations, menuCategories, menuItems] = await Promise.all([
        run<Unit[]>(sb.from('units').select('*').order('sort_order')),
        run<Category[]>(sb.from('item_categories').select('*').eq('organisation_id', orgId).order('sort_order').order('name')),
        selectAll<Item>((a, b) => sb.from('items').select('*').eq('organisation_id', orgId).order('name').range(a, b)),
        selectAll<PackSize>((a, b) => sb.from('item_pack_sizes').select('*').eq('organisation_id', orgId).order('name').range(a, b)),
        selectAll<Vendor>((a, b) => sb.from('vendors').select('*').eq('organisation_id', orgId).order('name').range(a, b)),
        run<StorageLocation[]>(sb.from('storage_locations').select('*').eq('organisation_id', orgId).order('name')),
        run<MenuCategory[]>(sb.from('menu_categories').select('*').eq('organisation_id', orgId).order('sort_order').order('name')),
        selectAll<MenuItem>((a, b) => sb.from('menu_items').select('*').eq('organisation_id', orgId).order('name').range(a, b)),
      ]);
      setState({ units, categories, items, packSizes, vendors, locations, menuCategories, menuItems });
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
    return {
      ...state,
      loading,
      item: id => (id ? itemMap.get(id) : undefined),
      location: id => (id ? locMap.get(id) : undefined),
      outletLocations: state.locations.filter(l => l.outlet_id === outletId),
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

