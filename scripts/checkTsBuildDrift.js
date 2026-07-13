#!/usr/bin/env node
/**
 * checkTsBuildDrift.js — verifica que los .js comiteados bajo server/
 * sean exactamente lo que `tsc` generaría a partir de server-types/*.ts.
 *
 * Contexto (ver docs/ADR-013-server-types-build-relationship.md): los
 * .js compilados se comitean a mano y CI solo corre `tsc --noEmit`
 * (type-check), nunca `tsc` real — por diseño, para no tener un paso de
 * CI que escriba en el repo sin review humano (ver "Alternativas
 * consideradas" en la ADR). Ese diseño es correcto, pero dejaba abierta
 * la puerta al incidente real de la Sesión 3: alguien edita el .js
 * compilado a mano, nadie lo nota hasta que una sesión futura corre
 * `build:ts` y sobreescribe el fix sin querer.
 *
 * Este script cierra ese hueco sin violar la decisión de la ADR: compila
 * a un directorio temporal (nunca al repo real) y compara byte a byte
 * contra los .js comiteados. Falla con exit 1 y un mensaje claro si hay
 * drift. No escribe nada en server/ ni en server-types/.
 */
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const REPO_ROOT = path.resolve(__dirname, '..');
const tmpOutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukora-ts-drift-'));

function listFilesRecursive(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

try {
  execFileSync(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['tsc', '-p', 'tsconfig.json', '--outDir', tmpOutDir],
    { cwd: REPO_ROOT, stdio: 'inherit' }
  );

  const generated = listFilesRecursive(path.join(tmpOutDir, 'server'));
  const drifted = [];

  for (const generatedPath of generated) {
    const relative = path.relative(tmpOutDir, generatedPath); // e.g. server/domain/risk/advancedRiskEngine.js
    const committedPath = path.join(REPO_ROOT, relative);
    if (!fs.existsSync(committedPath)) {
      drifted.push(`${relative} — existe en el build pero no está comiteado`);
      continue;
    }
    const generatedContent = fs.readFileSync(generatedPath, 'utf8');
    const committedContent = fs.readFileSync(committedPath, 'utf8');
    if (generatedContent !== committedContent) {
      drifted.push(`${relative} — el .js comiteado difiere de lo que \`tsc\` generaría`);
    }
  }

  if (drifted.length > 0) {
    console.error('\n❌ DRIFT detectado entre server-types/*.ts y los .js comiteados:\n');
    for (const line of drifted) console.error(`   - ${line}`);
    console.error(
      '\n   Esto significa que un .js "generated build artifact" fue editado a mano\n' +
      '   (el mismo incidente que documenta docs/ADR-013-server-types-build-relationship.md,\n' +
      '   Sesión 3). Corregí: editá el .ts en server-types/ y corré `npm run build:ts`,\n' +
      '   luego `npx vitest run` completo antes de comitear.\n'
    );
    process.exitCode = 1;
  } else {
    console.log(`✅ Sin drift: los .js comiteados coinciden con lo que \`tsc\` generaría (${generated.length} archivos verificados).`);
  }
} finally {
  fs.rmSync(tmpOutDir, { recursive: true, force: true });
}
