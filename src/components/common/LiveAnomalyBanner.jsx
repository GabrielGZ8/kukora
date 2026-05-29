import { useState, useEffect } from 'react';
import { api } from '../../api';

const COINS = 'bitcoin,ethereum,solana,binancecoin,ripple,cardano';

export default function LiveAnomalyBanner() {
  const [anomalies, setAnomalies] = useState([]);
  const [current, setCurrent]     = useState(0);
  const [visible, setVisible]     = useState(false);

  useEffect(() => {
    const load = async () => {
      try {
        const data = await api.get(`/api/crypto/anomalies?coins=${COINS}&days=7`);
        const high = (data || []).filter(a => a.anomaly?.level === 'high');
        if (high.length > 0) { setAnomalies(high); setVisible(true); }
      } catch {}
    };
    load();
    const id = setInterval(load, 120_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (anomalies.length <= 1) return;
    const id = setInterval(() => setCurrent(c => (c + 1) % anomalies.length), 4000);
    return () => clearInterval(id);
  }, [anomalies.length]);

  if (!visible || anomalies.length === 0) return null;
  const a = anomalies[current];

  return (
    <div style={{
      position: 'fixed', bottom: 20, right: 20, zIndex: 999,
      background: '#fff',
      border: '1px solid rgba(240,62,62,0.25)',
      borderLeft: '3px solid var(--color-red)',
      borderRadius: 'var(--radius-lg)',
      padding: '12px 14px',
      maxWidth: 300, minWidth: 240,
      boxShadow: '0 4px 24px rgba(0,0,0,0.10)',
      animation: 'fadeSlideUp 0.25s ease',
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <span style={{ fontSize: 16, lineHeight: 1, flexShrink: 0, marginTop: 1 }}>🚨</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 3 }}>
            <span style={{
              fontSize: 10, fontWeight: 800, color: 'var(--color-red)',
              letterSpacing: '0.06em', textTransform: 'uppercase',
              fontFamily: 'var(--font-mono)',
            }}>
              {(a.symbol || a.id || '').toUpperCase()} · Anomalía
            </span>
            <button
              onClick={() => setVisible(false)}
              style={{ background: 'none', border: 'none', color: 'var(--text-dim)', fontSize: 13, cursor: 'pointer', padding: '0 0 0 8px', lineHeight: 1 }}
            >✕</button>
          </div>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.45, margin: 0 }}>
            {a.anomaly?.reason}
          </p>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
            <div style={{ height: 3, background: 'var(--bg-surface-3)', borderRadius: 99, flex: 1, overflow: 'hidden' }}>
              <div style={{
                height: '100%', width: `${a.anomaly?.severityScore || 0}%`,
                background: 'var(--color-red)', borderRadius: 99,
                transition: 'width 0.5s',
              }} />
            </div>
            <span style={{ fontSize: 10, color: 'var(--color-red)', fontFamily: 'var(--font-mono)', fontWeight: 700, flexShrink: 0 }}>
              {a.anomaly?.severityScore}/100
            </span>
          </div>
          {anomalies.length > 1 && (
            <div style={{ fontSize: 9, color: 'var(--text-dim)', marginTop: 6, textAlign: 'right' }}>
              {current + 1} / {anomalies.length} alertas
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
