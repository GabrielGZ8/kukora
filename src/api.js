const base = '/api/crypto';

// ─── Core fetch — checks HTTP status THEN json.ok ─────────────────────────
const get = async (url) => {
  const r = await fetch(url);
  if (!r.ok) {
    // Try to parse the error body, fall back to HTTP status
    let msg = `HTTP ${r.status}`;
    try { const j = await r.json(); msg = j.error || msg; } catch {}
    if (r.status === 429) throw new Error('Rate limit de CoinGecko alcanzado. Espera unos segundos.');
    if (r.status === 502) throw new Error('CoinGecko no disponible. Reintentando pronto.');
    throw new Error(msg);
  }
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || 'API error');
  return j.data;
};

// ─── Server persistence helpers — POST/DELETE with JSON ───────────────────
const post = async (url, body) => {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || 'Server error');
  return j.data;
};

const del = async (url) => {
  const r = await fetch(url, { method: 'DELETE' });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || 'Server error');
  return j.data;
};

const patch = async (url, body) => {
  const r = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || 'Server error');
  return j.data;
};

// ─── Crypto endpoints ──────────────────────────────────────────────────────
export const api = {
  get,
  markets:    (limit = 50)           => get(`${base}/markets?limit=${limit}`),
  global:     ()                     => get(`${base}/global`),
  trending:   ()                     => get(`${base}/trending`),
  coin:       (id)                   => get(`${base}/coin/${id}`),
  history:    (id, days)             => get(`${base}/coin/${id}/history?days=${days}`),
  ohlc:       (id, days)             => get(`${base}/coin/${id}/ohlc?days=${days}`),
  technical:  (id, days)             => get(`${base}/coin/${id}/technical?days=${days}`),
  analytics:  (id, days, w)          => get(`${base}/coin/${id}/analytics?days=${days}${w ? `&window=${w}` : ''}`),
  anomaly:    (id, days)             => get(`${base}/coin/${id}/anomaly?days=${days}`),
  anomalies:  (coins, days)          => get(`${base}/anomalies?coins=${coins}&days=${days}`),
  scores:     (coins, days)          => get(`${base}/scores?coins=${coins}&days=${days}`),
  overview:   ()                     => get(`${base}/overview`),
  risk:       (id, days)             => get(`${base}/coin/${id}/risk?days=${days}`),
  correlation:(coins, days)          => get(`${base}/correlation?coins=${coins}&days=${days}`),
  forecast:   (id, days, horizon)    => get(`${base}/coin/${id}/forecast?days=${days}&horizon=${horizon}`),
  montecarlo: (id, days, horizon, simulations, target) => {
    const p = new URLSearchParams({ days: days||60, horizon: horizon||30, simulations: simulations||300 });
    if (target != null) p.set('target', target);
    return get(`${base}/coin/${id}/montecarlo?${p}`);
  },
  backtest:   (id, days, strategy)   => get(`${base}/coin/${id}/backtest?days=${days}&strategy=${strategy}`),
  backtestAll:(id, days)             => get(`${base}/coin/${id}/backtest?days=${days}&all=true`),
  regime:     (coins, days)          => get(`${base}/regime?coins=${coins}&days=${days}`),
  kcs:        (coins, days)          => get(`${base}/kcs?coins=${coins}&days=${days}`),
  coinRegime: (id, days)             => get(`${base}/coin/${id}/regime?days=${days}`),

  // ─── Persistence (MongoDB with localStorage fallback) ──────────────────
  // Alerts
  alerts: {
    list:    ()     => get('/api/alerts'),
    create:  (data) => post('/api/alerts', data),
    delete:  (id)   => del(`/api/alerts/${id}`),
    update:  (id, data) => patch(`/api/alerts/${id}`, data),
  },
  // Watchlist
  watchlist: {
    get:  ()      => get('/api/watchlist'),
    save: (coins) => post('/api/watchlist', { coins }),
  },
  // Portfolio
  portfolio: {
    list:   ()     => get('/api/portfolio'),
    create: (data) => post('/api/portfolio', data),
    delete: (id)   => del(`/api/portfolio/${id}`),
  },
};
