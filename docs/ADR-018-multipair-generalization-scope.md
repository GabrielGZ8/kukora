# ADR-018 — Generalización multipar (item 3): qué se generalizó y qué depende de exchangeService

**Status**: Accepted (parte segura implementada; resto depende de un cambio de mayor riesgo, ver abajo)
**Date**: 2026-07-07

## Contexto

"XRP existe parcialmente" — auditoría de esta sesión confirmó exactamente
dónde y por qué:

1. **Bug real de contabilidad** (corregido): `walletManager.ts` y
   `opportunityDetection.js` resolvían el bucket de wallet con
   `asset === 'ETH' ? 'ETH' : 'BTC'`. Cualquier asset que no fuera
   exactamente `'ETH'` — incluida XRP — se contabilizaba silenciosamente
   como BTC. Un trade "XRP" debitaba/acreditaba el wallet de BTC bajo una
   etiqueta falsa. Mismo patrón de bug que H-6 (Sesión 20) cerró para ETH,
   nunca extendido a un tercer asset.
2. **Fee table incompleta** (corregido): `WITHDRAWAL_FEES` solo tenía
   entradas BTC/USDT — ETH y XRP siempre caían al fallback plano de $6.
3. **Bug de dirección de hedge** (corregido, `tradeStateMachine.js`):
   `planHedge` adivinaba la dirección del hedge por identidad del asset
   (`asset === 'BTC' ? SELL : BUY`) en vez de por la dirección real de la
   exposición — ni siquiera era correcto para BTC vs ETH, y se rompía en
   silencio para cualquier tercer asset.
4. **exchangeService solo tiene feeds reales para BTC y ETH** (NO
   corregido esta sesión — ver razonamiento abajo). `multiPairService.
   getOrderBooksForPair()` usa `getOrderBooks()`/`getOrderBooksETH()`
   (WebSocket, 5 exchanges) para BTC/ETH, pero cae a un fallback REST de
   UN SOLO exchange (Binance) para XRP/SOL/BNB. Sin datos multi-exchange
   reales, **no existe spread cross-exchange que detectar para XRP** — el
   motor de arbitraje literalmente no puede encontrar oportunidades XRP
   viables, sin importar qué tan bien esté generalizado el resto del
   pipeline. Esta es la causa raíz real de "XRP existe parcialmente".
5. **rebalanceEngine solo rebalancea BTC/USDT** (NO corregido esta sesión
   — ver razonamiento abajo). `analyzeBalance()`/`suggestRebalance()`
   solo detectan desbalance de USDT y BTC; ETH y XRP nunca se analizan.
   `executeRebalance()` tiene un allowlist explícito que rechaza
   cualquier otro asset.

## Implementado y verificado esta sesión

- `Wallets` (walletManager.ts): XRP como bucket real de primera clase,
  mismo patrón que ETH (env var `WALLET_XRP`, mismo tamaño relativo).
- `resolveWalletAsset()`: un solo punto de verdad para el bucket check,
  reemplaza las dos ternarias hardcodeadas.
- `WITHDRAWAL_FEES` / `WithdrawalFee`: entradas reales para ETH y XRP en
  los 5 exchanges (valores de referencia, mismo caveat que ya aplicaba a
  BTC/USDT — no son fetched en vivo).
- `getPnL()`: 4º parámetro opcional `currentXrpPrice`, retrocompatible.
- `planHedge()`: dirección explícita (`direction: 'long'|'short'`) en vez
  de adivinar por asset — corrige el bug también para BTC/ETH, no solo
  para XRP.
- 10 tests nuevos/actualizados verificando el aislamiento real de XRP.

## Por qué NO se tocó exchangeService.js ni se generalizó rebalanceEngine

**exchangeService.js** es el feed de precios en vivo de los 5 exchanges —
el input de TODA decisión del motor. Darle a XRP (y SOL/BNB) el mismo
tratamiento WebSocket multi-exchange que BTC/ETH significa replicar el
mecanismo de conexión+parseo+cache para cada exchange × cada asset nuevo
— el archivo más crítico y de mayor blast radius de todo el sistema. Es,
sin comparación, el cambio de mayor riesgo de todo el backlog restante:
más riesgoso que la Fase B de multi-tenant, porque un error aquí no rompe
una feature nueva — rompe el feed de precios del que depende **todo** lo
que ya funciona hoy para BTC/ETH.

**rebalanceEngine** generalizado (loop de detección de desbalance +
mapa de precios por asset en vez de un solo `btcPrice`, tocando
`analyzeBalance`/`suggestRebalance`/`executeRebalance` y ~6 archivos de
test) depende de lo anterior: rebalancear ETH/XRP entre exchanges no
tiene ningún valor real hasta que existan oportunidades XRP reales que
ejecutar y generen ese desbalance — hoy sería código nuevo sin ningún
camino de ejecución real que lo alcance.

**Recomendación**: tratar "exchangeService generalizado a N assets" como
un ítem de trabajo propio, post-12-julio, con su propio checkpoint y
verificación exhaustiva (no mezclado con otros cambios). Una vez ahí,
generalizar rebalanceEngine es la extensión natural y de bajo riesgo
relativo (mismo patrón que analyzeBalance ya usa para BTC, replicado por
asset en un loop en vez de un bloque hardcodeado).
