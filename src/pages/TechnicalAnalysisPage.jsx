import { useState, useEffect, useRef } from 'react';
import { createChart, ColorType, CrosshairMode } from 'lightweight-charts';
import { usePolling } from '../hooks/usePolling';
import { api } from '../api';

const COINS = [
  { id: 'bitcoin',     label: 'BTC', color: '#F7931A' },
  { id: 'ethereum',    label: 'ETH', color: '#627EEA' },
  { id: 'solana',      label: 'SOL', color: '#9945FF' },
  { id: 'binancecoin', label: 'BNB', color: '#F0B90B' },
  { id: 'ripple',      label: 'XRP', color: '#346AA9' },
];
const PERIODS = [{ label: '7d', days: 7 }, { label: '30d', days: 30 }, { label: '90d', days: 90 }];

const fmtN = (v, dec = 2) => v == null ? '—' : Number(v).toFixed(dec);

function RSIBar({ value }) {
  const color = value > 70 ? 'var(--color-red)' : value < 30 ? 'var(--color-green)' : 'var(--color-blue)';
  const label = value > 70 ? 'Sobrecomprado' : value < 30 ? 'Sobrevendido' : 'Neutral';
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color }}>{fmtN(value)}</span>
        <span style={{ fontSize: 11, color }}>{label}</span>
      </div>
      <div style={{ background: 'var(--bg-surface-3)', borderRadius: 99, height: 6, overflow: 'hidden' }}>
        <div style={{ width: `${value}%`, background: color, height: '100%', borderRadius: 99, transition: 'width 0.4s ease' }} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text-dim)', marginTop: 2 }}>
        <span>0</span><span>30</span><span>50</span><span>70</span><span>100</span>
      </div>
    </div>
  );
}

function SignalBadge({ signal }) {
  const colors = {
    bullish: { bg: 'var(--color-green-dim)', color: 'var(--color-green)', border: 'rgba(0,184,122,0.25)' },
    bearish: { bg: 'var(--color-red-dim)',   color: 'var(--color-red)',   border: 'rgba(240,62,62,0.25)' },
    neutral: { bg: 'var(--color-yellow-dim)',color: 'var(--color-yellow)',border: 'rgba(245,158,11,0.25)' },
  };
  const c = colors[signal.type] || colors.neutral;
  return (
    <div style={{ padding: '10px 12px', borderRadius: 'var(--radius)', background: c.bg, border: `1px solid ${c.border}`, marginBottom: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, color: c.color }}>{signal.label}</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{signal.desc}</div>
        </div>
        <span style={{ fontSize: 10, color: 'var(--text-dim)', whiteSpace: 'nowrap', marginLeft: 8 }}>
          {new Date(signal.ts).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })}
        </span>
      </div>
    </div>
  );
}

export default function TechnicalAnalysisPage() {
  const [coin, setCoin]     = useState(COINS[0]);
  const [period, setPeriod] = useState(PERIODS[1]);
  const chartContainerRef   = useRef(null);
  const chartRef            = useRef(null);
  const candleSeriesRef     = useRef(null);
  const sma20Ref            = useRef(null);
  const ema20Ref            = useRef(null);
  const bbUpperRef          = useRef(null);
  const bbLowerRef          = useRef(null);

  const { data: technical, loading } = usePolling(
    () => api.technical(coin.id, period.days),
    120000,
    [coin.id, period.days]
  );
  const { data: ohlcRaw } = usePolling(
    () => api.ohlc(coin.id, period.days),
    120000,
    [coin.id, period.days]
  );

  // Init chart once
  useEffect(() => {
    if (!chartContainerRef.current) return;
    const chart = createChart(chartContainerRef.current, {
      layout: { background: { type: ColorType.Solid, color: '#ffffff' }, textColor: '#6b7280' },
      grid: { vertLines: { color: 'rgba(0,0,0,0.04)' }, horzLines: { color: 'rgba(0,0,0,0.04)' } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: 'rgba(0,0,0,0.07)' },
      timeScale: { borderColor: 'rgba(0,0,0,0.07)', timeVisible: true },
      width:  chartContainerRef.current.clientWidth,
      height: 380,
    });

    const candleSeries = chart.addCandlestickSeries({
      upColor: '#00b87a', downColor: '#f03e3e',
      borderUpColor: '#00b87a', borderDownColor: '#f03e3e',
      wickUpColor: '#00b87a', wickDownColor: '#f03e3e',
    });
    const sma20Series = chart.addLineSeries({ color: '#FF8C42', lineWidth: 2, title: 'SMA20' });
    const ema20Series = chart.addLineSeries({ color: '#3b82f6', lineWidth: 2, lineStyle: 1, title: 'EMA20' });
    const bbUpperSeries = chart.addLineSeries({ color: 'rgba(139,92,246,0.5)', lineWidth: 1, title: 'BB+' });
    const bbLowerSeries = chart.addLineSeries({ color: 'rgba(139,92,246,0.5)', lineWidth: 1, title: 'BB-' });

    chartRef.current       = chart;
    candleSeriesRef.current = candleSeries;
    sma20Ref.current        = sma20Series;
    ema20Ref.current        = ema20Series;
    bbUpperRef.current      = bbUpperSeries;
    bbLowerRef.current      = bbLowerSeries;

    const ro = new ResizeObserver(() => {
      chart.applyOptions({ width: chartContainerRef.current?.clientWidth || 600 });
    });
    ro.observe(chartContainerRef.current);

    return () => { chart.remove(); ro.disconnect(); };
  }, []);

  // Update chart data
  useEffect(() => {
    if (!ohlcRaw || !candleSeriesRef.current) return;
    const candles = ohlcRaw
      .map(([ts, o, h, l, c]) => ({ time: Math.floor(ts / 1000), open: o, high: h, low: l, close: c }))
      .sort((a, b) => a.time - b.time);
    candleSeriesRef.current.setData(candles);
  }, [ohlcRaw]);

  useEffect(() => {
    if (!technical || !sma20Ref.current) return;
    const { prices: _prices, timestamps, indicators } = technical;

    const toPoints = (arr) => arr
      .map((v, i) => v !== null ? { time: Math.floor(timestamps[i] / 1000), value: v } : null)
      .filter(Boolean)
      .sort((a, b) => a.time - b.time);

    sma20Ref.current.setData(toPoints(indicators.sma20));
    ema20Ref.current.setData(toPoints(indicators.ema20));
    bbUpperRef.current.setData(toPoints(indicators.bollinger.upper));
    bbLowerRef.current.setData(toPoints(indicators.bollinger.lower));
  }, [technical]);

  const ind = technical?.indicators;
  const stats = technical?.stats;
  const signals = technical?.signals || [];
  const prices = technical?.prices || [];
  const lastPrice = prices[prices.length - 1];
  const lastSMA20 = ind?.sma20.filter(v => v !== null).pop();
  const lastRSI   = ind?.rsi.filter(v => v !== null).pop();
  const lastMACD  = ind?.macd?.macd.filter(v => v !== null).pop();
  const lastSignal= ind?.macd?.signal.filter(v => v !== null).pop();
  const bbW = ind ? (() => {
    const u = ind.bollinger.upper.filter(v => v !== null).pop();
    const l = ind.bollinger.lower.filter(v => v !== null).pop();
    const m = ind.bollinger.middle.filter(v => v !== null).pop();
    return m ? (((u - l) / m) * 100).toFixed(2) : null;
  })() : null;
  const smaVsPrice = lastSMA20 && lastPrice ? (((lastPrice - lastSMA20) / lastSMA20) * 100).toFixed(2) : null;

  return (
    <div>
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ fontSize: 20, fontWeight: 800, marginBottom: 4 }}>◈ Analysis Técnico</h2>
        <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>Indicatores cuantitativos in real time · lightweight-charts</p>
      </div>

      {/* Selectors */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
        {COINS.map(c => (
          <button key={c.id} onClick={() => setCoin(c)}
            className={`btn ${coin.id === c.id ? 'btn-primary' : 'btn-secondary'}`}
            style={coin.id === c.id ? {} : { borderLeft: `3px solid ${c.color}` }}>
            {c.label}
          </button>
        ))}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          {PERIODS.map(p => (
            <button key={p.label} onClick={() => setPeriod(p)}
              className={`btn btn-sm ${period.days === p.days ? 'btn-primary' : 'btn-secondary'}`}>
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '60% 40%', gap: 20, alignItems: 'start' }}>

        {/* COLUMNA IZQUIERDA — chart */}
        <div>
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <div style={{ padding: '16px 20px 12px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <span style={{ fontSize: 15, fontWeight: 800 }}>{coin.label}/USD</span>
                <span style={{ fontSize: 12, color: 'var(--text-muted)', marginLeft: 8 }}>{period.label} · Candlestick</span>
              </div>
              <div style={{ display: 'flex', gap: 12, fontSize: 11 }}>
                <span><span style={{ color: '#FF8C42', fontWeight: 700 }}>—</span> SMA20</span>
                <span><span style={{ color: '#3b82f6', fontWeight: 700 }}>- -</span> EMA20</span>
                <span><span style={{ color: '#8b5cf6', fontWeight: 700 }}>—</span> BB</span>
              </div>
            </div>
            {loading && (
              <div style={{ height: 380, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <div className="spinner" />
              </div>
            )}
            <div ref={chartContainerRef} style={{ width: '100%', display: loading ? 'none' : 'block' }} />
          </div>
        </div>

        {/* COLUMNA DERECHA — indicatores */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

          {/* Indicatores */}
          <div className="card">
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', marginBottom: 14, letterSpacing: '0.06em', textTransform: 'uppercase' }}>Indicatores</div>

            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>RSI 14</div>
              {lastRSI != null ? <RSIBar value={lastRSI} /> : <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>Loading…</span>}
            </div>

            {[
              { label: 'MACD', value: lastMACD != null ? `${lastMACD >= 0 ? '+' : ''}${lastMACD.toFixed(4)}` : '—', color: lastMACD > 0 ? 'var(--color-green)' : 'var(--color-red)', sub: `Signal: ${lastSignal != null ? lastSignal.toFixed(4) : '—'}` },
              { label: 'BB Width', value: bbW ? `${bbW}%` : '—', color: 'var(--color-purple)', sub: 'volatility implícita' },
              { label: 'SMA20 vs Price', value: smaVsPrice != null ? `${smaVsPrice >= 0 ? '+' : ''}${smaVsPrice}%` : '—', color: smaVsPrice > 0 ? 'var(--color-green)' : 'var(--color-red)', sub: 'price relativo a media' },
            ].map(r => (
              <div key={r.label} style={{ display: 'flex', justifyContent: 'space-between', padding: '9px 0', borderTop: '1px solid var(--border)' }}>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 500 }}>{r.label}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>{r.sub}</div>
                </div>
                <div style={{ fontWeight: 700, fontSize: 13, color: r.color }}>{r.value}</div>
              </div>
            ))}
          </div>

          {/* Signales */}
          <div className="card">
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', marginBottom: 12, letterSpacing: '0.06em', textTransform: 'uppercase' }}>Señales Detectadas</div>
            {signals.length === 0
              ? <div style={{ fontSize: 12, color: 'var(--text-dim)', padding: '12px 0' }}>Sin signales activas en este period</div>
              : signals.map((s, i) => <SignalBadge key={i} signal={s} />)
            }
          </div>

          {/* Stats del period */}
          <div className="card">
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', marginBottom: 12, letterSpacing: '0.06em', textTransform: 'uppercase' }}>Statistics del Period</div>
            {[
              { label: 'Return', value: stats?.ret != null ? `${stats.ret >= 0 ? '+' : ''}${stats.ret}%` : '—', color: stats?.ret >= 0 ? 'var(--color-green)' : 'var(--color-red)' },
              { label: 'Volatility', value: stats?.vol != null ? `${stats.vol}%` : '—', color: 'var(--color-yellow)' },
              { label: 'Max Drawdown', value: stats?.drawdown != null ? `${stats.drawdown}%` : '—', color: 'var(--color-red)' },
              { label: 'Sharpe Ratio', value: stats?.sharpe ?? '—', color: stats?.sharpe > 1 ? 'var(--color-green)' : 'var(--color-yellow)' },
            ].map(r => (
              <div key={r.label} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{r.label}</span>
                <span style={{ fontSize: 13, fontWeight: 700, color: r.color }}>{r.value}</span>
              </div>
            ))}
          </div>

        </div>
      </div>
    </div>
  );
}
