# ADR-008: React + Vite over Next.js for the frontend

**Status:** Accepted
**Date:** 2025-Q2
**Author:** Engineering

---

## Context

Kukora's frontend is a 22-route single-page application driving a real-time
trading dashboard: live SSE streams, a 2-3s detection loop, and pages that
each render 4-12 data-dense panels. The choice of frontend framework affects
bundle strategy, dev iteration speed, and operational complexity — it was
never formally written down, so it's documented here for the next engineer
who reasonably asks "why isn't this Next.js?"

## Decision

Use React + Vite, not Next.js (or any other SSR-capable meta-framework).

## Rationale

**Server-side rendering doesn't help a real-time trading dashboard.**
SSR's main value is faster perceived first paint and SEO for content that's
mostly static at request time. Every page in Kukora is live: prices, spreads,
and engine state continue updating via SSE/polling within seconds of mount.
A server-rendered first paint would be stale before the user finishes reading
it, and there is no SEO requirement for an authenticated trading tool — the
two strongest reasons to reach for SSR don't apply here.

**Vite's code-splitting is the actual bottleneck this app has.**
With 22 routes and several panel-heavy pages (charting libraries, technical
indicators), the real performance risk is initial bundle size, not
time-to-first-byte. `React.lazy()` + Vite's per-route chunking (see
`src/App.jsx`) means a user landing on `/alerts` never downloads the
backtest engine's charting dependencies. Next.js's App Router offers a
comparable per-route splitting model, but at the cost of a server runtime
this app doesn't otherwise need.

**No server runtime to operate.** Kukora already runs a stateful Node/Express
process (the arbitrage engine, SSE fan-out, MongoDB connections). Adding a
second Node runtime for SSR (or running SSR inside the same process) is
operational complexity in exchange for a benefit (SSR) this app doesn't use.
Vite's output is a static bundle the Express server already serves via
`express.static` in production (see `server/index.js`) — no additional
process, no additional deployment target.

**Dev experience.** Vite's HMR is faster than Next.js's dev server for a
project this size, and the configuration surface is smaller — there's one
`vite.config.js`, not a routing convention, a server/client component
boundary, and a build-time vs runtime distinction to reason about.

## Consequences

- No SEO for any Kukora page. Acceptable: this is an authenticated
  operational tool, not public marketing content.
- No streaming SSR / React Server Components. Acceptable: nothing in this
  app benefits from server-rendered initial HTML when the data is live
  within seconds anyway.
- If a public, content-heavy marketing site is ever built around Kukora
  (docs, landing page, blog), that should be a *separate* Next.js or
  Astro project — not a reason to migrate the dashboard itself.

## Alternatives considered

- **Next.js (App Router):** rejected per above — SSR/RSC value doesn't
  apply, and it adds a server runtime to operate for a benefit unused.
- **Create React App:** rejected on its own merits — unmaintained,
  slower dev server, no first-class code-splitting story compared to Vite.
- **Remix:** similar reasoning to Next.js; SSR-first architecture solving
  a problem (stale-on-load content) this app doesn't have.
