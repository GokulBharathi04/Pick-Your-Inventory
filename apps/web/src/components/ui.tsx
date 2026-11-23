import { createContext, useCallback, useContext, useEffect, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Link } from '../lib/router';
import { errorText } from '../lib/supabase';

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');
export { cx };

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------
type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  size?: 'sm' | 'md';
  busy?: boolean;
};

export function Button({ variant = 'primary', size = 'md', busy, className, children, disabled, type, ...rest }: ButtonProps) {
  const base = 'inline-flex items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-60';
  const sizes = size === 'sm' ? 'h-8 px-2.5 text-xs' : 'h-9 px-3.5 text-sm';
  const variants = {
    primary: 'bg-teal text-white hover:bg-teal-ink border border-teal',
    secondary: 'bg-white text-ink border border-line hover:border-slate-400',
    danger: 'bg-white text-red-700 border border-red-200 hover:bg-red-50',
    ghost: 'bg-transparent text-teal-ink hover:bg-teal-wash border border-transparent',
  }[variant];
  return (
    <button type={type ?? 'button'} className={cx(base, sizes, variants, className)} disabled={disabled || busy} {...rest}>
      {busy && <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-r-transparent" aria-hidden="true" />}
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Page layout
// ---------------------------------------------------------------------------
export function PageHeader({ title, subtitle, actions, back }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; back?: { to: string; label: string } }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        {back && <Link to={back.to} className="mb-1 inline-block text-xs font-medium text-teal-ink hover:underline">← {back.label}</Link>}
        <h1 className="text-xl font-semibold text-ink">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Section({ title, actions, children, className, subtitle }: { title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx('mb-5 rounded-lg border border-line bg-white', className)}>
      {(title || actions) && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
          <div>
            {title && <h2 className="text-sm font-semibold text-ink">{title}</h2>}
            {subtitle && <p className="text-xs text-muted">{subtitle}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Toolbar({ children }: { children: ReactNode }) {
  return <div className="mb-3 flex flex-wrap items-end gap-2">{children}</div>;
}

// ---------------------------------------------------------------------------
// Form controls
// ---------------------------------------------------------------------------
export function Field({ label, hint, children, className }: { label: ReactNode; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cx('flex min-w-0 flex-col gap-1', className)}>
      <span className="text-xs font-medium text-slate-700">{label}</span>
      {children}
      {hint && <span className="text-xs text-muted">{hint}</span>}
    </label>
  );
}

export type Option = { value: string; label: string; group?: string };

export function Select({ value, onChange, options, placeholder, className, disabled, id }: {
  value: string; onChange: (v: string) => void; options: Option[]; placeholder?: string; className?: string; disabled?: boolean; id?: string;
}) {
  const groups = Array.from(new Set(options.map(o => o.group ?? '')));
  const hasGroups = groups.some(g => g !== '');
  return (
    <select id={id} className={cx('input', className)} value={value} onChange={e => onChange(e.target.value)} disabled={disabled}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {hasGroups
        ? groups.map(g => (
          <optgroup key={g} label={g || 'Other'}>
            {options.filter(o => (o.group ?? '') === g).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </optgroup>
        ))
        : options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

export function Checkbox({ label, checked, onChange, disabled }: { label: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-2 text-sm">
      <input type="checkbox" className="h-4 w-4 accent-teal" checked={checked} onChange={e => onChange(e.target.checked)} disabled={disabled} />
      <span>{label}</span>
    </label>
  );
}

export function FormGrid({ children, cols = 2 }: { children: ReactNode; cols?: 1 | 2 | 3 | 4 }) {
  const c = { 1: 'sm:grid-cols-1', 2: 'sm:grid-cols-2', 3: 'sm:grid-cols-3', 4: 'sm:grid-cols-2 lg:grid-cols-4' }[cols];
  return <div className={cx('grid grid-cols-1 gap-3', c)}>{children}</div>;
}

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------
export function ErrorNote({ error }: { error: string | null | undefined }) {
  if (!error) return null;
  return <div role="alert" className="mb-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-800">{error}</div>;
}

export function Notice({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'ok'; children: ReactNode }) {
  const t = { info: 'bg-teal-wash text-teal-ink', warn: 'bg-amber-50 text-amber-900', ok: 'bg-green-50 text-green-800' }[tone];
  return <div className={cx('mb-3 rounded-md px-3 py-2 text-sm', t)}>{children}</div>;
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return <div className="py-8 text-center text-sm text-muted">{label}</div>;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-line bg-white px-4 py-10 text-center">
      <p className="font-medium text-ink">{title}</p>
      {children && <div className="mt-1 text-sm text-muted">{children}</div>}
    </div>
  );
}

const tones = {
  green: 'bg-green-50 text-green-800 ring-green-200',
  amber: 'bg-amber-50 text-amber-900 ring-amber-200',
  red: 'bg-red-50 text-red-800 ring-red-200',
  blue: 'bg-sky-50 text-sky-800 ring-sky-200',
  grey: 'bg-slate-100 text-slate-700 ring-slate-200',
  teal: 'bg-teal-wash text-teal-ink ring-teal/30',
};
export type Tone = keyof typeof tones;

export function Badge({ tone = 'grey', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={cx('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ring-1 ring-inset', tones[tone])}>{children}</span>;
}

const statusTones: Record<string, Tone> = {
  draft: 'grey', pending: 'amber', in_progress: 'blue', sent: 'blue', submitted: 'amber',
  posted: 'green', received: 'green', approved: 'green', active: 'green',
  rejected: 'red', cancelled: 'grey', voided: 'red', retired: 'grey', inactive: 'grey',
};
const statusLabels: Record<string, string> = { in_progress: 'In progress', sent: 'In transit' };

export function StatusBadge({ status }: { status: string }) {
  const label = statusLabels[status] ?? (status.charAt(0).toUpperCase() + status.slice(1).replace(/_/g, ' '));
  return <Badge tone={statusTones[status] ?? 'grey'}>{label}</Badge>;
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------
export type Column<T> = {
  label: ReactNode;
  render: (row: T) => ReactNode;
  num?: boolean;
  className?: string;
};

export function DataTable<T>({ rows, columns, rowKey, onRowClick, empty, footer }: {
  rows: T[]; columns: Column<T>[]; rowKey: (row: T) => string; onRowClick?: (row: T) => void; empty?: ReactNode; footer?: ReactNode;
}) {
  if (rows.length === 0) return <Empty title={typeof empty === 'string' ? empty : 'Nothing here yet'}>{typeof empty === 'string' ? null : empty}</Empty>;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>{columns.map((c, i) => <th key={i} className={cx(c.num && 'num', c.className)}>{c.label}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={rowKey(r)} className={onRowClick ? 'clickable' : undefined} onClick={onRowClick ? () => onRowClick(r) : undefined}>
              {columns.map((c, i) => <td key={i} className={cx(c.num && 'num', c.className)}>{c.render(r)}</td>)}
            </tr>
          ))}
        </tbody>
        {footer && <tfoot>{footer}</tfoot>}
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Overlays
// ---------------------------------------------------------------------------
export function Modal({ open, title, onClose, children, footer, size = 'md' }: {
  open: boolean; title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; size?: 'md' | 'lg' | 'xl';
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  const w = { md: 'max-w-lg', lg: 'max-w-3xl', xl: 'max-w-5xl' }[size];
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-3 sm:p-8" role="dialog" aria-modal="true">
      <div className={cx('w-full rounded-lg bg-white shadow-xl', w)}>
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="text-base font-semibold">{title}</h2>
          <button type="button" onClick={onClose} className="rounded p-1 text-muted hover:bg-slate-100" aria-label="Close dialog">✕</button>
        </div>
        <div className="max-h-[75vh] overflow-y-auto p-4">{children}</div>
        {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-line px-4 py-3">{footer}</div>}
      </div>
    </div>
  );
}

// Asks for a short reason (void, reject, cancel) and runs the action.
export function ReasonModal({ open, title, label = 'Reason', confirmLabel, danger, required = true, onClose, onConfirm }: {
  open: boolean; title: string; label?: string; confirmLabel: string; danger?: boolean; required?: boolean;
  onClose: () => void; onConfirm: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (open) { setReason(''); setError(null); } }, [open]);
  const submit = async () => {
    if (required && !reason.trim()) { setError('Give a reason'); return; }
    setBusy(true);
    setError(null);
    try { await onConfirm(reason.trim()); onClose(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} title={title} onClose={onClose}
      footer={<><Button variant="secondary" onClick={onClose}>Back</Button><Button variant={danger ? 'danger' : 'primary'} busy={busy} onClick={submit}>{confirmLabel}</Button></>}>
      <ErrorNote error={error} />
      <Field label={label}>
        <textarea className="input" rows={3} value={reason} onChange={e => setReason(e.target.value)} autoFocus />
      </Field>
    </Modal>
  );
}

export function Tabs({ tabs, value, onChange }: { tabs: { key: string; label: ReactNode }[]; value: string; onChange: (k: string) => void }) {
  return (
    <div className="mb-4 flex gap-1 overflow-x-auto border-b border-line" role="tablist">
      {tabs.map(t => (
        <button key={t.key} type="button" role="tab" aria-selected={value === t.key} onClick={() => onChange(t.key)}
          className={cx('-mb-px border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap', value === t.key ? 'border-teal text-teal-ink' : 'border-transparent text-muted hover:text-ink')}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function Stat({ label, value, hint, tone, to }: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'warn' | 'bad' | 'ok'; to?: string }) {
  const color = tone === 'bad' ? 'text-red-700' : tone === 'warn' ? 'text-amber-700' : tone === 'ok' ? 'text-green-700' : 'text-ink';
  const body = (
    <div className="h-full rounded-lg border border-line bg-white p-4 transition-colors hover:border-slate-300">
      <div className="text-xs font-medium text-muted">{label}</div>
      <div className={cx('mt-1 text-2xl font-semibold tabular-nums', color)}>{value}</div>
      {hint && <div className="mt-1 text-xs text-muted">{hint}</div>}
    </div>
  );
  return to ? <Link to={to} className="block">{body}</Link> : body;
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------
type Toast = { id: number; text: string; tone: 'ok' | 'bad' };
const ToastContext = createContext<(text: string, tone?: 'ok' | 'bad') => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, tone: 'ok' | 'bad' = 'ok') => {
    const id = Date.now() + Math.random();
    setToasts(t => [...t, { id, text, tone }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 4000);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed right-4 bottom-4 z-[60] flex flex-col gap-2" aria-live="polite">
        {toasts.map(t => (
          <div key={t.id} className={cx('rounded-md px-3 py-2 text-sm shadow-lg', t.tone === 'ok' ? 'bg-navy text-white' : 'bg-red-700 text-white')}>{t.text}</div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
