// useTenantBot — client for the per-tenant paper-trading primitives
// (ADR-017): each user's own bot on/off state, their own config overrides
// layered on top of the shared engine config, their own isolated wallet/
// P&L/history, and their own risk-guard circuit breaker. Fully independent
// from the shared/demo bot that useArbitrageStream + ArbitragePage's main
// toggle control — see server/routes/tenantBot.routes.js for the HTTP
// surface this hook talks to.
import { useState, useEffect, useCallback, useRef } from 'react';
import { getAccessToken } from '../api';

// Deliberately NOT using api.js's generic get()/post() or requestArbitrage()
// here. Both go through requestJson(), which throws an ApiError and
// DISCARDS the response body whenever the JSON payload has `ok:false` —
// even on HTTP 200 — and ApiError only carries a message string, not the
// original body. That's fine for callers who only care "did it work?",
// but this panel needs `data.rejected` (which key was rejected and why)
// and `data.reason` (why a risk-guard reset was a no-op) to show the user
// something more useful than a generic "Request failed" toast. This tiny
// wrapper parses the body regardless of status and lets callers decide.
async function tenantBotRequest(path, options = {}) {
  const token = getAccessToken ? getAccessToken() : null;
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;

  let res;
  try {
    res = await fetch(`/api/tenant-bot/${path}`, { ...options, headers, credentials: 'include' });
  } catch {
    throw new Error('Error de red — revisa tu conexión.');
  }

  if (res.status === 429) {
    throw new Error('Límite de solicitudes alcanzado (10/min). Espera unos segundos e intenta de nuevo.');
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error('Sesión no válida — vuelve a iniciar sesión.');
  }

  let body = null;
  try { body = await res.json(); } catch { /* no/invalid JSON body */ }

  if (res.status >= 500) {
    throw new Error(body?.error || `Error del servidor (HTTP ${res.status})`);
  }
  if (!body) {
    throw new Error(`Respuesta vacía del servidor (HTTP ${res.status})`);
  }
  // 200 (success) and 400 (application-level ok:false — e.g. a rejected
  // config key, or a risk/reset no-op on an inactive breaker) both resolve
  // here. Callers inspect body.ok / body.data themselves.
  return body;
}

const POLL_MS = 5000;

export function useTenantBot() {
  // { botStatus, wallets, pnl, history, configOverrides, risk }
  const [status, setStatus] = useState(null);
  // liveConfig's schema (shared reference: min/max/step/options per key)
  const [schema, setSchema] = useState(null);
  // The CURRENT global config value per key — this is what tenantConfig.
  // getEffective() falls back to for any key a tenant hasn't overridden
  // (liveConfig.get(key), i.e. the live admin-set value, NOT the frozen
  // module defaults) — using this as the fallback base keeps "effective
  // value" in this panel consistent with what the engine actually uses.
  const [globalConfig, setGlobalConfig] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const mountedRef = useRef(true);

  const fetchStatus = useCallback(async () => {
    try {
      const body = await tenantBotRequest('status', { method: 'GET' });
      if (!mountedRef.current) return;
      if (body.ok) { setStatus(body.data); setError(null); }
    } catch (e) {
      if (mountedRef.current) setError(e.message);
    }
  }, []);

  // Schema + current global values come from the exact same validated
  // parameter set the shared engine uses (GET /api/arbitrage/config) —
  // tenantConfig overrides are validated against those same rules
  // (tenantConfig.js reuses liveConfig.validateOne), so this is the
  // correct source of truth for min/max/step/options, not a duplicate copy.
  const fetchSchema = useCallback(async () => {
    try {
      const res = await fetch('/api/arbitrage/config');
      const j = await res.json();
      if (!mountedRef.current) return;
      if (j.ok !== false) {
        setSchema(j.schema || null);
        setGlobalConfig(j.data || null);
      }
    } catch { /* reference-only — panel still works from configOverrides alone if this fails */ }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    setLoading(true);
    Promise.all([fetchStatus(), fetchSchema()]).finally(() => {
      if (mountedRef.current) setLoading(false);
    });
    const id = setInterval(fetchStatus, POLL_MS);
    return () => { mountedRef.current = false; clearInterval(id); };
  }, [fetchStatus, fetchSchema]);

  const toggleBot = useCallback(async (enabled) => {
    const body = await tenantBotRequest('toggle', { method: 'POST', body: JSON.stringify({ enabled }) });
    if (body.ok) setStatus(prev => (prev ? { ...prev, botStatus: body.data } : prev));
    await fetchStatus();
    return body;
  }, [fetchStatus]);

  // patch: { key: value, ... } — only the keys the caller actually wants
  // to change. Applied in a single request (this route shares a 10/min
  // per-uid budget across toggle/config/risk-reset — see server/index.js
  // financialControlLimiter), so batch, don't call this per-field.
  const saveConfig = useCallback(async (patch) => {
    const body = await tenantBotRequest('config', { method: 'POST', body: JSON.stringify({ patch }) });
    await fetchStatus();
    return body.data; // { ok, applied, rejected }
  }, [fetchStatus]);

  const clearOverride = useCallback(async (key) => {
    const body = await tenantBotRequest(`config/${encodeURIComponent(key)}`, { method: 'DELETE' });
    await fetchStatus();
    return body;
  }, [fetchStatus]);

  const resetAllOverrides = useCallback(async () => {
    const body = await tenantBotRequest('config/reset', { method: 'POST' });
    await fetchStatus();
    return body;
  }, [fetchStatus]);

  const resetRisk = useCallback(async () => {
    const body = await tenantBotRequest('risk/reset', { method: 'POST' });
    await fetchStatus();
    return body;
  }, [fetchStatus]);

  return {
    status, schema, globalConfig, loading, error,
    toggleBot, saveConfig, clearOverride, resetAllOverrides, resetRisk,
    refresh: fetchStatus,
  };
}
