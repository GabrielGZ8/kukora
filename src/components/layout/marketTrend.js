import { api } from '../../api';

// ─── Module-level market trend cache (avoids 429 on every remount) ────────
// Extracted from Layout.jsx (Round 7 — audit 4.3: split large components).
const _mktCache = { trend: 'neutral', ts: 0 };
const MKT_CACHE_TTL = 5 * 60 * 1000;

export async function fetchMarketTrend() {
  const now = Date.now();
  if (_mktCache.ts && now - _mktCache.ts < MKT_CACHE_TTL) return _mktCache.trend;
  try {
    const data = await api.markets(20);
    const coins = data?.coins || [];
    if (!coins.length) return _mktCache.trend;
    const avg = coins.reduce((a, c) => a + (c.price_change_percentage_24h || 0), 0) / coins.length;
    _mktCache.trend = avg > 1.5 ? 'bullish' : avg < -1.5 ? 'bearish' : 'neutral';
    _mktCache.ts = now;
  } catch { /* market-trend is cosmetic — silently keep last cached value on fetch errors */ }
  return _mktCache.trend;
}
