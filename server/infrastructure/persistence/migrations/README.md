# Migraciones de base de datos

Ver `docs/ADR-014-db-migration-strategy.md` para el contexto y la decisión completa.

## Convención

- Un archivo por migración: `NNNN_descripcion-corta.js` (ej. `0001_rename_pnl_field.js`).
- Cada archivo exporta `{ up, down }`, funciones `async` que reciben la conexión
  de Mongoose ya establecida (`mongoose.connection`).
- Ejecución manual, no automatizada al boot ni en CI (mismo criterio que
  ADR-013 usa para la compilación de TypeScript: no tocar datos de
  producción sin revisión humana explícita).

## Cuándo hace falta una migración formal aquí

- **Sí**: rename de campo, cambio de tipo, eliminación de campo, backfill
  de datos existentes.
- **No**: campo nuevo con `default:` o sin `required:` — Mongoose ya
  aplica esos casos de forma perezosa sin migración (patrón que este
  proyecto viene usando desde antes de esta ADR).

## Estado actual

Ninguna migración pendiente ni ejecutada todavía — esta carpeta se creó
de forma preventiva (L-5), no porque exista un cambio de schema real en
curso.
