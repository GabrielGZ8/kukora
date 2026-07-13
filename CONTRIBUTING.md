# Contributing to Kukora

## Branching strategy

- `main` — always deployable. Protected; merges only via reviewed PR.
- `develop` — integration branch for the next release. Feature branches
  target `develop`, not `main`.
- `feature/<short-description>` — one feature or fix per branch
  (e.g. `feature/portfolio-pagination`).

Release flow: `feature/*` → `develop` → `main`, tagged on merge to `main`.

## Commit message format

This repo follows [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <short summary>

[optional body]
[optional footer]
```

Types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `perf`, `ci`.
Scope is the touched module or layer (e.g. `arbitrage`, `api`, `frontend`,
`docs`). Examples:

```
feat(api): add pagination to GET /api/portfolio
fix(server): anonymous clients no longer share one rate-limit bucket
test(middleware): add coverage for sessionMiddleware UUID validation
docs(adr): record React+Vite vs Next.js decision
```

## Pull request checklist

Before opening a PR:

- [ ] `npm run lint` passes (or new warnings are explained in the PR)
- [ ] `npm test` passes, and new logic has test coverage
- [ ] `npm run build` succeeds (catches frontend syntax/bundle errors)
- [ ] No new npm dependency without a one-line justification in the PR
      description (see restriction below)
- [ ] Public API changes (new/changed endpoints, response shapes) are
      reflected in `docs/Architecture.md` or relevant module docs
- [ ] No secrets, API keys, or `.env` values committed

PR description should state: what changed, why, and how it was tested
(unit tests added, manual verification steps, etc).

### On adding dependencies

Kukora intentionally keeps its dependency surface small — every dependency
is a unit of supply-chain risk and an upgrade obligation. Before adding one,
check whether the same problem is solvable with:
1. A built-in Node/browser API
2. ~20-30 lines of project code (see `server/validation.js` for an example
   of preferring hand-rolled logic over a validation library)

If a dependency is still the right call, say so explicitly in the PR.

## How to add a new exchange

1. Add exchange credentials/config to `.env.example` and `feeConfig.js`
   (withdrawal fees, maker/taker fees).
2. Implement a WebSocket adapter in `exchangeService.js` following the
   existing adapter shape (`connect`, `onOrderBook`, `disconnect`).
3. Add the exchange to `ALL_EXCHANGES` in
   `src/components/common/ArbitrageSharedComponents.jsx` (frontend display)
   and to `EX_COLORS` for its brand color.
4. Add the exchange to `INITIAL_BALANCES` in `server/walletManager.js` so
   the simulated wallet has starting capital on that venue.
5. Verify `/health` and `/api/readiness` report the new feed once connected.
6. Add at least one test exercising detection across the new exchange pair
   (see `tests/kukora.test.js` for the existing pattern).

## How to add a new scoring factor

Scoring lives in `server/scoringService.js`. To add a factor:

1. Add the raw signal computation (e.g. a new function exported from the
   relevant tracker module — see `exchangeReliabilityDynamic.js` or
   `adaptiveScoring.js` for examples of self-contained signal modules).
2. Wire the signal into `scoreOpportunity()`'s composite score, with an
   explicit weight constant (not a magic number inline).
3. Add the factor's contribution to the `reasoning` array so it's visible
   in the UI's score breakdown (see `OpportunityScoreBreakdown` usage in
   `ArbitragePage.jsx`).
4. Add a unit test asserting the factor moves the score in the expected
   direction for both a favorable and unfavorable input.
5. Document the factor in `docs/Architecture.md` under the scoring section.

## Running things locally

```
npm install
npm run dev        # frontend (Vite) + backend (Express) concurrently
npm test           # vitest unit tests
npm run lint        # eslint
npm run build       # production frontend bundle
```

See `DeveloperGuide.md` for environment variable setup and MongoDB
configuration (optional — the app runs in in-memory mode without it).

## Test suites

Kukora has two coexisting test suites with different purposes:

### Vitest unit/integration tests (`tests/*.test.js`)

Run with `npm test` (alias: `npx vitest run`). These are the tests that run
in CI and must always pass before merge. They cover middleware, health checks,
engine logic, scoring, risk, and alert services — all in-process, no live
server required. Adding coverage here is the standard way to test new modules.

### Legacy smoke suite (`tests/smoke.test.js`)

**Run with `node tests/smoke.test.js`** — NOT with Vitest.

This is a 1385-line standalone HTTP integration runner that fires real HTTP
requests against a live server. It was written before the Vitest suite existed
and uses its own custom assertion/runner infrastructure. It is NOT migrated to
Vitest because:

1. It tests the full HTTP layer end-to-end (auth headers, SSE streams,
   rate-limiting, CORS) — concerns that can't be covered by in-process unit
   tests without significant infrastructure.
2. Its custom runner emits a human-readable report format that the team uses
   during manual pre-deploy verification.
3. Migrating it would require a full rewrite with no additional coverage gain.

**Run the smoke suite before every production deploy:**

```
# Terminal 1 — start the server in test mode
NODE_ENV=test npm run server

# Terminal 2 — run the smoke suite against it
node tests/smoke.test.js
```

The smoke suite expects the server on `http://localhost:5000`. It will exit
with a non-zero code if any assertion fails.
