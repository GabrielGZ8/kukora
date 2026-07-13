import { createContext, useContext, useReducer, useEffect, useRef, useCallback } from 'react';
import { api } from '../api';

/**
 * AppStateContext — minimal shared state, deliberately not Redux/Zustand.
 *
 * Today, BTC price, engine status, and session metrics are each fetched
 * independently by every page that needs them — SummaryPage polls /health,
 * ArbitragePage polls the engine status, AboutPage polls /health again,
 * etc. That's N redundant requests for the same three pieces of data.
 *
 * This context centralizes exactly those three things behind a single
 * poll loop. It is intentionally NOT a general-purpose store: pages that
 * have page-specific data (analytics, backtests, forecasts...) keep using
 * their own hooks/usePolling — only the genuinely cross-cutting,
 * everybody-needs-this data lives here.
 */

const POLL_INTERVAL_MS = 15000;

const initialState = {
  btcPrice: null,
  btcChange24h: null,
  engineStatus: null,   // raw `engine` block from /health
  dbStatus: null,       // raw `db` block from /health
  sessionMetrics: null, // raw GET /api/metrics snapshot
  lastUpdated: null,
  loading: true,
  error: null,
};

function reducer(state, action) {
  switch (action.type) {
    case 'FETCH_START':
      return { ...state, loading: state.lastUpdated === null };
    case 'FETCH_SUCCESS':
      return {
        ...state,
        ...action.payload,
        lastUpdated: Date.now(),
        loading: false,
        error: null,
      };
    case 'FETCH_ERROR':
      return { ...state, loading: false, error: action.error };
    default:
      return state;
  }
}

const AppStateContext = createContext(null);

export function AppStateProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const mountedRef = useRef(true);

  const refresh = useCallback(async () => {
    dispatch({ type: 'FETCH_START' });
    try {
      const [health, metricsSnap, markets] = await Promise.allSettled([
        api.system.health(),
        api.system.metrics(),
        api.markets(1),
      ]);

      if (!mountedRef.current) return;

      const payload = {};
      if (health.status === 'fulfilled') {
        payload.engineStatus = health.value.engine || null;
        payload.dbStatus = health.value.db || null;
      }
      if (metricsSnap.status === 'fulfilled') {
        payload.sessionMetrics = metricsSnap.value;
      }
      if (markets.status === 'fulfilled') {
        const coin = markets.value?.coins?.[0];
        if (coin) {
          payload.btcPrice = coin.current_price;
          payload.btcChange24h = coin.price_change_percentage_24h;
        }
      }
      dispatch({ type: 'FETCH_SUCCESS', payload });
    } catch (e) {
      if (mountedRef.current) dispatch({ type: 'FETCH_ERROR', error: e.message || 'Failed to refresh' });
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    refresh();
    const id = setInterval(refresh, POLL_INTERVAL_MS);
    return () => {
      mountedRef.current = false;
      clearInterval(id);
    };
  }, [refresh]);

  return (
    <AppStateContext.Provider value={{ ...state, refresh }}>
      {children}
    </AppStateContext.Provider>
  );
}

export function useAppState() {
  const ctx = useContext(AppStateContext);
  if (!ctx) throw new Error('useAppState must be used within an AppStateProvider');
  return ctx;
}
