# ADR-013 — `server-types/` es la fuente TypeScript de un subconjunto de `server/`, compilada manualmente y comiteada

**Status:** Accepted
**Date:** 2026-07-04
**Deciders:** Engineering Lead
**Contexto de origen:** L-1 de `implementation_plan.md` ("`server-types/` directory contains orphaned TypeScript sources... the relationship is unclear and the build process is not documented")

---

## Contexto

`server-types/` no está huérfano — es la fuente TypeScript real de un
subconjunto acotado del núcleo financiero de `server/`. La confusión que
señalaba el audit externo es legítima: la relación nunca se documentó
explícitamente, y la Sesión 3 de `MIGRATION_CLEANUP_LOG.md` ya tuvo que
diagnosticar esto de cero tras una regresión real causada precisamente por
no tenerlo escrito en ningún lado.

Mecánica verificada leyendo `tsconfig.json`, `package.json` y
`.github/workflows/ci.yml` (no asumida):

- `tsconfig.json`: `rootDir: "server-types"`, `outDir: "."`. Esto mapea
  cada `server-types/server/<ruta>.ts` a `server/<ruta>.js` al compilar —
  ej. `server-types/server/domain/risk/advancedRiskEngine.ts` →
  `server/domain/risk/advancedRiskEngine.js`,
  `server-types/server/domain/wallet/walletManager.ts` →
  `server/domain/wallet/walletManager.js`,
  `server-types/server/exchangeAdapter.ts` → `server/exchangeAdapter.js`.
- `package.json` define **dos comandos separados y no equivalentes**:
  - `"typecheck": "tsc --noEmit"` — solo verifica tipos, **no escribe
    ningún archivo**.
  - `"build:ts": "tsc"` — compila de verdad y **sobreescribe** los `.js`
    en `server/domain/` y `server/` con la salida generada.
- `.github/workflows/ci.yml`: el job `test` corre `npx tsc --noEmit`
  (equivalente a `typecheck`). **Ningún job de CI corre `build:ts` ni
  `tsc` sin `--noEmit`.** El `Dockerfile` tampoco lo invoca. No hay
  ningún paso automatizado, en ningún pipeline de este repo, que
  regenere los `.js` compilados.
- Ni `server-types/` ni los `.js` generados en `server/domain/` /
  `server/` están en `.gitignore` — **ambos se comitean al repositorio**:
  el `.ts` fuente y su artefacto `.js` compilado viven juntos en git.

En conjunto, esto significa: **los `.js` compilados que corren en
producción son artefactos comiteados, regenerados manualmente y a mano
por quien edita el `.ts` fuente correspondiente — no algo que CI genere o
verifique más allá de comprobar que el `.ts` sigue compilando sin
errores.**

Cada archivo `.js` generado ya lleva un header explícito
("Never edit ... directly — it is a generated build artifact; edit this
file and run `tsc`"), así que la intención de diseño siempre existió —
solo faltaba documentar el mecanismo completo en un solo lugar.

### El incidente que motivó revisar esto (Sesión 3)

Una sesión anterior editó `server/domain/risk/advancedRiskEngine.js` (el `.js`
compilado) directamente a mano, sin actualizar
`server-types/server/domain/risk/advancedRiskEngine.ts`. En cuanto una sesión
posterior corrió `npx tsc` (`build:ts`) para compilar un fix de
`walletManager.ts`, TypeScript recompiló **todos** los `.ts` de
`server-types/`, incluyendo `advancedRiskEngine.ts` — y sobrescribió el
`.js` parcheado a mano con una versión que tenía imports rotos
(`../liveConfig` en vez de `../infrastructure/liveConfig`, porque los
stubs `.d.ts` seguían apuntando a rutas planas viejas). Resultado: 16
tests rotos con `Cannot find module`. La causa raíz real no era el `.js`
editado a mano — era que los `.d.ts` de `server-types/server/*.d.ts`
estaban desalineados con la ubicación real de los módulos tras la
reorganización a `domain/`/`infrastructure/`. Se corrigió moviendo los
`.d.ts` a rutas espejo (`server-types/server/infrastructure/*.d.ts`, etc.)
y arreglando los imports en los `.ts` fuente. Ver Sesión 3 completa en
`MIGRATION_CLEANUP_LOG.md` para el detalle.

## Decisión

**Mantener `server-types/` como está — fuente TypeScript real, compilada
manualmente, sin integrarla a ningún paso automatizado de CI/build** —
con las siguientes reglas explícitas, ahora documentadas formalmente:

1. **Nunca editar a mano** un archivo bajo `server/domain/`,
   `server/exchangeAdapter.js`, o cualquier otro `.js` que tenga el header
   "generated build artifact". Si hace falta un cambio de lógica en esos
   archivos, editar el `.ts` correspondiente en `server-types/server/` y
   correr `npm run build:ts` para regenerarlo.
2. **Después de correr `npm run build:ts`, correr la suite completa**
   (`npx vitest run`) antes de comitear — la compilación puede tocar
   *todos* los `.ts` del proyecto en una sola pasada (como pasó en el
   incidente de la Sesión 3), no solo el archivo que se quería cambiar.
3. **CI intencionalmente solo tipa-chequea (`tsc --noEmit`), nunca
   compila y sobreescribe.** Esto es correcto tal como está: si CI
   corriera `build:ts`, el pipeline modificaría archivos del repo en
   cada build sin comitear el resultado, lo cual generaría drift
   silencioso entre lo que corre en CI/producción (compilado en el
   momento) y lo que está en git (compilado la última vez que un humano
   corrió `build:ts` localmente). Mantener la compilación manual y
   explícita es más seguro para un sistema financiero, aunque signifique
   confiar en la disciplina de quien edita el `.ts`.
4. **Los `.d.ts` bajo `server-types/server/**` deben reflejar la
   ubicación real de los módulos JS que describen** (ya corregido en la
   Sesión 3: viven en `server-types/server/infrastructure/*.d.ts` y
   `server-types/server/domain/*.d.ts`, no en rutas planas). Si el
   proyecto vuelve a reorganizar carpetas dentro de `server/`, estos
   `.d.ts` deben moverse en el mismo commit — de lo contrario `tsc`
   fallará en CI la próxima vez que alguien toque el `.ts` fuente
   correspondiente (el fallo sería inmediato y detectado en CI, no
   silencioso — pero prevenirlo es más barato que diagnosticarlo).

## Consecuencias

**Positivas:**
- Resuelve la ambigüedad exacta que señalaba el audit externo: ya no hay
  ninguna pregunta abierta sobre "es esto código huérfano o parte real
  del build" — está documentado con la mecánica exacta y verificada.
- El incidente de la Sesión 3 queda con causa raíz documentada en un solo
  lugar de referencia (esta ADR + el detalle ya existente en el log), en
  vez de quedar solo enterrado en el historial de sesiones.
- Cero cambios de código — como ADR-010/011/012, esta es puramente
  declarativa.

**Negativas:**
- La compilación manual sigue siendo un proceso que depende de que un
  humano recuerde correr `build:ts` y la suite completa después de tocar
  cualquier `.ts` en `server-types/`. Esto no se automatiza con esta ADR
  — es una decisión consciente (ver alternativas abajo), no un
  descuido.
- Un colaborador nuevo que no lea esta ADR puede volver a cometer el
  mismo error de la Sesión 3 (editar el `.js` compilado a mano). Mitigado
  por el header ya presente en cada archivo generado, y ahora también por
  esta ADR.

## Alternativas consideradas

- **Integrar `build:ts` a CI y comitear el resultado automáticamente
  (bot commit)**: rechazado. Añade complejidad de permisos de escritura
  al repo desde CI y un vector de commits automáticos sin revisión humana
  en el núcleo financiero del sistema — el costo de seguridad/auditoría
  no se justifica frente al costo actual (disciplina manual + `tsc
  --noEmit` como red de seguridad en cada PR).
- **Eliminar `server-types/` y reescribir esos módulos directamente en
  JS**: rechazado — perdería el chequeo de tipos estricto
  (`strict: true`, `noImplicitAny: true`) que ya existe hoy para el
  núcleo financiero más sensible (`walletManager`, `advancedRiskEngine`),
  que es precisamente donde más vale la pena tenerlo. Revertir TypeScript
  a JS puro es además una de las Open Questions del plan (Q1) sin
  responder por el usuario — no es una decisión que corresponda tomar
  unilateralmente en esta ADR.
- **Mover `server-types/` a vivir junto a cada `.js` que genera (ej.
  `server/domain/risk/advancedRiskEngine.ts` junto a
  `server/domain/risk/advancedRiskEngine.js`)**: rechazado por ahora — el
  `rootDir`/`outDir` actual ya funciona y está verificado; mezclar fuente
  `.ts` y artefacto `.js` en el mismo directorio aumenta el riesgo de que
  alguien edite el archivo equivocado por estar uno al lado del otro,
  exactamente el error que causó el incidente de la Sesión 3. Mantenerlos
  en árboles separados (`server-types/` vs `server/`) hace más difícil
  confundirlos.
