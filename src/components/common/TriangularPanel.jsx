
import { useTranslation } from '../../i18n/I18nContext';

export default function TriangularPanel({ data }) {
  const { t } = useTranslation();
  const signals = data?.triangularSignals || [];
  const best    = data?.triangularSignal  || null;
  const fmtPct  = n => n != null ? `${n >= 0 ? '+' : ''}${Number(n).toFixed(4)}%` : '—';
  const fmtUSD  = n => n != null ? `${n >= 0 ? '+' : '-'}$${Math.abs(n).toFixed(4)}` : '—';
  const statusColor = s => s?.netPct > 0 ? 'var(--color-green)' : 'var(--color-red)';

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
      <div className="card" style={{ padding:'14px 20px' }}>
        <div style={{ display:'flex', alignItems:'baseline', gap:12, flexWrap:'wrap' }}>
          <div>
            <div style={{ fontSize:9, fontWeight:700, color:'var(--text-dim)', textTransform:'uppercase', letterSpacing:'0.07em' }}>△ {t('triangular.title')}</div>
            <div style={{ fontSize:11, color:'var(--text-dim)', marginTop:3 }}>
              {t('triangular.description')}{' '}
              {t('triangular.enginePrefix')} {(data?.orderBooks||[]).filter(o=>o.bid).length} {t('triangular.engineSuffix')}.
            </div>
          </div>
          <div style={{ marginLeft:'auto', display:'flex', gap:16, fontSize:11 }}>
            <span><b style={{ fontFamily:'var(--font-mono)' }}>{signals.length}</b> <span style={{ color:'var(--text-dim)' }}>rutas detectadas</span></span>
            <span><b style={{ fontFamily:'var(--font-mono)', color:'var(--color-green)' }}>{signals.filter(s => s.netPct > 0).length}</b> <span style={{ color:'var(--text-dim)' }}>con profit bruta</span></span>
          </div>
        </div>
      </div>

      {best && (
        <div className="card" style={{ padding:'14px 20px', background:'rgba(87,65,217,0.06)', border:'1px solid rgba(87,65,217,0.2)' }}>
          <div style={{ fontSize:9, fontWeight:700, color:'#5741D9', textTransform:'uppercase', letterSpacing:'0.07em', marginBottom:8 }}>⭐ Best route this session</div>
          <div style={{ display:'flex', alignItems:'center', gap:12, flexWrap:'wrap' }}>
            <div style={{ fontSize:13, fontWeight:800, fontFamily:'var(--font-mono)' }}>{best.path}</div>
            <div style={{ fontSize:18, fontWeight:900, fontFamily:'var(--font-mono)', color: best.netPct > 0 ? 'var(--color-green)' : 'var(--color-red)' }}>
              {fmtPct(best.netPct)}
            </div>
            <div style={{ fontSize:11, color:'var(--text-dim)' }}>Neto: <b style={{ color: best.netProfit > 0 ? 'var(--color-green)' : 'var(--color-red)', fontFamily:'var(--font-mono)' }}>{fmtUSD(best.netProfit)}</b></div>
            {best.executed && <span style={{ padding:'2px 8px', background:'rgba(0,184,122,0.15)', color:'var(--color-green)', borderRadius:5, fontSize:9, fontWeight:800 }}>EJECUTADA</span>}
          </div>
          {best.legs && (
            <div style={{ marginTop:10, display:'flex', gap:8, flexWrap:'wrap' }}>
              {best.legs.map((leg, i) => (
                <div key={i} style={{ padding:'6px 10px', background:'var(--bg-surface)', borderRadius:7, border:'1px solid var(--border)', fontSize:10 }}>
                  <span style={{ fontWeight:700 }}>Leg {i+1}:</span> {leg.action} {leg.pair} @ <span style={{ fontFamily:'var(--font-mono)' }}>${leg.price?.toFixed(2)}</span>
                  {' '}en <b>{leg.exchange}</b>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {signals.length === 0 ? (
        <div className="card" style={{ padding:'28px 20px', textAlign:'center' }}>
          <div style={{ fontSize:28, marginBottom:10 }}>△</div>
          <div style={{ fontWeight:700, marginBottom:6 }}>Sin rutas triangulares detectadas</div>
          <div style={{ fontSize:11, color:'var(--text-dim)', maxWidth:380, margin:'0 auto' }}>
            Triangular routes require simultaneous spreads across 3 exchanges.
          </div>
        </div>
      ) : (
        <div className="card" style={{ padding:'0' }}>
          <div style={{ padding:'12px 16px', borderBottom:'1px solid var(--border)', fontSize:9, fontWeight:700, color:'var(--text-dim)', textTransform:'uppercase', letterSpacing:'0.07em' }}>
            {t('triangular.allRoutes')} ({signals.length})
          </div>
          <div style={{ overflowX:'auto' }}>
            <table style={{ width:'100%', borderCollapse:'collapse', fontSize:10 }}>
              <thead>
                <tr style={{ borderBottom:'1px solid var(--border)', background:'var(--bg-surface)' }}>
                  {[t('triangular.route'), t('triangular.netSpread'), t('triangular.netProfit'), t('triangular.totalFees'), t('triangular.score'), t('triangular.status')].map(h => (
                    <th key={h} style={{ padding:'6px 12px', textAlign:'left', fontWeight:700, color:'var(--text-dim)', fontSize:8, textTransform:'uppercase', letterSpacing:'0.05em', whiteSpace:'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {signals.map((s, i) => (
                  <tr key={i} style={{ borderBottom: i < signals.length-1 ? '1px solid var(--border)' : 'none', background: s.netPct > 0 ? 'rgba(0,184,122,0.03)' : 'transparent' }}>
                    <td style={{ padding:'8px 12px', fontFamily:'var(--font-mono)', fontWeight:700, whiteSpace:'nowrap' }}>{s.path}</td>
                    <td style={{ padding:'8px 12px', fontFamily:'var(--font-mono)', color: statusColor(s), fontWeight:700 }}>{fmtPct(s.netPct)}</td>
                    <td style={{ padding:'8px 12px', fontFamily:'var(--font-mono)', color: statusColor(s), fontWeight:700, whiteSpace:'nowrap' }}>{fmtUSD(s.netProfit)}</td>
                    <td style={{ padding:'8px 12px', fontFamily:'var(--font-mono)', color:'var(--text-dim)', whiteSpace:'nowrap' }}>
                      {s.totalFees != null ? `$${s.totalFees.toFixed(4)}` : '—'}
                    </td>
                    <td style={{ padding:'8px 12px', fontFamily:'var(--font-mono)' }}>
                      {s.score != null ? (
                        <span style={{ padding:'1px 6px', borderRadius:4, background: s.score >= 65 ? 'rgba(0,184,122,0.12)' : 'rgba(245,158,11,0.1)', color: s.score >= 65 ? 'var(--color-green)' : '#F59E0B', fontWeight:800 }}>
                          {s.score}
                        </span>
                      ) : '—'}
                    </td>
                    <td style={{ padding:'8px 12px' }}>
                      {s.executed ? (
                        <span style={{ fontSize:9, fontWeight:800, color:'var(--color-green)' }}>✓ EJECUTADA</span>
                      ) : s.netPct > 0 ? (
                        <span style={{ fontSize:9, color:'var(--color-yellow)' }}>Viable</span>
                      ) : (
                        <span style={{ fontSize:9, color:'var(--text-dim)' }}>No viable</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="card" style={{ padding:'14px 20px' }}>
        <div style={{ fontSize:9, fontWeight:700, color:'var(--text-dim)', textTransform:'uppercase', letterSpacing:'0.07em', marginBottom:8 }}>How triangular arbitrage works</div>
        <div style={{ display:'grid', gridTemplateColumns:'repeat(3, 1fr)', gap:12, fontSize:10 }}>
          {[
            { icon:'1️⃣', title:'O(n³) Detection', body:'The engine evaluates all possible 3-exchange combinations. With 5 exchanges, that is 60 routes evaluated per tick in under 30ms.' },
            { icon:'2️⃣', title:'VWAP en cada leg', body:'Cada leg usa VWAP walk sobre el order book L2 real. No mid-price — el price real de execution considerando la profundidad del libro.' },
            { icon:'3️⃣', title:'Fees reales x3', body:'Cada ruta paga fees en los 3 legs. El model descuenta fees reales de maker/taker por exchange antes de reportar profit neta.' },
          ].map(({ icon, title, body }) => (
            <div key={title} style={{ padding:'10px', background:'var(--bg-surface)', borderRadius:8, border:'1px solid var(--border)' }}>
              <div style={{ fontSize:16, marginBottom:6 }}>{icon}</div>
              <div style={{ fontWeight:800, marginBottom:4 }}>{title}</div>
              <div style={{ color:'var(--text-dim)', lineHeight:1.5 }}>{body}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
