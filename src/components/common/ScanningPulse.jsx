import { useState, useEffect } from 'react';

export default function ScanningPulse({ opportunitiesScanned, nearViableCount, bestOpportunitySeen }) {
  const [dots, setDots] = useState('.');
  useEffect(() => {
    const id = setInterval(() => setDots(d => d.length >= 3 ? '.' : d + '.'), 500);
    return () => clearInterval(id);
  }, []);

  return (
    <div style={{ padding: '32px 24px', textAlign: 'center' }}>
      <div style={{ fontSize: 40, marginBottom: 12 }}>🔍</div>
      <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--text)', marginBottom: 6 }}>
        Escaneando markets{dots}
      </div>
      <div style={{ fontSize: 13, color: 'var(--text-dim)', marginBottom: 20 }}>
        Analizando spreads entre 5 exchanges in real time
      </div>
      {opportunitiesScanned > 0 && (
        <div style={{ display: 'flex', gap: 24, justifyContent: 'center', flexWrap: 'wrap' }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 24, fontWeight: 900, fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>{opportunitiesScanned.toLocaleString()}</div>
            <div style={{ fontSize: 10, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 700 }}>pares analizados</div>
          </div>
          {nearViableCount > 0 && (
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 24, fontWeight: 900, fontFamily: 'var(--font-mono)', color: 'var(--color-yellow)' }}>{nearViableCount}</div>
              <div style={{ fontSize: 10, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 700 }}>cerca de viable</div>
            </div>
          )}
          {bestOpportunitySeen && (
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 24, fontWeight: 900, fontFamily: 'var(--font-mono)', color: bestOpportunitySeen.netProfit>0?'var(--color-green)':'var(--color-yellow)' }}>
                {bestOpportunitySeen.netProfit>=0?'+':''}{bestOpportunitySeen.netProfit.toFixed(3)}
              </div>
              <div style={{ fontSize: 10, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 700 }}>mejor spread visto $</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
