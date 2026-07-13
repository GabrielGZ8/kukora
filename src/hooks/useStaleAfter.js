import { useState, useEffect, useRef } from 'react';

/**
 * createStaleTracker — pure, DOM-free timing core behind useStaleAfter.
 * Kept separate from the React hook so the actual regression (does the
 * "stale" flag flip at the right time, does it reset on reconnect, does it
 * stop firing after teardown) can be unit-tested in the plain `node` test
 * environment without needing jsdom/react-dom.
 *
 * @param {number} delayMs
 * @param {(stale: boolean) => void} onChange
 * @returns {{ setConnected(connected: boolean): void, teardown(): void }}
 */
export function createStaleTracker(delayMs, onChange) {
  let timer = null;
  function setConnected(connected) {
    clearTimeout(timer);
    if (!connected) {
      timer = setTimeout(() => onChange(true), delayMs);
    } else {
      onChange(false);
    }
  }
  function teardown() {
    clearTimeout(timer);
  }
  return { setConnected, teardown };
}

/**
 * useStaleAfter — returns true once `connected` has been false continuously
 * for at least `delayMs`, and resets to false immediately when `connected`
 * becomes true again.
 *
 * Extracted from ArbitragePage during the 2026-07 audit: the SSE dot alone
 * gave near-invisible feedback on disconnects, and since useArbitrageStream
 * merges data by delta, the UI kept showing frozen numbers with no warning.
 * This hook drives the "datos congelados / reconectando" banner.
 */
export function useStaleAfter(connected, delayMs = 3000) {
  const [stale, setStale] = useState(false);
  const trackerRef = useRef(null);
  if (!trackerRef.current) {
    trackerRef.current = createStaleTracker(delayMs, setStale);
  }

  useEffect(() => {
    trackerRef.current.setConnected(connected);
    return () => trackerRef.current.teardown();
  }, [connected, delayMs]);

  return stale;
}
