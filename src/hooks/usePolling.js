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

  const active        = useRef(true);  // true while the component is mounted
  const timerRef      = useRef(null);  // holds the next setTimeout handle
  const retryCountRef = useRef(0);     // consecutive rate-limit errors for backoff

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
      retryCountRef.current = 0; // reset backoff on success
    } catch (e) {
      if (!active.current) return;
      setError(e.message);
      // Rate-limit backoff: on 429 / rate-limit errors, double the wait
      // (capped at 5 minutes) so a rate-limited endpoint doesn't keep
      // hammering the API every intervalMs, producing 10-54s slow requests.
      const isRateLimit = e?.status === 429 || e?.message?.toLowerCase().includes('rate');
      if (isRateLimit) {
        retryCountRef.current = Math.min(retryCountRef.current + 1, 5);
      }
    } finally {
      if (active.current) setLoading(false);
      scheduleNext();
    }
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps

  function scheduleNext() {
    if (!active.current) return;
    // Exponential backoff when rate-limited: 2^n × intervalMs, capped at 5 min.
    const backoff = retryCountRef.current > 0
      ? Math.min(intervalMs * 2 ** retryCountRef.current, 5 * 60_000)
      : intervalMs;
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(fetch_, backoff);
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
