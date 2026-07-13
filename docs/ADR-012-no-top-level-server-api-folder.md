# ADR-012 — No introducir una carpeta `server/api/` de nivel superior (por ahora)

**Status:** Rejected (por ahora — revisable si el equipo crece)
**Date:** 2026-07-02
**Deciders:** Engineering Lead
**Contexto de origen:** Pendiente #3/#4 de `MIGRATION_CLEANUP_LOG.md` — sugerencia
del análisis externo (ChatGPT) de reorganizar bajo
`api/ · application/ · domain/ · infrastructure/ · shared/`.

---

## Contexto

El análisis externo sugirió envolver la estructura actual de `server/` bajo
una carpeta `api/` de nivel superior, junto a `application/`, `domain/`,
`infrastructure/` y una nueva `shared/`. La intención es razonable en
abstracto: hacer explícito, de un vistazo, que existe una capa de "interfaz
HTTP" separada del resto.

## Decisión

**No introducir `server/api/` en este momento.** El repo ya tiene esa capa
— se llama `server/routes/` (más `server/arbitrage/subroutes/` para el único
feature que la necesita, ver ADR-011) — y ya cumple exactamente el rol que
`api/` cumpliría en la taxonomía sugerida.

Evaluado el cambio concreto que implicaría:

1. **Mover `server/routes/` → `server/api/`**: es un rename 1:1 de una
   carpeta que ya existe y ya es el punto de entrada HTTP. No añade
   información nueva — solo cambia una palabra. El costo (tocar el único
   `require` en `server/index.js` por cada route file, más cualquier test
   que importe rutas directamente) es real y el beneficio es
   exclusivamente estético.
2. **Envolver `domain/`, `application/`, `infrastructure/` dentro de un
   `server/api/` compartido**: esto invierte el significado habitual de
   "api" en una arquitectura hexagonal/clean (donde `api` es la capa más
   externa, no un contenedor de todo). Haría el árbol más confuso, no
   menos, y tocaría literalmente cada `require(...)` del proyecto — el tipo
   de refactor de alcance masivo que la sesión anterior evitó
   deliberadamente por buena razón (ver "Qué se hizo" en
   `MIGRATION_CLEANUP_LOG.md`: cambios verificados en capas pequeñas, no un
   solo movimiento gigante).
3. **Crear `shared/`**: no hay hoy código genuinamente compartido entre
   `domain/`, `application/` e `infrastructure/` que no tenga ya un hogar
   natural (utils viven donde se usan; no se detectó duplicación cruzada al
   escanear por contenido durante la limpieza de shims). Crear la carpeta
   sin contenido real que mover sería estructura especulativa.

En resumen: la taxonomía sugerida (`api / application / domain /
infrastructure`) **ya existe**, solo que la capa `api` se llama `routes`.
Renombrar una carpeta que ya cumple su función, a costo de tocar ~10
archivos de wiring y tests, no mueve la aguja en claridad arquitectónica —
y el resto de la sugerencia (envolver todo, crear `shared/`) activamente la
empeora.

## Consecuencias

**Positivas:**
- Se evita un refactor de alcance amplio y bajo beneficio marginal, en línea
  con la disciplina de "verificar cada cambio por separado" que ya guio la
  limpieza de shims.
- La estructura actual (`domain/ · application/ · infrastructure/ · routes/
  · repositories/ · arbitrage/`) queda validada explícitamente como
  suficiente, en vez de dejar la pregunta abierta indefinidamente.

**Negativas:**
- Si un revisor externo compara literalmente contra la taxonomía sugerida
  (`api/` con ese nombre exacto), puede leer la ausencia de una carpeta
  llamada `api/` como que la sugerencia "no se atendió". Mitigado por esta
  ADR, que dirige explícitamente a `server/routes/` como el equivalente
  funcional.

## Revisión futura

Esta decisión es revisable si: (a) el equipo crece lo suficiente como para
que el costo de un rename de 10 archivos se vuelva trivial en comparación
con el valor de alinear terminología con literatura estándar, o (b) aparece
código genuinamente compartido entre las tres capas que justifique un
`shared/` real (no especulativo).
