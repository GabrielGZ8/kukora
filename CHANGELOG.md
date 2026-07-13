# Changelog

All notable changes to Kukora are documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [2.23.0] — Multi-tenant demo comparison + offline tape recorder / experiment sweep

### Added
- **Multi-tenant demo comparison** (`server/routes/tenantDemo.routes.js`,
  `src/pages/TenantComparisonPage.jsx`) — two synthetic tenants
  (`demo-conservative`: minScore 80 / 0.005 BTC per trade,
  `demo-aggressive`: minScore 40 / 0.02 BTC per trade) running side by
  side on the *real* multi-tenant execution engine (ADR-017,
  `tenantBotState`/`tenantConfig`/`tenantExecution`/`tenantRiskGuard`) —
  not a parallel simulation. `POST /api/tenant-demo/start` applies both
  config profiles via the same `tenantConfig.setMany()` a real user's
  toggle would use and enables both bots; `GET /status` returns a
  side-by-side snapshot (wallets, P&L, trade history, risk-guard status);
  `POST /stop` disables both bots without touching their wallet/history;
  `POST /reset` fully clears both. Mounted at `/api/tenant-demo` (and
  `/api/v1/...`), gated by `requireAuth` + `financialControlLimiter` on
  mutations (same class of endpoint as `/api/tenant-bot/*`). New nav
  entry "Comparación Multi-Tenant" / "Multi-Tenant Compare". Because
  demo uids are prefixed `demo-`, they're picked up automatically by the
  Judge Report's multi-tenant snapshot section with zero extra code.
  7/7 new e2e tests (`tests/tenantDemo.routes.e2e.test.js`).
- **Tape recorder / offline experiment sweep** (`scripts/tapeRecorder.js`,
  `scripts/experimentSweep.js`, `scripts/lib/tapeReplay.js`) — records
  real order-book snapshots from the live exchange feeds to a JSON Lines
  file (`npm run tape:record`), then replays that recording through the
  actual detection engine (`opportunityDetection.detectOpportunities()`
  — no parallel reimplementation) to reconstruct a deterministic
  opportunity log, and runs the existing `arbBacktestEngine.parameterSweep()`
  on it (`npm run tape:sweep -- --tape=<file>`). This makes it possible
  to re-run a parameter sweep against the *same* market conditions
  twice, which the live opportunity log alone can't do. The core replay
  logic (`scripts/lib/tapeReplay.js`) is dependency-injected and fully
  unit tested (12/12, `tests/tapeReplay.test.js`) without touching the
  network; the recorder CLI itself requires real outbound network access
  to exchange REST APIs and degrades honestly (reports network errors
  per snapshot, keeps retrying) rather than failing silently or
  fabricating data in restricted environments.

### Verified
- Full suite: 127 test files / 2014 tests passing, zero regressions.
- `tsc --noEmit`: 0 errors. `eslint` on all new/modified files: 0 errors.
- `npm run build` (Vite): succeeds, includes the new
  `TenantComparisonPage` chunk.
- `npm run check:i18n`: es.js/en.js key parity maintained (400 keys).
- Manual smoke test of `scripts/experimentSweep.js` against a synthetic
  JSONL tape (bypassing the network-dependent recorder) confirmed the
  full replay → opportunity log → parameter sweep → ranked results
  pipeline works end-to-end.

## [2.22.0] — Statistical edge validation (ADR-019) + one-click Judge Report

### Added
- **Statistical edge validation** (`server/domain/engines/statisticalValidation.js`,
  see `docs/ADR-019-statistical-edge-validation.md`) — bootstrap confidence
  interval + significance test on net P&L per trade, aggregated across
  multiple independent market windows instead of a single pooled sample.
  Honest by design: if the sample is small or the edge isn't
  distinguishable from zero, the module reports that explicitly instead
  of dressing it up. Exposed at `GET /api/arb-backtest/validation`
  (`?windows=1..8`, default 4), wired next to the existing
  `/api/arb-backtest/institutional` endpoint in
  `server/arbitrage/subroutes/query.routes.js`. 12/12 new unit tests
  (`tests/statisticalValidation.test.js`).
- **Judge Report** (`server/domain/analytics/judgeReport.js`) — a
  one-click, fully self-contained HTML report (zero external
  dependencies, opens offline) combining architecture summary,
  institutional backtest metrics (Sharpe/Sortino/Calmar/Kelly/VaR/Omega),
  the new statistical edge validation, the latest stress-test/adversarial
  scenario state, and a multi-tenant P&L/risk snapshot — built so an
  evaluator doesn't have to navigate the full dashboard or read every ADR
  individually. Mounted at `GET /api/ops/judge-report` (and
  `/api/v1/ops/judge-report`), gated by the same `requireAuth` +
  `operationalDashboard` feature flag + `OPS_READ` permission as the rest
  of `ops.routes.js`, since it aggregates cross-tenant data. 7/7 new unit
  tests (`tests/judgeReport.test.js`). Every section that lacks data
  (empty opportunity log, no active tenants, no stress test) says so
  explicitly rather than rendering an empty table or inventing numbers —
  same honesty principle as ADR-019.

### Verified
- Full suite: 125 test files / 1995 tests passing, zero regressions
  against the 2.21.0 baseline.

## [2.21.0] — Institutional platform layer: observability, RBAC, feature flags, background jobs, plugin architecture, partial event sourcing, operational dashboard

Full rationale, tradeoffs and what was deliberately deferred: [PROGRESS.md](PROGRESS.md).

### Added
- **OpenTelemetry** (`server/infrastructure/telemetry.js`) — distributed
  tracing across the detection→scoring→execution path, OTLP-exportable,
  zero-cost when `OTEL_ENABLED=false` (default).
- **RBAC** (`server/infrastructure/rbac.js`) — 3-tier permission model
  (`user`/`operator`/`admin`) on top of the existing `role` field. The
  trading kill switch specifically requires the admin-only
  `flags:kill_switch` permission; day-to-day flag/job actions need only
  `operator`. Wired into `featureFlags.routes.js` and `ops.routes.js`.
  `OPERATOR_EMAILS` env var added, same self-healing pattern as the
  existing `ADMIN_EMAILS`.
- **Feature Flags** (`server/infrastructure/featureFlags.js`) — typed
  flags (boolean / percentage-rollout with deterministic per-tenant
  bucketing / enum), per-tenant overrides, audit history. Includes a real
  kill switch (`killSwitchTrading`, `killSwitchTenantExecution`) wired
  into `executeBestOpportunity()`, with its own RCA category
  (`KILL_SWITCH_ACTIVE`) in `observabilityService.js`.
- **Background Jobs** (`server/infrastructure/backgroundJobs.js`) — job
  registration with fixed-interval **or** daily-at-time (`runAt: 'HH:mm'`
  UTC) scheduling, retries with linear backoff, timeout, and a hard
  no-overlap guarantee. `rebalanceScheduler.startAutoRebalanceLoop()` and
  `dailyReportService.start()` migrated onto this framework (same external
  contract, verified against existing tests) so their status is visible in
  `/api/ops` instead of being invisible bespoke timers.
- **Plugin architecture for exchanges** (`server/infrastructure/exchangeAdapters/`)
  — each exchange (Binance, Kraken, Bybit, OKX, Coinbase) is now a
  self-contained `*.adapter.js` descriptor, auto-discovered and validated
  by a loader. `exchangeRegistry.js` consumes the loader instead of 5
  hardcoded `registerExchange()` calls — adding exchange #6 is one new
  file, zero changes to the registry.
- **Partial event sourcing** (`server/infrastructure/eventStore.js`) —
  immutable, append-only per-trade event log
  (`requested → filled/partial_filled/rejected/failed → settled`),
  independent of `tradeStateMachine`'s in-memory-only history. Supports
  `projectTradeState()` (rebuild state by folding events, useful as a
  consistency check) and `replayTrade()` (full timeline for support/audit).
  Persists to MongoDB when connected, always available in-memory.
  Connected to `executeBestOpportunity()` — every real trade now emits its
  lifecycle to this log.
- **Operational dashboard** (`server/routes/ops.routes.js`, mounted at
  `/api/ops` and `/api/v1/ops`) — aggregates background-job health, active
  kill switches, tracing status, and recent trade events in one
  authenticated, RBAC-gated endpoint. Includes a manual "run job now"
  action and per-trade replay.

### Changed
- `server/models.js` — `User.role` enum extended from `['user', 'admin']`
  to `['user', 'operator', 'admin']`.
- `.gitignore` — was only ignoring `node_modules`; now also ignores
  `.env`/`.env.local` (kept `.env.example` explicitly un-ignored). If
  `.env` was ever committed before this change, rotate every secret in it
  (MongoDB password, `JWT_SECRET`, `JWT_REFRESH_SECRET`,
  `KUKORA_MASTER_KEY`, `ADMIN_TOKEN`) and scrub it from git history.

### Dependencies
- Added: `@opentelemetry/sdk-node`, `@opentelemetry/api`,
  `@opentelemetry/resources`, `@opentelemetry/semantic-conventions`,
  `@opentelemetry/auto-instrumentations-node`,
  `@opentelemetry/exporter-trace-otlp-http`, `@opentelemetry/sdk-trace-node`,
  `@opentelemetry/exporter-metrics-otlp-http`, `@opentelemetry/sdk-metrics`.

### Tests
- 1976 tests passing across 123 files (up from the pre-existing suite —
  zero regressions). New: `tests/telemetry.test.js`,
  `tests/featureFlags.test.js`, `tests/rbac.test.js`,
  `tests/backgroundJobs.test.js`, `tests/eventStore.test.js`.

## [2.20.0] — checkpoint-37: per-user exchange credentials + per-user live-trading toggle (Settings UI, part 3 of 3 — plan complete)

Third and final piece of the original 3-piece plan (parts 1 and 2 below).
This checkpoint delivers the **Settings UI**: a user can now connect their
own exchange keys and turn on real-money trading for their own account
entirely from the app, with no server-side/env-var step required.

### Added
- **`src/components/settings/ExchangeCredentialsSection.jsx`** (new) —
  rendered in the existing "keys" Settings tab, above the legacy
  `ApiKeysSection` (which still exists unchanged — it only tests the
  platform-wide env-var keys, never persists anything):
  - Lists connected exchanges (name + connected-since date), each with a
    "Disconnect" button (confirms via `window.confirm` before calling
    `DELETE /api/user/exchange-credentials/:exchange`).
  - A connect form (exchange picker + API key/secret, passphrase field
    appears only for OKX) that calls
    `POST /api/user/exchange-credentials`. Renders the withdrawal-
    permission `warning` inline when the exchange couldn't be verified
    programmatically (Kraken), and the plain error when the connection
    test or the withdrawal check failed outright.
  - Key/secret inputs are masked by default (`type="password"`) with a
    show/hide toggle, `autoComplete="off"`, and are cleared from the form
    the moment a connect attempt finishes — nothing is ever displayed
    again once saved, matching the backend's own guarantee.
- **`src/components/settings/LiveModeSection.jsx`** (new) — rendered right
  below it in the same tab:
  - A persistent, always-visible status pill (pulsing dot + label) using
    the same visual criterion as `TradingConfigSection`'s global
    paper/live badge and `SystemHealthStrip`'s status dot, so "which mode
    is active" reads consistently across the app.
  - Two gates shown inline before the user can even attempt to enable:
    "connect an exchange first" (reads `hasExchange`, lifted from
    `ExchangeCredentialsSection` via `SettingsPage`) and "set up 2FA
    first" — the latter includes a compact inline 2FA enrollment flow
    (`POST /api/trading/2fa/setup` → shows the secret + otpauth URI for
    manual entry in an authenticator app → `POST /api/trading/2fa/confirm`
    with a 6-digit code), reusing the *existing* 2FA mechanism
    (`server/application/twoFactor.js`) instead of building a second one.
  - The enable flow itself: clicking "Enable Live Trading" opens a
    confirmation panel showing the exact `disclaimerText` returned by
    `GET /api/user/live-mode` (so the UI never hardcodes/duplicates the
    legal copy), an **unchecked-by-default** checkbox the user must tick
    themselves, and a current 2FA code input. The submit button stays
    disabled until both are filled — there is no path to enabling live
    trading without an explicit, un-pre-checked confirmation.
  - Disabling requires no confirmation and no 2FA (`POST
    /api/user/live-mode/disable`), matching the backend's own "turning
    off is never the risky action" design.
- **`src/api.js`** — new `api.exchangeCredentials.{list,connect,disconnect}`
  and `api.liveMode.{status,enable,disable}` client methods, plus
  `api.trading.{get2faStatus,setup2fa,confirm2fa}` (the 2FA endpoints
  existed on the server since Ronda 21 but had no frontend client at all
  until this UI needed them).
- **`src/pages/SettingsPage.jsx`** — renders both new sections in the
  "keys" tab; `connectedExchanges` state lifted here so
  `ExchangeCredentialsSection`'s list and `LiveModeSection`'s "has an
  exchange" gate stay in sync without a redundant second fetch.
- **i18n** — `settingsSections.exchangeAccounts` and
  `settingsSections.liveMode` added to both `en.js` and `es.js`
  dictionaries (Spanish is this platform's default language).

`npx vite build` — succeeds (986 modules transformed). `npx eslint` — clean
on all new/changed files. `npx vitest run` — 118 files / 1917 tests, all
green (backend test coverage unchanged by this UI-only checkpoint; no new
frontend component tests were added — see "Not yet done").

### Not yet done
- No frontend component tests for `ExchangeCredentialsSection.jsx` /
  `LiveModeSection.jsx` (the project's existing frontend test coverage is
  thin overall — e.g. `tests/components/ScoreCard.test.jsx` is one of very
  few — this UI follows that existing pattern rather than introducing a
  new one unilaterally).
- No end-to-end (supertest) test exists yet exercising the real
  `requireAuth` + `financialControlLimiter` middleware chain for the two
  new routers (see the part-2 entry below — same gap, still open).
- **Product/legal sign-off is still required** before this is exposed to
  real users in production — see the part-2 entry below. Nothing in this
  UI checkpoint resolves that; it remains a decision for the product
  owner, not an engineering one.

## [2.19.0] — checkpoint-37: per-user exchange credentials + per-user live-trading toggle (API routes, part 2 of 3)

Second of the three planned pieces (see [2.18.0] below for part 1, the
service layer this builds on). This checkpoint delivers **the HTTP routes**
that expose `userSecretsVault.js` and `userLiveModeService.js` to real
requests. The **Settings UI (part 3)** is still not started — see "Not yet
done" below.

### Added
- **`server/domain/risk/userExchangeValidation.js`** (new) — Zod schemas
  for the two new route surfaces, following the same pattern as
  `tradingValidation.js` (kept in its own file since these are a distinct
  route surface, not because the validation approach differs):
  - `ExchangeCredentialsBodySchema` — `exchange`/`apiKey`/`apiSecret`
    required non-empty strings, `apiPassphrase` optional (OKX only).
  - `LiveModeEnableBodySchema` — `twoFactorToken` required, and
    `disclaimerAccepted` constrained to the **literal** `true` (not merely
    truthy) — a pre-checked or string `"true"` value is rejected with a
    400 before `enableLiveMode()` is ever called, so the disclaimer
    acceptance in the request body can only mean a real, explicit accept.
- **`server/routes/userExchangeCredentials.routes.js`** (new):
  - `GET /api/user/exchange-credentials` — lists the caller's connected
    exchanges (name + `connectedAt` only, via `listUserExchanges`).
  - `POST /api/user/exchange-credentials` — connect/rotate a key.
    Enforces the exact order from the original spec: (1) schema
    validation, (2) `liveExecution.testExchangeConnection()` against the
    real exchange, (3) `liveExecution.checkWithdrawalPermission()` — hard
    403 if withdrawal is confirmed enabled; if the exchange can't be
    verified programmatically (documented Kraken limitation), the key is
    saved but the response carries a non-null `warning` telling the user
    to confirm manually — never a silent "assumed safe". Only after both
    checks pass does `setUserCredentials()` encrypt and persist. The raw
    key/secret/passphrase are never included in the response, logged, or
    echoed in any error message.
  - `DELETE /api/user/exchange-credentials/:exchange` — disconnect; 404 if
    the exchange was never connected, 200 `{ existed: true }` otherwise.
  - All three require `requireAuth`; every operation is keyed on
    `req.userId`, never on anything the client sends.
- **`server/routes/userLiveMode.routes.js`** (new):
  - `GET /api/user/live-mode` — current `{ enabled, enabledAt }` plus
    `disclaimerText` (the exact string the UI must show and the user must
    accept) so the frontend never has to hardcode/duplicate the
    disclaimer copy.
  - `POST /api/user/live-mode` — enable; delegates to
    `userLiveModeService.enableLiveMode()` (which itself enforces: a
    connected exchange, a valid current 2FA token, and the disclaimer
    accepted). A service-layer rejection (e.g. "no exchange connected")
    is surfaced as a 400 with the service's own message, not a generic
    500.
  - `POST /api/user/live-mode/disable` — always allowed, **no** 2FA
    required (turning real-money trading *off* is never the risky
    action a user needs to be gated on).
- **`server/index.js`** — both routers mounted at
  `/api/user/exchange-credentials` and `/api/user/live-mode` (and their
  `/api/v1/...` aliases, same additive pattern as every other route in
  this file). Both are added to the existing `financialControlLimiter`
  (10 req/min, GETs skipped) alongside `/api/trading/mode`,
  `/api/trading/execute`, `/api/tenant-bot`, etc. — connecting exchange
  keys and toggling real-money trading are exactly the class of
  financial-control mutation that limiter exists for.
- **`tests/userExchangeCredentialsAndLiveMode.routes.test.js`** (new, 15
  tests) — exercises both routers' handlers directly (same lightweight
  pattern as `tests/user-data.routes.test.js`), mocking `liveExecution` /
  `userSecretsVault` / `userLiveModeService`. Covers: schema-level 400s,
  connection-test failure, withdrawal-permission hard-block (403),
  Kraken-style unverifiable-permission warning path, successful connect,
  no key/secret ever echoed back, delete existing/non-existing, live-mode
  GET/enable/disable, and the literal-`true` disclaimer requirement.

`npx vitest run` — 118 files / 1917 tests, all green.

### Not yet done (explicitly out of scope for this checkpoint)
- **Settings UI** (exchange connect/disconnect list, live/paper toggle
  with the 2FA + risk-disclaimer confirmation flow, persistent mode
  indicator consistent with `WatchdogPanel.jsx`/`SystemHealthStrip.jsx`)
  — not started. This is piece 3 of the original 3-piece plan.
- No end-to-end (supertest, full Express app) test yet for these two
  routers — current coverage is at the router/handler level with the
  service layer mocked, same depth as the existing
  `user-data.routes.test.js` pattern. An e2e test similar to
  `twoFactorTradingGate.e2e.test.js` would additionally verify the real
  `requireAuth` + `financialControlLimiter` middleware chain end to end.
- **Product/legal decision flagged, still unresolved** (per the original
  request's own instruction not to decide this silently): allowing users
  to connect real exchange accounts and trade with real money raises
  custody and liability questions this checkpoint does not and should not
  resolve unilaterally — a product/legal sign-off is still needed before
  this is exposed to real users in production, independent of whether the
  code itself is correct and tested.

## [2.18.0] — checkpoint-37: per-user exchange credentials + per-user live-trading toggle (backend, part 1 of 3)

First of the three planned pieces for letting each user connect their own
exchange API credentials and control real-money trading for their own
account, instead of this being a whole-deployment, env-var-only decision
made by the operator. This checkpoint delivers the **backend service
layer with full test coverage** (piece 1 and 2 of the original 3-piece
plan); routes/API endpoints and the Settings UI (piece 3) are **not yet
implemented** — see "Not yet done" below.

### Added
- **`server/infrastructure/userSecretsVault.js`** — per-user sibling to
  the existing global `secretsVault.js`. Same AES-256-GCM encryption
  (same `KUKORA_MASTER_KEY`, same `encrypt()`/`decrypt()`), but stored
  per-`userId` in a new `UserExchangeCredential` Mongo collection instead
  of the global vault's single encrypted file — a user needs a
  queryable-by-userId store, which the global vault never needed.
  - `setUserCredentials(userId, exchange, apiKey, apiSecret, { passphrase })`
    — unlike every other best-effort/fire-and-forget persistence pattern
    in this codebase, this **throws** if MongoDB is not connected, rather
    than reporting success while the credential only lives in memory and
    would silently vanish on the next restart.
  - `getUserCredentials(userId, exchange)` — in-memory LRU cache first
    (hot path, no Mongo round-trip per trade), Mongo + decrypt on a cache
    miss. Never throws for "no credentials" — returns `null` so
    `liveExecution.js` can fall back to the global vault/env exactly as
    before.
  - `listUserExchanges(userId)` — exchange name + `connectedAt` only,
    never key material.
  - `hasAnyUserExchange(userId)` — checks the in-memory cache first (the
    common "just connected, now enabling live mode" flow), falls back to
    a real DB query otherwise.
  - `deleteUserCredentials(userId, exchange)` — disconnect/rotate-out.
  - Tests: `tests/userSecretsVault.test.js` (16 tests) — DB-not-connected
    throw behavior, round-trip encrypt/decrypt, never-plaintext-on-disk,
    case-insensitivity, OKX passphrase vaulting, upsert-not-duplicate on
    reconnect, key-material-never-leaks on list, cache-hit-skips-Mongo.
- **`server/infrastructure/userLiveModeService.js`** — per-user
  "real-money trading enabled: true/false" toggle, separate from
  `liveConfig`'s global `tradingMode`. `enableLiveMode(userId, {
  twoFactorToken, disclaimerAccepted })` requires, in order: (1) at least
  one connected exchange (`userSecretsVault.hasAnyUserExchange`), (2)
  confirmed 2FA with a valid current token (reuses the existing
  `server/application/twoFactor.js` — no duplicated TOTP logic), (3)
  `disclaimerAccepted === true` literally — no pre-checked-default path.
  `disableLiveMode` never requires 2FA. `isLiveModeEnabled(userId)` is
  the synchronous hot-path check `liveExecution.js` consults before any
  real order. Same LRU-in-memory + best-effort-Mongo-persistence pattern
  as `userRiskProfileService.js`; unlike the credentials vault above,
  losing this on a restart is low-risk (reverts to the safe default
  `false`), so persistence here stays fire-and-forget.
  - Tests: `tests/userLiveModeService.test.js` (8 tests) — each of the
    three activation requirements rejected independently with a specific
    message, all-three-met success, disable-never-needs-2FA, per-user
    isolation.
- **`server/models.js`** — new `UserExchangeCredential` schema
  (`userId`+`exchange` unique compound index, `apiKeyEnc`/`apiSecretEnc`/
  `apiPassphraseEnc` — always ciphertext, never plaintext); `liveTradingEnabled`
  / `liveTradingEnabledAt` / `liveTradingDisclaimerHash` fields added to
  the existing `UserTradingConfig` schema for the toggle's best-effort
  persistence.

### Changed
- **`server/application/liveExecution.js`**:
  - `_resolveCredentials(userId, exchange, envKeys)` — tries the user's
    own connected credentials (`userSecretsVault`) first, falls back to
    the global vault/env (`secretsVault.getCredentials`) exactly as
    before. Purely additive: a deployment where no user has ever
    connected their own key sees zero behavior change.
  - `_requireUserLiveModeEnabled(userId)` — new gate in `executeLive` and
    `executeCrossExchangeLive`, **on top of** (never instead of) the
    existing global `LIVE_ENABLED` / `getUserMode(userId) === 'live'`
    gate. A real trade now requires all three: server globally enabled,
    user's mode set to `'live'`, AND this user's own toggle on. Rejects
    with a specific, actionable error rather than silently falling back
    to paper.
  - `checkWithdrawalPermission(exchange, apiKey, apiSecret, apiPassphrase)`
    — new thin wrapper exposing each of the five exchange clients'
    `checkWithdrawalPermission()` (added to every client class:
    `BinanceClient` via `apiRestrictions`, `BybitClient` via
    `query-api` read-only/Wallet-permission heuristic, `KrakenClient`
    — always `verifiable:false`, Kraken has no such endpoint,
    `OKXClient` via `account/config` perm string, `CoinbaseClient` via
    `key_permissions.can_transfer`) — intended for the not-yet-built
    connect-credentials route to reject a key with withdrawal
    permission before it's ever vaulted.
- **Existing live-execution test suites** (`tests/liveExecution.test.js`,
  `tests/liveExecutionCrossExchange.test.js`,
  `tests/liveExecutionOkxCoinbase.test.js`) updated: their
  `_autoSeedOpportunityStore` loader wrapper now also calls
  `userLiveModeService._forceEnableForTests(userId)` (a test-only bypass
  seam, never reachable from production code) so the ~90 pre-existing
  tests written before this per-user toggle existed keep exercising
  `executeLive`/`executeCrossExchangeLive`'s actual trading logic without
  re-deriving 2FA + exchange-connection fixtures for every test.

### Fixed (found while writing this checkpoint's own tests)
- `userSecretsVault.js` / `userLiveModeService.js` needed the same
  documented ESM/CJS module-instance-duplication test seam already used
  by `persistenceService.js` (a module's internal `require('mongoose')`
  and a test file's top-level `import mongoose from 'mongoose'` resolve
  to two different mocked instances under this project's Vitest setup) —
  applied `_setMongooseForTests`/`_resetMongooseForTests` to both new
  modules. The **same duplication turned out to also apply to plain
  same-project CJS modules**, not just the globally-mocked `mongoose`
  package: `userLiveModeService.js`'s internal `require('./userSecretsVault')`
  and `require('../application/twoFactor')` each resolved to a different
  instance than a test file's top-level `import` of the same path
  (confirmed by a direct object-identity check). Added the same seam
  pattern for both (`_setUserSecretsVaultForTests`/
  `_resetUserSecretsVaultForTests`, `_setTwoFactorForTests`/
  `_resetTwoFactorForTests`) so `userLiveModeService.test.js` can point
  the module under test at the exact instances it populated via 2FA
  setup / credential connection.

### Not yet done (explicitly out of scope for this checkpoint)
- **API routes** (e.g. `POST/DELETE /api/user/exchange-credentials`,
  `GET /api/user/exchange-credentials`, `POST /api/user/live-mode`,
  `GET /api/user/live-mode`) — the service layer above is fully built
  and tested, but nothing in `server/routes/` calls it yet. The
  connect-credentials route in particular still needs the "validate
  against the real exchange, reject if withdrawal-enabled" pre-check
  described in the original request — `checkWithdrawalPermission()`
  above is the primitive it needs, not yet wired into a route.
- **Settings UI** (exchange connect/disconnect list, live/paper toggle
  with the 2FA + risk-disclaimer confirmation flow, persistent mode
  indicator) — not started.
- Session/auth wiring for the new routes once they exist (which
  middleware supplies `userId` to them) has not been decided.

`npx vitest run` — 117 files / 1902 tests, all green.

## [2.17.0] — ADR-019 (Hallazgo 5) closed end-to-end; final verification pass found and fixed a real slippage-bias bug

Final CTO/senior-engineer verification pass over the ADR-019 multi-factor
decision engine work (§1 Fill Probability, §2 Liquidity Prediction, §3
Execution-outcome penalty, §4 Market Regime, §5 Slippage-bias penalty, Part
C recovery classification) that arrived across several sessions. Every
piece was re-verified against the running code (not just trusted from
prior session summaries) before being accepted as final, per this
project's own audit methodology. Confirms `fillProbabilityEngine`,
`liquidityPredictionEngine`, `exchangeIntelligence`'s execution-outcome
history, and `exchangeReliabilityDynamic`'s slippage-bias tracker now all
genuinely gate or scale real trading decisions — Hallazgo 5 (open since
v2.15.0) is closed.

### Fixed — real bug found during verification: §5's slippage-bias signal was feeding a fabricated constant instead of a genuine divergence
- **Paper-trading path** (`server/application/arbitrageOrchestrator.js`,
  `executeBestOpportunity`): was calling `recordSlippageBias(exchange,
  applyResult.trade.slippagePct)` — the raw realized slippage magnitude,
  not a bias. `executeSimulated()` (`opportunityDetection.js`) always
  copies `opportunity.slippagePct` verbatim into the returned trade object
  (`slippagePct: opportunity.slippagePct` — no independent market fill
  exists in paper trading to diverge from the pre-trade model), so this
  fed a constant, always-positive "worse than modeled" signal into §5's
  penalty on every single paper trade — directly contradicting §5's own
  documented semantics ("a bias <= 0 is never penalized", "self-healing").
  Fixed to compute the honest delta
  (`applyResult.trade.slippagePct - bestWithSizing.slippagePct`), which
  is provably 0 for every paper trade given `executeSimulated`'s
  passthrough behavior — i.e. the shared paper-trading bot now correctly
  contributes **no** penalty from this signal (accurate: it has no real
  divergence to report) instead of a fabricated one.
- **Live-money path** (`server/application/liveExecution.js`): §5 had no
  real data source at all before this fix — `recordSlippageBias` was
  never called from the live execution path, only (incorrectly) from
  paper trading. Added `_recordRealizedSlippageBias(exchange, side,
  referencePrice, fillPrice)`, wired into all 5 real-fill success paths
  (single-leg `executeLive`, cross-exchange clean full-fill, cross-
  exchange same-size partial fill, and both residual-completion partial-
  fill paths) — the same call sites `liveTradeLedger.recordLiveFill()`
  already uses (Hallazgo 3b, v2.16.0). Computes a genuine adverse-
  divergence percentage from the real `fillPrice` the exchange returned
  vs. the pre-trade `referencePrice` (the same value `resolveTrustedOpportunity()`/
  `smartOrderRouter` already use — Hallazgo 1, v2.14.0), compared against
  `liveConfig.maxSlippagePct` as the "modeled/acceptable" baseline (the
  budget `ioc_protected` orders are already priced against) rather than
  inventing a new per-leg model split of the opportunity's blended
  buy+sell `slippagePct` average. A fill within budget contributes zero
  penalty; a fill that exceeds it contributes a real, positive one. Never
  throws (defensive null/zero guards) — a bias-recording failure must
  never block the trade ledger update or alerting that run alongside it.
  - Tests: `tests/adr019SlippageBiasFix.test.js` (8 tests) — proves the
    old approach would have produced a non-zero bias for identical
    modeled/realized inputs (regression demonstration), proves the fixed
    delta is exactly 0 for the paper-trading passthrough case, and
    exercises `_recordRealizedSlippageBias` directly against the real
    `exchangeReliabilityDynamic` module (BUY/SELL sign conventions,
    within-budget vs. over-budget fills, favorable fills, and null/zero
    defensive guards) — end-to-end against the real penalty function
    rather than a mock, sidestepping this repo's documented CJS/ESM
    dual-module-instance mocking pitfall (see
    `tests/exchangeReliabilityDynamic.slippagePenalty.test.js`).

### Verified (no change needed) — the rest of ADR-019
- §1 Fill Probability gate (`arbitrageOrchestrator.passesFillProbabilityGate`/`selectBestOpportunity`),
  §2 Liquidity Prediction position-size factor (`adaptivePositionSizing.computeSize`,
  clamped ≤1.0×), §4 Market Regime (`marketRegimeCache`, ≥1.0× score /
  ≤1.0× size multipliers, periodic not per-tick recompute), and §3's
  execution-outcome penalty combination (`opportunityDetection.js`'s
  `Math.max(getDynamicPenalty, getExecutionPenalty * 0.25, getSlippagePenalty)`
  per side) were re-read end-to-end against the live code and confirmed
  correct and consistent with the ADR's design and its own "never
  increases risk" invariant (every multiplier/gate found only tightens or
  holds baseline behavior). Part C's `_logRecoveryClassification` in
  `liveExecution.js` was confirmed observability-only (wrapped in
  try/catch, never alters which recovery action actually runs) — `_emergencyFlatten`
  remains the sole live recovery mechanism, per the Hallazgo 7 (v2.16.0)
  decision.
- Full regression: `npx vitest run` → **115 files / 1878 tests passing**
  (1870 baseline + 8 new), zero failures, zero skipped.

## [2.16.0] — AUDIT FINDINGS 3b, 4, 7, 8: live daily-loss breaker now sees real fills; orphaned recovery engine documented, not silently wired in

Continuation of the independent code-flow audit (third pass). Closes the
residual gap Hallazgo 3 (v2.15.0) left open, plus Hallazgo 4 (paper-trading
daily-loss check used the wrong PnL source), Hallazgo 7 (a false claim of
integration + 246 lines of unreferenced-but-tested recovery/hedge code,
documented rather than unilaterally wired into the live-money path), and
Hallazgo 8 (two observability event categories silently dropped from
history). One finding remains open — Hallazgo 5 (MEDIUM, analytics-only
signal engines) — pending a product decision; see "Known remaining gaps".

### Fixed — Hallazgo 3b (residual CRITICAL): live daily-loss circuit breaker read paper P&L, not real fills
- **New**: `server/domain/wallet/liveTradeLedger.js` — a real-fills-only,
  local-midnight-reset P&L accumulator (same integer-accumulator-to-avoid-
  FP-drift pattern as `opportunityDetection.js`'s `getDailyPnl`/
  `addDailyPnl`, applied to a different, real-money ledger). Deliberately a
  single global accumulator, not per-user: `secretsVault.getCredentials()`
  — the source of the API keys `liveExecution.js` trades with — is a
  single global vault, not per-tenant, regardless of which `userId`
  initiates a trade.
- `server/application/liveExecution.js` (`_runInstitutionalRiskGate`):
  `sessionPnl` — the daily-loss circuit breaker's input — now comes from
  `liveTradeLedger.getTodaysLivePnl()` instead of
  `walletManager.getPnL().realizedPnl` (paper P&L). `executeLive`/
  `executeCrossExchangeLive` call the new `recordLiveFill()` at every point
  they already compute a realized `netProfit`/`grossProfit` for a
  completed real trade: the single-leg success path, the cross-exchange
  clean full-fill success, and both residual-completed partial-fill
  success paths (4 call sites total in the cross-exchange function).
  Deliberately NOT recorded: the `_emergencyFlatten`-driven partial-
  failure/manual-intervention paths — those `throw` rather than return
  `ok: true`, and neither the existing audit log nor
  `alertWebhookService.alertTradeExecuted` computes a realized P&L figure
  for a flattened residual position either; inventing one here would be
  new, unverified logic out of scope for this fix.
  - Removed the now-inaccurate doc comment (and the now-unused
    `walletManager` import) that flagged this as a known remaining gap.
  - Tests: `tests/liveTradeLedger.test.js` (6 tests — accumulation,
    non-numeric-input safety, floating-point-drift avoidance, local-
    midnight reset, forced test reset). `tests/liveExecution.test.js`: 3
    new tests in the risk-gate describe block — a real (ledger-recorded)
    loss blocks the next live trade via the daily-loss breaker while the
    paper wallet stays untouched (reproduces the bug directly), a loss
    from a previous day does not carry over, and a wiring test proving a
    real `executeLive` success actually feeds the ledger (not just that a
    manually-recorded value is read back). `tests/liveExecutionCrossExchange.test.js`:
    1 new wiring test for the cross-exchange success path.

### Fixed — Hallazgo 4 (HIGH): shared-bot daily-loss check used unbounded all-time P&L instead of today's
- `server/application/arbitrageOrchestrator.js`: `preTradeRiskCheck`'s 4th
  parameter ("daily loss", checked against `maxDailyLossUSD` and the
  emergency-stop threshold inside `advancedRiskEngine.preTradeRiskCheck`)
  came from `walletManager.getPnL().realizedPnl` — the sum of up to
  `MAX_TRADE_HISTORY` (500) trades with no date filter at all, not
  actually "today's" P&L. Old losses from days or weeks ago (still sitting
  in the in-memory trade history) permanently counted against today's
  daily-loss breaker, while a bad trading day following a historically
  profitable stretch could net out to a "safe" positive number and never
  trip the breaker. Fixed by reusing the already-computed, correctly-
  scoped (local-midnight-reset) `sessionPnlNow` (`opportunityDetection.getDailyPnl()`)
  that adaptive position sizing and `isDailyLossBreached()` already rely
  on, instead of introducing a third implementation.
  `tenantRiskGuard.js`'s `_todaysRealizedPnl` is the per-tenant analog of
  this same fix, already correct (confirmed by reading it), and out of
  scope here — it protects the isolated per-tenant paper bot, not this
  shared-bot path.
  - Tests: 1 new test in `tests/arbitrageOrchestrator.test.js` that makes
    the two values diverge (mocks `walletManager.getPnL()` to a large
    stale loss unrelated to today, sets the real `getDailyPnl()` accumulator
    to a small today-only value) and asserts `preTradeRiskCheck` receives
    the latter, not the former.

### Documented — Hallazgo 7 (MEDIUM): false integration claim + 246 lines of unreferenced (but tested) recovery/hedge code
- Verified with `grep -rn "determineRecoveryAction\|executeRecovery\|planHedge" server/`
  that none of the three functions are called from any production file —
  only from `tests/v17.test.js` directly (12 passing tests). Note: the
  orphaned code is `tradeStateMachine.js`'s Section 4 (Failure Recovery
  Engine) + Section 5 (Hedge Engine), ~246 lines (lines 354–599) — not the
  full 651-line file as originally estimated; the rest of the file
  (`createTrade`, `transition`, `classifyFillTier`, `evaluatePartialFill`,
  `getStats`, etc.) is actively used by `arbitrageOrchestrator.js` and
  `liveExecution.js`. Flagging this discrepancy per the audit's own
  verify-before-asserting methodology rather than silently using the
  original (incorrect) line count.
  - `server/application/liveExecution.js`: removed a comment above
    `_fetchWithRetry` that incorrectly claimed `_placeAndConfirm` uses
    `determineRecoveryAction` to register recovery decisions in the audit
    trail — grep confirms that call never existed.
  - `server/domain/analytics/tradeStateMachine.js`: added a doc header
    above Section 4 documenting the orphaned status and the two options
    considered — (a) wire it in as a classification layer ahead of
    `_emergencyFlatten`, or (b) formally document it as an available-but-
    unused engine and leave `_emergencyFlatten` (liveExecution.js's
    independent, battle-tested real-money recovery path — unchanged, not
    touched by this finding) as the sole live recovery mechanism. Took
    option (b): wiring 246 lines of currently-unexercised classification
    logic into the real-money execution path is a product/architecture
    decision (what should trigger a hedge vs. a flatten? before or instead
    of `_emergencyFlatten`? what's the rollout/kill-switch story?), not
    something to decide unilaterally inside an audit pass — same reasoning
    as Hallazgo 5 below. No behavior change, no new tests needed (comment/
    documentation only); revisit if/when option (a) is explicitly
    requested.

### Fixed — Hallazgo 8 (LOW): two observability event categories were live-only, never buffered for history
- `server/infrastructure/observabilityService.js`: `_buffers` was missing
  `'DEMO'` (`opportunityDetection.js`'s synthetic-opportunity event,
  DEMO_MODE) and `'ENGINE'` (`backtestEngine.js`'s run-result-shape-
  contract warning) — `emit()`'s `if (buf)` guard silently skipped
  buffering events in those two categories, so they were emitted live on
  the bus but `getEvents('DEMO'|'ENGINE')`/`getAllRecentEvents()` never
  returned them; only a listener subscribed at the exact moment of
  emission ever saw them. Confirmed via `grep -rhoP` across `server/` for
  every string literal passed as `emit()`'s first argument that DEMO and
  ENGINE were the only two categories missing a buffer entry. Purely
  additive fix.
  - Tests: new `tests/observabilityService.test.js` (5 tests) — buffers/
    retrieves events for every pre-existing category (no-regression
    baseline), reproduces the bug directly for DEMO and ENGINE using the
    real call sites' exact category/event names, confirms both now appear
    in `getAllRecentEvents()`, and confirms an unrecognized category still
    doesn't throw (defensive default preserved).

### Known remaining gaps (from the audit, not yet addressed)
- **Hallazgo 5** — `fillProbabilityEngine`, `liquidityPredictionEngine`,
  most of `exchangeIntelligence`'s ranking functions, `marketRegime`, and
  `executionQualityTracker`'s `slippageAdjustment` all compute real,
  non-trivial signals that never feed into any actual trading decision
  (confirmed decorative/analytics-only by the audit, tracing
  `selectBestOpportunity()`/`executeBestOpportunity()` line by line). This
  needs a governance decision (wire them in, or formally document them as
  analytics-only, optionally moving them out of `domain/engines/`) rather
  than a code fix, so it's left open pending product input.

## [2.15.0] — AUDIT FINDINGS 2, 3, 6: risk gate reads the real trade size, real capital, and retry queue no longer mis-attributes sessions

Continuation of the independent code-flow audit (second pass). Three more
confirmed findings closed; two (Hallazgo 4 — unify daily PnL calculation,
Hallazgo 5 — decide whether fillProbability/liquidityPrediction/marketRegime/
executionQuality feedback loops should gate decisions or stay analytics-only)
remain open — see "Known remaining gaps" below.

### Fixed — Hallazgo 2 (CRITICAL): position-size check validated the wrong number
- `server-types/server/domain/risk/advancedRiskEngine.ts` (`preTradeRiskCheck`):
  `arbitrageOrchestrator.js`'s `getPositionSizeForOpportunity()` returns
  `{ ...opp, positionSizing }`, leaving the ORIGINAL pre-adjustment
  `opportunity.tradeAmount` untouched on the same object alongside the real,
  adjusted size in `positionSizing.size` (which is what actually executes,
  both in paper trading and — via `amount` — live). The position-size check
  read `tradeAmount` — the wrong, smaller number — so a trade adaptive
  sizing scaled up to 3x on high score/momentum could bypass
  `maxPositionValueUSD` using its stale pre-adjustment value. Fixed with
  explicit precedence: `positionSizing?.size ?? tradeAmount ?? 0.05`.
  `OpportunityLike` gained an explicit `positionSizing?: { size?: number }`
  field so this type-checks without falling back to `unknown`.
  - Chose the documented "minimal" fix (precedence at the read site) over
    the "best" fix (explicit `tradeSizeBTC` parameter in the function
    signature) — the signature change would have touched 17+ existing call
    sites across production code and tests for no behavioral difference,
    since `positionSizing` is the only field that was ever ambiguous.
  - Tests: 3 new cases in `tests/advancedRiskEngine.test.js` (adjusted size
    over cap even though stale tradeAmount alone would pass; adjusted size
    under cap even though stale tradeAmount alone would look larger;
    fallback to tradeAmount when positionSizing is absent, e.g.
    `liveExecution.js`'s synthetic `riskOpportunity`).

### Fixed — Hallazgo 3 (CRITICAL): live risk gate measured capital against the paper wallet
- `server/application/liveExecution.js` (`_runInstitutionalRiskGate`):
  `capitalUSD` — the number every percentage-of-capital risk limit
  (drawdown, position-size cap) is checked against — came from
  `walletManager.getBalances()`. That module's own file header says exactly
  what it is: "Gestiona saldos simulados por exchange" — the paper-trading
  ledger, not the real exchange account. Every live-trade risk limit
  expressed as a percentage of capital was being checked against a number
  with no relationship to the money actually at risk. Now `capitalUSD` is
  fetched from the real, already-authenticated exchange client(s) for this
  trade via `client.getBalance()` (new `_fetchRealCapitalUSD()` helper) —
  the same real-balance mechanism `preflightCheck` already uses for the
  sufficient-funds check. Fails safe: an unreadable balance contributes 0,
  which can only make every percentage-of-capital check *stricter*.
  - `_runInstitutionalRiskGate` is now `async` and takes the real client(s)
    (`[client]` for single-exchange, `[buyClient, sellClient]` for
    cross-exchange) as a new parameter; both call sites in `executeLive`/
    `executeCrossExchangeLive` now `await` it.
  - **Known remaining gap, documented in code, not silently left**:
    `sessionPnl` (the daily-loss circuit breaker input) still comes from
    `walletManager.getPnL()` — paper P&L. Closing that fully needs a real
    realized-P&L tracker fed from actual fills; flagged in a doc comment
    directly above the fix so it isn't mistaken for fully closed.
  - Tests: new case in `tests/liveExecution.test.js` proving the real
    (mocked) exchange balance — not the untouched-default paper wallet — is
    what reaches the gate. All existing tests updated to mock the 2
    additional real-balance fetches the gate now makes per exchange client.

### Fixed — Hallazgo 6 (MEDIUM): retry queue could mis-attribute a trade to the wrong session
- `server/infrastructure/persistenceService.js` (`_enqueueRetry`,
  `_writeQueuedItem`): items queued during a MongoDB outage captured no
  `sessionId`, so a delayed retry read the *live* `_sessionId` module
  variable at flush time. If `advanceSession()` (manual bot reset) ran in
  the outage window before the retry flushed, the trade was archived under
  the wrong (later) session — a silent audit-trail integrity bug, not a
  money-safety one. Fixed by capturing `sessionId` at enqueue time and using
  `item.sessionId` at write time (falling back to the live variable only
  for already-serialized pre-fix queue items).

### Known remaining gaps (from the audit, not yet addressed)
- **Hallazgo 4** — daily P&L is calculated in more than one place; needs
  unifying into a single source of truth. Not yet located/fixed in this
  pass.
- **Hallazgo 5** — `fillProbabilityEngine`, `liquidityPredictionEngine`,
  most of `exchangeIntelligence`'s ranking functions, `marketRegime`, and
  `executionQualityTracker`'s `slippageAdjustment` all compute real,
  non-trivial signals that never feed into any actual trading decision
  (confirmed decorative/analytics-only by the audit). This needs a
  governance decision (wire them in, or formally document them as
  analytics-only) rather than a code fix, so it's left open.

## [2.14.0] — AUDIT FINDING 1 (CRITICAL): live execution no longer trusts client-supplied opportunity prices

Independent code-flow audit (session focused on `POST /api/trading/execute/cross`
and `/api/trading/execute`) found that every layer of protection meant to
guard real money — the staleness gate, the institutional risk gate, and the
IOC "protected" order's price limit — read its numbers directly from the
client-supplied `opportunity` object (`buyPrice`/`sellPrice`/`askPrice`/
`bidPrice`/`detectedAt`/`slippagePct`) without ever re-checking them against
the detection engine that actually computed them. A stale frontend payload,
a race condition, or a serialization bug could pass all three checks on a
trade that doesn't actually satisfy any of them.

### Added
- `server/domain/engines/opportunitySnapshotStore.js`: new in-memory,
  TTL-bounded (5s) store keyed by `${opportunity.id}:${asset}` (avoids a
  BTC/ETH id collision on the same exchange pair — `opportunityDetection.js`
  reuses the same `arb-${buyExchange}-${sellExchange}` id scheme for both).
  `arbitrageOrchestrator.js` now calls `recordSnapshots()` at all three
  points where it finalizes a tick's opportunity array (event-driven path,
  BTC tick-loop path, and ETH detection), right alongside the existing
  `recordOpportunitySeen()` calls.
- `resolveTrustedOpportunity()` in `server/application/liveExecution.js`:
  the single choke point `executeLive()`/`executeCrossExchangeLive()` now
  call before touching any exchange or price field. Resolves the client's
  `opportunity.id` against the snapshot store; throws (before any balance
  check, any risk check, any order placement) if the id is missing, unknown,
  or has expired. On success, every downstream consumer (`preflightCheck`,
  `preflightSellSide`, `_runInstitutionalRiskGate`, `_placeAndConfirm`'s
  smart-order-router price limit, the crash-recovery marker, the audit log)
  reads from the server's own last-computed opportunity instead of the raw
  request body — purely additive, no change to the execution logic itself.
- `tests/opportunitySnapshotStore.test.js` (8 tests) and a new
  `resolveTrustedOpportunity` describe block in `tests/liveExecution.test.js`
  (5 tests) covering: missing id, unknown id, expired id, client price
  fields being ignored in favor of the server snapshot, and the BTC/ETH id
  collision case.

### Changed
- `tests/liveExecution.test.js`, `tests/liveExecutionCrossExchange.test.js`,
  `tests/liveExecutionOkxCoinbase.test.js`: `loadModule()` now auto-seeds the
  snapshot store with whatever opportunity object each test passes in
  (matching production behavior where the detection loop already recorded
  it), so pre-existing test fixtures keep exercising the exact same
  preflight/risk-gate/order-routing logic through the new
  `resolveTrustedOpportunity()` gate rather than bypassing it. Tests that
  need to verify the rejection path itself use the new unwrapped
  `loadRawModule()` instead.

## [2.13.0] — TenantBotPanel (UI para el bot personal) + pase de due diligence dirigido: 2 bugs de seguridad/enforcement corregidos

Dos partes: (1) se construyó la superficie de UI que faltaba para los
primitivos multi-tenant (`tenantBot.routes.js`) — panel "Mi Bot Personal"
en ArbitragePage — y (2) un pase de due diligence enfocado en aislamiento
multi-tenant, seguridad de rutas y coherencia enforcement-vs-UI encontró
y corrigió 2 bugs reales el mismo día. Ver
`docs/TechnicalDueDiligence-2026-07-02.md` (Addendum 2) para el detalle
completo con evidencia archivo:línea.

### Added
- `src/hooks/useTenantBot.js` + `src/components/common/TenantBotPanel.jsx`:
  nueva pestaña "🤖 Mi Bot Personal" — toggle del bot per-tenant, wallet/
  P&L/win-rate en vivo, risk guard con reset, 15 parámetros curados
  editables en batch (no auto-save por campo, por el rate limit
  compartido de `financialControlLimiter`).
- `tests/arbitrageConfig.security.e2e.test.js`: cobertura e2e real
  (supertest contra la app completa) para el gate de admin en mutaciones
  de config global — el test unitario existente (`getHandler()`) nunca
  ejercitaba middleware, ver Hallazgo 3 del addendum.

### Fixed
- **`tenantRiskGuard.checkPreTrade` ahora aplica `maxDailyLossUSD`.** Era
  validado y guardable desde el nuevo panel, pero ningún código lo leía —
  un stop-loss diario configurado por el usuario no tenía ningún efecto.
  Ahora se calcula desde `walletManager.getTradeHistory(uid)` (sin estado
  nuevo) y dispara el circuit breaker per-tenant igual que drawdown/rachas
  de pérdidas. 4 tests nuevos en `tenantRiskGuard.test.js`.
- **`POST /api/arbitrage/config` y `/config/reset` ahora requieren
  `requireRole('admin')`.** Antes cualquier usuario autenticado podía
  mutar la config global compartida (`liveConfig`) de la que todo tenant
  sin override propio depende como fallback — inconsistente con rutas
  hermanas del mismo archivo (`/adversarial/run`) que ya exigían admin.
  `ADMIN_EMAILS` auto-sincroniza el rol del dueño del proyecto en cada
  login, así que el gate no bloquea el demo en vivo.
- `financialControlLimiter` (rate limiter de 10/min compartido por
  toggle/config/risk-reset de `tenant-bot`) ya no cuenta requests `GET`
  — antes, el polling de solo-lectura de un panel (cada 5s) podía agotar
  el budget de mutaciones en ~50s.
- `POST /api/tenant-bot/config` ahora devuelve siempre HTTP 200 (antes
  400 en rechazos parciales), consistente con `/api/arbitrage/config` —
  evita que los helpers genéricos del frontend descarten el detalle de
  qué parámetro se rechazó y por qué.

## [2.12.0] — Cierre de los 5 pendientes reales de ADR-017: A1 completo (SSE por-tenant), persistencia por-tenant, risk guard por-tenant, coverage medido, auditoría de seguridad

Continuación directa de la sesión de CHECKPOINT_07/[2.11.0]. Los 5 puntos
listados como "Lo que falta para un 100" al cierre de esa sesión quedan
resueltos y verificados esta sesión. Ver `CHECKPOINT_08.md` para el
detalle narrativo completo; este changelog resume el "qué cambió".

### Added — Item 1: SSE por-tenant conectado al broadcast real (ADR-017, el más grande)
- `arbitrage.state.js`: los clientes SSE (`sseClients`) ahora se asocian a
  su `uid` vía un `WeakMap`-like tracking (`sseClientUid`) poblado en el
  handler de conexión; `pushToSSE()` sigue siendo un solo broadcast por
  tick (sin N payloads serializados por tenant) pero superpone el delta
  de cada uid (`mergeTenantOverlay`, de `tenantSseDelta.js`, construido y
  probado la sesión anterior pero nunca conectado) antes de escribir a
  cada `res` individual — dos usuarios conectados simultáneamente reciben
  ahora wallet/P&L/bot-status propios del mismo tick compartido, en vez
  del mismo payload idéntico.
- `stream.routes.js` (`GET /stream`): registra el `uid` del cliente al
  conectar (ya autenticado vía `requireAuthForStream`/ticket), lo limpia
  en el evento `close`, y el payload inicial (`init`) también pasa por
  `mergeTenantOverlay` — no solo los ticks subsecuentes.
- Sin `uid` asociado (cliente legacy o no identificado), `mergeTenantOverlay`
  retorna la misma referencia del payload compartido — cero cambio de
  forma para ese caso, mismo contrato que la función pura ya tenía.
- Tests nuevos en `arbitrage.state.test.js` (overlay per-uid, dos tenants
  reciben datos distintos del mismo `pushToSSE()`) y
  `arbitrage.stream.routes.test.js` (registro/limpieza de `sseClientUid`,
  overlay en el payload `init`). Sin regresión en la suite de SSE
  existente (`sseConnection.e2e.test.js`).
- Con esto, "multi-tenant" deja de ser solo una promesa de arquitectura:
  dos usuarios conectados a la vez ven su propio wallet/P&L en vivo desde
  el mismo tick de 150ms, sin duplicar el broadcast.

### Added — Item 2: persistencia por-tenant (antes solo en memoria)
- `server/infrastructure/tenantPersistence.js` (nuevo): conecta el
  primitivo per-usuario que ya existía en `persistenceService.js`
  (`persistEngineSnapshot`/`restoreEngineSnapshot`, nunca conectado a
  tenants reales — ver ADR-017 pendiente #2 de la sesión anterior) a
  `tenantBotState.activeUids()`. `persistActiveTenantSnapshots()` guarda
  el snapshot de cada tenant activo con fallas aisladas por tenant (un
  Mongo write que falla para un uid nunca aborta el resto);
  `restoreTenantSnapshot(uid)` nunca lanza, incluso si la llamada
  subyacente rechaza. `startTenantPersistenceFlush`/`stopTenantPersistenceFlush`
  (idempotentes) corren cada 30s junto al flush ya existente del bot
  compartido.
- Conectado en `arbitrageOrchestrator.js`: el flush por-tenant arranca en
  `_startup()` junto al del bot compartido y se detiene en `stopEngine()`.
  Verificado con boot+SIGTERM real (log confirma
  `[tenantPersistence] Per-tenant snapshot flush started`).
- 11 tests nuevos (`tenantPersistence.test.js`). Ahora, si el proceso
  reinicia, cada tenant activo recupera su snapshot en vez de perder todo
  su historial.

### Added — Item 3: risk engine por-tenant (antes un solo cerebro global)
- `server/infrastructure/tenantRiskGuard.js` (nuevo): circuit breaker,
  límite de drawdown y guard de tamaño de posición **por tenant** —
  aditivo y aislado, no reemplaza ni modifica el risk engine global
  compartido (que sigue siendo la única defensa contra riesgo agregado
  de la plataforma, decisión ya documentada en ADR-017). Un tenant con
  configuración agresiva ahora puede tropezar SU PROPIO breaker sin
  afectar a otros tenants ni al bot compartido.
- Conectado en `tenantExecution.js`: `checkPreTrade` se llama antes de
  `executeSimulated` en `_executeForTenant`, bloqueando el trade si el
  breaker de ese uid está activo.
- 8 tests nuevos (`tenantRiskGuard.test.js`), incluyendo aislamiento
  explícito entre dos tenants (uno tropieza su breaker, el otro sigue
  operando normalmente).

### Added — HTTP surface: `server/routes/tenantBot.routes.js` (nuevo)
- Antes de esta sesión no existía ningún endpoint HTTP real para que un
  usuario autenticado prendiera/apagara su bot, aplicara overrides de
  config, o reseteara su propio risk breaker — los primitivos existían
  solo a nivel de módulo. Rutas nuevas montadas en `/api/tenant-bot`:
  `GET /status`, `POST /toggle`, `GET/POST/DELETE /config[/:key]`,
  `POST /config/reset`, `POST /risk/reset` — todas detrás de
  `requireAuth` (gate ya cubierto por tests de auth existentes).
- 12 tests e2e nuevos vía supertest contra la app real
  (`tenantBot.routes.e2e.test.js`), incluyendo aislamiento entre dos uids
  y (tras el fix de rate-limiting de abajo) verificación de que el
  límite de 10/min realmente dispara un 429.

### Added — Item 4: coverage medido (antes solo estimado)
- Corrido `vitest run --coverage` por primera vez esta sesión. Resultado:
  70.04% statements / 59.45% branches / 68.14% funciones / 73.28% líneas
  agregado del repo. Los módulos nuevos/modificados de esta sesión miden
  entre 85–100% (`tenantRiskGuard.js` 97.9%, `tenantPersistence.js`
  94.7%, `tenantExecution.js` 88.75%, `tenantSseDelta.js`/`tenantConfig.js`/
  `tenantBotState.js` 100%). Los huecos más grandes están en módulos NO
  tocados esta sesión (`crypto.routes.js` 63.5%, `liveConfig.js` 62.75%,
  `exchangeService.js` 47.45%) — quedan identificados, no cerrados; ver
  `CHECKPOINT_08.md` para el detalle completo por archivo.

### Fixed — Item 5: auditoría de seguridad (auth/2FA/rate-limiting)
- Revisión dirigida de `auth.js` (JWT access/refresh, blacklist de jti,
  roles, hashing constante-en-tiempo para login), `twoFactor.js`/`totp.js`
  (TOTP RFC 6238, proof-of-possession para disable) y el rate-limiting
  existente (`apiLimiter` global, `financialControlLimiter` en endpoints
  financieros). Diseño confirmado sólido — sin hallazgos de vulnerabilidad
  en el código ya existente.
- **Hallazgo real**: las rutas nuevas de `tenantBot.routes.js` (item de
  arriba) no tenían ningún rate-limiting propio — a diferencia de
  `/api/trading/mode`/`/api/trading/2fa` (que sí están detrás de
  `financialControlLimiter`), un atacante podía spamear
  toggle/config/risk-reset sin límite específico (más allá del
  `apiLimiter` genérico de 600/min compartido por toda `/api/`). Fix:
  `financialControlLimiter` (10/min por uid) aplicado a
  `/api/tenant-bot/toggle`, `/config*` y `/risk/reset`, mismo patrón que
  el resto de endpoints de control financiero del proyecto. Verificado
  con un test e2e nuevo que confirma un 429 real al superar el límite.

### Verification
- Suite completa corrida 3 veces a lo largo de la sesión con el estándar
  del proyecto (vitest → tsc → build:ts → vitest → lint), más boot+SIGTERM
  real después de cada cambio de riesgo (SSE wiring, persistencia,
  rate-limiting). Estado final: 91 archivos / 1529 tests (subió de
  88/1492 al cierre de la sesión anterior).

---

## [2.11.0] — ADR-017 pendientes reales: A3 (ETH por-tenant), A4 (regresión Multi-Hop), A1 parcial (SSE), hallazgos de auditoría (memoria, persistencia cross-tenant)

### Added — A4: test de regresión para el bug de Multi-Hop event-driven
- `_attachEventDriven()` (`arbitrageOrchestrator.js`) extraído a una
  función nombrada `_handlePriceUpdate`, exportada como
  `_handlePriceUpdateForTests` (mismo criterio que
  `_resetLoopBackoffForTests`). Cero cambio de comportamiento en runtime —
  solo hace testeable el handler que antes era un closure anónimo pasado
  directo a `priceEmitter.on(...)`.
- `tests/arbitrageOrchestratorEventDriven.test.js` (4 tests nuevos):
  regresión directa del bug de `multiHopSignal` corregido en la sesión
  anterior — verificado reintroduciendo el bug temporalmente y confirmando
  que el test nuevo lo detecta (falla), luego restaurando el fix.

### Added — A3: extensión del pase de ejecución por-tenant a ETH (ADR-017)
- `tenantExecution.js`: `runTenantExecutionPass(opportunities, ethOpportunities, now)`
  ahora evalúa ambos pools por tenant activo — BTC primero, y solo si ese
  tenant no ejecutó BTC este tick, ETH (mismo criterio "uno u otro por
  tick" que ya usa el bot compartido entre `evaluateAndExecuteBtc`/
  `evaluateAndExecuteEth`, pero resuelto independientemente por tenant).
  Fingerprint de-dup ahora namespaced por pool de asset (`BTC`/`ETH`) con
  Maps por-tenant independientes — un dedup de un pool nunca bloquea al
  otro. Retrocompatible: la firma de dos argumentos anterior a esta sesión
  (`runTenantExecutionPass(opportunities, now)`) sigue funcionando
  exactamente igual (detección de tipo en runtime: si el segundo argumento
  es un `number`, se interpreta como `now` y ETH se omite). 6 tests nuevos.

### Added — A1 (parcial): función pura de delta SSE por-tenant (ADR-017)
- `server/infrastructure/tenantSseDelta.js`: `buildTenantSseDelta(uid, opts)`
  arma el snapshot por-tenant (wallet/P&L/bot-status/historial) a superponer
  sobre el payload de tick compartido; `mergeTenantOverlay(shared, uid, opts)`
  superpone ese delta sin mutar el payload compartido — con `uid` ausente,
  retorna la MISMA referencia del payload compartido (cero cambio de forma
  para clientes sin tenant identificado). 7 tests nuevos, cero I/O, cero
  riesgo de runtime porque **todavía no está conectada** a ningún broadcast.
- **Deliberadamente NO conectado esta sesión**: el wiring real (que
  `sseClients` deje de ser un `Set<res>` ciego al uid y pase a asociar
  cada conexión con su `req.userId`, y que el loop de 150ms llame a este
  módulo antes de `pushToSSE`) toca el broadcast en caliente que la demo
  compartida usa en vivo — el mismo tipo de cambio de alto riesgo que
  ADR-016/ADR-017 ya identificaron como el más peligroso del backlog, a
  solo 5 días del deadline de evaluación. Se prioriza no tocar el
  broadcast compartido esta sesión — ver ADR-017 para el detalle completo
  y la recomendación para la siguiente sesión (sin presión de deadline).

### Fixed — Hallazgos de auditoría (Parte B)
- **Fuga de memoria real en `createTenantStore` (`tenantStore.js`)**: el
  `Map` interno de TODO store por-tenant (`tenantConfig`, `tenantBotState`,
  y el store de wallets/historial de `walletManager.ts`) crecía sin
  límite — cualquier uid que alguna vez llamara `get()` quedaba para
  siempre en memoria, a diferencia de otros stores per-usuario ya
  existentes en este proyecto (`userRiskProfileService.js`,
  `multiPairService.js`), que ya tienen un LRU acotado. Con tráfico real
  de N usuarios a lo largo del tiempo, esto es una fuga de memoria de
  crecimiento indefinido. Fix: LRU acotado en el factory (límite 1000 por
  defecto, mismo criterio que los stores ya existentes), aplicado una
  sola vez para que los tres stores que ya usan `createTenantStore` (y
  cualquiera futuro) queden protegidos automáticamente. 4 tests de
  regresión nuevos, incluyendo uno que reproduce el escenario real (500
  uids sintéticos, confirma que el store nunca excede el tope).
- **Gap de persistencia cross-tenant en `ArbitrageOp` (`walletManager.ts`)**:
  el documento Mongo que audita cada trade ejecutado (bot compartido O
  cualquier tenant vía `tenantExecution.js`) no tenía ningún campo `uid` —
  todos los trades de todos los tenants (y del bot compartido) se
  persistían indistinguibles entre sí en la misma colección. El estado en
  memoria (ya per-uid desde antes) nunca tuvo esta fuga; la COPIA
  persistida en Mongo sí mezclaba todo. Mismo patrón de bug que el bucket
  de asset BTC/ETH/XRP (ver ADR-018), esta vez en la capa de persistencia.
  Fix: campo `uid` (opcional, default `null`) agregado al schema y
  pasado a través de `applyTrade()` → `_applyTradeInternal()` →
  `ArbitrageOp.create()`. Retrocompatible con cualquier documento ya
  escrito (uid ausente = comportamiento de antes de este fix).
- Consistencia de versión: `package.json` actualizado a `2.11.0` para
  reflejar exactamente el HEAD de este CHANGELOG.

### Deferred — ver `CHECKPOINT_07.md` y `ADR-017` para el detalle completo
- A1: wiring real del broadcast SSE por-tenant (ver arriba).
- A2: sesiones/replay/analytics por-tenant — decisión documentada
  servicio por servicio en ADR-017 (replayService = datos de mercado, no
  tocar; persistenceService legacy session/equity = solo bot compartido,
  por diseño, no una fuga — ver ADR-017), pero la extensión real de
  `persistenceService`/`EngineSnapshot` a tenants activos (más allá del
  fix de `uid` en `ArbitrageOp` de arriba) queda pendiente.
- Auditoría exhaustiva de Parte B: esta sesión encontró y corrigió los
  dos hallazgos de arriba (memoria + persistencia cross-tenant) mediante
  revisión dirigida de los stores por-tenant nuevos/modificados, pero NO
  constituye una auditoría línea-por-línea de todo `src/`+`server/` como
  la de CHECKPOINT_06 (item 7) — ver CHECKPOINT_07.md, sección "Lo que
  NO se hizo esta sesión", para el alcance exacto y honesto de esta parte.

---

## [2.10.0] — Cierre de pendientes: config dinámica, generalización XRP, multi-tenant fase B, auditoría final

### Added — Configuración dinámica, item 2
- Auditoría de constantes hardcodeadas en el motor (`adaptiveScoring.js`,
  `spreadMomentumEngine.js`, `smartOrderRouter.js`, `advancedRiskEngine.ts`,
  `opportunityLifecycle.js`, `directionalBiasTracker.js`) migradas a
  `liveConfig`, con las mismas validaciones y valores por defecto — cambio
  de parametrización puro, sin cambio de comportamiento observable.

### Added — Generalización XRP, item 3 (parte segura)
- Tabla de fees real para ETH/XRP (antes caían en un fallback plano de
  $6 pensado solo para USDT/BTC).
- Fix de bug de aislamiento de asset en wallets: XRP ahora usa su propio
  bucket en vez de compartir contabilidad con BTC.
- Fix de bug de dirección de hedge en `tradeStateMachine.planHedge`: la
  dirección se pasa explícitamente en vez de adivinarse por identidad de
  asset (podía producir hedges en la dirección equivocada para pares no
  BTC/USDT).

### Added — Multi-tenant real, item 1 fase B (ADR-017)
- `server/infrastructure/tenantExecution.js`: pase de ejecución por-tenant
  conectado al tick de 150ms, DESPUÉS del bot compartido (aditivo, el bot
  compartido no cambió). Itera `tenantBotState.activeUids()` sobre las
  oportunidades ya detectadas ese tick, selecciona con
  `tenantConfig.getEffective(uid, ...)` y de-dup de fingerprint
  independiente por-tenant, y ejecuta contra el wallet aislado de cada uid
  (`walletManager` ya era tenant-aware). Deliberadamente no pasa por risk
  engine/state machine/predictive rebalance/alertas (siguen compartidos —
  ver comentario de cabecera del archivo y ADR-017 actualizado). Alcance
  BTC únicamente; ETH queda para una sesión futura. 8 tests nuevos.

### Fixed — Auditoría final profunda, item 7
- **Bug real en el path event-driven (`_attachEventDriven`,
  `arbitrageOrchestrator.js`)**: `multiHopSignal` se usaba para decidir si
  ejecutar Multi-Hop (item 4) pero nunca se extraía del resultado de
  `detectOpportunities()` en ese path — a diferencia del path de polling
  (150ms), que sí lo hacía correctamente. Con `multiHopEnabled` activo,
  cada price-update disparaba un `ReferenceError` silencioso (atrapado por
  el try/catch existente, logueado como warning) y Multi-Hop nunca llegaba
  a ejecutar una sola vez por esta vía. Encontrado por ESLint
  (`no-undef`) durante la auditoría, no por un reporte previo — el flag
  está deshabilitado por defecto, así que nunca se manifestó en demo/tests.
  Fix: agregar `multiHopSignal` a la desestructuración, igual que
  `triangularSignal` en la misma línea.
- `server/index.js`: 3 declaraciones de función dentro de un bloque `if`
  (`no-inner-declarations`) convertidas a expresiones de función — mismo
  comportamiento exacto, sin dependencia de hoisting entre bloques,
  satisface el lint del propio proyecto (`npm run lint` ahora limpio en
  `src/` y `server/`).
- Documentación: `ADR-017` actualizado con el cierre de Fase B y el
  alcance real pendiente (SSE por-usuario, sesiones/replay/analytics
  por-tenant, extensión a ETH) — para que la siguiente sesión no tenga que
  re-descubrir qué falta.

---

## [2.9.0] — Refinamiento post-checkpoint-03: multi-tenant fase A, Mongo Atlas, explainability

### Added — Multi-tenant real, item 1 fase A (ADR-017)
- `server/infrastructure/tenantConfig.js`: overrides de configuración
  por-usuario sobre `liveConfig`, reutilizando `liveConfig.validateOne`
  (nueva exportación) — sin duplicar las ~40 reglas de validación.
  Aditivo: ningún caller existente cambia de comportamiento.
- `server/infrastructure/tenantBotState.js`: intención de bot on/off +
  metadata de sesión por-usuario, independiente del bot compartido global.
- `tenantStore.js`: `resolveTenantKey(uid, botId)` documenta la
  convención de clave compuesta para cuando un usuario pueda correr más
  de un bot — sin cambiar la forma de ningún store existente.
- Fase B (loop de ejecución iterando tenants activos + SSE por-usuario)
  queda explícitamente para después del 12 de julio — ver ADR-017 para
  el razonamiento completo (toca el hot path del motor de trading en vivo).

### Added — Mongo Atlas readiness, item 5
- `server/index.js`: la conexión inicial a Mongo ahora reintenta con
  backoff exponencial acotado (1s/2s/4s/8s/16s, luego cada 30s) en vez de
  quedarse en modo in-memory hasta un reinicio manual si Atlas tarda en
  resumir desde un cluster free-tier pausado.
- `ExecutionRecord.js`: índice en `ts` (la colección de mayor volumen,
  consultada con `.find().sort({ts:-1}).limit(n)`, no tenía índice).
- `.env.example`: guía específica de Atlas (Network Access, Database
  Access, por qué no hace falta crear índices a mano).

### Added — Explainability del motor, item 6
- `server/domain/explainability.js`: agrega score breakdown, fill
  probability breakdown, fees en USD, slippage, liquidez predicha,
  contexto de volatilidad de mercado, snapshot de riesgo (circuit
  breaker/drawdown/exposición, solo lectura) y la política de ejecución
  (market/IOC/post-only) que se usaría — todo en `opportunity.explain`,
  sin recalcular ni mutar nada que ya exista en sus propios módulos.
- Conectado en los dos puntos donde `arbitrageOrchestrator` arma el
  array de oportunidades (path event-driven y loop de 150ms).

---

## [2.8.0] — Full parametrization surface exposed in the UI

### Fixed — Configuration UI vs. backend capability gap
The backend (`liveConfig.js`) has always validated and hot-reloaded ~32
parameters across 6 groups, but `LiveConfigPanel.jsx` only rendered 8 of
them ("core"). Execution tuning (slippage, latency, retries), risk limits
(drawdown, exposure caps, circuit breakers, weekly/daily stops), capital
allocation (per-exchange/per-strategy split, reserve %), rebalancing
thresholds, and scoring weights were all live-adjustable via the API but
invisible in the product itself.

- Added a schema-driven "Advanced parameters" section to `LiveConfigPanel.jsx`
  — collapsible groups (Execution / Risk / Capital / Rebalancing / Scoring),
  generic field renderer covering every schema type the backend declares
  (`number` incl. nullable, `boolean`, `enum`, and the new `weights` type
  for object-shaped params). Add a parameter to the backend schema and it
  appears in the UI automatically — no duplicated frontend metadata.
- `server/infrastructure/liveConfig.js`: added missing `getSchema()` entries
  for `scoringWeights`, `capitalPerStrategy`, `capitalPerExchange` — these
  had validators (so `setMany()` already accepted them) but no schema, so
  no generic UI could ever have rendered them.
- `tests/liveConfig.test.js`: new cross-contract test asserts every key in
  `getAll().current` has a matching `getSchema()` entry, so a future
  validator added without a schema entry fails CI instead of silently
  staying invisible in the UI again.
- `README.md`: parametrization claim updated to the verified count (32
  params / 6 groups, UI-editable, not just API-editable).

---

## [2.7.0] — PM2 supervision + i18n migration gaps closed

### Added — Process supervision
- `ecosystem.config.js`: PM2 process definition, `fork` mode, `instances: 1`
  by design (see `docs/ADR-016-pm2-single-instance-constraint.md` — the
  arbitrage engine's 5 live exchange WebSocket connections and in-memory
  SSE/risk state are process-singletons; cluster mode would duplicate WS
  connections per worker and split SSE clients with no cross-worker fan-out).
- `npm run pm2:start` / `pm2:stop` / `pm2:restart` / `pm2:logs` / `pm2:status`.
- `pm2` added to `devDependencies`.

### Fixed — i18n migration gaps (H-10 follow-up)
- `RegisterPage.jsx`: was still 100% hardcoded English despite the
  `auth.register` / `auth.googleErrors` dictionary sections already existing
  and being fully covered in both `es.js`/`en.js` — migrated to
  `useTranslation()`, mirroring the already-migrated `LoginPage.jsx` pattern.
- `IntelligencePage.jsx`: same gap in the other direction — the component
  had hardcoded Spanish strings with no matching dictionary section at all.
  Added the missing `intelligencePage` section (19 keys) to both
  dictionaries and migrated the component.
- `scripts/checkI18nCoverage.js` now reports 240 matched keys (was 221) —
  parity maintained.
- Corrected two stale code comments in `server/index.js` still referencing
  `render.yaml`/`vercel.json` (removed under L-4/ADR-012; Railway is the
  only deployment target).

### Verified (full pass, this round)
- `vitest run` — 76/76 files, 1317/1317 tests
- `eslint` — 0 errors
- `tsc --noEmit` — 0 errors
- `checkI18nCoverage` / `checkTsBuildDrift` — clean
- `vite build` — clean production build

---
> **Nota (L-3, Sesión 23)**: este archivo se condensó de 32KB a un resumen
> escaneable por entrada. El historial completo, con el detalle técnico
> línea por línea de cada "Round"/sesión (útil para auditoría profunda o
> para entender el porqué de una decisión específica), vive ahora en
> [`CHANGELOG_ARCHIVE.md`](./CHANGELOG_ARCHIVE.md) — nada se borró, solo se
> movió. El detalle de las 22+ sesiones de refactor arquitectónico
> (C-1 a L-5) vive en [`MIGRATION_CLEANUP_LOG.md`](./MIGRATION_CLEANUP_LOG.md),
> que es la fuente de verdad para ese eje de trabajo y no se tocó aquí.

---

## [Unreleased] — Round 23: ArbitragePage tab-bar clipping fix + latency endpoint documented
- Fixed tab bar clipping on narrow viewports in `ArbitragePage.jsx` (horizontal scroll instead of hard clip).
- Documented the existing `GET /api/arbitrage/e2e-latency` endpoint in `docs/JudgeGuide.md` (no fabricated numbers — instructs running against live data first).
- Verified: 1145/1145 tests, lint/build clean.

## [Unreleased] — Round 22: Predictive rebalancing gap closed (directional bias)
- Added `server/domain/directionalBiasTracker.js` — predicts inventory imbalance from recent buy/sell directional bias ahead of the reactive concentration threshold (closes the one written committee commitment with no code behind it).
- Verified with new dedicated test coverage; no regressions.

## [Unreleased] — Round 20: Repository-layer wiring + Fase 3 dual-leg execution + CI
- Added `executeCrossExchangeLive()` — real dual-leg cross-exchange execution with partial-fill auto-recovery (`CLOSE_NOW`). Not wired to any HTTP route yet by design (needs its own security review first).
- Closed Nivel 3 #3: `alerts`/`watchlist`/`portfolio` routes now go through the repository layer instead of calling Mongoose models directly.
- Added `.github/workflows/ci.yml`: `npm audit` (blocking on high/critical) → `vitest run --coverage` → `vite build` → smoke tests → `tsc --noEmit`.
- Verified: 1073/1073 tests, coverage thresholds raised to match.

## [Unreleased] — Round 19: Fase 2 (Shadow Mode) closed — Bybit + Kraken clients
- Extended `liveExecution.js` beyond Binance-only to recognize Kraken and Bybit for connection testing and live execution.
- Closed the last item tracked in `docs/RoadmapToProduction.md` Fase 2.

## [2.6.0] — Round 6: TypeScript migration (audit 1.1, final outstanding item), plus bugs found along the way

This closes the last open item from the technical due diligence audit
(`kukora-technical-due-diligence.md`, finding 1.1: "no static typing on the
financial core"). All other findings from the audit (1.2 Redis-backed
stream tickets, 1.3, 2.1–2.5, and the minor performance/security fixes)
were already resolved in prior rounds.

### Added — TypeScript migration (audit fix 1.1)
- **`server-types/server/{feeConfig,validation,walletManager,advancedRiskEngine}.ts`**:
  the four financial-core modules flagged by the audit are now real,
  `strict: true` TypeScript sources. They compile via `tsc` to the exact
  same `server/*.js` CommonJS output that existed before, so every
  existing `require('./feeConfig')` (and the 20+ other call sites across
  `arbitrageEngine.js`, `rebalanceEngine.js`, `riskEngine.js`,
  `arbitrage.engine.js`, the arbitrage route files, etc.) is unaffected —
  zero call sites needed to change.
- **`server-types/server/{exchangeRegistry,logger,liveConfig,observabilityService,analytics}.d.ts`**:
  loose, sibling type declarations for the still-plain-JS modules these
  four files depend on. Standard incremental-adoption pattern: type the
  boundary the migrated modules touch, not every transitive dependency.
- **`tsconfig.json`**: `rootDir: server-types`, `outDir: .` — so a file at
  `server-types/server/feeConfig.ts` compiles in place to
  `server/feeConfig.js`, never emitting anywhere else. `noEmitOnError:
  true` so a type error blocks the build instead of silently shipping
  stale JS.
- **`package.json`**: added `build:ts` (`tsc`) script. The pre-existing
  `typecheck` script (`tsc --noEmit`) now actually has a `tsconfig.json`
  to run against — previously listed in `package.json` but non-functional
  with no TypeScript config in the repo.
- The highest-value part of this migration: `walletManager.ts`'s
  `applyTrade`/`getPnL` and `advancedRiskEngine.ts`'s `preTradeRiskCheck`
  now have compiler-enforced shapes for `Trade`, `Wallets`, and `PnLSummary`.
  A caller passing an incomplete trade object (e.g. missing `sellPrice`)
  is now a build-time error instead of a `NaN` discovered at runtime,
  sometimes deep inside a live P&L calculation.

### Fixed — real bugs found while verifying the migration end-to-end
These were pre-existing, unrelated to the TS migration, but surfaced by
running the full test/lint/build pipeline as part of closing out the audit:
- **`server/crypto.routes.js`**: 11 route handlers had
  `const id = sanitizeCoinId(id)` — referencing the constant being
  declared instead of `req.params.id`, a temporal-dead-zone bug that threw
  `ReferenceError: Cannot access 'id' before initialization` on every
  request to `/api/crypto/coin/:id` and its `ohlc`/`history`/`technical`/
  `analytics` variants. Fixed to `sanitizeCoinId(req.params.id)` throughout.
- **`server/index.js`**: the `/ready` readiness probe called `isDbReady()`,
  a function that was never defined anywhere in the file — a guaranteed
  `ReferenceError` on any deployment with `MONGODB_URI` set. Replaced with
  the same `mongoose.connection.readyState === 1` check used elsewhere in
  the codebase.
- **`tests/auth.routes.test.js`**: `signRefreshToken()` passed `jti` both
  inside the JWT payload (via `...overrides`) and as the `jwtid` sign
  option, which `jsonwebtoken` rejects outright. Fixed to destructure
  `jti` out of the payload spread.
- **`vitest.config.js`**: `auth.js` is loaded once via ESM `import` and
  separately via CJS `require()` in `auth.routes.test.js` (intentional,
  documented in that file, needed to reach the same mongoose model
  instances). Without a fixed `JWT_REFRESH_SECRET` in the test
  environment, `auth.js`'s `crypto.randomBytes(64)` fallback generated two
  different secrets across those two module instances, making any test
  that signs a token in one and verifies it in the other fail with
  "invalid signature" — not a real auth bug, just test nondeterminism.
  Added fixed `JWT_SECRET`/`JWT_REFRESH_SECRET` to the Vitest `env` block.
- **`tests/notifications.routes.test.js`**: `PATCH /:id/read` tests used
  `'n1'` / `'not-a-real-id'` as the notification id, which fails the
  route's (correct, intentional) `mongoose.Types.ObjectId.isValid()` guard
  added to prevent CastError-based injection. Updated the fixtures to
  valid-shaped ObjectId strings rather than weakening the guard.
- **`.eslintrc.cjs`**: added a scoped override for the four `tsc`-compiled
  files so generated CommonJS-interop `var` bindings (standard `tsc`
  output shape) don't trip `no-var`/`prefer-const` — these files are build
  artifacts and should never be hand-edited.
- Removed five now-genuinely-dead imports flagged by `no-unused-vars`
  (`getMinScore`/`getBalances`/`getPnL` in `config.routes.js`,
  `getJournal` in `stream.routes.js`, unused `API`/`Badge` in three
  frontend components) — zero `eslint src/ server/` errors maintained.

### Verified
- `npm run typecheck` (`tsc --noEmit`): 0 errors.
- `npm test` (Vitest): **135/135 passing**, 7/7 test files green.
- `npm run lint`: 0 errors across `src/` and `server/`.
- `npm run build` (Vite production bundle): succeeds.
- `node --check` on every file under `server/`: all syntactically valid.

## [2.5.0] — Round 5: notifications SSE ticket auth, Docker build/runtime hardening, proxy-aware rate limiting

### Fixed — Security
- **`useNotifications.js` / `notifications.routes.js`**: the bell-icon notification stream was still putting the raw, long-lived access token directly in the EventSource URL (`?token=...`), the same class of issue already fixed for the arbitrage and alerts streams (C-2). Migrated to the existing one-time stream-ticket exchange (`POST /api/auth/stream-ticket` → 30s single-use `?ticket=`): the real JWT is now sent exactly once, over an `Authorization` header, and never appears in a URL, proxy log, browser history entry, or `Referer` header. `server/auth.js`'s `consumeStreamTicket` is reused as-is — no new auth primitive introduced.
- **`tests/notifications.routes.test.js`**: `requireAuthForStream` tests rewritten against the ticket flow, including a dedicated test that a ticket cannot be replayed after first use.
- **`src/pages/DocsPage.jsx`**: SSE endpoint docs updated to describe ticket-based auth; added the previously-undocumented `POST /api/auth/stream-ticket` endpoint.
- **`server/auth.js`**: startup check for missing `JWT_SECRET`/`JWT_REFRESH_SECRET` now goes through the structured `logger` instead of raw `console.error`/`console.warn`, so it's actually visible in Datadog/CloudWatch-style log aggregation in production instead of only appearing on stdout. Removed a redundant duplicate `require('crypto')`.

### Fixed — Deployment
- **`Dockerfile` build stage**: was running `npm ci --omit=dev` *before* `npm run build`, which would fail outright (`vite: not found`) since Vite and `@vitejs/plugin-react` are correctly kept in `devDependencies`. Build stage now does a full `npm ci` (it needs the build tooling); the separate runtime stage still does `npm ci --omit=dev` for a lean production image.
- **`Dockerfile` runtime stage**: container ran as root with no `USER` directive. Now drops to the pre-existing unprivileged `node` user (uid 1000) from the base image after fixing up `/app` ownership.
- **`Dockerfile` healthcheck**: `/health` is protected by the optional `INTERNAL_API_KEY` header in production; the `HEALTHCHECK` instruction now forwards that key (via `${INTERNAL_API_KEY}`, expanded in-container) so a configured key doesn't cause Docker/Railway to report a healthy app as unhealthy.
- **`server/index.js`**: added `app.set('trust proxy', 1)`. Kukora deploys behind a single platform reverse proxy (Railway/Render/Vercel); without this, `req.ip` always resolved to the proxy's address, silently collapsing every anonymous client (no session header yet — every curl, healthcheck, first-time visitor) onto one shared rate-limit bucket.

### Fixed — Lint
- **`useAlertsStream.js`**: removed an unused `endpoint` parameter on `fetchStreamTicket` that was failing `no-unused-vars`. Lint is back to 0 errors across `src/` and `server/`.

## [2.4.0] — Round 4: lint zero, tests +30, observability

### Fixed — Server lint (97 → 0 errors, 28 files)
- `adaptiveScoring.js`: removed unused `simulateRun` import
- `advancedRiskEngine.js`: removed `maxCapitalPerTrade`; trimmed dead analytics imports; added `_lastFailureTs` to `getStatus()` return; renamed unused params with `_` convention
- `adversarialScenarios.js`: removed two dead `require()` importing from `arbitrageEngine`/`walletManager`
- `alertWebhookService.js`: uncommented `alertCircuitBreakerActivated` export (was defined but accidentally excluded)
- `arbitrage.state.js`: removed unused `liveConfig` import
- `arbitrageEngine.js`: removed `MIN_SPREAD_PCT`, `MAX_SPREAD_PCT`, `MAX_DAILY_LOSS`, `leg1GrossProfit` dead vars
- `auditedPnl.js`: commented empty catch with rationale
- `backtestEngine.js`: trimmed analytics imports to `stdDev` only; renamed `prices→_prices` unused param
- `crypto.routes.js`: removed 4 unused analytics imports; renamed `req→_req` in overview handler
- `dailyReportService.js`: removed unused `_err()`; added `bestSeen` to report data object
- `datasetService.js`: removed dead `keys` variable; added `sma50`/`normalizedBH` to chart return
- `exchangeService.js`: removed `_err()`; commented all 12 WebSocket empty catches with context
- `executionQualityTracker.js`: commented MongoDB fallback empty catch
- `forecastService.js`: removed unused `ema` import
- `index.js`: removed `randomUUID`, `START_TS`, `pkg`, `dbConnectedAt`; removed dead `wrap` helper
- `institutionalBacktest.js`: fixed duplicate `profitFactor` key in metrics return object
- `kcsService.js`: trimmed 3 analytics imports; removed dead `clamp01` local function
- `marketRegimeEngine.js`: removed `volatility`/`momentum` imports; renamed unused `btcDominance` param
- `mlScoringPipeline.js`: removed 3 unused destructured vars from opportunity object; renamed `context→_context`
- `observabilityService.js`: removed `LATENCY_BUCKETS` (implementation uses percentiles, not fixed buckets)
- `performanceReport.js`: removed `sessionPnl`/`tradeCount` from destructure; added `institutionalReport` to return; removed dead `fmtPct`
- `persistenceService.js`: removed unused `_err()`
- `predictiveRebalance.js`: removed `_sessionStartTs`; added `capitalPerTradeUSD` to return
- `rebalanceEngine.js`: removed unused `applyTrade` import; renamed unused `btcPrice` param
- `replayService.js`: added missing `MAX_MEMORY_REPLAYS = 200` constant definition
- `scoringService.js`: removed unused `drawdown`/`stdDev` imports
- `spreadHeatmapService.js`: renamed unused `key→_key` in for-of destructure
- `spreadMomentumEngine.js`: added `currentPredicted` (OLS validation value) to opportunity return
- `walletManager.js`: removed unused `_log()`
- `watchdog.js`: removed unused `path` import; replaced 3 hardcoded `'kukora_watchdog'` strings with `HEARTBEAT_KEY` constant; renamed `heapTotal→_heapTotal` in `checkMemory`; commented 9 empty catches with rationale

### Fixed — Frontend lint (34 → 0 errors, 18 files)
- Removed unused imports/vars: `OpportunityScoreBreakdown`, `React`, `useRef`, `EX_COLORS`, `fmt1`, `fmt`, `clamp01`, `totalVol`, `anLoading`, `idx`, `up24`
- Fixed prefer-const violations and unescaped entities (`"`, `'`, `&`)
- Commented all empty catch blocks with context (optimistic UI, localStorage fallback, network poll)
- `MarketPulse.jsx`: added `totalVol` metric card to the display grid
- `datasetService.js`: exposed `sma50` and `normalizedBH` in chart data

### Improved — ESLint config
- Added `varsIgnorePattern: '^_'` and `argsIgnorePattern: '^_'` to `no-unused-vars` — standardises the `_` prefix as the project-wide convention for intentionally-unused identifiers

### Added — Tests (41 → 71, +30 tests)
- `tests/engine.test.js`: 30 new tests covering `scoringService` (7), `arbitrageEngine.detectOpportunities` (7), `advancedRiskEngine` circuit breaker + `preTradeRiskCheck` + `getStatus` + `assetRiskScore` (11), and `alertWebhookService` integration (5)

### Added — Observability
- `server/logger.js`: added `git_sha` field to production JSON log entries when `GIT_SHA` env var is set (injected by CI via `$RAILWAY_GIT_COMMIT_SHA` or equivalent)
- Confirmed `metricsService` increments `detection_cycles` and `trades_executed` correctly in `arbitrage.engine.js`

### Added — Documentation
- `CONTRIBUTING.md`: documented `tests/smoke.test.js` as Legacy smoke suite — how to run it (`node tests/smoke.test.js`), why it coexists with Vitest (tests HTTP layer end-to-end), and why it is NOT migrated
- `docs/CHANGELOG.md`: replaced with redirect to canonical root `CHANGELOG.md`

---

## [2.1.0] — Engineering quality pass

### Fixed
- `AboutPage.jsx`: corrected `lyesterday` autocorrect typo throughout — property key, display values, and TIMELINE entry title. This affected the "Risk & Execution Layer" milestone title and the entire Technical Architecture table.
- `riskEngine.js`: removed `logger.warn()` call that fired on every `require()` — deprecated shim files should not emit runtime noise.
- `index.html`: corrected `lang="es"` → `lang="en"` (platform is fully in English).

### Improved — CI/CD
- Added `audit` job to CI pipeline: `npm audit --audit-level=high` fails the build on high/critical vulnerabilities.
- Added `docker` job: verifies Docker image builds cleanly on every push to `main` with BuildKit layer caching.
- Added `concurrency` group to CI to cancel stale runs on force-push.
- Added `dist/index.html` existence check to the build verification step.

### Improved — About Page
- Added live `System Status` panel rendering engine stats from `/health` — opportunities detected, trades executed, daily P&L, heap usage.
- Added `Platform Modules` section: 8 module cards linking to their respective pages.
- Added `Architecture Decision Records` section surfacing ADR-001 through ADR-004 summaries inline.
- Improved `Status` badge: shows actual uptime duration and DB latency when connected.
- Added inline SVG icons to contact links.

### Improved — Documentation
- `docs/Architecture.md`: updated version reference from `v17` to `v2.0`. Added Module Map table (18 modules), Data Flow diagram, Key Design Decisions table, Performance Targets table.
- `docs/DeveloperGuide.md`: complete rewrite — prerequisites, all npm scripts, project structure tree, "Adding a module" guide, "Adding a page" guide, logging conventions, testing guide, deployment options.
- `README.md`: fixed state machine description `8 states` → `12 states` to match implementation.

### Improved — Code Quality
- Added `.eslintrc.cjs` — the `npm run lint` script existed but there was no ESLint configuration, making linting effectively a no-op. Config enforces `prefer-const`, `no-var`, `no-unused-vars`, React Hooks rules, with appropriate overrides for server and test files.
- Added `eslint`, `eslint-plugin-react`, `eslint-plugin-react-hooks` to `devDependencies`.
- Added `npm run audit` convenience script.

### Improved — Vite Config
- Added `/health` proxy entry so the dev server correctly proxies health checks from the frontend to the API.

---

## [2.0.0] — Platform maturity release

### Platform & Infrastructure
- Added `.github/workflows/ci.yml` — CI pipeline runs test suite on every push
- Added `Dockerfile` and `.dockerignore` for containerized deployment
- Rate limiting re-enabled with separate limits for API vs SSE endpoints
- Helmet CSP configured with explicit allowlists
- Environment variables cleaned — credentials no longer included in repository

### Frontend
- All user-visible UI text translated to English for international consistency
- Navigation section labels updated: Arbitrage System, Markets, Tools, Quantitative Analysis, Research, Platform
- `AboutPage` rewritten as a professional product page with development timeline, technical architecture table and design principles
- Onboarding tour fully translated with accurate platform descriptions
- Version tracking removed from file-level JSDoc headers

### Documentation
- `README.md` completely rewritten as technical platform documentation
- `package.json` description updated

### Code Quality
- Version number prefixes removed from inline comments
- All hackathon/jury-specific references removed from source code
- `DEMO_MODE` documented as Sandbox Mode with isolation notes

---

## [1.18.0] — Operational maturity

### Arbitrage Engine
- Walk-forward backtest with parameter sweep across 35 combinations
- Adversarial scenario suite: mid-flight failure recovery, slippage circuit breaker, liquidity crunch
- Replay engine for historical market moment reproduction
- Executive dashboard with cross-module KPIs

### Risk & Inventory
- Predictive rebalancing with depletion forecasting
- Capital efficiency panel: hourly ROI, idle capital %, infrastructure break-even
- Audited P&L with cent-accurate reconciliation, CSV and HTML export

### Platform
- Hot-reloadable live configuration without process restarts
- StatArb module: EWMA Z-score, AR(1) half-life, mean-reversion signals
- Spread heatmap: persistent edge by pair and exchange
- Microstructure: order book decay curves, latency racing benchmarks

---

## [1.0.0] — Core engine

### Foundation
- Bilateral O(n²) detection across 5 exchanges via native WebSockets
- VWAP L2 pricing (replaces midprice assumptions)
- Pre-funded bilateral settlement model
- Full trade state machine with 12 states: DETECTED → SCORING → APPROVED → ORDER_CREATED → ORDER_SUBMITTED → PARTIALLY_FILLED → FILLED → SETTLING → COMPLETED / FAILED / ROLLED_BACK / EMERGENCY_EXIT
- Advanced risk engine with circuit breakers, drawdown controls, per-exchange exposure limits
- Composite opportunity scoring: profit, liquidity, persistence, latency, confidence
- Sub-30ms detection latency established as baseline
