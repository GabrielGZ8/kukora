/**
 * LiveTradeTicker.jsx — Kukora
 *
 * Improvement #11: "Live trade ticker". Barra horizontal estilo NYSE en el
 * footer: cada trade ejecutado se añade y desaparece tras unos seconds.
 * Provides live trade visualization of executed arbitrage operations.
 */
import { useState, useEffect, useRef } from 'react';

const EX_COLORS = { Binance: '#F0B90B', Kraken: '#5741D9', Bybit: '#F7A600', Coinbase: '#0052FF', OKX: '#aaa' };
const TICKER_LIFETIME_MS = 9000;
const MAX_TICKER_ITEMS = 8;

// TICKER_HEIGHT is exported so the page can add matching paddingBottom
// when the ticker is visible, preventing it from obscuring content.
export const TICKER_HEIGHT = 42;

export default function LiveTradeTicker({ trade }) {
  const [items, setItems] = useState([]);
  const lastTradeIdRef = useRef(null);

  useEffect(() => {
    if (!trade || !trade.id || trade.id === lastTradeIdRef.current) return;
    lastTradeIdRef.current = trade.id;

    const item = { ...trade, _tickerKey: `${trade.id}-${Date.now()}`, _addedAt: Date.now() };
    setItems(prev => [item, ...prev].slice(0, MAX_TICKER_ITEMS));

    const timeout = setTimeout(() => {
      setItems(prev => prev.filter(i => i._tickerKey !== item._tickerKey));
    }, TICKER_LIFETIME_MS);
    return () => clearTimeout(timeout);
  }, [trade]);

  if (!items.length) return null;

  return (
    <div className="live-ticker-fixed" style={{
      background: 'var(--bg-surface)',
      borderTop: '1px solid rgba(255,45,120,0.3)',
      padding: '8px 16px',
      display: 'flex',
      gap: 18,
      alignItems: 'center',
      height: TICKER_HEIGHT,
      overflowX: 'auto',
      whiteSpace: 'nowrap',
      boxShadow: '0 -4px 20px rgba(0,0,0,0.18)',
    }}>
      <span style={{ fontSize: 10, fontWeight: 900, color: '#FF2D78', letterSpacing: '0.1em', flexShrink: 0 }}>● LIVE</span>
      {items.map(item => {
        const isProfit = (item.netProfit || 0) >= 0;
        // Format safely — trade data may arrive with string or number fields
        const amount    = typeof item.amount === 'number'    ? item.amount.toFixed(4)              : (item.amount ?? '—');
        const buyPrice  = typeof item.buyPrice === 'number'  ? item.buyPrice.toLocaleString()       : (item.buyPrice ?? '—');
        const sellPrice = typeof item.sellPrice === 'number' ? item.sellPrice.toLocaleString()      : (item.sellPrice ?? '—');
        const net       = typeof item.netProfit === 'number' ? item.netProfit.toFixed(2)            : (item.netProfit ?? '—');
        return (
          <span key={item._tickerKey} style={{
            display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12,
            fontFamily: 'var(--font-mono, monospace)', color: 'var(--text-muted)', flexShrink: 0,
            animation: 'tickerFadeIn 0.4s ease-out',
          }}>
            {/* BUY leg */}
            <span style={{ color: '#00b87a', fontWeight: 800 }}>BUY</span>
            <span>{amount} BTC @ ${buyPrice}</span>
            <span style={{ color: EX_COLORS[item.buyExchange] || '#999' }}>({item.buyExchange})</span>
            <span style={{ color: 'var(--text-dim)' }}>←→</span>
            {/* SELL leg */}
            <span style={{ color: '#f03e3e', fontWeight: 800 }}>SELL</span>
            <span>@ ${sellPrice}</span>
            <span style={{ color: EX_COLORS[item.sellExchange] || '#999' }}>({item.sellExchange})</span>
            {/* Net result */}
            <span style={{ color: isProfit ? '#00b87a' : '#f03e3e', fontWeight: 900 }}>
              · NET {isProfit ? '+' : ''}${net} {isProfit ? '✓' : '✕'}
            </span>
            <span style={{ color: 'var(--border)' }}>|</span>
          </span>
        );
      })}
      <style>{`
        @keyframes tickerFadeIn {
          from { opacity: 0; transform: translateX(-8px); }
          to   { opacity: 1; transform: translateX(0); }
        }
      `}</style>
    </div>
  );
}
