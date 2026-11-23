// Indian number formatting (₹1,25,000) and dates as DD MMM YYYY.

const money = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function toNum(v: unknown): number {
  if (v === null || v === undefined || v === '') return 0;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n + 0 : 0; // + 0 turns -0 into 0
}

export function fmtMoney(v: unknown): string {
  return money.format(toNum(v));
}

export function fmtNum(v: unknown, maxDigits = 2): string {
  return new Intl.NumberFormat('en-IN', { maximumFractionDigits: maxDigits }).format(toNum(v));
}

export function fmtPct(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  return `${fmtNum(v, 1)}%`;
}

// Rate per base unit, e.g. ₹0.0400 / g
export function fmtRate(v: unknown, unit?: string): string {
  const n = toNum(v);
  const digits = n !== 0 && Math.abs(n) < 1 ? 4 : 2;
  const s = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);
  return unit ? `${s} / ${unit}` : s;
}

// A quantity held in base units (g, ml, pcs), shown in kg or l once it is large.
export function fmtQty(v: unknown, baseUnit?: string | null): string {
  const n = toNum(v);
  if (baseUnit === 'g' && Math.abs(n) >= 1000) return `${fmtNum(n / 1000, 3)} kg`;
  if (baseUnit === 'ml' && Math.abs(n) >= 1000) return `${fmtNum(n / 1000, 3)} l`;
  return `${fmtNum(n, 3)}${baseUnit ? ' ' + baseUnit : ''}`;
}

function parts(v: string | Date): Date | null {
  if (v instanceof Date) return v;
  if (!v) return null;
  // A plain date (YYYY-MM-DD) is a calendar day, not a moment.
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const [y, m, d] = v.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function fmtDate(v: string | Date | null | undefined): string {
  const d = v ? parts(v) : null;
  if (!d) return '—';
  return `${String(d.getDate()).padStart(2, '0')} ${months[d.getMonth()]} ${d.getFullYear()}`;
}

export function fmtDateTime(v: string | Date | null | undefined): string {
  const d = v ? parts(v) : null;
  if (!d) return '—';
  let h = d.getHours();
  const ampm = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  return `${fmtDate(d)}, ${h}:${String(d.getMinutes()).padStart(2, '0')} ${ampm}`;
}

// Today and other days as YYYY-MM-DD in the browser's time zone.
export function isoDay(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function addDays(day: string, n: number): string {
  const d = parts(day) ?? new Date();
  d.setDate(d.getDate() + n);
  return isoDay(d);
}

export function startOfMonth(d: Date = new Date()): string {
  return isoDay(new Date(d.getFullYear(), d.getMonth(), 1));
}

// Start of a calendar day as a timestamp in the browser's time zone.
export function dayStart(day: string): string {
  const d = parts(day) ?? new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

// Value for <input type="datetime-local">
export function localDateTimeValue(d: Date = new Date()): string {
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 16);
}

// 'staff_meal' → 'Staff meal'
export const humanize = (s: string | null | undefined) =>
  s ? s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ') : '';
