// usePolling — solo hace fetch cuando la página está activa (visible)
// Evita que todas las páginas golpeen CoinGecko al mismo tiempo
import { useState, useEffect, useRef, useCallback } from 'react';

export function usePolling(fetchFn, intervalMs = 30000, deps = []) {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [ts, setTs]           = useState(null);
  const timer  = useRef(null);
  const active = useRef(true); // si el componente está montado

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const fetch_ = useCallback(async () => {
    if (!active.current) return;
    // Pausa si el tab está oculto — evita 429 en background
    if (document.hidden) return;
    try {
      const result = await fetchFn();
      if (!active.current) return;
      setData(result);
      setError(null);
      setTs(new Date());
    } catch (e) {
      if (!active.current) return;
      setError(e.message);
    } finally {
      if (active.current) setLoading(false);
    }
  }, deps);

  useEffect(() => {
    active.current = true;
    setLoading(true);
    fetch_();
    timer.current = setInterval(fetch_, intervalMs);
    return () => {
      active.current = false;
      clearInterval(timer.current);
    };
  }, [fetch_, intervalMs]);

  return { data, loading, error, ts, refetch: fetch_ };
}
