#!/usr/bin/env node
'use strict';

/**
 * scripts/experimentSweep.js — Iniciativa 3 del plan competitivo.
 *
 * Reproduce un archivo JSONL grabado con `scripts/tapeRecorder.js` a
 * través del motor de detección REAL (`opportunityDetection.detectOpportunities`,
 * no una reimplementación paralela — ver `scripts/lib/tapeReplay.js`),
 * reconstruye el opportunity log resultante, y corre
 * `arbBacktestEngine.parameterSweep()` sobre él — el mismo sweep que
 * expone `GET /api/arb-backtest/sweep`, pero sobre datos de mercado
 * grabados y reproducibles en vez de sobre el log en vivo de la sesión
 * actual del servidor.
 *
 * Uso:
 *   node scripts/experimentSweep.js --tape=data/tapes/tape-xxx.jsonl [--top=10]
 */

const fs = require('fs');
const readline = require('readline');

const { parseTapeLine, replayTape } = require('./lib/tapeReplay');

function parseArgs(argv) {
  const args = { tape: null, top: 10 };
  for (const raw of argv.slice(2)) {
    const m = raw.match(/^--([a-zA-Z]+)=(.*)$/);
    if (!m) continue;
    const [, key, val] = m;
    if (key === 'top') args.top = Number(val);
    else if (key === 'tape') args.tape = val;
  }
  return args;
}

async function readTapeFile(tapePath) {
  const snapshots = [];
  let corruptLines = 0;
  const rl = readline.createInterface({ input: fs.createReadStream(tapePath), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const parsed = parseTapeLine(line);
    if (parsed) snapshots.push(parsed);
    else corruptLines++;
  }
  return { snapshots, corruptLines };
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.tape) {
    console.error('❌ Falta --tape=<ruta al archivo .jsonl grabado con scripts/tapeRecorder.js>');
    process.exit(1);
  }
  if (!fs.existsSync(args.tape)) {
    console.error(`❌ No existe el archivo: ${args.tape}`);
    process.exit(1);
  }

  console.log(`📂 Leyendo grabación: ${args.tape}`);
  const { snapshots, corruptLines } = await readTapeFile(args.tape);
  if (corruptLines > 0) {
    console.warn(`⚠️  ${corruptLines} línea(s) corrupta(s) o con forma inválida — ignoradas, no detienen la corrida.`);
  }
  if (snapshots.length === 0) {
    console.error('❌ La grabación no tiene snapshots válidos. No hay nada que reproducir.');
    console.error('   Si el archivo está vacío, revisa que scripts/tapeRecorder.js haya corrido con acceso de red real.');
    process.exit(1);
  }
  console.log(`✅ ${snapshots.length} snapshot(s) válido(s) cargados.`);

  // Requeridos de forma perezosa: opportunityDetection trae su propio
  // opportunity log en memoria (module-level) — este proceso es su propia
  // instancia de Node, así que reproducir la grabación acá nunca toca ni
  // contamina el log del servidor real en producción.
  const { detectOpportunities, getOpportunityLog, resetSessionStats } = require('../server/domain/engines/opportunityDetection');
  const { parameterSweep } = require('../server/domain/engines/arbBacktestEngine');

  resetSessionStats();
  const { processed, skipped, opportunitiesDetected } = replayTape(snapshots, { detectOpportunities });
  console.log(`🔁 Reproducidos ${processed} snapshot(s) (${skipped} inválido(s) omitido(s)), ${opportunitiesDetected} evaluaciones de oportunidad generadas.`);

  const opLog = getOpportunityLog();
  const viableCount = opLog.filter((o) => o.viable).length;
  console.log(`📊 Opportunity log reconstruido: ${opLog.length} entradas (últimas ${opLog.length}, tope 200), ${viableCount} viables.`);

  const sweep = parameterSweep(opLog);
  if (sweep.error) {
    console.error(`❌ Sweep no se pudo correr: ${sweep.error}`);
    console.error('   Esto es honesto, no un bug: se necesitan más datos viables de los que esta grabación capturó.');
    process.exit(1);
  }

  const ranked = sweep.topResults || [];
  const top = ranked.slice(0, Math.max(1, args.top));

  console.log('');
  console.log(`🏆 Top ${top.length} combinaciones de parámetros (mejor: minScore=${sweep.best?.params?.minScore ?? '—'}, cooldownMs=${sweep.best?.params?.cooldownMs ?? '—'}):`);
  console.log('');
  console.log('minScore  cooldownMs  netProfit    sharpe   maxDD    captureRate  trades  stability');
  for (const r of top) {
    const v = r.validate;
    console.log(
      `${String(r.params.minScore).padEnd(9)}` +
      `${String(r.params.cooldownMs).padEnd(12)}` +
      `${String(v.totalNetProfit).padEnd(13)}` +
      `${String(v.sharpeRatio).padEnd(9)}` +
      `${String(v.maxDrawdown + '%').padEnd(9)}` +
      `${String(v.captureRate + '%').padEnd(13)}` +
      `${String(v.tradesExecuted).padEnd(8)}` +
      `${r.sharpeStability != null ? r.sharpeStability : '—'}`,
    );
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error('❌ Fallo inesperado del experiment sweep:', e.message);
    process.exit(1);
  });
}

module.exports = { parseArgs, readTapeFile };
