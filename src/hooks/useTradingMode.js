import { useState, useEffect, useCallback } from 'react';
import { api } from '../api';

/**
 * useTradingMode — fetches and manages paper/live mode + active pairs
 * for the current user.
 */
export function useTradingMode() {
  const [mode, setModeState]           = useState('paper');
  const [liveEnabled, setLiveEnabled]  = useState(false);
  const [loading, setLoading]          = useState(true);
  const [pairs, setPairsState]         = useState(['BTC/USDT']);
  const [userConfig, setUserConfig]    = useState(null);
  const [supported, setSupported]      = useState([]);

  const fetchAll = useCallback(async () => {
    try {
      const [modeRes, pairsRes] = await Promise.allSettled([
        api.trading.getMode(),
        api.trading.getPairs(),
      ]);
      if (modeRes.status === 'fulfilled') {
        setModeState(modeRes.value.mode || 'paper');
        setLiveEnabled(!!modeRes.value.liveEnabled);
      }
      if (pairsRes.status === 'fulfilled') {
        setPairsState(pairsRes.value.userConfig?.pairs || ['BTC/USDT']);
        setUserConfig(pairsRes.value.userConfig || null);
        setSupported(pairsRes.value.supported || []);
      }
    } catch { /* trading mode UI is non-critical — fail silently */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const setMode = useCallback(async (newMode) => {
    const result = await api.trading.setMode(newMode);
    setModeState(result.mode);
    return result;
  }, []);

  const setPairs = useCallback(async (config) => {
    const updated = await api.trading.setPairs(config);
    setPairsState(updated.pairs || []);
    setUserConfig(updated);
    return updated;
  }, []);

  return { mode, liveEnabled, loading, setMode, pairs, setPairs, userConfig, supported, refresh: fetchAll };
}
