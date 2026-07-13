# ADR-010 — `server/models.js` se mantiene separado de `server/infrastructure/persistence/models/`

**Status:** Accepted
**Date:** 2026-07-02
**Deciders:** Engineering Lead
**Contexto de origen:** Pendiente #1 de `MIGRATION_CLEANUP_LOG.md` (cierre de la migración `domain/application/infrastructure`)

---

## Contexto

Tras eliminar los 79 shims de la raíz de `server/`, quedaron exactamente dos
archivos legítimos en `server/`: `index.js` (entry point) y `models.js`. Este
último no es un shim — es un archivo real de ~200 líneas con schemas de
Mongoose. La pregunta abierta era si debía moverse también a
`server/infrastructure/persistence/models/`, junto con los 6 modelos
operacionales (`HeatmapBucket`, `DailyReportDoc`, `ExecutionRecord`,
`ReplaySnapshot`, `DailyStatsDoc`, `SessionDoc`), o si la separación actual
tiene una justificación real.

El propio `server/infrastructure/persistence/models/index.js` ya documentaba
(desde antes de esta sesión, comentario "audit v2, section 1.3") una
intención explícita:

> Los 8 modelos "oficiales" de dominio de consumidor (User, Alert, Watchlist,
> Portfolio, Notification, etc.) siguen viviendo en `server/models.js` —
> dejados ahí para evitar un rename de amplio radio de cada archivo de rutas
> que hace `require('./models')` — pero también se re-exportan aquí.

Es decir: la separación ya era una decisión de diseño tomada, solo que nunca
se elevó a ADR formal. Esta ADR la ratifica explícitamente.

## Decisión

**Mantener `server/models.js` separado de
`server/infrastructure/persistence/models/`,** con la siguiente distinción
de responsabilidad:

- **`server/models.js`** — modelos de **dominio de consumidor / cuenta**:
  `User` y los modelos asociados a la sesión de un usuario final (auth,
  perfil, preferencias). Son modelos que **rutas de negocio** (`watchlist`,
  `portfolio`, `notifications`, `alerts`) consultan directamente por
  identidad de usuario.
- **`server/infrastructure/persistence/models/`** — modelos
  **operacionales / de motor**: `HeatmapBucket`, `DailyReportDoc`,
  `ExecutionRecord`, `ReplaySnapshot`, `DailyStatsDoc`, `SessionDoc`. Son
  modelos que el motor de arbitraje escribe internamente (telemetría,
  snapshots, reportes) y que ningún endpoint de negocio "consulta como
  dominio propio" — se consumen desde `infrastructure/` (persistencia,
  replay, reporting).

Ambos quedan expuestos desde un único punto de entrada
(`server/infrastructure/persistence/models/index.js` re-exporta
`server/models.js` junto con los 6 modelos operacionales), así que
`require('../infrastructure/persistence/models')` sigue siendo la forma
recomendada de importar *cualquier* modelo — la separación física es interna,
no una fuga de abstracción hacia quien consume.

**Excepción ya documentada y fuera de alcance de esta ADR:** `ArbitrageOp`
(definido en `server-types/server/walletManager.ts`, compilado vía `tsc`) no
vive en ninguna de las dos carpetas de modelos — está en el núcleo
financiero migrado a TypeScript. Moverlo requiere re-tipar en el mismo
pipeline de compilación, no un edit manual del `.js` generado. Se mantiene
como pendiente de una migración TS futura, no de esta ADR.

## Consecuencias

**Positivas:**
- La separación ahora es una decisión documentada, no un artefacto de
  migración incompleta — resuelve la ambigüedad que señalaba el audit
  externo sobre "modelos de Mongoose definidos en 7 archivos distintos".
- `server/models.js` (auth/cuenta) y `infrastructure/persistence/models/`
  (operacional) mapean 1:1 a dos bounded contexts reales del negocio: gestión
  de identidad vs. telemetría del motor de trading. No es una separación
  arbitraria.
- Cero cambios de código — esta ADR es puramente declarativa.

**Negativas:**
- `server/models.js` sigue siendo el único archivo con lógica real fuera de
  `domain/`, `application/`, `infrastructure/`, `routes/`. Un lector nuevo
  puede preguntarse por qué no vive en `server/domain/models/user.js` o
  similar. Mitigado por esta ADR y por el comentario ya existente en
  `infrastructure/persistence/models/index.js`.

## Alternativas consideradas

- **Mover `server/models.js` completo a
  `infrastructure/persistence/models/user.js`**: rechazado por ahora. Tiene
  el mismo argumento de "radio de cambio amplio" que ya frenó el move
  anterior (~15+ archivos de rutas y tests hacen
  `require('../models')` o `require('./models')` directamente), y no
  resuelve ninguna inconsistencia real de dominio — solo reduce en uno el
  número de archivos en la raíz de `server/`, que ya bajó de 78 a 2. El
  costo/beneficio no lo justifica en este momento.
- **Mover los 6 modelos operacionales fuera de `infrastructure/` a
  `domain/`**: rechazado — son modelos de persistencia pura (schemas de
  Mongoose), no lógica de negocio; `infrastructure/` es la capa correcta.
