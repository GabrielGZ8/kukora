// usePolling — serial polling with recursive setTimeout.
// Prevents overlapping requests: the next fetch only starts AFTER
// the current one resolves (success or error).  Also pauses when
// the browser tab is hidden to avoid unnecessary rate-limit hits.

import { useState, useEffect, useRef, useCallback } from 'react';

export function usePolling(fetchFn, intervalMs = 30000, deps = []) {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [ts, setTs]           = useState(null);

  const active   = useRef(true);   // true while the component is mounted
  const timerRef = useRef(null);   // holds the next setTimeout handle

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const fetch_ = useCallback(async () => {
    if (!active.current) return;
    // Pause while the tab is hidden — avoids 429s from background tabs
    if (document.hidden) {
      scheduleNext();
      return;
    }
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
      scheduleNext();
    }
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps

  function scheduleNext() {
    if (!active.current) return;
    // Clear any existing timer before scheduling (defensive)
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(fetch_, intervalMs);
  }

  useEffect(() => {
    active.current = true;
    setLoading(true);
    // Fire immediately, subsequent calls are chained inside fetch_
    fetch_();

    return () => {
      active.current = false;
      clearTimeout(timerRef.current);
    };
  }, [fetch_]); // intervalMs changes are absorbed via the closure in scheduleNext

  return { data, loading, error, ts, refetch: fetch_ };
}
