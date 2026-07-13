/**
 * AlertsConfigPanel.jsx — Kukora
 *
 * Automated alert configuration panel. Shows if Telegram
 * and/or webhook are configured, allows sending a test alert,
 * and explains how to configure them.
 *
 * This panel lives inside the "🔁 Adaptive System" tab of ArbitragePage,
 * como una tercera sub-tab. Las alerts son el differencedor que demuestra
 * demonstrating that Kukora operates autonomously without constant supervision.
 */
import { requestArbitrage } from '../../api';
import { useState, useEffect, useCallback } from 'react';

export default function AlertsConfigPanel() {
  const [config, setConfig]     = useState(null);
  const [testing, setTesting]   = useState(false);
  const [testResult, setTestResult] = useState(null);

  const fetchConfig = useCallback(async () => {
    try {
      const j = await requestArbitrage('alerts/config');
      if (j?.ok) setConfig(j.data);
    } catch { /* noop */ }
  }, []);

  useEffect(() => { fetchConfig(); }, [fetchConfig]);

  const sendTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const j = await requestArbitrage('alerts/test', { method: 'POST' });
      setTestResult({ ok: j?.ok, msg: j?.message || j?.error });
    } catch { setTestResult({ ok: false, msg: 'No se pudo conectar' }); }
    finally { setTesting(false); }
  };

  const active = config?.active;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.65 }}>
        Kukora can send automated alerts to Telegram or any webhook when it executes a trade, detects a large opportunity, or when the engine stops. This demonstrates real autonomous operation — the system notifies you, not the other way around.
      </div>

      {/* Status actual */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <div className="card" style={{
          padding: '14px 18px',
          border: config?.telegramConfigured ? '1px solid rgba(0,184,122,0.3)' : '1px solid var(--border)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <span style={{ fontSize: 18 }}>📱</span>
            <span style={{ fontWeight: 800, fontSize: 13 }}>Telegram</span>
            <span style={{
              marginLeft: 'auto', fontSize: 9, fontWeight: 800, padding: '2px 8px', borderRadius: 99,
              background: config?.telegramConfigured ? 'rgba(0,184,122,0.1)' : 'var(--bg-surface-2)',
              color: config?.telegramConfigured ? 'var(--color-green)' : 'var(--text-dim)',
            }}>
              {config?.telegramConfigured ? '✓ Asset' : '○ No configurado'}
            </span>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.5 }}>
            {config?.telegramConfigured
              ? 'Bot configured and ready. You will receive a Telegram message for every executed trade.'
              : 'To activate: create a bot with @BotFather, then add TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in Railway → Variables.'}
          </div>
        </div>

        <div className="card" style={{
          padding: '14px 18px',
          border: config?.webhookConfigured ? '1px solid rgba(87,65,217,0.3)' : '1px solid var(--border)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <span style={{ fontSize: 18 }}>🔗</span>
            <span style={{ fontWeight: 800, fontSize: 13 }}>Webhook</span>
            <span style={{
              marginLeft: 'auto', fontSize: 9, fontWeight: 800, padding: '2px 8px', borderRadius: 99,
              background: config?.webhookConfigured ? 'rgba(87,65,217,0.1)' : 'var(--bg-surface-2)',
              color: config?.webhookConfigured ? '#5741D9' : 'var(--text-dim)',
            }}>
              {config?.webhookConfigured ? '✓ Asset' : '○ No configurado'}
            </span>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.5 }}>
            {config?.webhookConfigured
              ? 'Webhook configurado. Kukora hace POST JSON a tu URL en cada evento.'
              : 'To activate: add WEBHOOK_URL in Railway → Variables. Compatible with Discord, Slack, n8n, Zapier, or your own endpoint.'}
          </div>
        </div>
      </div>

      {/* Config params */}
      {config && (
        <div className="card" style={{ padding: '12px 16px', display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 12 }}>
          <span style={{ color: 'var(--text-dim)' }}>Profit minimum para alert:</span>
          <b style={{ fontFamily: 'var(--font-mono)' }}>${config.alertMinProfit}</b>
          <span style={{ color: 'var(--text-dim)', marginLeft: 8 }}>Cooldown entre alerts:</span>
          <b style={{ fontFamily: 'var(--font-mono)' }}>{config.alertCooldownMs / 1000}s</b>
          <span style={{ color: 'var(--text-dim)', fontStyle: 'italic', marginLeft: 8 }}>Configurable via ALERT_MIN_PROFIT y ALERT_COOLDOWN_MS en .env</span>
        </div>
      )}

      {/* Events list */}
      <div className="card" style={{ padding: '14px 18px' }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 12 }}>
          Eventos que disparan alerts
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {[
            { icon: '✅', event: 'trade_executed',       label: 'Trade ejecutado',          desc: 'Siempre. Incluye par, amount, prices, fees, slippage y neto final.' },
            { icon: '⚡', event: 'opportunity_large',    label: 'Large opportunity',        desc: `When netProfit > $${config?.alertMinProfit || 5.00} — configurable. Only when not executed (cooldown active or other reason).` },
            { icon: '🛑', event: 'daily_stop',           label: 'Daily loss stop',           desc: 'Cuando el engine se detiene por loss acumulada del day.' },
            { icon: '⚠️', event: 'exchange_degraded',   label: 'Exchange degradado',        desc: 'Cuando reliability score de un exchange baja de 60% por >30s.' },
          ].map(ev => (
            <div key={ev.event} style={{ display: 'flex', gap: 12, alignItems: 'flex-start', padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
              <span style={{ fontSize: 16, flexShrink: 0 }}>{ev.icon}</span>
              <div>
                <div style={{ fontWeight: 700, fontSize: 12 }}>{ev.label}</div>
                <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 2, lineHeight: 1.5 }}>{ev.desc}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Test button */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button
          onClick={sendTest}
          disabled={testing || !active}
          title={!active ? 'Configura al menos Telegram o Webhook primero' : ''}
          style={{
            background: active ? 'linear-gradient(135deg,#5741D9,#FF2D78)' : 'var(--bg-surface-3)',
            color: active ? '#fff' : 'var(--text-dim)',
            border: 'none', borderRadius: 8, padding: '9px 20px',
            fontWeight: 800, fontSize: 12,
            cursor: testing || !active ? 'not-allowed' : 'pointer',
            opacity: testing ? 0.6 : 1,
          }}
        >
          {testing ? 'Enviando…' : '📤 Enviar alert de test'}
        </button>
        {!active && (
          <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>Configura Telegram o Webhook en Railway → Variables para activar</span>
        )}
        {testResult && (
          <span style={{ fontSize: 12, color: testResult.ok ? 'var(--color-green)' : 'var(--color-red)' }}>
            {testResult.ok ? '✓' : '✕'} {testResult.msg}
          </span>
        )}
      </div>

      {/* Setup guide */}
      <div className="card" style={{ padding: '14px 18px', background: 'linear-gradient(135deg, rgba(87,65,217,0.04), rgba(255,45,120,0.03))', border: '1px solid rgba(87,65,217,0.12)' }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10 }}>
          How to configure Telegram (3 steps)
        </div>
        {[
          { n: 1, text: 'Abre Telegram → busca @BotFather → /newbot → ponle un name → copia el token (formato: 123456:ABC...)' },
          { n: 2, text: 'Message the bot you created. Then open https://api.telegram.org/bot{TOKEN}/getUpdates — copy the chat_id that appears.' },
          { n: 3, text: 'In Railway → your project → Variables → add TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID → Redeploy.' },
        ].map(s => (
          <div key={s.n} style={{ display: 'flex', gap: 10, marginBottom: 8, fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>
            <span style={{ width: 18, height: 18, borderRadius: '50%', background: 'rgba(87,65,217,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, fontWeight: 900, color: '#5741D9', flexShrink: 0 }}>{s.n}</span>
            <span>{s.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
