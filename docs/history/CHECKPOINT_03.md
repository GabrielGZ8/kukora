# CHECKPOINT_03 — refinamiento post-checkpoint-02 (en progreso)

Sesión de refinamiento de ingeniería (fase "sin funcionalidades nuevas,
solo consistencia y pulido"). Alcance pedido: items 1-6 de la lista del
usuario (el 7, refactorización final, queda explícitamente fuera de esta
sesión). Este checkpoint es un punto intermedio verificado — no el final —
para no arriesgar el progreso si la sesión se corta.

Estado de cada item al momento de este checkpoint:

## Item 4 — Multi-Hop como estrategia opcional: ✅ COMPLETO
- `liveConfig.multiHopEnabled` (default `false`) y `minMultiHopNetPct`
  (default `0.05`), con validators y schema — mismo mecanismo genérico de
  config que todo lo demás, sin endpoints nuevos.
- `arbitrageOrchestrator.js`: bloque de ejecución para `multiHopSignal`,
  espejo exacto del patrón ya existente para `triangular`, gateado por
  `liveConfig.get('multiHopEnabled')`. Con la config por defecto el
  comportamiento es idéntico al de antes (informativo solamente, cero
  costo extra de CPU/latencia/API).
- Documentado en el propio bloque de código el impacto real de activarlo
  (hoy: solo el costo de ejecutar el trade, igual que triangular — el
  grafo actual es mismo-activo/exchange, sin fetches nuevos; la extensión
  multi-activo real que sí requeriría nuevos fetches de libros sigue sin
  conectar a propósito, tal como decidió la sesión anterior).
- 1425+ tests siguen pasando.

## Item 1 — Multi-tenant real: 🟡 PARCIAL — ver decisión pendiente abajo
- Construido `server/infrastructure/tenantStore.js` (+ `.d.ts` + tests):
  mecanismo genérico único de Map-por-uid, perezoso, con fallback a
  `DEFAULT_UID` para cualquier caller que no pase `uid` — reutilizable
  para cualquier estado futuro que sí deba aislarse por usuario.
- `walletManager.ts` refactorizado: wallets, historial de trades, mutex de
  ejecución y P&L ahora son genuinamente aislables por uid
  (`getBalances(uid)`, `applyTrade(trade, uid)`, `resetBalances(uid)`,
  `getTradeHistory(uid)`, `getPnL(btc, eth, uid)`,
  `applyRebalanceTransfer(..., uid)`). 100% retrocompatible — todo caller
  que no pase `uid` sigue operando exactamente como antes (bucket
  `default`). Recompilado con `tsc`, `--noEmit` limpio, tests nuevos
  prueban aislamiento real entre dos uids.
- **HALLAZGO IMPORTANTE que cambia el alcance correcto de este item**:
  al revisar las rutas reales (`stream.routes.js`), `/wallets`, `/history`,
  `/reset`, `/bot` no son operaciones "de un usuario sobre su propia
  cuenta" — son la consola de administración de UN bot compartido:
  `/reset` está gateado por `ADMIN_TOKEN` (no por identidad de usuario) y
  además de los wallets resetea `dailyPnl`, `sessionStats`, `statArb`,
  `intelligence`, `replays`, `benchmark`, `journal`, `scenario`,
  `latencyRacing`, `reliability`, `adaptive`, `alerts`, `equityCurve`,
  `counters` — todo estado de un ÚNICO motor compartido, visto en vivo por
  cualquier usuario autenticado vía SSE. Esto es consistente con la nota ya
  documentada en `userRiskProfileService.js` (detección/scoring es una
  instancia única a propósito) y con `twoFactor.js`/`liveExecution.js`
  (modelo de "un solo operador", donde lo que sí es per-user son los
  límites de riesgo de cada usuario para SU capital/API-keys reales en
  modo live).
- **Decisión pendiente para la próxima sesión (no adiviné para no romper
  el modelo de producto real)**: ¿wallets/paper-trading/bot-on-off deben
  seguir siendo el estado de UN bot compartido (y entonces el trabajo de
  este item se considera terminado con la capacidad ya construida, lista
  para cuando se decida usarla), o el producto realmente quiere N cuentas
  de paper-trading independientes por usuario (lo cual requiere además
  cambiar el loop de ejecución de 150ms para iterar sobre uids activos y
  el broadcast SSE para ser por-usuario, un cambio de arquitectura mayor
  que no se implementó en esta sesión para no arriesgar el sistema)?
- Lo que SÍ quedó explícitamente fuera por ahora: sesiones, oportunidades,
  replay, analytics y caches del motor compartido — mismo argumento que
  arriba, son estado del motor único, no por-usuario, y tocarlos sin la
  decisión anterior resuelta habría sido adivinar dos veces.

## Item 5 — Mongo Atlas: pendiente (siguiente en la cola de esta sesión)
## Item 6 — Explainability: pendiente (siguiente en la cola de esta sesión)
## Item 2 — Config dinámica: pendiente (siguiente en la cola de esta sesión)
## Item 3 — Generalización multipar (XRP): pendiente, alto riesgo/alcance,
   evaluar tiempo restante antes de tocar.

Todo lo anterior está compilado, tipado (`tsc --noEmit` limpio) y con
`npm run build:ts` regenerado. Suite completa: 81 archivos / 1435 tests,
todos pasando.
