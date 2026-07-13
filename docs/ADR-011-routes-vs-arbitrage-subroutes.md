# ADR-011 — `server/routes/` (wiring por feature) vs `server/arbitrage/subroutes/` (split interno de un solo feature)

**Status:** Accepted
**Date:** 2026-07-02
**Deciders:** Engineering Lead
**Contexto de origen:** Pendiente #2 de `MIGRATION_CLEANUP_LOG.md`

---

## Contexto

El audit externo señaló como riesgo de percepción que convivieran dos
carpetas de "routes": `server/routes/` (7 archivos, uno por feature:
`crypto`, `arbitrage`, `portfolio`, `watchlist`, `notifications`, `alerts`,
`dataset`) y `server/arbitrage/routes/` (3 archivos internos del feature de
arbitraje: `stream`, `query`, `config`). Vistas desde afuera, dos carpetas
llamadas "routes" en el mismo repo sugieren una convención inconsistente o
una migración a medias — exactamente el patrón que un jurado o un ingeniero
nuevo penaliza al evaluar madurez arquitectónica.

Al revisar el código (no solo los nombres) la situación real es otra:
`server/arbitrage.routes.js` (ahora `server/routes/arbitrage.routes.js`)
tenía 1247 líneas en un solo archivo antes del audit fix 2.1. Ese fix ya
documentado (ver comentario en `server/arbitrage/index.js`, sección "Audit
fix 2.1") lo partió en 3 sub-routers por responsabilidad (streams SSE,
queries de solo lectura, mutaciones de config), montados desde un archivo
de wiring de ~40 líneas en `server/routes/arbitrage.routes.js`. Es decir:
no son dos convenciones compitiendo por el mismo rol — son dos niveles
distintos de la misma jerarquía:

- `server/routes/*.routes.js` — **capa de wiring HTTP por feature**, uno por
  dominio de negocio, montado directamente en `server/index.js`.
- `server/arbitrage/subroutes/*.routes.js` — **partición interna** de un
  único feature (`arbitrage`) que, sin partirse, sería inmanejable en un
  solo archivo. Ningún otro feature de este repo alcanza ese tamaño, así
  que ningún otro feature necesita este segundo nivel.

El problema real no era la arquitectura — era el nombre. Dos carpetas
llamadas "routes" en el mismo árbol se leen como la misma convención
aplicada dos veces, aunque cumplan roles distintos.

## Decisión

1. **Renombrar `server/arbitrage/routes/` → `server/arbitrage/subroutes/`.**
   Esto es un cambio puramente de nomenclatura (3 archivos movidos, ~20
   referencias de `require(...)`/comentarios actualizadas, sin cambios de
   comportamiento), verificado con la suite completa
   (**1145/1145 tests** después del rename). El nombre ahora comunica
   directamente la relación jerárquica: son *sub*-rutas de un feature, no
   una segunda carpeta de rutas de nivel de aplicación.
2. **No fusionar** `server/routes/` con lo que hoy es
   `server/arbitrage/subroutes/`. Fusionarlas obligaría a: (a) que
   `server/index.js` monte 3 sub-routers de arbitraje directamente en vez
   de 1, perdiendo el punto único de wiring por feature, o (b) que los 6
   features restantes se dividan artificialmente en sub-archivos que no
   necesitan solo para "verse igual" que arbitrage. Ninguna de las dos
   opciones mejora la arquitectura — solo la disfraza.

## Consecuencias

**Positivas:**
- Un lector nuevo que vea `server/arbitrage/subroutes/` entiende de
  inmediato, por el nombre, que es una partición interna de un feature y no
  una segunda convención de routing a nivel de aplicación.
- La jerarquía real (feature-level wiring → sub-routers solo donde el
  tamaño lo justifica) queda explícita sin necesitar leer el código para
  confirmarlo.
- Cero riesgo funcional: rename mecánico, verificado con la suite completa.

**Negativas:**
- Ninguna identificada. Es un cambio de bajo riesgo y alcance acotado.

## Alternativas consideradas

- **Fusionar todo bajo `server/routes/arbitrage/{stream,query,config}.routes.js`**:
  técnicamente viable, pero movería el feature de arbitraje fuera de
  `server/arbitrage/` (que también contiene `index.js`, la orquestación y
  la detección de ese mismo dominio), rompiendo la cohesión de que "todo lo
  de arbitraje vive bajo `server/arbitrage/`". Rechazado: cambia más de lo
  necesario para resolver un problema que era de nombre, no de ubicación.
- **No tocar nada, dejarlo solo documentado**: era la opción por defecto de
  la sesión anterior (evitar mezclar refactors sin verificar). Se descarta
  aquí porque el rename es de bajo riesgo, ya verificado, y resuelve la
  causa raíz de la percepción de inconsistencia en vez de solo explicarla.
