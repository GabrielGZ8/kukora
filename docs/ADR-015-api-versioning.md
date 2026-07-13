# ADR-015 — Versionado de API (`/api/v1/*`)

**Status:** Accepted
**Date:** 2026-07-05
**Deciders:** Engineering Lead (CTO)
**Contexto de origen:** H-9 de `implementation_plan.md` ("prefijo `/api/v1/`
para permitir evolución de la API sin romper clientes existentes")

---

## Contexto

H-9 llevaba varias sesiones desbloqueado (Q4, Sesión 14) pero pospuesto a
propósito: la implementación "obvia" — mover todas las rutas de `/api/...`
a `/api/v1/...` y actualizar el frontend (28 páginas, `src/api.js` como
único punto de llamadas) — es un cambio de alto riesgo sin beneficio
inmediato antes del 12 de julio, y exactamente el tipo de refactor
especulativo que la decisión de CTO de la Sesión 14 pidió evitar.

Auditoría real antes de decidir: `src/api.js` centraliza todas las
llamadas del frontend con una única constante base (`/api`), así que un
cambio de prefijo sí sería mecánicamente simple del lado frontend — pero
"simple" no es lo mismo que "sin riesgo": requiere tocar y volver a probar
manualmente las 28 páginas antes de un hackathon, sin necesidad de negocio
real que lo justifique hoy.

## Decisión

**Agregar `/api/v1/*` como alias puramente aditivo de `/api/*`, montando
las mismas instancias de router en ambos prefijos. No se retira, no se
deprecia, y no se planea fecha de corte para `/api/*`.**

```js
app.use(['/api/auth', '/api/v1/auth'], authRouter);
// ...mismo patrón para crypto, arbitrage, notifications, trading,
// alerts, watchlist, portfolio, dataset.
```

Los rate limiters (`apiLimiter`, `financialControlLimiter`) se extendieron
de la misma forma (array de paths) para que `/api/v1/...` tenga
exactamente las mismas protecciones que `/api/...` — no una superficie de
API nueva sin los mismos guardrails.

Los endpoints operacionales internos (`/health`, `/api/readiness`,
`/api/metrics`) quedan fuera del versionado a propósito: no son parte del
contrato de negocio consumido por clientes externos, son para
monitoreo/load balancers.

## Consecuencias

**Positivas:**
- Cierra H-9 de verdad: existe un contrato versionado real, no solo un
  plan de tenerlo.
- Cero riesgo para el frontend actual — `/api/...` sigue funcionando
  exactamente igual, sin ningún cambio de comportamiento ni de código en
  `src/`.
- Cualquier integración nueva (o un futuro cliente externo/partner) puede
  empezar a depender de `/api/v1/...` desde ya, con la garantía implícita
  de que ese contrato no cambiará de forma incompatible sin un `/api/v2/`.
- Migrar el frontend de `/api/` a `/api/v1/` en el futuro (si se decide)
  es un cambio de una sola constante en `src/api.js`, sin apuro.

**Negativas:**
- Dos prefijos activos para siempre (o hasta que se decida lo contrario)
  es una superficie ligeramente mayor que mantener — mismo trade-off que
  cualquier estrategia de versionado aditivo. Aceptado: el costo de
  mantenimiento de una duplicación de mounts (no de lógica — los routers
  son los mismos objetos) es mínimo.
- No resuelve por sí solo el caso de uso que originalmente motivaría un
  `/api/v2/` (un cambio de contrato incompatible) — esa es una decisión
  futura, separada, para cuando aparezca esa necesidad real.

## Alternativas consideradas

- **Migrar todo el frontend a `/api/v1/` ahora y retirar `/api/`**:
  rechazada por el riesgo de re-probar 28 páginas manualmente sin
  necesidad de negocio real antes del 12 de julio.
- **No hacer nada / dejar H-9 pospuesto indefinidamente**: rechazada —
  el alias aditivo tiene costo de implementación mínimo (verificado en
  esta sesión: cero regresiones, cero cambios de comportamiento) y cierra
  el ítem de verdad en vez de seguir posponiéndolo sin razón concreta.
