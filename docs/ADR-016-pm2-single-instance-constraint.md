# ADR-016 — PM2 process supervision, single instance by design

**Status**: Accepted
**Date**: 2026-07-04
**Context**: closes the last code-level item in `docs/RoadmapToProduction.md`
Fase 4 ("PM2 cluster mode sigue siendo trabajo real pendiente").

## Decision

Add `ecosystem.config.js` for PM2 process supervision, running the app in
**fork mode with `instances: 1`** — explicitly *not* `exec_mode: 'cluster'`
with multiple instances.

## Why not cluster mode

`server/index.js` boots a single, stateful arbitrage engine per process:

- `server/infrastructure/exchangeService.js` opens exactly 5 live WebSocket
  connections (Binance, Kraken, Bybit, OKX, Coinbase) via its `init()` call
  from the startup sequence (C-1 fix). Every additional process replicates
  this — N cluster workers means 5×N real connections to exchange APIs
  against the same credentials/IP, which risks tripping exchange-side rate
  limits or bans, independent of `exchangeRateLimiter.js` (which limits
  *outbound* calls per exchange per process, not across processes).
- `server/application/arbitrage.state.js` holds the opportunity feed,
  SSE client sets (`sseClients`, `alertsClients`, `notificationClients`),
  and detection loop state in process memory — there is no shared store
  (Redis is used only for one-time SSE stream tickets, not for engine
  state or pub/sub fan-out). A browser's long-lived SSE connection is
  pinned to whichever worker accepted it; if the detection loop that
  computes new opportunities is running in a *different* worker, that
  browser silently stops receiving ticks.
- The 150ms detection loop, risk engine (circuit breakers, drawdown
  tracking), and audited P&L ledger are all singletons. Two unsynchronized
  copies computing risk state independently is worse than one process
  going down — it's silent, incorrect duplication.

None of this is a PM2 problem — it would be true under any multi-process
supervisor (cluster, systemd with multiple units, Kubernetes with
`replicas: 2`, etc.). PM2 cluster mode was the item on the roadmap because
it's the common instinct for "use all my cores," and that instinct is wrong
for this specific architecture without further work.

## What we get from PM2 in fork mode (`instances: 1`)

- Automatic restart on crash, with `max_restarts`/`min_uptime` guards
  against a crash-loop hammering the exchange APIs on every restart.
- `max_memory_restart` as a safety net against slow memory leaks in the
  in-memory arrays (most are capped per module, but this is a backstop).
- Centralized log files (`logs/pm2-out.log`, `logs/pm2-error.log`).
- Compatible graceful shutdown for free: PM2's default stop signal is
  `SIGINT`, which `server/index.js`'s `shutdown()` coordinator (C-4 fix)
  already handles identically to `SIGTERM` — no code changes needed.

This complements, rather than replaces, Railway's own
`restartPolicyType: ON_FAILURE` in `railway.json`. PM2 is documented here
for non-Railway deployments (bare VM, on-prem, or a Docker host that isn't
using the platform's own supervisor).

## If real multi-core scaling is needed later

The correct path is **not** flipping `instances` to `max`. It's splitting
the process:

1. One long-running **engine** process: owns the 5 exchange WS connections,
   runs the detection/risk/scoring loop, and is the only writer to a shared
   store (Redis pub/sub or a message queue) for opportunity ticks and SSE
   fan-out.
2. N stateless **API** replicas: serve REST endpoints and subscribe to the
   engine's pub/sub channel to fan out SSE to their own connected clients,
   with no exchange WebSocket connections and no independent risk-engine
   state of their own.

That is a real architectural change (new pub/sub wiring, a leader/replica
split in `server/index.js`), not a one-line config flip — it's out of scope
here and should be its own ADR when the need is real (i.e. when a single
process's CPU becomes the actual bottleneck, which the 150ms detection loop
budget suggests is far off for 5 exchanges / 2 pairs).

## Consequences

- `npm run pm2:start` / `pm2:stop` / `pm2:restart` / `pm2:logs` /
  `pm2:status` are available as an alternative to `npm start` for
  deployments that want process supervision outside of Railway.
- `pm2 reload` (used by `npm run pm2:restart`) sends the app's own graceful
  shutdown sequence before restarting, so a reload during market hours
  still flushes the persistence retry queue and closes exchange WS
  connections cleanly rather than yanking the process.
- Running `instances > 1` in `ecosystem.config.js` without the leader/
  replica split above is explicitly unsupported and will cause the
  duplicate-WS / split-SSE / duplicate-risk-state problems described above.
