import { toNum } from './format';
import type { Item, PackSize, Unit } from './types';

// Units an item can be entered in: its own family (g → g, kg) and, if it has
// one, its cross-family conversion (eggs in pcs can also be entered in g).
export function unitsFor(item: Pick<Item, 'base_unit' | 'alt_unit'> | null | undefined, units: Unit[]): Unit[] {
  if (!item) return [];
  return units
    .filter(u => u.base_code === item.base_unit || (item.alt_unit && u.base_code === item.alt_unit))
    .sort((a, b) => a.sort_order - b.sort_order);
}

// Same rule as private.to_base_qty in the database.
export function toBase(item: Pick<Item, 'base_unit' | 'alt_unit' | 'alt_per_base'>, qty: number, unitCode: string, units: Unit[]): number {
  const u = units.find(x => x.code === unitCode);
  if (!u) throw new Error(`Unknown unit: ${unitCode}`);
  const f = toNum(u.factor_to_base);
  if (u.base_code === item.base_unit) return round6(qty * f);
  if (item.alt_unit && u.base_code === item.alt_unit && toNum(item.alt_per_base) > 0) return round6((qty * f) / toNum(item.alt_per_base));
  throw new Error(`This item can't be measured in ${unitCode}`);
}

export function fromBase(item: Pick<Item, 'base_unit' | 'alt_unit' | 'alt_per_base'>, qtyBase: number, unitCode: string, units: Unit[]): number {
  const one = toBase(item, 1, unitCode, units);
  return one === 0 ? 0 : round6(qtyBase / one);
}

// The unit people usually type: kg for gram items, l for millilitre items.
export function defaultUnit(baseUnit: string): string {
  if (baseUnit === 'g') return 'kg';
  if (baseUnit === 'ml') return 'l';
  return baseUnit;
}

export const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

export function packLabel(p: PackSize, baseUnit: string): string {
  return `${p.name} (${toNum(p.quantity_in_base)} ${baseUnit})`;
}
