import { useState } from 'react';
import OpportunityScoreBreakdown from './OpportunityScoreBreakdown';
import { EX_COLORS, scoreColor, fmt, fmtP, fmtPct, translateRejection, SlippageBadge, ExDot } from './ArbitrageSharedComponents';

export default function OpportunityHero({ op, minScore, rank }) {
  const isViable = op.viable && op.score >= minScore;
  const isSynthetic = op.synthetic;
  const [showBreakdown, setShowBreakdown] = useState(false);

  const borderColor = isViable
    ? (isSynthetic ? 'rgba(255,200,0,0.5)' : 'rgba(0,184,122,0.50)')
    : op.circuitBreaker ? 'rgba(245,158,11,0.30)' : 'var(--border)';
  const bgGradient = isViable
    ? (isSynthetic
        ? 'linear-gradient(135deg, rgba(255,200,0,0.06), rgba(255,140,0,0.03))'
        : 'linear-gradient(135deg, rgba(0,184,122,0.07), rgba(0,184,122,0.02))')
    : 'var(--bg-surface-2)';

  return (
    <div style={{
      padding: '14px 16px', background: bgGradient,
      border: `1px solid ${borderColor}`, borderRadius: 12,
      opacity: op.viable && op.score < minScore ? 0.5 : 1, position: 'relative',
    }}>
      {rank <= 3 && isViable && (
        <div style={{ position:'absolute', top:-6, left:12, background: rank===1?'#FF2D78':rank===2?'#5741D9':'#F59E0B', color:'#fff', fontSize:9, fontWeight:900, padding:'2px 8px', borderRadius:99 }}>
          #{rank} VIABLE
        </div>
      )}
      <div style={{ display:'flex', alignItems:'center', gap:10, flexWrap:'wrap', marginTop: rank<=3&&isViable ? 6 : 0 }}>
        {isViable ? (
          <span style={{ background: isSynthetic?'rgba(255,200,0,0.15)':'rgba(0,184,122,0.12)', color: isSynthetic?'#F59E0B':'var(--color-green)', fontWeight:800, fontSize:11, padding:'3px 10px', borderRadius:99, border:`1px solid ${isSynthetic?'rgba(255,200,0,0.3)':'rgba(0,184,122,0.3)'}`, whiteSpace:'nowrap', letterSpacing:'0.02em' }}>
            {isSynthetic ? '🎬 DEMO' : '⚡ VIABLE'}
          </span>
        ) : op.circuitBreaker ? (
          <span style={{ background:'rgba(245,158,11,0.10)', color:'#F59E0B', fontWeight:800, fontSize:11, padding:'3px 10px', borderRadius:99 }}>⛔ CIRCUIT BREAKER</span>
        ) : (
          <span style={{ background:'var(--color-red-dim)', color:'var(--color-red)', fontWeight:700, fontSize:11, padding:'3px 10px', borderRadius:99, maxWidth:200, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }} title={op.rejectionReason}>
            ✗ {translateRejection(op.rejectionReason) || 'REJECTED'}
          </span>
        )}
        {op.viable && (
          <span
            onClick={(e) => { if (op.scoreBreakdown) { e.stopPropagation(); setShowBreakdown(s => !s); } }}
            title={op.scoreBreakdown ? 'Click para ver el breakdown del score' : undefined}
            style={{ background:`${scoreColor(op.score)}18`, color:scoreColor(op.score), fontWeight:900, fontSize:12, padding:'3px 10px', borderRadius:6, fontFamily:'var(--font-mono)', border:`1px solid ${scoreColor(op.score)}33`, cursor: op.scoreBreakdown ? 'pointer' : 'default' }}>
            {op.score}/100{op.scoreBreakdown ? (showBreakdown ? ' ▲' : ' ▼') : ''}
          </span>
        )}
        <SlippageBadge method={op.slippageMethod} />
        <span style={{ fontSize:13, fontWeight:700, flex:1 }}>
          <span style={{ color:EX_COLORS[op.buyExchange]||'#aaa' }}>BUY</span>
          <span style={{ fontFamily:'var(--font-mono)', fontWeight:800 }}> ${fmt(op.buyPrice)} </span>
          <span style={{ color:'var(--text-dim)' }}>→</span>
          <span style={{ color:EX_COLORS[op.sellExchange]||'#aaa' }}> SELL</span>
          <span style={{ fontFamily:'var(--font-mono)', fontWeight:800 }}> ${fmt(op.sellPrice)}</span>
        </span>
        <div style={{ marginLeft:'auto', textAlign:'right' }}>
          <div style={{ fontFamily:'var(--font-mono)', fontWeight:900, fontSize:16, color: op.netProfit>0?'var(--color-green)':'var(--color-red)', lineHeight:1 }}>
            {op.netProfit>0?'+':''}{fmtP(op.netProfit,4)}
          </div>
          <div style={{ fontSize:10, color:'var(--text-dim)', fontFamily:'var(--font-mono)' }}>{fmtPct(op.netProfitPct)}</div>
          {op.profitLow!=null && op.viable && (
            <div style={{ fontSize:8, color:'var(--text-dim)', fontFamily:'var(--font-mono)' }}>95% CI [{fmtP(op.profitLow,2)}, {fmtP(op.profitHigh,2)}]</div>
          )}
        </div>
      </div>
      <div style={{ display:'flex', gap:10, marginTop:8, flexWrap:'wrap', alignItems:'center', fontSize:11 }}>
        <ExDot name={op.buyExchange} />
        <span style={{ color:'var(--text-dim)' }}>→</span>
        <ExDot name={op.sellExchange} />
        <span style={{ color:'var(--border)', margin:'0 2px' }}>|</span>
        <span style={{ color:'var(--text-dim)' }}>Gross: <span style={{ fontFamily:'var(--font-mono)', color:'var(--text-muted)' }}>${fmt(op.grossProfit,4)}</span></span>
        <span style={{ color:'var(--text-dim)' }}>Fees: <span style={{ fontFamily:'var(--font-mono)', color:'var(--color-red)' }}>-${fmt((op.buyFee||0)+(op.sellFee||0),4)}</span></span>
        <span style={{ color:'var(--text-dim)' }}>Slip: <span style={{ fontFamily:'var(--font-mono)', color:'var(--color-red)' }}>-${fmt(op.slippage,4)}</span></span>
        <span style={{ color:'var(--text-dim)' }}>Spread: <span style={{ fontFamily:'var(--font-mono)' }}>{op.spreadPct?.toFixed(3)||'—'}%</span></span>
        {op.breakEvenPct != null && (
          <span title="Minimum spread para cubrir fees + slippage" style={{ color:'var(--text-dim)' }}>
            Break-even: <span style={{ fontFamily:'var(--font-mono)', color:'var(--color-yellow)' }}>{op.breakEvenPct}%</span>
          </span>
        )}
        {op.viabilityThresholdPct != null && (
          <span title="Minimum spread to cover fees + slippage + minimum profit threshold" style={{ color:'var(--text-dim)' }}>
            Threshold viable: <span style={{ fontFamily:'var(--font-mono)', color:'rgba(245,158,11,0.8)' }}>{op.viabilityThresholdPct}%</span>
          </span>
        )}
        {op.fillProbability != null && (
          <span title="Probabilidad de execution completa" style={{ color:'var(--text-dim)' }}>
            P(fill): <span style={{ fontFamily:'var(--font-mono)', fontWeight:800, color: op.fillProbability>=80?'var(--color-green)':op.fillProbability>=50?'var(--color-yellow)':'var(--color-red)' }}>{op.fillProbability}%</span>
          </span>
        )}
        <LiquidityTrendBadge prediction={op.liquidityPrediction} />
        {op.viable && op.recommendedSize != null && (
          <span style={{ color:'var(--color-green)', fontWeight:700 }}>Rec: <span style={{ fontFamily:'var(--font-mono)' }}>{op.recommendedSize} BTC</span></span>
        )}
        {!op.viable && op.rejectionReason && (
          <span style={{ color:'var(--color-red)', fontSize:10, fontStyle:'italic', maxWidth:300, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }} title={op.rejectionReason}>
            {translateRejection(op.rejectionReason)}
          </span>
        )}
      </div>
      {showBreakdown && op.scoreBreakdown && (
        <OpportunityScoreBreakdown breakdown={op.scoreBreakdown} compact />
      )}
    </div>
  );
}

// liquidityPredictionEngine.js (beta) attaches { buy, sell } predictions to
// every opportunity — see server/domain/engines/liquidityPredictionEngine.js. This
// renders the worse-case trend of the two legs (a deteriorating leg matters
// more than an improving one when deciding whether to trust the size), plus
// the blended confidence, with a hover tooltip explaining the basis so this
// never reads as a mystery number.
function LiquidityTrendBadge({ prediction }) {
  if (!prediction || (!prediction.buy && !prediction.sell)) return null;
  const legs = [prediction.buy, prediction.sell].filter(Boolean);
  if (legs.length === 0) return null;

  // Cold-start legs (confidence 0) don't get a badge at all — showing a
  // trend with zero evidence behind it would be exactly the kind of false
  // precision the model is designed to avoid.
  const evaluable = legs.filter(l => l.confidence > 0);
  if (evaluable.length === 0) return null;

  const TREND_RANK = { deteriorating: 2, stable: 1, improving: 0 };
  const worst = evaluable.reduce((a, b) => (TREND_RANK[b.trend] > TREND_RANK[a.trend] ? b : a));
  const avgConfidence = evaluable.reduce((s, l) => s + l.confidence, 0) / evaluable.length;

  const STYLE = {
    improving:     { icon: '▲', color: 'var(--color-green)',  label: 'Liquidez mejorando' },
    stable:        { icon: '▬', color: 'var(--text-dim)',     label: 'Liquidez estable' },
    deteriorating: { icon: '▼', color: 'var(--color-red)',    label: 'Liquidez deteriorándose' },
  }[worst.trend];

  const tooltip =
    `${STYLE.label} (beta) — confianza ${(avgConfidence * 100).toFixed(0)}% ` +
    `basada en ${evaluable.reduce((s, l) => s + l.sampleCount, 0)} observaciones. ` +
    `Fill esperado: ${worst.expectedFillPct}%.` +
    (worst.recommendedMaxSizeUSD ? ` Tamaño recomendado: hasta $${worst.recommendedMaxSizeUSD}.` : '');

  return (
    <span
      title={tooltip}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        background: `${STYLE.color}18`, color: STYLE.color,
        fontWeight: 700, fontSize: 10, padding: '2px 8px', borderRadius: 99,
        border: `1px solid ${STYLE.color}40`, whiteSpace: 'nowrap',
        animation: 'fadeSlideUp 0.25s ease',
      }}>
      <span
        aria-hidden="true"
        style={{
          display: 'inline-block',
          animation: worst.trend === 'deteriorating' ? 'pulseDot 1.4s ease-in-out infinite' : 'none',
        }}>
        {STYLE.icon}
      </span>
      Liquidez <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 800 }}>{worst.expectedFillPct}%</span>
      <span style={{ fontSize: 8.5, opacity: 0.75, fontWeight: 600 }}>· beta</span>
    </span>
  );
}
