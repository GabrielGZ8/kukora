#!/usr/bin/env node
'use strict';

/**
 * scripts/tapeRecorder.js — Iniciativa 3 del plan competitivo.
 *
 * Graba snapshots crudos de order books (los mismos 5 exchanges que usa
 * el motor en vivo — Binance, Kraken, Bybit, OKX, Coinbase) a un archivo
 * JSON Lines, a intervalos regulares, durante una duración fija. El
 * archivo resultante puede reproducirse offline con
 * `scripts/experimentSweep.js` para correr un parameter sweep
 * determinístico sobre esas condiciones de mercado exactas.
 *
 * IMPORTANTE — requiere acceso de red real a los exchanges: este script
 * llama a `exchangeService.getOrderBooks()`, que hace fetch REST directo
 * a las APIs públicas de cada exchange (Binance, Kraken, Bybit, OKX,
 * Coinbase). En un entorno de desarrollo con egress de red restringido
 * (p. ej. un sandbox limitado a registries de npm/GitHub), cada llamada
 * fallará con un error de red — el script lo reporta explícitamente por
 * snapshot y sigue intentando en el siguiente intervalo, en vez de
 * fallar la corrida completa o inventar datos. En producción (Railway,
 * o cualquier entorno con salida a internet sin restricciones) las
 * llamadas funcionan igual que las que ya hace el bot en vivo.
 *
 * Uso:
 *   node scripts/tapeRecorder.js [--duration=60] [--interval=5] [--out=data/tapes/tape.jsonl]
 *
 *   --duration  segundos totales de grabación (default: 60)
 *   --interval  segundos entre snapshots (default: 5)
 *   --out       ruta del archivo JSONL de salida (default: data/tapes/tape-<timestamp>.jsonl)
 */

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const args = { duration: 60, interval: 5, out: null };
  for (const raw of argv.slice(2)) {
    const m = raw.match(/^--([a-zA-Z]+)=(.*)$/);
    if (!m) continue;
    const [, key, val] = m;
    if (key === 'duration' || key === 'interval') args[key] = Number(val);
    else if (key === 'out') args.out = val;
  }
  return args;
}

function defaultOutPath() {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join('data', 'tapes', `tape-${ts}.jsonl`);
}

async function main() {
  const args = parseArgs(process.argv);
  if (!Number.isFinite(args.duration) || args.duration <= 0) {
    console.error('❌ --duration debe ser un número de segundos > 0');
    process.exit(1);
  }
  if (!Number.isFinite(args.interval) || args.interval <= 0) {
    console.error('❌ --interval debe ser un número de segundos > 0');
    process.exit(1);
  }

  const outPath = args.out || defaultOutPath();
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const stream = fs.createWriteStream(outPath, { flags: 'a' });

  // Requerido de forma perezosa (después de validar args): exchangeService
  // hace fetch real de red al importarse solo si se llama getOrderBooks(),
  // no al hacer require() (ver nota "C-1 fix" en el propio archivo — abrir
  // conexiones es explícito vía init(), que este script NUNCA llama, así
  // que solo usa el camino REST de fallback, nunca WS).
  const { getOrderBooks } = require('../server/infrastructure/exchangeService');

  const totalTicks = Math.ceil(args.duration / args.interval);
  console.log(`🎙️  Grabando ${totalTicks} snapshots cada ${args.interval}s (duración total ~${args.duration}s) → ${outPath}`);

  let recorded = 0;
  let networkErrors = 0;

  for (let tick = 0; tick < totalTicks; tick++) {
    const tickStart = Date.now();
    try {
      const orderBooks = await getOrderBooks();
      const allErrored = Array.isArray(orderBooks) && orderBooks.length > 0
        && orderBooks.every((ob) => ob && ob.error);
      if (allErrored) {
        networkErrors++;
        console.warn(`⚠️  [${tick + 1}/${totalTicks}] Todos los exchanges devolvieron error — ¿sin acceso de red saliente? Sigo intentando.`);
      } else {
        const snapshot = { ts: new Date().toISOString(), orderBooks };
        stream.write(JSON.stringify(snapshot) + '\n');
        recorded++;
        console.log(`✅ [${tick + 1}/${totalTicks}] Snapshot grabado (${orderBooks.filter((ob) => !ob?.error).length}/${orderBooks.length} exchanges con datos válidos)`);
      }
    } catch (e) {
      networkErrors++;
      console.warn(`⚠️  [${tick + 1}/${totalTicks}] Error de red: ${e.message} — sigo intentando en el próximo intervalo.`);
    }

    const elapsed = Date.now() - tickStart;
    const waitMs = Math.max(0, args.interval * 1000 - elapsed);
    if (tick < totalTicks - 1 && waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
  }

  stream.end();

  console.log('');
  console.log(`📼 Grabación terminada: ${recorded} snapshots válidos, ${networkErrors} intentos con error de red, archivo: ${outPath}`);
  if (recorded === 0) {
    console.log('   Ningún snapshot válido se grabó — esto es esperado en un entorno sin salida de red a exchanges');
    console.log('   externos (p. ej. un sandbox de desarrollo con egress restringido a registries de paquetes).');
    console.log('   Corre este script en el entorno de producción/desarrollo real (con acceso a internet) para');
    console.log('   grabar una sesión reproducible, y luego usa scripts/experimentSweep.js --tape=' + outPath);
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error('❌ Fallo inesperado del tape recorder:', e.message);
    process.exit(1);
  });
}

module.exports = { parseArgs, defaultOutPath };
