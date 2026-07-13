# ADR-014 — Estrategia de migraciones de base de datos

**Status:** Accepted
**Date:** 2026-07-04
**Deciders:** Engineering Lead (CTO)
**Contexto de origen:** L-5 de `implementation_plan.md` ("estrategia de migraciones de DB")

---

## Contexto

Auditoría real del repo antes de decidir (no asumida): no existe ninguna
carpeta `migrations/`, ninguna dependencia de migración instalada
(`migrate-mongo`, `umzug`, etc. — verificado en `package.json`), y ningún
script de migración versionado en ningún lado del código. Los 7 schemas
de Mongoose del proyecto (`server/models.js`: modelos de cuenta/usuario;
`server/infrastructure/persistence/models/`: `HeatmapBucket`,
`DailyReportDoc`, `ExecutionRecord`, `ReplaySnapshot`, `DailyStatsDoc`,
`SessionDoc`; más `ArbitrageOp` en `server-types/server/walletManager.ts`,
ver ADR-010) han evolucionado hasta ahora **solo por adición** — campos
nuevos con `default:` o sin `required:`, nunca un rename o eliminación
de campo existente. Es precisamente por eso que el proyecto nunca sintió
la falta de una herramienta de migración: Mongoose no exige que un
documento viejo tenga los campos nuevos, así que "migrar" hasta ahora
significaba simplemente desplegar el nuevo schema y dejar que los campos
default se aplicaran de forma perezosa en el próximo `save()`.

Esa estrategia implícita deja de funcionar en el momento en que se
necesite: renombrar un campo, cambiar su tipo, eliminarlo, o backfillear
datos históricos con un cálculo derivado. Ninguno de esos casos existe
hoy en el backlog real del proyecto — esta ADR no resuelve una migración
pendiente concreta, resuelve la ausencia de un proceso para cuando
aparezca una.

## Decisión

**Adoptar un runner de migraciones mínimo y explícito, sin agregar una
dependencia externa nueva, hasta que la primera migración real (no
aditiva) lo justifique.**

1. **Convención de carpeta**: `server/infrastructure/persistence/migrations/`,
   un archivo por migración, nombrado `NNNN_descripcion-corta.js`
   (`0001_ejemplo.js`, `0002_...`), cada uno exportando `{ up, down }` como
   funciones async que reciben la conexión de Mongoose ya establecida.
   Se crea la carpeta con un `README.md` documentando la convención, sin
   ninguna migración real todavía (no hay ninguna pendiente hoy).
2. **Sin dependencia externa por ahora**: no instalar `migrate-mongo` ni
   `umzug` hoy. El volumen actual (7 schemas, evolución solo aditiva) no
   justifica una dependencia nueva con su propio modelo de tracking de
   estado (colección `_migrations`, locks, CLI propio). Si aparece una
   migración real no aditiva, evaluar en ese momento si el runner casero
   sigue siendo suficiente o si se justifica adoptar una librería — con
   el proceso ya en marcha, esa decisión futura tiene contexto real en
   vez de ser especulativa como sería hoy.
3. **Regla de proceso, no de código**: cualquier cambio de schema que
   **no** sea puramente aditivo (rename, cambio de tipo, eliminación de
   campo, backfill de datos existentes) requiere un archivo de migración
   en la carpeta anterior, ejecutado manualmente antes del despliegue
   (mismo criterio de disciplina manual y explícita que ya usa
   ADR-013 para la compilación de TypeScript — preferible a automatizar
   un paso que toca datos de producción sin revisión humana).
4. **Cambios aditivos** (campo nuevo con default, índice nuevo) **no**
   requieren migración formal — siguen el patrón actual que ya funciona.

## Consecuencias

**Positivas:**
- Resuelve la ambigüedad real que señalaba el plan original: ya existe
  un lugar y una convención documentada para la primera migración no
  aditiva que aparezca, en vez de tener que improvisar el proceso bajo
  presión cuando eso pase.
- Cero dependencias nuevas, cero riesgo de introducir un framework de
  migración sin necesidad real — coherente con la prioridad de
  estabilidad hasta el 12 de julio (ver Sesión 14 de
  `MIGRATION_CLEANUP_LOG.md`).
- Cero cambios de comportamiento — como ADR-010/011/012/013, es
  puramente declarativa más una carpeta vacía con convención.

**Negativas:**
- El runner "casero" (ejecución manual de `up`/`down`, sin tracking de
  qué migraciones ya corrieron en cada entorno) es menos robusto que una
  librería madura. Aceptado por ahora — el volumen de migraciones reales
  esperado en el corto plazo es cero a bajo.
- Si el proyecto crece a necesitar migraciones frecuentes, esta decisión
  debe revisarse (ver alternativa considerada abajo).

## Alternativas consideradas

- **Adoptar `migrate-mongo` ahora, aunque no haya ninguna migración
  pendiente**: rechazado por ahora — agrega una dependencia y una
  colección de estado (`changelog`) para un caso de uso que hoy no
  existe. Es exactamente el tipo de trabajo especulativo que la decisión
  de CTO de la Sesión 14 pidió evitar antes del 12 de julio. Revisar
  después de la evaluación si el ritmo de cambios de schema lo justifica.
- **No hacer nada / dejar la estrategia implícita actual**: rechazado —
  es lo que generó el ítem L-5 en primer lugar; sin ningún lugar
  designado, la primera migración no aditiva real se improvisaría bajo
  presión, con mayor riesgo sobre datos de producción financieros.
- **Migraciones automáticas al boot del servidor** (correr migraciones
  pendientes en `server/index.js` al arrancar): rechazado — mismo
  argumento que ADR-013 usa para rechazar que CI compile TS
  automáticamente: tocar datos de producción sin revisión humana
  explícita no es aceptable para el núcleo financiero de este sistema.
