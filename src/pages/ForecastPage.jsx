import { useState, useEffect, useRef } from 'react';
import { createChart, ColorType, LineStyle } from 'lightweight-charts';
import { usePolling } from '../hooks/usePolling';
import { api } from '../api';
import { ErrorState, EmptyState } from '../components/common/StateViews';

const COINS = [
  { id: 'bitcoin',     label: 'BTC', color: '#F7931A' },
  { id: 'ethereum',    label: 'ETH', color: '#627EEA' },
  { id: 'solana',      label: 'SOL', color: '#9945FF' },
  { id: 'binancecoin', label: 'BNB', color: '#F0B90B' },
  { id: 'ripple',      label: 'XRP', color: '#346AA9' },
];
const PERIODS  = [{ label: '7d', days: 7 }, { label: '30d', days: 30 }, { label: '90d', days: 90 }];
const HORIZONS = [{ label: '3d', h: 3 }, { label: '7d', h: 7 }, { label: '14d', h: 14 }];

const fmt = v => v == null ? '—' : v >= 1 ? `$${Number(v).toLocaleString('en', { maximumFractionDigits: 2 })}` : `$${Number(v).toFixed(5)}`;

export default function ForecastPage() {
  const [coin, setCoin]     = useState(COINS[0]);
  const [period, setPeriod] = useState(PERIODS[1]);
  const [horizon, setHorizon] = useState(HORIZONS[1]);
  const chartRef = useRef(null);
  const containerRef = useRef(null);

  const { data, loading } = usePolling(
    () => api.get(`/api/crypto/coin/${coin.id}/forecast?days=${period.days}&horizon=${horizon.h}`),
    180_000, [coin.id, period.days, horizon.h]
  );

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      layout: { background: { type: ColorType.Solid, color: '#ffffff' }, textColor: '#6b7280' },
      grid: { vertLines: { color: 'rgba(0,0,0,0.04)' }, horzLines: { color: 'rgba(0,0,0,0.04)' } },
      rightPriceScale: { borderColor: 'rgba(0,0,0,0.07)' },
      timeScale: { borderColor: 'rgba(0,0,0,0.07)', timeVisible: true },
      width:  containerRef.current.clientWidth,
      height: 360,
    });

    chartRef.current = chart;
    const ro = new ResizeObserver(() => {
      chart.applyOptions({ width: containerRef.current?.clientWidth || 700 });
    });
    ro.observe(containerRef.current);
    return () => { chart.remove(); ro.disconnect(); };
  }, []);

  useEffect(() => {
    if (!data || !chartRef.current) return;
    const chart = chartRef.current;
    // clear old series by removing and recreating — simplest approach
    chart.timeScale().resetTimeScale?.();

    const { prices, timestamps, forecast, lastTs } = data;
    if (!prices?.length) return;

    // Historical line
    const histSeries = chart.addLineSeries({ color: coin.color, lineWidth: 2, title: coin.label });
    histSeries.setData(
      prices.map((p, i) => ({ time: Math.floor(timestamps[i] / 1000), value: p }))
            .sort((a, b) => a.time - b.time)
    );

    if (forecast?.forecast) {
      const DAY_S = 86400;
      const baseTs = Math.floor(lastTs / 1000);

      // Forecast center line
      const fcastSeries = chart.addLineSeries({ color: '#FF2D78', lineWidth: 2, lineStyle: LineStyle.Dashed, title: 'Forecast' });
      fcastSeries.setData(forecast.forecast.map(f => ({ time: baseTs + f.h * DAY_S, value: f.point })));

      // Upper CI band
      const upperSeries = chart.addLineSeries({ color: 'rgba(255,45,120,0.25)', lineWidth: 1, lineStyle: LineStyle.Dotted, title: 'CI Upper' });
      upperSeries.setData(forecast.forecast.map(f => ({ time: baseTs + f.h * DAY_S, value: f.upper })));

      // Lower CI band
      const lowerSeries = chart.addLineSeries({ color: 'rgba(255,45,120,0.25)', lineWidth: 1, lineStyle: LineStyle.Dotted, title: 'CI Lower' });
      lowerSeries.setData(forecast.forecast.map(f => ({ time: baseTs + f.h * DAY_S, value: f.lower })));
    }

    chart.timeScale().fitContent();
  }, [data, coin]);

  const fc = data?.forecast?.forecast || [];
  const bt = data?.backtest;
  const lastPrice = data?.lastPrice;
  const targetH   = fc[fc.length - 1];
  const fcastReturn = lastPrice && targetH ? ((targetH.point - lastPrice) / lastPrice * 100) : null;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
        <div>
          <h2 style={{ fontSize: 20, fontWeight: 800, marginBottom: 4 }}>◌ Forecast</h2>
          <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>Proyección estadística de precio · Ensemble (SMA Drift + Holt EWM) · Intervalos de confianza 90%</p>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {PERIODS.map(p => (
            <button key={p.label} className={`btn btn-sm ${period.days === p.days ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setPeriod(p)}>{p.label}</button>
          ))}
          <div style={{ width: 1, background: 'var(--border)', margin: '0 4px' }} />
          {HORIZONS.map(h => (
            <button key={h.label} className={`btn btn-sm ${horizon.h === h.h ? 'btn-secondary' : 'btn-ghost'}`} onClick={() => setHorizon(h)} style={horizon.h === h.h ? { borderColor: 'var(--color-primary)', color: 'var(--color-primary)' } : {}}>
              +{h.label}
            </button>
          ))}
        </div>
      </div>

      {/* Coin selector */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
        {COINS.map(c => (
          <button key={c.id} onClick={() => setCoin(c)}
            className={`btn ${coin.id === c.id ? 'btn-primary' : 'btn-secondary'}`}
            style={coin.id === c.id ? {} : { borderLeft: `3px solid ${c.color}` }}>
            {c.label}
          </button>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 300px', gap: 20, alignItems: 'start' }}>
        {/* Chart */}
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: '14px 20px 12px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <span style={{ fontSize: 14, fontWeight: 800 }}>{coin.label}/USD</span>
              <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 8 }}>Historial {period.label} + forecast {horizon.label}</span>
            </div>
            <div style={{ display: 'flex', gap: 16, fontSize: 11 }}>
              <span><span style={{ color: coin.color, fontWeight: 700 }}>—</span> Histórico</span>
              <span><span style={{ color: '#FF2D78', fontWeight: 700 }}>- -</span> Forecast</span>
              <span><span style={{ color: 'rgba(255,45,120,0.4)', fontWeight: 700 }}>···</span> CI 90%</span>
            </div>
          </div>
          {loading && <div style={{ height: 360, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><div className="spinner" /></div>}
          <div ref={containerRef} style={{ width: '100%', display: loading ? 'none' : 'block' }} />
        </div>

        {/* Right panel */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* Forecast summary */}
          <div className="card">
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 14 }}>Proyección {horizon.label}</div>
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Precio actual</div>
              <div style={{ fontSize: 18, fontWeight: 900 }}>{fmt(lastPrice)}</div>
            </div>
            {targetH && (
              <>
                <div style={{ marginBottom: 8 }}>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Target (d+{horizon.h})</div>
                  <div style={{ fontSize: 18, fontWeight: 900, color: fcastReturn >= 0 ? 'var(--color-green)' : 'var(--color-red)' }}>{fmt(targetH.point)}</div>
                  <div style={{ fontSize: 12, color: fcastReturn >= 0 ? 'var(--color-green)' : 'var(--color-red)', fontWeight: 700 }}>
                    {fcastReturn >= 0 ? '+' : ''}{fcastReturn?.toFixed(2)}%
                  </div>
                </div>
                <div style={{ padding: '10px 12px', background: 'var(--bg-surface-2)', borderRadius: 'var(--radius)', fontSize: 11, marginTop: 8 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                    <span style={{ color: 'var(--text-muted)' }}>CI Superior</span>
                    <span style={{ fontWeight: 700, color: 'var(--color-green)' }}>{fmt(targetH.upper)}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: 'var(--text-muted)' }}>CI Inferior</span>
                    <span style={{ fontWeight: 700, color: 'var(--color-red)' }}>{fmt(targetH.lower)}</span>
                  </div>
                </div>
              </>
            )}
          </div>

          {/* Day-by-day table */}
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', fontSize: 12, fontWeight: 700 }}>Proyección día a día</div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
              <thead>
                <tr style={{ background: 'var(--bg-surface-2)' }}>
                  {['Día', 'Target', '±Range'].map(h => (
                    <th key={h} style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {fc.map(f => (
                  <tr key={f.h} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={{ padding: '8px 12px', fontWeight: 700, color: 'var(--text-muted)' }}>+{f.h}d</td>
                    <td style={{ padding: '8px 12px', fontWeight: 700, color: lastPrice && f.point >= lastPrice ? 'var(--color-green)' : 'var(--color-red)' }}>{fmt(f.point)}</td>
                    <td style={{ padding: '8px 12px', color: 'var(--text-dim)' }}>±{fmt((f.upper - f.lower) / 2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Backtest accuracy */}
          {bt && (
            <div className="card">
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12 }}>Backtest (modelo)</div>
              {[
                { label: 'MAPE',      value: `${bt.mape?.toFixed(2)}%`, note: 'error promedio', good: bt.mape < 5 },
                { label: 'Hit Rate',  value: `${bt.hitRate?.toFixed(1)}%`, note: 'dentro del CI', good: bt.hitRate > 70 },
                { label: 'Horizonte', value: `${bt.horizon}d`, note: 'testado', good: true },
                { label: 'Modelo',    value: bt.model, note: '', good: true },
              ].map(r => (
                <div key={r.label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '7px 0', borderBottom: '1px solid var(--border)', fontSize: 12 }}>
                  <div>
                    <div style={{ fontWeight: 600 }}>{r.label}</div>
                    {r.note && <div style={{ fontSize: 10, color: 'var(--text-dim)' }}>{r.note}</div>}
                  </div>
                  <span style={{ fontWeight: 700, color: r.good ? 'var(--color-green)' : 'var(--color-yellow)' }}>{r.value}</span>
                </div>
              ))}
              <div style={{ marginTop: 10, fontSize: 10, color: 'var(--text-dim)', lineHeight: 1.5 }}>
                ⚠ Proyección estadística. No es asesoría financiera.
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
