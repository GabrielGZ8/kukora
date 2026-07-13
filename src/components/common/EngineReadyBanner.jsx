// ─── EngineReadyBanner ─────────────────────────────────────────────────────
// Extracted from ArbitragePage.jsx (Round 7 — audit 4.3: split large components).
export default function EngineReadyBanner({ wsStatusMap, feedFreshness, data, onConfigClick }) {
  const wsValues       = Object.values(wsStatusMap);
  const totalExchanges = wsValues.length || 5;
  const liveExchanges  = wsValues.filter(Boolean).length;
  const staleFeeds     = Object.values(feedFreshness).filter(f => f?.stale).length;
  const allReady       = liveExchanges >= 4 && staleFeeds === 0;
  const partialReady   = liveExchanges >= 2;
  const feeMode        = data?.engineConfig?.feeMode || 'taker';
  const configChangedKeys = Array.isArray(data?.configChanged) ? data.configChanged : [];

  const feeBadge = (
    <span className="stable-pill" style={{
      marginLeft: 6, padding: '1px 7px', borderRadius: 5, fontSize: 9, fontWeight: 800,
      background: feeMode === 'maker' ? 'rgba(0,184,122,0.15)' : 'rgba(245,158,11,0.12)',
      color:      feeMode === 'maker' ? 'var(--color-green)'   : '#F59E0B',
      border:     feeMode === 'maker' ? '1px solid rgba(0,184,122,0.3)' : '1px solid rgba(245,158,11,0.3)',
      letterSpacing: '0.05em', textTransform: 'uppercase',
    }}>
      {feeMode === 'maker' ? '★ MAKER FEES' : 'TAKER FEES'}
    </span>
  );

  const configBadge = configChangedKeys.length > 0 ? (
    <span
      onClick={onConfigClick}
      title={`Modified parameters: ${configChangedKeys.join(', ')} — click to view`}
      className="stable-pill"
      style={{ marginLeft:4, padding:'1px 7px', borderRadius:5, fontSize:9, fontWeight:800, background:'rgba(245,158,11,0.15)', color:'#F59E0B', border:'1px solid rgba(245,158,11,0.3)', letterSpacing:'0.04em', cursor:'pointer' }}>
      ⚙ CONFIG LIVE · {configChangedKeys.length} param{configChangedKeys.length > 1 ? 's' : ''}
    </span>
  ) : null;

  if (allReady) return (
    <div className="status-banner" style={{ background:'rgba(0,184,122,0.08)', border:'1px solid rgba(0,184,122,0.25)' }}>
      <span style={{ width:8, height:8, borderRadius:'50%', background:'var(--color-green)', animation:'pulseDot 1.5s infinite', flexShrink:0 }}/>
      <span style={{ fontWeight:800, color:'var(--color-green)' }}>SYSTEM READY</span>
      <span style={{ color:'var(--text-dim)' }}>{liveExchanges}/{totalExchanges} exchanges live · All feeds fresh · Engine active</span>
      {feeBadge}
      {configBadge}
    </div>
  );

  if (partialReady) return (
    <div className="status-banner" style={{ background:'rgba(245,158,11,0.07)', border:'1px solid rgba(245,158,11,0.25)' }}>
      <span style={{ width:8, height:8, borderRadius:'50%', background:'#F59E0B', animation:'pulseDot 1.5s infinite', flexShrink:0 }}/>
      <span style={{ fontWeight:800, color:'#F59E0B' }}>WARMING UP</span>
      <span style={{ color:'var(--text-dim)' }}>{liveExchanges}/{totalExchanges} exchanges connected · Waiting for fresh feeds…</span>
      {feeBadge}
      {configBadge}
    </div>
  );

  return (
    <div className="status-banner" style={{ background:'rgba(255,45,120,0.07)', border:'1px solid rgba(255,45,120,0.20)' }}>
      <span style={{ width:8, height:8, borderRadius:'50%', background:'var(--color-red)', flexShrink:0 }}/>
      <span style={{ fontWeight:800, color:'var(--color-red)' }}>CONNECTING</span>
      <span style={{ color:'var(--text-dim)' }}>Establishing WebSocket connections to exchanges…</span>
    </div>
  );
}
