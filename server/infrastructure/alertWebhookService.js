/**
 * alertWebhookService.js — Kukora v17
 *
 * Sistema completo de alertas operacionales críticas.
 *
 * CANALES:
 *   1. Telegram — bot via Bot API
 *   2. Webhook genérico — Discord, Slack, n8n, Zapier
 *
 * EVENTOS CRÍTICOS (v17 — nuevos):
 *   - circuit_breaker_activated  : el sistema dejó de operar → URGENTE
 *   - circuit_breaker_reset      : sistema reanudó operaciones
 *   - drawdown_warning           : drawdown > 50% del límite → advertencia
 *   - drawdown_critical          : drawdown > 80% del límite → crítico
 *   - exchange_offline           : exchange desconectado > 60s
 *   - balance_critical           : balance < 20% del mínimo operacional
 *   - pnl_velocity_alert         : perdiendo > X/min en los últimos 5 minutos
 *   - system_restart             : servidor se reinició (watchdog detectó)
 *   - daily_loss_warning         : P&L > 70% del límite diario
 *
 * EVENTOS FASE 3 (live trading — nuevos):
 *   - live_partial_recovered     : leg parcial de un trade cross-exchange
 *                                  live se aplanó (CLOSE_NOW) con éxito
 *   - live_partial_unrecovered   : idem, pero el flatten falló — requiere
 *                                  intervención manual inmediata
 *
 * EVENTOS EXISTENTES (preservados):
 *   - trade_executed
 *   - opportunity_large
 *   - daily_stop
 *   - exchange_degraded
 */

'use strict';

const mongoose = require('mongoose');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID   || '';
const WEBHOOK_URL        = process.env.WEBHOOK_URL         || '';
const ALERT_MIN_PROFIT   = parseFloat(process.env.ALERT_MIN_PROFIT   || '5.00');
const ALERT_COOLDOWN_MS  = parseInt(process.env.ALERT_COOLDOWN_MS    || '30000', 10);

const _lastAlertTs = {};
const _alertHistory = [];
const MAX_ALERT_HISTORY = 200;

// ─── Cooldown ─────────────────────────────────────────────────────────────

function shouldAlert(eventType, overrideCooldownMs = null) {
  const now      = Date.now();
  const last     = _lastAlertTs[eventType] || 0;
  const cooldown = overrideCooldownMs ?? ALERT_COOLDOWN_MS;
  if (now - last < cooldown) return false;
  _lastAlertTs[eventType] = now;
  return true;
}

// ─── Formatters ───────────────────────────────────────────────────────────

function formatTradeExecuted(trade) {
  const profit = trade.netProfit >= 0
    ? `+$${trade.netProfit.toFixed(4)}`
    : `-$${Math.abs(trade.netProfit).toFixed(4)}`;
  const emoji = trade.netProfit >= 0 ? '✅' : '🔴';
  return {
    text: [
      `${emoji} *TRADE EJECUTADO* — Kukora`,
      `Par: \`${trade.buyExchange} → ${trade.sellExchange}\``,
      `Monto: \`${(trade.amount || 0).toFixed(4)} BTC\``,
      `Compra: \`$${(trade.buyPrice || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}\``,
      `Venta: \`$${(trade.sellPrice || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}\``,
      `Fees: \`-$${(trade.totalFees || 0).toFixed(4)}\``,
      `Slippage: \`-$${(trade.slippage || 0).toFixed(4)}\``,
      `*Neto: ${profit}*`,
    ].join('\n'),
    title: `Trade Ejecutado — ${trade.buyExchange}→${trade.sellExchange} ${profit}`,
    severity: trade.netProfit >= 0 ? 'info' : 'warn',
  };
}

function formatCircuitBreakerActivated(reason, context = {}) {
  return {
    text: [
      `🚨 *CIRCUIT BREAKER ACTIVADO — Kukora*`,
      ``,
      `⛔ *El motor de arbitraje ha pausado operaciones.*`,
      ``,
      `Reason: \`${reason}\``,
      context.consecutiveFailures ? `Fallos consecutivos: \`${context.consecutiveFailures}\`` : '',
      context.sessionPnl != null ? `Session P&L: \`$${context.sessionPnl.toFixed(2)}\`` : '',
      ``,
      `Action required: review the system and perform a manual reset if safe.`,
      `POST /api/arbitrage/risk/circuit-breaker/reset`,
    ].filter(Boolean).join('\n'),
    title: `🚨 Circuit Breaker Activado — ${reason.slice(0, 60)}`,
    severity: 'critical',
  };
}

function formatCircuitBreakerReset(source) {
  return {
    text: [
      `✅ *CIRCUIT BREAKER RESET — Kukora*`,
      `System resumed operations.`,
      `Fuente del reset: \`${source}\``,
    ].join('\n'),
    title: `Circuit Breaker Reset — ${source}`,
    severity: 'info',
  };
}

function formatDrawdownWarning(drawdownPct, maxDrawdownPct, currentEquityUSD, level = 'warning') {
  const emoji = level === 'critical' ? '🔴' : '⚠️';
  return {
    text: [
      `${emoji} *DRAWDOWN ${level.toUpperCase()} — Kukora*`,
      ``,
      `Drawdown actual: \`${drawdownPct.toFixed(2)}%\``,
      `Configured limit: \`${maxDrawdownPct}%\``,
      `Equity actual: \`$${currentEquityUSD?.toFixed(2) ?? '—'}\``,
      ``,
      level === 'critical'
        ? `⛔ The system will halt if drawdown continues to increase.`
        : `Monitorear de cerca. El circuit breaker se activa al ${maxDrawdownPct}%.`,
    ].join('\n'),
    title: `${emoji} Drawdown ${drawdownPct.toFixed(1)}% / ${maxDrawdownPct}% — Kukora`,
    severity: level === 'critical' ? 'critical' : 'warn',
  };
}

function formatExchangeOffline(exchange, offlineSecs) {
  return {
    text: [
      `📡 *EXCHANGE OFFLINE — Kukora*`,
      ``,
      `Exchange: \`${exchange}\``,
      `Tiempo offline: \`${offlineSecs}s\``,
      ``,
      `Price feed for ${exchange} is stale or disconnected.`,
      `Opportunities on this pair are being skipped.`,
    ].join('\n'),
    title: `📡 ${exchange} Offline (${offlineSecs}s) — Kukora`,
    severity: 'warn',
  };
}

function formatBalanceCritical(exchange, asset, current, minimum) {
  return {
    text: [
      `💰 *BALANCE CRÍTICO — Kukora*`,
      ``,
      `Exchange: \`${exchange}\``,
      `Activo: \`${asset}\``,
      `Balance actual: \`${current.toFixed(asset === 'BTC' ? 6 : 2)}\``,
      `Operational minimum: \`${minimum.toFixed(asset === 'BTC' ? 6 : 2)}\``,
      ``,
      `Action required: rebalance funds to ${exchange}.`,
      `Opportunities on this exchange are being rejected.`,
    ].join('\n'),
    title: `💰 Critical Balance: ${asset} on ${exchange} — Kukora`,
    severity: 'warn',
  };
}

// Refinamiento post-Sesión 34, Área 3 — automatización del disparo de
// rebalanceo. Visibilidad explícita: un rebalanceo AUTOMÁTICO mueve fondos
// reales sin que un humano lo haya pedido en el momento — debe ser tan
// visible como cualquier otra alerta operativa, no un movimiento silencioso
// en el historial.
function formatAutoRebalanceExecuted(detail) {
  const { asset, from, to, amount, feeUSD, severity, reason } = detail;
  return {
    text: [
      `🔄 *REBALANCEO AUTOMÁTICO EJECUTADO — Kukora*`,
      ``,
      `Activo: \`${asset}\``,
      `${from} → ${to}: \`${amount}\``,
      `Fee estimado: \`$${(feeUSD || 0).toFixed(2)}\``,
      `Severidad detectada: \`${severity}\``,
      `Motivo: ${reason}`,
    ].join('\n'),
    title: `🔄 Auto-rebalance: ${amount} ${asset} ${from} → ${to} — Kukora`,
    severity: 'info',
  };
}

function formatPnlVelocityAlert(lossPerMinute, windowMinutes, sessionPnl) {
  return {
    text: [
      `📉 *VELOCIDAD DE PÉRDIDA ALTA — Kukora*`,
      ``,
      `Pérdida en últimos ${windowMinutes}min: \`$${Math.abs(lossPerMinute * windowMinutes).toFixed(2)}\``,
      `Tasa: \`$${Math.abs(lossPerMinute).toFixed(4)}/min\``,
      `Total session P&L: \`$${sessionPnl.toFixed(2)}\``,
      ``,
      `Consider reducing position size or pausing the bot.`,
    ].join('\n'),
    title: `📉 Pérdida rápida: $${Math.abs(lossPerMinute * windowMinutes).toFixed(2)} en ${windowMinutes}min`,
    severity: 'warn',
  };
}

function formatDailyLossWarning(sessionPnl, limit, pct) {
  return {
    text: [
      `⚠️ *DAILY LOSS WARNING — Kukora*`,
      ``,
      `Session P&L: \`$${sessionPnl.toFixed(2)}\``,
      `Daily limit: \`$${limit.toFixed(2)}\``,
      `Consumed: \`${pct.toFixed(0)}%\` of limit`,
      ``,
      `System will halt upon reaching the limit.`,
    ].join('\n'),
    title: `⚠️ Daily Loss ${pct.toFixed(0)}% of limit — Kukora`,
    severity: 'warn',
  };
}

function formatDailyStop(pnl) {
  return {
    text: [
      `🛑 *DAILY LOSS STOP — Kukora*`,
      `Engine stopped automatically.`,
      `P&L acumulado hoy: \`$${pnl?.toFixed(2)}\``,
      `Threshold: \`$${process.env.MAX_DAILY_LOSS_USD || '-500.00'}\``,
      `Bot will resume on the next session reset.`,
    ].join('\n'),
    title: `Daily Stop Activado — P&L: $${pnl?.toFixed(2)}`,
    severity: 'critical',
  };
}

function formatExchangeDegraded(exchange, score) {
  return {
    text: [
      `⚠️ *EXCHANGE DEGRADADO — Kukora*`,
      `Exchange: \`${exchange}\``,
      `Reliability score: \`${score}/100\``,
      `Causa posible: errores WS, latencia alta, o feed frozen.`,
      `Scoring penalty active until the feed recovers.`,
    ].join('\n'),
    title: `${exchange} Degradado — Score: ${score}`,
    severity: 'warn',
  };
}

function formatSystemRestart(reason, previousUptimeMs) {
  const prevUptime = previousUptimeMs
    ? `${Math.floor(previousUptimeMs / 3600000)}h ${Math.floor((previousUptimeMs % 3600000) / 60000)}m`
    : 'desconocido';
  return {
    text: [
      `🔄 *SISTEMA REINICIADO — Kukora*`,
      ``,
      `Reason: \`${reason}\``,
      `Uptime previo: \`${prevUptime}\``,
      ``,
      `Arbitrage engine is resuming operations.`,
      `State restored from MongoDB (if available).`,
    ].join('\n'),
    title: `🔄 Kukora reiniciado — uptime previo: ${prevUptime}`,
    severity: 'info',
  };
}

function formatOpportunityLarge(op) {
  return {
    text: [
      `⚡ *OPORTUNIDAD GRANDE* — Kukora`,
      `Par: \`${op.buyExchange} → ${op.sellExchange}\``,
      `Spread: \`${op.spreadPct?.toFixed(4)}%\``,
      `*Profit estimado: +$${op.netProfit?.toFixed(4)}*`,
      `Score: \`${op.score}/100\``,
      `Slippage: \`${op.slippageMethod}\``,
    ].join('\n'),
    title: `Oportunidad — +$${op.netProfit?.toFixed(4)} — ${op.buyExchange}→${op.sellExchange}`,
    severity: 'info',
  };
}

/**
 * formatLivePartialFailure — Fase 3 (executeCrossExchangeLive). One leg of
 * a real dual-leg cross-exchange trade filled and the other didn't; this
 * covers both outcomes of the automatic CLOSE_NOW flatten attempt.
 */
function formatLivePartialFailure(detail) {
  const { tradeId, filledExchange, failedExchange, qty, recovered, manualInterventionRequired } = detail;
  return {
    text: [
      `🚨 *LIVE TRADE — PIERNA PARCIAL — Kukora*`,
      ``,
      `Trade: \`${tradeId}\``,
      `Se llenó en: \`${filledExchange}\` (qty: \`${qty}\`)`,
      `Falló en: \`${failedExchange}\``,
      recovered
        ? `✅ Posición aplanada automáticamente (CLOSE_NOW) en ${filledExchange}.`
        : `⛔ *FLATTEN FALLÓ — INTERVENCIÓN MANUAL REQUERIDA en ${filledExchange}.*`,
      manualInterventionRequired ? `` : '',
      `Ver GET /api/trading/audit para el detalle.`,
    ].filter(Boolean).join('\n'),
    title: recovered
      ? `Live partial leg recuperada — ${filledExchange}→${failedExchange}`
      : `🚨 MANUAL INTERVENTION — Live partial leg sin recuperar en ${filledExchange}`,
    severity: recovered ? 'warn' : 'critical',
  };
}

// ─── Senders ──────────────────────────────────────────────────────────────

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return { sent: false, reason: 'not_configured' };
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'Markdown' }),
      signal:  AbortSignal.timeout(6000),
    });
    if (!res.ok) {
      const err = await res.text();
      return { sent: false, reason: err.slice(0, 100) };
    }
    return { sent: true };
  } catch (e) {
    return { sent: false, reason: e.message };
  }
}

async function sendWebhook(payload) {
  if (!WEBHOOK_URL) return { sent: false, reason: 'not_configured' };
  try {
    const res = await fetch(WEBHOOK_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ source: 'kukora', ts: new Date().toISOString(), ...payload }),
      signal:  AbortSignal.timeout(6000),
    });
    return { sent: res.ok, status: res.status };
  } catch (e) {
    return { sent: false, reason: e.message };
  }
}

async function dispatch(eventType, formatted) {
  const entry = {
    ts:       new Date().toISOString(),
    event:    eventType,
    title:    formatted.title,
    severity: formatted.severity || 'info',
    sent:     false,
  };

  try {
    const [tg, wh] = await Promise.all([
      sendTelegram(formatted.text),
      sendWebhook({ event: eventType, ...formatted }),
    ]);
    entry.sent    = tg.sent || wh.sent;
    entry.channels = { telegram: tg, webhook: wh };
  } catch { /* non-fatal */ }

  _alertHistory.unshift(entry);
  if (_alertHistory.length > MAX_ALERT_HISTORY) _alertHistory.pop();

  try {
    const obs = require('./observabilityService');
    obs.emit('SYSTEM', `alert.${eventType}`, {
      title: formatted.title, severity: entry.severity, sent: entry.sent,
    }, entry.severity === 'critical' ? 'error' : 'info');
  } catch { /* observability not critical */ }

  let notificationDoc = null;
  try {
    const { Notification } = require('../models');
    if (mongoose.connection.readyState === 1) {
      notificationDoc = await Notification.create({
        userId:   'broadcast',
        event:    eventType,
        title:    formatted.title,
        severity: entry.severity,
      });
    }
  } catch { /* DB may be unavailable — in-app notification list will just miss this one */ }

  try {
    const { pushToNotifications } = require('../application/arbitrage.state');
    pushToNotifications({
      type:      'notification',
      id:        notificationDoc?._id?.toString() || null,
      event:     eventType,
      title:     formatted.title,
      severity:  entry.severity,
      read:      false,
      createdAt: notificationDoc?.createdAt?.toISOString() || entry.ts,
    });
  } catch { /* SSE push is best-effort */ }

  return entry;
}

// ─── P&L velocity tracker (rolling 5-min window) ─────────────────────────

const _pnlHistory = [];

function recordPnlPoint(sessionPnl) {
  const now = Date.now();
  _pnlHistory.push({ ts: now, pnl: sessionPnl });
  while (_pnlHistory.length > 0 && now - _pnlHistory[0].ts > 600_000) _pnlHistory.shift();
}

function getPnlVelocity(windowMs = 300_000) {
  if (_pnlHistory.length < 2) return null;
  const now    = Date.now();
  const recent = _pnlHistory.filter(p => now - p.ts <= windowMs);
  if (recent.length < 2) return null;
  const oldest   = recent[0];
  const newest   = recent[recent.length - 1];
  const deltaMs  = newest.ts - oldest.ts;
  const deltaPnl = newest.pnl - oldest.pnl;
  if (deltaMs === 0) return null;
  return deltaPnl / (deltaMs / 60_000);
}

// ─── Public alert functions ───────────────────────────────────────────────

async function alertTradeExecuted(trade) {
  const key = `trade_${trade.id || trade.ts}`;
  if (_lastAlertTs[key]) return;
  _lastAlertTs[key] = Date.now();
  return dispatch('trade_executed', formatTradeExecuted(trade));
}

async function alertOpportunityLarge(op) {
  if (!op || (op.netProfit || 0) < ALERT_MIN_PROFIT) return;
  if (!shouldAlert(`opportunity_large_${op.buyExchange}_${op.sellExchange}`)) return;
  return dispatch('opportunity_large', formatOpportunityLarge(op));
}

async function alertDailyStop(pnl) {
  if (!shouldAlert('daily_stop', 60_000)) return;
  return dispatch('daily_stop', formatDailyStop(pnl));
}

async function alertExchangeDegraded(exchange, score) {
  if (score >= 60) return;
  if (!shouldAlert(`exchange_degraded_${exchange}`, 120_000)) return;
  return dispatch('exchange_degraded', formatExchangeDegraded(exchange, score));
}

// ─── v17 alerts ───────────────────────────────────────────────────────────

async function alertCircuitBreakerActivated(reason, context = {}) {
  if (!shouldAlert('circuit_breaker_activated', 120_000)) return;
  return dispatch('circuit_breaker_activated', formatCircuitBreakerActivated(reason, context));
}

async function alertCircuitBreakerReset(source) {
  if (!shouldAlert('circuit_breaker_reset', 10_000)) return;
  return dispatch('circuit_breaker_reset', formatCircuitBreakerReset(source));
}

async function alertDrawdown(drawdownPct, maxDrawdownPct, currentEquityUSD) {
  const pctOfLimit = drawdownPct / maxDrawdownPct;
  if (pctOfLimit < 0.5) return;
  const level = pctOfLimit >= 0.8 ? 'critical' : 'warning';
  if (!shouldAlert(`drawdown_${level}`, level === 'critical' ? 60_000 : 300_000)) return;
  return dispatch(`drawdown_${level}`, formatDrawdownWarning(drawdownPct, maxDrawdownPct, currentEquityUSD, level));
}

async function alertExchangeOffline(exchange, offlineSecs) {
  if (offlineSecs < 60) return;
  if (!shouldAlert(`exchange_offline_${exchange}`, 300_000)) return;
  return dispatch('exchange_offline', formatExchangeOffline(exchange, offlineSecs));
}

async function alertBalanceCritical(exchange, asset, current, minimum) {
  if (current >= minimum * 0.2) return;
  if (!shouldAlert(`balance_critical_${exchange}_${asset}`, 300_000)) return;
  return dispatch('balance_critical', formatBalanceCritical(exchange, asset, current, minimum));
}

async function alertAutoRebalanceExecuted(detail) {
  // Sin cooldown de shouldAlert() aquí a propósito: rebalanceScheduler.js ya
  // tiene su propio cooldown (autoRebalanceCooldownMs) antes de siquiera
  // llamar a executeRebalance() — cada llamada a esta función representa un
  // movimiento de fondos real que YA ocurrió, así que debe alertar siempre.
  return dispatch('auto_rebalance_executed', formatAutoRebalanceExecuted(detail));
}

async function alertPnlVelocity(sessionPnl) {
  recordPnlPoint(sessionPnl);
  const velocity = getPnlVelocity(300_000);
  if (!velocity || velocity >= 0) return;
  const lossPerMin    = Math.abs(velocity);
  const projectedHour = lossPerMin * 60;
  if (projectedHour < 10) return;
  if (!shouldAlert('pnl_velocity', 600_000)) return;
  return dispatch('pnl_velocity', formatPnlVelocityAlert(velocity, 5, sessionPnl));
}

async function alertDailyLossWarning(sessionPnl, dailyLossLimit) {
  if (dailyLossLimit >= 0 || sessionPnl >= 0) return;
  const pct = (sessionPnl / dailyLossLimit) * 100;
  if (pct < 70) return;
  const level = pct >= 90 ? 'daily_loss_90' : 'daily_loss_70';
  if (!shouldAlert(level, 300_000)) return;
  return dispatch(level, formatDailyLossWarning(sessionPnl, dailyLossLimit, pct));
}

async function alertSystemRestart(reason = 'unknown', previousUptimeMs = null) {
  return dispatch('system_restart', formatSystemRestart(reason, previousUptimeMs));
}

/**
 * alertLivePartialFailure — Fase 3 (executeCrossExchangeLive): fired when
 * exactly one leg of a live cross-exchange trade filled and the other
 * didn't, regardless of whether the emergency CLOSE_NOW flatten recovered
 * it. Always dispatches (no cooldown/de-dup) — this is a safety-critical,
 * low-frequency event where every occurrence needs a human's eyes, unlike
 * the high-frequency informational alerts above.
 */
async function alertLivePartialFailure(detail) {
  return dispatch(
    detail.recovered ? 'live_partial_recovered' : 'live_partial_unrecovered',
    formatLivePartialFailure(detail),
  );
}

// ─── Getters ──────────────────────────────────────────────────────────────

function getConfig() {
  return {
    telegramConfigured: !!(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID),
    webhookConfigured:  !!WEBHOOK_URL,
    alertMinProfit:     ALERT_MIN_PROFIT,
    alertCooldownMs:    ALERT_COOLDOWN_MS,
    active:             !!(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) || !!WEBHOOK_URL,
    v17Alerts: {
      circuitBreaker: true,
      drawdown:       true,
      exchangeOffline:true,
      balanceCritical:true,
      pnlVelocity:    true,
      dailyLossWarn:  true,
      systemRestart:  true,
    },
  };
}

function getAlertHistory(limit = 50) {
  return _alertHistory.slice(0, limit);
}

function resetAlerts() {
  for (const k of Object.keys(_lastAlertTs)) delete _lastAlertTs[k];
  _pnlHistory.length = 0;
}

module.exports = {
  alertTradeExecuted,
  alertOpportunityLarge,
  alertDailyStop,
  alertExchangeDegraded,
  getConfig,
  resetAlerts,
  alertCircuitBreakerActivated,
  alertCircuitBreakerReset,
  alertDrawdown,
  alertExchangeOffline,
  alertBalanceCritical,
  alertPnlVelocity,
  alertDailyLossWarning,
  alertSystemRestart,
  alertLivePartialFailure,
  alertAutoRebalanceExecuted,
  getAlertHistory,
  recordPnlPoint,
  getPnlVelocity,
};
