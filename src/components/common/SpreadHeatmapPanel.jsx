/**
 * SpreadHeatmapPanel.jsx — Kukora
 *
 * Improvement #3: "Spread heatmap live". Grilla NxN (5 exchanges = 25 celdas)
 * donde cada celda muestra el spread actual entre ese par exacto (comprar en
 * la row, vender en la column), coloreado de gris a verde según magnitud.
 * Se reconstruye en cada tick a partir de `opportunities`, que ya contiene
 * TODOS los pares calculados por detectOpportunities() — no se inventa nada,
 * solo se visualiza lo que el engine ya produce en cada ciclo.
 */
import { useMemo, useState } from 'react';

const FALLBACK_EXCHANGES = ['Binance', 'Kraken', 'Bybit', 'OKX', 'Coinbase'];
const EX_COLORS = { Binance: '#F0B90B', Kraken: '#5741D9', Bybit: '#F7A600', Coinbase: '#0052FF', OKX: '#aaa' };

function cellColor(spreadPct, breakEvenPct, viable) {
  if (spreadPct == null) return 'var(--bg-surface-2)';
  if (viable) return 'rgba(0,184,122,0.55)'; // strong green — actually executable
  if (spreadPct <= 0) return 'var(--bg-surface-2)'; // negative/zero spread — neutral
  // Scale intensity by how close the spread is to break-even (0 to 1 ratio, capped)
  const ratio = breakEvenPct > 0 ? Math.min(1, spreadPct / breakEvenPct) : Math.min(1, spreadPct / 0.05);
  const alpha = 0.08 + ratio * 0.35;
  return `rgba(0,184,122,${alpha.toFixed(2)})`;
}

export default function SpreadHeatmapPanel({ data }) {
  const opportunities = useMemo(() => data?.opportunities || [], [data?.opportunities]);
  const [hoverCell, setHoverCell] = useState(null);

  const grid = useMemo(() => {
    const map = {};
    for (const op of opportunities) {
      map[`${op.buyExchange}|${op.sellExchange}`] = op;
    }
    return map;
  }, [opportunities]);

  // Derive exchange list directly from live opportunity data — no hardcoded assumptions.
  // A new exchange added server-side shows up automatically in the heatmap.
  const allSeenExchanges = useMemo(() => {
    if (!opportunities?.length) return null;
    const seen = new Set();
    opportunities.forEach(o => {
      if (o.buyExchange) seen.add(o.buyExchange);
      if (o.sellExchange) seen.add(o.sellExchange);
    });
    return seen.size > 0 ? [...seen].sort() : null;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opportunities]);
  const exchanges = allSeenExchanges || FALLBACK_EXCHANGES;

  const hovered = hoverCell ? grid[hoverCell] : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '12px 18px',
        background: 'linear-gradient(135deg, rgba(255,45,120,0.06), rgba(88,65,217,0.06))',
        border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', flexWrap: 'wrap', gap: 10,
      }}>
        <div>
          <div style={{ fontWeight: 900, fontSize: 16, letterSpacing: '-0.02em' }}>▦ Spread Heatmap — Edge por Par</div>
          <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 4, lineHeight:1.5 }}>
            Row = exchange de compra · Column = exchange de venta · Color = magnitud del spread sobre break-even.<br/>
            <b>Verde brillante</b> = spread ejecutable ahour · <b>Verde tenue</b> = spread positivo pero bajo el threshold · <b>Gris</b> = spread negativo o cero. Identifica qué pares tienen mayor edge persistente a lo largo del tiempo.
          </div>
        </div>
      </div>

      <div className="card" style={{ padding: '16px 20px', overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'separate', borderSpacing: 4, margin: '0 auto' }}>
          <thead>
            <tr>
              <th style={{ width: 90 }} />
              {exchanges.map(ex => (
                <th key={ex} style={{ padding: '4px 6px', fontSize: 10, fontWeight: 800, color: EX_COLORS[ex] }}>
                  {ex.slice(0, 4)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {exchanges.map(buyEx => (
              <tr key={buyEx}>
                <th style={{ textAlign: 'right', paddingRight: 8, fontSize: 10, fontWeight: 800, color: EX_COLORS[buyEx], whiteSpace: 'nowrap' }}>
                  {buyEx}
                </th>
                {exchanges.map(sellEx => {
                  if (buyEx === sellEx) {
                    return <td key={sellEx} style={{ width: 64, height: 44, background: 'var(--bg-surface-3)', borderRadius: 6 }} />;
                  }
                  const key = `${buyEx}|${sellEx}`;
                  const op = grid[key];
                  const bg = cellColor(op?.spreadPct, op?.breakEvenPct, op?.viable);
                  return (
                    <td
                      key={sellEx}
                      onMouseEnter={() => setHoverCell(key)}
                      onMouseLeave={() => setHoverCell(null)}
                      style={{
                        width: 64, height: 44, background: bg, borderRadius: 6, textAlign: 'center',
                        cursor: op ? 'pointer' : 'default',
                        border: op?.viable ? '1px solid rgba(0,184,122,0.6)' : '1px solid transparent',
                        transition: 'background 0.25s',
                      }}
                    >
                      {op ? (
                        <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', height: '100%' }}>
                          <span style={{ fontSize: 11, fontWeight: 800, fontFamily: 'var(--font-mono)', color: op.viable ? '#003d28' : 'var(--text)' }}>
                            {op.spreadPct?.toFixed(3)}%
                          </span>
                          {op.viable && <span style={{ fontSize: 8, fontWeight: 900, color: '#003d28' }}>VIABLE</span>}
                        </div>
                      ) : (
                        <span style={{ fontSize: 10, color: 'var(--text-dim)' }}>—</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>

        {/* Legend */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 16, fontSize: 10, color: 'var(--text-dim)' }}>
          <span>Spread:</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ width: 14, height: 14, borderRadius: 3, background: 'var(--bg-surface-2)' }} />
            <span>negativo/nulo</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ width: 14, height: 14, borderRadius: 3, background: 'rgba(0,184,122,0.20)' }} />
            <span>positivo, bajo break-even</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ width: 14, height: 14, borderRadius: 3, background: 'rgba(0,184,122,0.55)', border: '1px solid rgba(0,184,122,0.6)' }} />
            <span>viable (ejecutable)</span>
          </div>
        </div>
      </div>

      {/* Hovered cell detail */}
      {hovered && (
        <div className="card" style={{ padding: '12px 16px', display: 'flex', gap: 20, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ fontWeight: 800, fontSize: 13 }}>{hovered.buyExchange} → {hovered.sellExchange}</div>
          <div style={{ fontSize: 12 }}>Spread: <b style={{ fontFamily: 'var(--font-mono)' }}>{hovered.spreadPct?.toFixed(4)}%</b></div>
          <div style={{ fontSize: 12 }}>Break-even: <b style={{ fontFamily: 'var(--font-mono)', color: 'var(--color-yellow)' }}>{hovered.breakEvenPct}%</b></div>
          <div style={{ fontSize: 12 }}>Neto: <b style={{ fontFamily: 'var(--font-mono)', color: (hovered.netProfit || 0) >= 0 ? 'var(--color-green)' : 'var(--color-red)' }}>
            {(hovered.netProfit || 0) >= 0 ? '+' : ''}${hovered.netProfit?.toFixed(4)}
          </b></div>
          {!hovered.viable && hovered.rejectionReason && (
            <div style={{ fontSize: 11, color: 'var(--text-dim)', fontStyle: 'italic' }}>{hovered.rejectionReason}</div>
          )}
        </div>
      )}
    </div>
  );
}
