import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';

/** Fetches a GET endpoint, optionally refreshing every `refreshMs`. */
export function useApi<T>(path: string | null, refreshMs?: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const alive = useRef(true);

  const load = useCallback(async () => {
    if (!path) return;
    setLoading(true);
    try {
      const d = await api<T>(path);
      if (alive.current) {
        setData(d);
        setError(null);
      }
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    alive.current = true;
    void load();
    const t = refreshMs ? setInterval(() => void load(), refreshMs) : undefined;
    return () => {
      alive.current = false;
      if (t) clearInterval(t);
    };
  }, [load, refreshMs]);

  return { data, error, loading, reload: load };
}
