'use strict';
/**
 * scripts/checkI18nCoverage.js — H-10 (Sesión 26)
 *
 * Verifica que src/i18n/dictionaries/es.js y en.js tengan exactamente el
 * mismo conjunto de llaves (recursivamente). Una llave presente en un
 * idioma y ausente en el otro es un bug real: o bien se ve el texto en el
 * idioma equivocado, o se ve la key cruda sin traducir. Mismo espíritu que
 * scripts/checkTsBuildDrift.js (C-5 / ADR-013) — una comprobación barata
 * y determinística en vez de confiar en que nadie se olvide de traducir
 * una llave nueva.
 *
 * No escribe nada en disco — solo lee y compara.
 */

const path = require('path');

function collectKeys(obj, prefix = '') {
  const keys = [];
  for (const [k, v] of Object.entries(obj)) {
    const full = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      keys.push(...collectKeys(v, full));
    } else {
      keys.push(full);
    }
  }
  return keys;
}

function main() {
  // Los diccionarios son ESM (`export default`) — usamos require con
  // interop manual en vez de import() dinámico para mantener este script
  // consistente con checkTsBuildDrift.js (CommonJS, sin necesidad de
  // await top-level ni de marcar el script como módulo ESM).
  const esPath = path.join(__dirname, '..', 'src', 'i18n', 'dictionaries', 'es.js');
  const enPath = path.join(__dirname, '..', 'src', 'i18n', 'dictionaries', 'en.js');

  delete require.cache[require.resolve(esPath)];
  delete require.cache[require.resolve(enPath)];

  // Los archivos usan `export default` (sintaxis ESM) — Node no puede
  // requerirlos directamente sin transpilar. Se extrae el objeto literal
  // vía un pequeño shim: leer el archivo y evaluarlo como CommonJS
  // reemplazando `export default` por `module.exports =`.
  const fs = require('fs');
  function loadEsmDictAsCjs(filePath) {
    const src = fs.readFileSync(filePath, 'utf8').replace('export default', 'module.exports =');
    const Module = require('module');
    const m = new Module(filePath, module);
    m.filename = filePath;
    m.paths = Module._nodeModulePaths(path.dirname(filePath));
    m._compile(src, filePath);
    return m.exports;
  }

  const es = loadEsmDictAsCjs(esPath);
  const en = loadEsmDictAsCjs(enPath);

  const esKeys = new Set(collectKeys(es));
  const enKeys = new Set(collectKeys(en));

  const onlyInEs = [...esKeys].filter(k => !enKeys.has(k));
  const onlyInEn = [...enKeys].filter(k => !esKeys.has(k));

  if (onlyInEs.length === 0 && onlyInEn.length === 0) {
    console.log(`✅ i18n en paridad: es.js y en.js tienen las mismas ${esKeys.size} llaves.`);
    process.exit(0);
  }

  console.error('❌ i18n fuera de paridad entre es.js y en.js:');
  if (onlyInEs.length) {
    console.error(`   Solo en es.js (${onlyInEs.length}): ${onlyInEs.join(', ')}`);
  }
  if (onlyInEn.length) {
    console.error(`   Solo en en.js (${onlyInEn.length}): ${onlyInEn.join(', ')}`);
  }
  process.exit(1);
}

main();
