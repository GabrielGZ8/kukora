/**
 * dailyReportService.js — Kukora v14
 *
 * Genera y envía un reporte diario automático cada medianoche UTC.
 * Después de 60 días de operación, operators can view the full state.
 *
 * Contenido del reporte:
 *   📅 Fecha y uptime total
 *   💰 P&L del día + acumulado
 *   📊 Trades: ejecutados, win rate, mejor trade
 *   🎯 Capture rate: oportunidades viables vs ejecutadas
 *   ⚡ Latencia: p50/p95/p99 E2E
 *   🔥 Mejor hora del día (spread heatmap)
 *   📈 Distribución por par
 *
 * También persiste el reporte en MongoDB para que el panel de historial
 * de reportes lo muestre aunque Telegram no esté configurado.
 */

'use strict';

const mongoose = require('mongoose');
const { logger } = require('./logger');
const backgroundJobs = require('./backgroundJobs');

// Q2 audit: verbose logs suppressed in production — printed only with
// DEBUG_KUKORA=1 in .env. See arbitrage.routes.js for the same pattern.
const _DEBUG = process.env.DEBUG_KUKORA === '1';
function _log(...args)  { if (_DEBUG) logger.debug('dailyReportService', String(args[0]), args.length > 1 ? { extra: args.slice(1) } : undefined); }
function _warn(...args) { if (_DEBUG) logger.warn('dailyReportService', String(args[0]), args.length > 1 ? { extra: args.slice(1) } : undefined); }


// ─── Schema ────────────────────────────────────────────────────────────────

// Audit fix 1.3: schema moved to server/models/DailyReportDoc.js.
const DailyReportDoc = require('./persistence/models/DailyReportDoc');

function isMongoReady() {
  return mongoose.connection.readyState === 1;
}

// ─── Data sources (inyectadas en init) ────────────────────────────────────

let _sources = null;
let _alertService = null;

function init({ getTradeHistory, getMissedSummary, getBestOpportunitySeen, getE2EStats, getDailyStats, alertService }) {
  _sources      = { getTradeHistory, getMissedSummary, getBestOpportunitySeen, getE2EStats, getDailyStats };
  _alertService = alertService;
}

// ─── Formatear reporte ────────────────────────────────────────────────────

function formatReport(date, data) {
  const {
    trades, pnl, fees, winRate, captureRate,
    bestTrade, pairBreakdown, e2e, uptimeHours,
  } = data;

  const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(4)}` : `-$${Math.abs(pnl).toFixed(4)}`;
  const lines  = [
    `📊 *Kukora — Reporte Diario*`,
    `📅 ${date} | ⏱ ${uptimeHours}h uptime`,
    ``,
    `💰 *P&L del día:* ${pnlStr}`,
    `📈 *Trades ejecutados:* ${trades}`,
    `🎯 *Win rate:* ${winRate}%`,
    `💸 *Fees pagados:* $${fees.toFixed(4)}`,
    ``,
    // Honesto: captureRate viene de missedOpportunityTracker, que acumula
    // desde que arrancó el proceso (no se resetea a medianoche como
    // `trades`/`pnl`/`fees` ahora sí hacen) — se etiqueta explícitamente
    // para no dar a entender que es del día. Fecharlo de verdad requiere
    // bucketing por día en missedOpportunityTracker.js, un cambio más
    // grande que no se justifica en esta pasada quirúrgica.
    captureRate != null
      ? `🎯 *Capture rate (sesión):* ${captureRate}% de oportunidades viables`
      : `🎯 *Capture rate (sesión):* —`,
    ``,
  ];

  if (bestTrade) {
    lines.push(`⭐ *Mejor trade del día:*`);
    lines.push(`   ${bestTrade.buyExchange}→${bestTrade.sellExchange} | +$${(bestTrade.netProfit || 0).toFixed(4)} | score ${bestTrade.score || '—'}`);
    lines.push(``);
  }

  if (e2e?.p50 != null) {
    lines.push(`⚡ *Latencia E2E:* p50=${e2e.p50}ms · p95=${e2e.p95}ms · p99=${e2e.p99}ms`);
    lines.push(``);
  }

  if (pairBreakdown && Object.keys(pairBreakdown).length) {
    lines.push(`📊 *Por par:*`);
    const sorted = Object.entries(pairBreakdown).sort((a, b) => b[1].count - a[1].count);
    for (const [pair, s] of sorted.slice(0, 5)) {
      const pnlStr2 = s.pnl >= 0 ? `+$${s.pnl.toFixed(4)}` : `-$${Math.abs(s.pnl).toFixed(4)}`;
      lines.push(`   ${pair}: ${s.count} trades · ${pnlStr2}`);
    }
    lines.push(``);
  }

  lines.push(`_Kukora · BTC Multi-Exchange Arbitrage_`);
  return lines.join('\n');
}

// ─── Generar y enviar reporte ─────────────────────────────────────────────

async function generateReport(date, uptimeMs) {
  if (!_sources) return null;

  // Bug real (mismo defecto que se encontró y corrigió en
  // dailyStatsService.buildDaySnapshot() esta sesión): getTradeHistory()
  // devuelve el buffer acumulado de hasta 500 trades de TODO el historial
  // del proceso (MAX_TRADE_HISTORY en walletManager.js), no los trades de
  // `date`. Sin este filtro, el "Reporte Diario" de medianoche mostraba
  // P&L/trades/win rate acumulados de todo el uptime del bot, no del día
  // que acaba de cerrar — silenciosamente incorrecto en cualquier operación
  // de más de un día.
  const allTrades   = _sources.getTradeHistory?.() || [];
  const trades      = allTrades.filter(t => typeof t.ts === 'string' && t.ts.slice(0, 10) === date);
  const missed      = _sources.getMissedSummary?.() || null;
  const bestSeen    = _sources.getBestOpportunitySeen?.() || null;
  const e2eStats    = _sources.getE2EStats?.() || null;

  const pnl       = trades.reduce((s, t) => s + (t.netProfit || 0), 0);
  const fees      = trades.reduce((s, t) => s + (t.totalFees || (t.buyFee||0)+(t.sellFee||0)), 0);
  const wins      = trades.filter(t => (t.netProfit || 0) > 0).length;
  const winRate   = trades.length ? +(wins / trades.length * 100).toFixed(1) : 0;

  // Best trade of the day
  const bestTrade = trades.length
    ? trades.reduce((best, t) => (!best || (t.netProfit||0) > (best.netProfit||0)) ? t : best, null)
    : null;

  // Breakdown por par
  const pairBreakdown = {};
  for (const t of trades) {
    const key = `${t.buyExchange}→${t.sellExchange}`;
    if (!pairBreakdown[key]) pairBreakdown[key] = { count: 0, pnl: 0 };
    pairBreakdown[key].count++;
    pairBreakdown[key].pnl = +(pairBreakdown[key].pnl + (t.netProfit||0)).toFixed(4);
  }

  const data = {
    trades:        trades.length,
    pnl:           +pnl.toFixed(4),
    fees:          +fees.toFixed(4),
    winRate,
    captureRate:   missed?.captureRate ?? null,
    bestTrade,
    bestSeen,
    pairBreakdown,
    e2e:           e2eStats?.e2e || null,
    uptimeHours:   +(uptimeMs / 3_600_000).toFixed(1),
  };

  const content = formatReport(date, data);
  return { date, content, data };
}

async function sendAndPersist(date, uptimeMs) {
  try {
    const report = await generateReport(date, uptimeMs);
    if (!report) return;

    // Persistir en MongoDB
    if (isMongoReady()) {
      await DailyReportDoc.findOneAndUpdate(
        { date },
        { $set: { content: report.content, data: report.data, sentAt: new Date() } },
        { upsert: true }
      );
    }

    // Send via Telegram/webhook if configured
    if (_alertService?.sendRaw) {
      try {
        await _alertService.sendRaw(report.content);
        if (isMongoReady()) {
          await DailyReportDoc.findOneAndUpdate({ date }, { $set: { delivered: true } });
        }
        _log(`[dailyReport] Reporte ${date} enviado y persistido`);
      } catch (e) {
        _warn(`[dailyReport] Fallo al enviar Telegram (reporte persistido de todas formas):`, e.message);
      }
    } else {
      _log(`[dailyReport] Reporte ${date} generado (Telegram no configurado)`);
    }
  } catch (e) {
    _warn('[dailyReport] Error generando reporte:', e.message);
  }
}

// ─── Scheduler ────────────────────────────────────────────────────────────

let _botStartedAt = Date.now();
const JOB_NAME = 'dailyReport.send';

/**
 * Migrated onto backgroundJobs' daily runAt mode (server/infrastructure/
 * backgroundJobs.js) — same schedule (00:00:30 UTC) and same behavior as
 * the standalone setTimeout-chain this used to run, but now visible in
 * /api/ops alongside every other job (retries, last-run status, etc.)
 * instead of being an invisible timer with no external status.
 */
function start(botStartedAt) {
  if (backgroundJobs.getJobStatus(JOB_NAME)) return; // idempotente, mismo contrato que antes
  _botStartedAt = botStartedAt || Date.now();
  backgroundJobs.registerJob(JOB_NAME, async () => {
    const date = new Date(Date.now() - 1000).toISOString().slice(0, 10); // ayer
    await sendAndPersist(date, Date.now() - _botStartedAt);
  }, { runAt: '00:00:30', retries: 1, timeoutMs: 30_000 });
}

// ─── Query: historial de reportes ─────────────────────────────────────────

async function getRecentReports(n = 14) {
  if (!isMongoReady()) return [];
  try {
    return await DailyReportDoc
      .find()
      .sort({ date: -1 })
      .limit(n)
      .lean()
      .then(docs => docs.map(d => ({
        date:      d.date,
        delivered: d.delivered,
        sentAt:    d.sentAt,
        pnl:       d.data?.pnl,
        trades:    d.data?.trades,
        winRate:   d.data?.winRate,
        preview:   d.content?.slice(0, 120),
      })));
  } catch (e) {
    return [];
  }
}

module.exports = { init, start, generateReport, sendAndPersist, getRecentReports };
