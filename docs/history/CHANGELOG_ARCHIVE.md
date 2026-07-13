# Changelog

All notable changes to Kukora are documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased] — Round 23: ArbitragePage tab-bar clipping fix + latency endpoint documented

Continues from Round 22. Two remaining items from the original audit's priority list closed;
one item explicitly left open pending real market-data runtime (documented below, not faked).

### Fixed
- **`src/pages/ArbitragePage.jsx`** — the tab bar's `OPERATIONAL` group (7 tabs: Parámetros,
  Executive Dashboard, Adaptive, Stress Test, Adversarial, Latency, Replay) was silently clipped
  on narrower viewports: the container used `overflow:'hidden'` with `flexShrink:0` on every tab
  button and no scroll affordance, so tabs past the visible width simply disappeared with no
  indication more existed. Changed to a horizontally-scrollable row per tab group
  (`overflowX:'auto'`, class `arb-tab-scroll`) with a themed thin scrollbar
  (`src/styles/global.css`) instead of hard clipping. This was found by static/code review, not
  by an actual browser session — a real-browser check at common laptop widths (1280px, 1366px) is
  still recommended before the July 12 evaluation to confirm the fix visually.
- Code-level review confirmed this was the only structural responsive issue: the always-visible
  `SystemStatusBar` (P&L, mode, circuit breaker) renders outside the tab system regardless of
  active tab, the default tab is `'bot'` (Opportunities), and every panel is independently wrapped
  in `<ErrorBoundary inline>` — a single panel failing does not take down the page. No changes
  needed there.

### Documented
- **`docs/JudgeGuide.md`** — new §4.1 pointing to the existing (previously undocumented)
  `GET /api/arbitrage/e2e-latency` endpoint (`server/infrastructure/e2eLatencyTracker.js`,
  already fully implemented: 500-sample circular buffer, p50/p95/p99 via linear interpolation,
  per-exchange breakdown — this was already wired into `arbitrageOrchestrator.js` on every real
  detection tick, just never surfaced as a citable aggregate figure in judge-facing docs).
  **No latency numbers are stated in the docs** — the entry explicitly instructs running the
  system against live market data for 30–60 min first and citing the real curl output, per the
  project's no-fabricated-numbers policy.

### Not done this round (needs a real browser / human)
- Actual screenshots of the live UI (was priority item #2's second half) — no Chromium/Playwright
  binary was available in this environment. Recommend Gabriel runs `npm run dev`, opens
  `http://localhost:5173`, resizes to laptop width, and confirms the tab-scroll fix renders as
  expected, then captures the 3–4 screenshots the original audit asked for.
- Real p50/p95/p99 latency figures — endpoint is ready, numbers require an actual live session.

### Verified, not touched
- Full suite: 1145/1145 passing (66 files), unchanged — this round touched no server logic, only
  a presentational fix and documentation. Lint clean. `npm run build` clean.

---

## [Unreleased] — Round 22: Predictive rebalancing gap closed (directional bias)

Closes the one concrete written commitment to the judging committee (Phase 1,
Question 3) that had no code behind it: predicting inventory imbalance from
recent buy/sell directional bias, ahead of the reactive concentration
threshold.

### Added
- **`server/domain/directionalBiasTracker.js`** — pure domain module.
  `computeBias(trades, {window, minSample})` scores each exchange's
  buy/sell bias over its last N cross-exchange trades;
  `getBiasSignals(trades, opts)` filters down to exchanges with a
  statistically meaningful, consistent bias (`|biasScore| >= 0.7`, minimum
  8-trade sample by default).
- **`liveInventoryReconciliation.checkInventory()`** now also raises
  *predictive* rebalance suggestions (`trigger: 'predictive'`) for
  consistently sell-biased exchanges whose real concentration has crossed an
  informational 45% threshold — before the existing 65% reactive threshold
  fires (`trigger: 'reactive'`). Every suggestion now carries a `trigger`
  field. Sourced from `liveExecution.getAuditLog()` — no new event wiring
  required.
- Tests: `tests/directionalBiasTracker.test.js` (15 cases, pure logic) and
  6 new integration cases in `tests/liveInventoryReconciliation.test.js`
  covering the predictive path, using the project's established
  `vi.spyOn()`-on-the-real-singleton pattern (see comment at the top of that
  file) rather than `vi.mock()`.
- `docs/Rebalancing.md` — new section documenting the live reconciliation
  system as distinct from the simulated-wallet `rebalanceEngine.js`, and the
  directional-bias mechanism. `docs/JudgeGuide.md` — FAQ entries on the
  slippage confidence cascade and the two predictive-rebalancing mechanisms;
  fixed a stale "72 tests" reference (now 1145). `docs/SystemLimits.md` —
  same stale-count fix.

### Verified, not touched
- Full suite: 1145/1145 passing (66 files) after the additions — up from the
  previously-verified 1124/1124 baseline. Lint clean on all new/modified
  files. `npm run build` clean.
- Confirmed (contrary to an earlier audit pass) that `predictiveRebalance.js`
  / `rebalanceEngine.js` (Sections 9–10, consumption-rate depletion
  forecasting on the *simulated* wallet model) were already fully
  implemented and wired end-to-end (`arbitrageOrchestrator.js` →
  `predictReb.recordTrade()`, routes at `/api/arbitrage/rebalance/predict`
  and `/consumption`) — this round's gap was specifically the *live-account*
  reconciliation path, which had no predictive signal at all.

---

## [Unreleased] — Round 20: Repository-layer wiring closed out + Fase 3 dual-leg execution + CI

Continues directly from Round 19. Two independent audit items closed and
one Fase 3 code deliverable added.

### Added — Fase 3: real dual-leg cross-exchange execution
- **`executeCrossExchangeLive(opportunity, userId, amount)`** in
  `server/application/liveExecution.js` — buys on
  `opportunity.buyExchange` and sells on `opportunity.sellExchange`
  concurrently (`Promise.all`), assuming pre-funded balances on both
  exchanges (quote currency on the buy side, base asset already in
  inventory on the sell side — a same-block inter-exchange transfer is far
  too slow for arbitrage timing).
- **Partial-fill recovery**: if exactly one leg fills, the position is
  flattened immediately on that same exchange (`CLOSE_NOW` — sell back a
  naked long, or buy back a naked short), mirroring the policy the
  `mid_flight_failure` adversarial scenario already documented for the
  simulated engine (`server/domain/adversarialScenarios.js`). The thrown
  error carries `.partial = true` and `.recovery` so callers can tell "the
  trade didn't happen" apart from "the trade half-happened and was
  auto-flattened — check the audit log."
- **`_normalizeOrderStatus(exchange, status)`** — maps Binance/Bybit/Kraken's
  differently-shaped `getOrder()` responses to a common
  `{ filled, fillPrice, fillQty }` shape, used only by the new
  cross-exchange path (the pre-existing single-leg `executeLive()` keeps
  its original Binance-shaped parsing, unchanged).
- **`preflightSellSide()`** — sell-leg-specific pre-flight check (base-asset
  balance instead of quote-currency balance).
- `tests/liveExecutionCrossExchange.test.js` — 10 new tests: full
  dual-leg success with gross-profit calculation, buy-filled/sell-failed
  recovery, sell-filled/buy-failed recovery (via symmetric assertions),
  neither-leg-filled failure, and pre-flight validation (missing
  `sellExchange`, `buyExchange === sellExchange`, unsupported pair, missing
  credentials, insufficient sell-side inventory).
- **Scope note**: `executeCrossExchangeLive()`, `executeLive()`, and
  `setUserMode()` are still not wired to any HTTP route — deliberately.
  Exposing "flip a user to live trading" / "execute a real order" over
  HTTP needs its own security review (auth, confirmation flow, rate
  limiting) before it ships; see `docs/RoadmapToProduction.md` Fase 3.

### Fixed — Nivel 3 #3: repository layer wired into routes (audit quick-win)
`server/repositories/index.js` existed since an earlier round
(`BaseRepository`, `AlertRepository`, `WatchlistRepository`,
`PortfolioRepository`, `MockRepository`) but `alerts.routes.js`,
`watchlist.routes.js`, and `portfolio.routes.js` still called Mongoose
models (`Alert.find(...)`, etc.) directly, bypassing it entirely.
- All three route files now delegate persistence to `repos.alerts` /
  `repos.watchlist` / `repos.portfolio` (built once via
  `buildRepositories()`); route handlers are left with only HTTP concerns
  (validation, status codes).
- **`PortfolioRepository.addEntryIdempotent(userId, data, idempotencyKey,
  windowMs)`** — the idempotency-key replay logic for
  `POST /api/portfolio` (dedupe a duplicate submission within a 60s window)
  moved out of the route handler and into the repository, alongside the
  rest of `PortfolioRepository`'s Mongoose access.
- `tests/user-data.routes.test.js` — mocks updated to match the
  repository's actual Mongoose call chains (`.find().sort().lean()`,
  `.findOne().lean()`, `.find().sort().skip().limit().lean()`); added a
  route-level test exercising the idempotency-free `POST /api/portfolio`
  path through the repository.
- `tests/repositories-real.test.js` — added a dedicated
  `addEntryIdempotent` test group (first-time creation, replay within the
  window, new entry once the window expires, DB-not-ready fallback) using
  a purpose-built fake Mongoose model that understands the
  `createdAt: { $gte: ... }` query shape (the shared generic fake model
  only does plain equality matching).

### Added — Nivel 3 #5: CI with mandatory npm audit + enforced coverage thresholds
- `.github/workflows/ci.yml` — on every push/PR to `main`: `npm ci` →
  `npm audit --omit=dev --audit-level=high` (blocking) → informational
  full audit report → `vitest run --coverage` (fails if coverage drops
  below `vitest.config.js`'s thresholds) → `vite build` → smoke tests →
  `tsc --noEmit`.
- Audit is scoped honestly rather than glossed over: dev-only tooling
  (esbuild via vite) is excluded since it never ships; one known moderate
  transitive vulnerability (`uuid` via `firebase-admin` → `google-gax`) is
  documented inline in the workflow as accepted-and-tracked because its
  fix (`firebase-admin@14`) requires Node ≥22 and Kukora currently targets
  Node 20 — CI still blocks on high/critical so a *new* vulnerable
  dependency doesn't slip through un-noticed.
- `vitest.config.js` coverage thresholds raised to match Round 20's actual
  numbers (lines 59→65, functions 53→58, branches 45→50, statements
  56→62) so CI locks in this round's progress instead of just matching the
  old floor.

### Verified
`npx vitest run` → **1073/1073** (1063 previous + 10 new cross-exchange
tests, cero regresiones)
`npx vitest run --coverage` → thresholds pass (65.95% stmts / 54.51%
branch / 62.98% funcs / 69.51% lines)
`npx vite build` → limpio
`node tests/smoke.test.js` → **76/76**
`npx tsc --noEmit` → limpio

## [Unreleased] — Round 19: Fase 2 (Shadow Mode) closed out — Bybit + Kraken clients

Closes the last remaining item tracked in `docs/RoadmapToProduction.md`
Fase 2: `server/application/liveExecution.js` previously only recognized
`'binance'`; `testExchangeConnection('kraken'/'bybit', ...)` returned
`{ ok: false, error: 'Exchange <x> not supported yet' }` and `executeLive()`
was hardcoded to Binance regardless of `opportunity.buyExchange`.

### Added
- **`BybitClient`** — v5 unified-account REST client. HMAC-SHA256 signing
  over `timestamp+apiKey+recvWindow+payload`, `X-BAPI-*` headers.
  `BYBIT_TESTNET=true` routes to Bybit's official Spot/Unified Testnet
  (`api-testnet.bybit.com`) — real sandbox, virtual funds, zero
  real-capital risk, same shape as Binance's testnet support.
- **`KrakenClient`** — real production Kraken auth scheme: HMAC-SHA512 over
  `path + SHA256(nonce + postdata)`, `API-Sign` header. Documented honestly:
  Kraken does not publish an official Spot sandbox. `KRAKEN_SANDBOX=true`
  only takes effect once `KRAKEN_SANDBOX_URL` is also configured (pointing
  at a self-hosted mock or equivalent); without it, the client throws
  instead of silently falling back to real production Kraken.
- **`getExchangeClient(exchange, apiKey, apiSecret)`** — factory that
  selects the right client + testnet/sandbox env flag generically. Used by
  both `executeLive()` and `testExchangeConnection()`, replacing the
  Binance-only hardcoding.
- `executeLive()` now reads `opportunity.buyExchange` to decide which
  exchange (and which `<EXCHANGE>_API_KEY`/`<EXCHANGE>_API_SECRET` env
  pair) to use, defaulting to `binance` when absent — it is no longer
  Binance-exclusive. The single-leg (buy-only) execution behavior is
  unchanged; real simultaneous dual-leg cross-exchange execution remains
  Fase 3 scope, as documented in the roadmap.
- `.env.example`: added `BYBIT_API_KEY`, `BYBIT_API_SECRET`,
  `BYBIT_TESTNET`, `KRAKEN_API_KEY`, `KRAKEN_API_SECRET`, `KRAKEN_SANDBOX`,
  `KRAKEN_SANDBOX_URL` with the same explanatory-comment style as the
  existing Binance block.
- `tests/liveExecution.test.js`: 11 new tests covering Bybit
  testnet/mainnet routing and error surfacing, Kraken signing/mainnet
  calls, the Kraken-sandbox-without-URL refusal path, and
  `executeLive()`'s per-exchange client/env-key selection.

### Changed
- `docs/RoadmapToProduction.md` Fase 2 section and `docs/Architecture.md`'s
  Path to Production table rewritten to reflect that all three exchanges
  are now implemented; the only remaining Fase 2 item is elapsed real-market
  shadow-mode time (30 days) to measure Sharpe, not code.

### Verified
- `npx vitest run`: 1056/1056 (was 1045/1045 — 11 new tests, zero regressions).
- `npx vite build`: clean.
- `node tests/smoke.test.js`: 76/76.
- `npx tsc --noEmit`: clean.

---

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
