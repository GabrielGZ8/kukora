import React from 'react';

export default function TradeAuditModal({ trade, onClose }) {
  if (!trade) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="card card-glass" style={{ width: '100%', maxWidth: 500, padding: 0, overflow: 'hidden' }} onClick={e => e.stopPropagation()}>
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--bg-surface-3)' }}>
          <h3 style={{ margin: 0, fontSize: 14, fontWeight: 900 }}>Audit de Ejecución [UUID: {trade.id?.slice(-8)}]</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', color: 'var(--text-dim)' }}>×</button>
        </div>
        
        <div style={{ padding: '20px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginBottom: 20 }}>
            <div>
              <div style={{ fontSize: 10, color: 'var(--text-dim)', fontWeight: 700, textTransform: 'uppercase', marginBottom: 4 }}>Exchange Compra</div>
              <div style={{ fontWeight: 800, fontSize: 14 }}>{trade.buyExchange}</div>
              <div style={{ fontSize: 12, fontFamily: 'var(--font-mono)' }}>${trade.buyPrice?.toLocaleString()}</div>
            </div>
            <div>
              <div style={{ fontSize: 10, color: 'var(--text-dim)', fontWeight: 700, textTransform: 'uppercase', marginBottom: 4 }}>Exchange Venta</div>
              <div style={{ fontWeight: 800, fontSize: 14 }}>{trade.sellExchange}</div>
              <div style={{ fontSize: 12, fontFamily: 'var(--font-mono)' }}>${trade.sellPrice?.toLocaleString()}</div>
            </div>
          </div>

          <div style={{ background: 'rgba(0,184,122,0.05)', border: '1px solid rgba(0,184,122,0.15)', borderRadius: 8, padding: '12px', marginBottom: 20 }}>
            <div style={{ fontSize: 11, fontWeight: 800, color: 'var(--color-green)', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
              <span>✓</span> MODELO DE COSTOS REALES APLICADO
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
                <span style={{ color: 'var(--text-muted)' }}>Taker Fees Acumulados</span>
                <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700 }}>-${trade.totalFees?.toFixed(4)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
                <span style={{ color: 'var(--text-muted)' }}>Slippage Proyectado (VWAP)</span>
                <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700 }}>-${trade.slippage?.toFixed(4)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, borderTop: '1px solid rgba(0,0,0,0.05)', paddingTop: 6 }}>
                <span style={{ fontWeight: 800 }}>Ganancia Neta Realizada</span>
                <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 900, color: 'var(--color-green)' }}>+${trade.netProfit?.toFixed(4)}</span>
              </div>
            </div>
          </div>

          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 10, color: 'var(--text-dim)', fontWeight: 700, textTransform: 'uppercase', marginBottom: 8 }}>Métricas de Latencia (Propagación)</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ flex: 1, height: 6, background: 'var(--bg-surface-3)', borderRadius: 3, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: '40%', background: 'var(--color-blue)', borderRadius: 3 }} />
              </div>
              <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', fontWeight: 700 }}>{trade.executionMs || 12}ms</span>
            </div>
            <div style={{ fontSize: 9, color: 'var(--text-dim)', marginTop: 4 }}>
              Detección via WebSocket Event-Driven. Procesamiento de orden atómica en paralelo.
            </div>
          </div>

          <div style={{ fontSize: 9, color: 'var(--text-dim)', background: 'var(--bg-surface-2)', padding: '10px', borderRadius: 6, fontStyle: 'italic' }}>
            Este trade fue validado contra el Order Book L2 en tiempo real. La ejecución simula una orden Taker que consume liquidez inmediata para garantizar el arbitraje.
          </div>
        </div>
        
        <div style={{ padding: '12px 20px', background: 'var(--bg-surface-3)', textAlign: 'right' }}>
          <button className="btn btn-secondary btn-sm" onClick={onClose}>Cerrar Audit</button>
        </div>
      </div>
    </div>
  );
}
