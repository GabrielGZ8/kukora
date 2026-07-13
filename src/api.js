const base = '/api/crypto';

// ─── Auth token injection ──────────────────────────────────────────────────
// Access token is stored in AuthContext (in-memory). We read it via a
// simple global getter to avoid circular imports with the context.
let _getToken = null;
export function _setTokenGetter(fn) { _getToken = fn; }
export function getAccessToken() { return _getToken ? _getToken() : null; }


// ─── Core fetch — timeout, retry-with-backoff on 5xx, normalized errors ───
const DEFAULT_TIMEOUT_MS = 15000;
const MAX_RETRIES = 2;          // total attempts = MAX_RETRIES + 1
const RETRY_BASE_DELAY_MS = 300; // exponential: 300ms, 600ms

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

class ApiError extends Error {
  constructor(message, { status = null, code = null, retried = 0 } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.retried = retried;
  }
}

// fetchWithTimeout wraps the browser fetch with an AbortController so a
// hung request doesn't leave a page spinning forever.
async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// requestJson centralizes: timeout, retry-with-exponential-backoff on 5xx
// (5xx is assumed transient — a deploy rolling, a DB hiccup; 4xx is not
// retried since retrying a bad request just repeats the same failure),
// and error normalization so every caller gets the same ApiError shape
// regardless of whether the failure was network-level, HTTP-level, or an
// `{ ok: false }` application-level error.
async function requestJson(url, options = {}) {
  // Inject Authorization header if a token getter is registered
  if (_getToken) {
    const token = _getToken();
    if (token) {
      options = {
        ...options,
        headers: { Authorization: 'Bearer ' + token, ...(options.headers || {}) },
        credentials: 'include',
      };
    }
  }
  let attempt = 0;
  let lastErr = null;

  while (attempt <= MAX_RETRIES) {
    try {
      const r = await fetchWithTimeout(url, options);

      if (!r.ok) {
        let serverMsg = null;
        try { const j = await r.json(); serverMsg = j.error; } catch { /* body wasn't JSON — fall back to status text below */ }

        if (r.status >= 500 && attempt < MAX_RETRIES) {
          attempt += 1;
          await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
          continue;
        }

        const friendly =
          r.status === 429 ? 'Rate limit reached. Please wait a few seconds.' :
          r.status === 502 ? 'Upstream service unavailable. Retrying shortly.' :
          serverMsg || `Request failed (HTTP ${r.status})`;
        throw new ApiError(friendly, { status: r.status, retried: attempt });
      }

      const j = await r.json();
      if (j.ok === false) throw new ApiError(j.error || 'API returned an error', { status: r.status, retried: attempt });
      return j;
    } catch (e) {
      if (e instanceof ApiError) throw e;
      // AbortError (timeout) or a network failure (offline, DNS, CORS) —
      // these are also worth a retry, same backoff as 5xx.
      lastErr = e;
      if (attempt < MAX_RETRIES) {
        attempt += 1;
        await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
        continue;
      }
      const isTimeout = e.name === 'AbortError';
      throw new ApiError(
        isTimeout ? 'Request timed out.' : 'Network error — check your connection.',
        { code: isTimeout ? 'TIMEOUT' : 'NETWORK', retried: attempt }
      );
    }
  }
  // Unreachable in practice, but keeps the function's return type honest.
  throw new ApiError(lastErr?.message || 'Request failed');
}

const get = async (url) => {
  const j = await requestJson(url, { method: 'GET' });
  return j.data;
};

// ─── Arbitrage endpoint helper ────────────────────────────────────────────
// Convenience wrapper: GET /api/arbitrage/<path> with token injected.
// Returns the full response JSON (not just .data) so callers can check .ok,
// .history, .mode, etc. directly — arbitrage endpoints don't all wrap in .data.
export const requestArbitrage = async (path, options = {}) => {
  const url = `/api/arbitrage/${path}`;
  const opts = { method: 'GET', ...options };
  if (opts.body && typeof opts.body === 'object') {
    opts.body = JSON.stringify(opts.body);
    opts.headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  }
  return requestJson(url, opts);
};

// ─── Server persistence helpers — POST/DELETE/PATCH with JSON ─────────────
const post = async (url, body) => {
  const j = await requestJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return j.data;
};

const del = async (url) => {
  const j = await requestJson(url, { method: 'DELETE' });
  return j.data;
};

const patch = async (url, body) => {
  const j = await requestJson(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return j.data;
};

// ─── Crypto endpoints ──────────────────────────────────────────────────────
export const api = {
  get,
  post,
  del,
  patch,
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
  // Portfolio — server paginates (?limit=&offset=, default 50/max 200).
  // list() requests the max page size and unwraps `items` so existing
  // callers that expect a flat array keep working unchanged. listPage()
  // is exposed for callers that want real pagination controls.
  portfolio: {
    list:     ()               => get('/api/portfolio?limit=200&offset=0').then(d => d.items || []),
    listPage: (limit, offset)  => get(`/api/portfolio?limit=${limit || 50}&offset=${offset || 0}`),
    create:   (data)           => post('/api/portfolio', data),
    delete:   (id)             => del(`/api/portfolio/${id}`),
  },

  // ─── Trading mode + multi-pair config (GAP 1 / GAP 4 UI) ───────────────
  trading: {
    getMode:   ()       => get('/api/trading/mode'),
    setMode:   (mode)   => post('/api/trading/mode', { mode }),
    getPairs:  ()        => get('/api/trading/pairs'),
    setPairs:  (config)  => post('/api/trading/pairs', config),
    getAudit:  ()        => get('/api/trading/audit'),
    testConn:  (data)    => post('/api/trading/test-connection', data),
    // Refinamiento post-Sesión 34 — perfil de riesgo por usuario.
    getRiskProfile: ()        => get('/api/trading/risk-profile'),
    setRiskProfile: (updates) => post('/api/trading/risk-profile', updates),
    // 2FA enrollment/verification (server/routes/trading.routes.js) — no
    // frontend client existed for these until checkpoint-37 needed them to
    // gate the per-user live-mode toggle below.
    get2faStatus: ()        => get('/api/trading/2fa/status'),
    setup2fa:     ()        => post('/api/trading/2fa/setup', {}),
    confirm2fa:   (token)   => post('/api/trading/2fa/confirm', { token }),
  },

  // ─── Per-user exchange credentials (checkpoint-37) ─────────────────────
  // Lets a user connect/rotate/disconnect THEIR OWN exchange API keys,
  // instead of exchange credentials only being settable platform-wide via
  // env vars. See server/routes/userExchangeCredentials.routes.js.
  exchangeCredentials: {
    list:       ()                              => get('/api/user/exchange-credentials'),
    connect:    (data)                           => post('/api/user/exchange-credentials', data),
    disconnect: (exchange)                       => del(`/api/user/exchange-credentials/${encodeURIComponent(exchange)}`),
  },

  // ─── Per-user live-trading toggle (checkpoint-37) ───────────────────────
  // Separate from api.trading.setMode(), which is the GLOBAL paper/live
  // switch the platform operator controls (LIVE_TRADING_ENABLED). This is
  // the per-user gate on top of it — see
  // server/routes/userLiveMode.routes.js and userLiveModeService.js.
  liveMode: {
    status:  ()                              => get('/api/user/live-mode'),
    enable:  (twoFactorToken)                => post('/api/user/live-mode', { twoFactorToken, disclaimerAccepted: true }),
    disable: ()                              => post('/api/user/live-mode/disable', {}),
  },

  // ─── User profile ────────────────────────────────────────────────────────
  profile: {
    get:    ()           => get('/api/auth/me'),
    update: (data)       => patch('/api/auth/me', data),
    changePassword: (data) => post('/api/auth/change-password', data),
  },

  // ─── In-app notifications (bell icon) ──────────────────────────────────
  notifications: {
    list:      (limit = 10)  => get(`/api/notifications?limit=${limit}`),
    markRead:  (id)          => patch(`/api/notifications/${id}/read`, {}),
    markAllRead: ()          => post('/api/notifications/read-all', {}),
    // EventSource can't send Authorization headers, so auth happens via a
    // one-time, 30s-TTL stream ticket (POST /api/auth/stream-ticket with the
    // real access token in a header) instead of ever putting a live JWT in
    // a URL — see requireAuthForStream on the server side.
    streamUrl: (ticket)      => `/api/notifications/stream${ticket ? `?ticket=${encodeURIComponent(ticket)}` : ''}`,
  },

  // ─── System endpoints ───────────────────────────────────────────────────
  system: {
    health:    () => requestJson('/health').then(j => j),
    readiness: () => requestJson('/api/readiness').then(j => j),
    metrics:   () => get('/api/metrics'),
  },

  // ─── Arbitrage engine data ───────────────────────────────────────────────
  arb: {
    dailyStats:  (days = 7)  => get(`/api/arbitrage/daily-stats?days=${days}`),
    executive:   ()          => get('/api/arbitrage/executive'),
  },
};

export { ApiError };
