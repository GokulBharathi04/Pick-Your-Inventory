import { useCallback, useEffect, useRef, useState } from 'react';
import { errorText } from './supabase';

export type Loaded<T> = {
  data: T | undefined;
  error: string | null;
  loading: boolean;
  reload: () => void;
};

// Runs an async loader whenever its inputs change, and on reload().
export function useLoad<T>(load: () => Promise<T>, deps: unknown[]): Loaded<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const loader = useRef(load);
  loader.current = load;

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    loader.current()
      .then(d => { if (alive) setData(d); })
      .catch(e => { if (alive) setError(errorText(e)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  const reload = useCallback(() => setTick(t => t + 1), []);
  return { data, error, loading, reload };
}

// Wraps a form action: tracks busy state and turns errors into text.
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = useCallback(async (fn: () => Promise<void>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, setError, act };
}

// Remembers a small value in the browser (outlet picked, report filters).
export function useStored<T>(key: string, initial: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = window.localStorage.getItem(key);
      return raw === null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  });
  const set = useCallback((v: T) => {
    setValue(v);
    try { window.localStorage.setItem(key, JSON.stringify(v)); } catch { /* storage may be unavailable */ }
  }, [key]);
  return [value, set];
}
