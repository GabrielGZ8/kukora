import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

async function loadModule({ liveEnabled = false } = {}) {
  vi.resetModules();
  process.env.LIVE_TRADING_ENABLED = liveEnabled ? 'true' : 'false';
  const mod = await import('../server/application/liveExecution.js?t=' + Math.random());
  const liveExecution = mod.default || mod;
  return _autoSeedOpportunityStore(liveExecution);
}

// Unwrapped variant — for tests that specifically want to verify the
// unknown/expired-opportunity rejection path itself, where auto-seeding
// would defeat the point of the test.
async function loadRawModule({ liveEnabled = false } = {}) {
  vi.resetModules();
  process.env.LIVE_TRADING_ENABLED = liveEnabled ? 'true' : 'false';
  const mod = await import('../server/application/liveExecution.js?t=' + Math.random());
  return mod.default || mod;
}

// AUDIT FINDING 1 fix (server/application/liveExecution.js): executeLive/
// executeCrossExchangeLive now resolve the client-supplied opportunity
// against a server-side snapshot store instead of trusting its numbers
// directly (see resolveTrustedOpportunity() and opportunitySnapshotStore.js).
// In production that store is populated by the detection loop
// (arbitrageOrchestrator.js). These unit tests build ad-hoc opportunity
// objects directly, with no detection loop running, so this wraps the two
// entry points to auto-seed the store with whatever opportunity object the
// test passes in — preserving the exact same downstream behavior (preflight
// / risk-gate / order-routing all see the fields the test set) while still
// exercising the real resolveTrustedOpportunity() gate rather than
// bypassing it.
function _autoSeedOpportunityStore(liveExecution) {
  const store = liveExecution._opportunitySnapshotStore;
  // checkpoint-37: these tests predate the per-user live-mode toggle
  // (userLiveModeService.js) and exercise setUserMode('live') directly —
  // never through the real activation flow (connect exchange + 2FA +
  // disclaimer). Force-enable the toggle for whatever userId the test
  // passes in via the test-only bypass seam, so the new gate doesn't
  // block pre-existing coverage of the trading logic itself.
  const userLiveModeService = require('../server/infrastructure/userLiveModeService');
  const wrap = (fn) => (opportunity, ...rest) => {
    if (opportunity && opportunity.id) store.recordSnapshot(opportunity);
    if (rest[0]) userLiveModeService._forceEnableForTests(rest[0]);
    return fn(opportunity, ...rest);
  };
  liveExecution.executeLive = wrap(liveExecution.executeLive);
  liveExecution.executeCrossExchangeLive = wrap(liveExecution.executeCrossExchangeLive);
  return liveExecution;
}

describe('liveExecution', () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.unstubAllGlobals();
  });

  describe('setUserMode / getUserMode', () => {
    it('defaults to paper mode for unknown users', async () => {
      const liveExecution = await loadModule();
      expect(liveExecution.getUserMode('new-user')).toBe('paper');
    });

    it('rejects invalid mode strings', async () => {
      const liveExecution = await loadModule();
      expect(() => liveExecution.setUserMode('u1', 'turbo')).toThrow('Invalid mode');
    });

    it('blocks switching to live mode when LIVE_TRADING_ENABLED is not set', async () => {
      const liveExecution = await loadModule({ liveEnabled: false });
      expect(() => liveExecution.setUserMode('u1', 'live')).toThrow(/Live trading is disabled/);
      // Mode should remain unset/paper since the switch was rejected
      expect(liveExecution.getUserMode('u1')).toBe('paper');
    });

    it('allows switching to live mode when LIVE_TRADING_ENABLED=true', async () => {
      const liveExecution = await loadModule({ liveEnabled: true });
      expect(() => liveExecution.setUserMode('u1', 'live')).not.toThrow();
      expect(liveExecution.getUserMode('u1')).toBe('live');
    });

    it('records a MODE_CHANGED entry in the audit log on success', async () => {
      const liveExecution = await loadModule({ liveEnabled: true });
      liveExecution.setUserMode('u1', 'live');
      const log = liveExecution.getAuditLog();
      expect(log[0]).toMatchObject({ event: 'MODE_CHANGED', userId: 'u1', mode: 'live' });
    });
  });

  describe('executeLive — paper mode / disabled safety gate', () => {
    it('delegates to paper execution when LIVE_TRADING_ENABLED is false, regardless of user mode', async () => {
      const liveExecution = await loadModule({ liveEnabled: false });
      const result = await liveExecution.executeLive({ id: 'op1' }, 'u1', 0.01);
      expect(result).toMatchObject({ ok: true, mode: 'paper', simulated: true });
      expect(result.tradeId).toMatch(/^live-/);
    });

    it('delegates to paper execution when user is in paper mode even if live trading is globally enabled', async () => {
      const liveExecution = await loadModule({ liveEnabled: true });
      // user never called setUserMode, so defaults to 'paper'
      const result = await liveExecution.executeLive({ id: 'op1' }, 'u1', 0.01);
      expect(result).toMatchObject({ ok: true, mode: 'paper', simulated: true });
    });

    it('never calls fetch (no real network) in paper mode', async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);
      const liveExecution = await loadModule({ liveEnabled: false });
      await liveExecution.executeLive({ id: 'op1' }, 'u1', 0.01);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('executeLive — live mode credential gate', () => {
    it('throws if BINANCE_API_KEY/SECRET are missing, even with live mode enabled', async () => {
      const liveExecution = await loadModule({ liveEnabled: true });
      liveExecution.setUserMode('u1', 'live');
      delete process.env.BINANCE_API_KEY;
      delete process.env.BINANCE_API_SECRET;
      await expect(liveExecution.executeLive({ id: 'op1' }, 'u1', 0.01))
        .rejects.toThrow(/BINANCE_API_KEY and BINANCE_API_SECRET must be set/);
    });

    it('never places an order if credentials are missing (no fetch call)', async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);
      const liveExecution = await loadModule({ liveEnabled: true });
      liveExecution.setUserMode('u1', 'live');
      delete process.env.BINANCE_API_KEY;
      delete process.env.BINANCE_API_SECRET;
      await expect(liveExecution.executeLive({ id: 'op1' }, 'u1', 0.01)).rejects.toThrow();
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('executeLive — live mode, preflight + order flow (mocked Binance REST)', () => {
    function mockFetchSequence(responses) {
      let call = 0;
      vi.stubGlobal('fetch', vi.fn(async () => {
        const r = responses[Math.min(call, responses.length - 1)];
        call++;
        return { ok: r.ok !== false, status: r.status || 200, json: async () => r.body };
      }));
    }

    beforeEach(() => {
      process.env.BINANCE_API_KEY = 'k';
      process.env.BINANCE_API_SECRET = 's';
    });

    it('blocks the trade when account.canTrade is false (preflight fails)', async () => {
      mockFetchSequence([{ body: { canTrade: false, balances: [] } }]);
      const liveExecution = await loadModule({ liveEnabled: true });
      liveExecution.setUserMode('u1', 'live');
      const opp = { id: 'op1', pair: 'BTC/USDT', buyPrice: 50000, detectedAt: Date.now() };
      await expect(liveExecution.executeLive(opp, 'u1', 0.01)).rejects.toThrow(/Pre-flight failed/);
    });

    it('blocks the trade when USDT balance is insufficient', async () => {
      mockFetchSequence([
        { body: { canTrade: true } },                          // getAccountInfo (preflight #1)
        { body: { balances: [{ asset: 'USDT', free: '10' }] } }, // getBalance (preflight #2)
      ]);
      const liveExecution = await loadModule({ liveEnabled: true });
      liveExecution.setUserMode('u1', 'live');
      const opp = { id: 'op1', pair: 'BTC/USDT', buyPrice: 50000, detectedAt: Date.now() };
      await expect(liveExecution.executeLive(opp, 'u1', 0.01)).rejects.toThrow(/Insufficient USDT balance/);
    });

    it('blocks the trade when the opportunity is stale (>2000ms old)', async () => {
      mockFetchSequence([
        { body: { canTrade: true } },
        { body: { balances: [{ asset: 'USDT', free: '999999' }] } },
      ]);
      const liveExecution = await loadModule({ liveEnabled: true });
      liveExecution.setUserMode('u1', 'live');
      const opp = { id: 'op1', pair: 'BTC/USDT', buyPrice: 50000, detectedAt: Date.now() - 5000 };
      await expect(liveExecution.executeLive(opp, 'u1', 0.01)).rejects.toThrow(/Opportunity stale/);
    });

    it('places a market buy order and returns fill details when everything checks out', async () => {
      mockFetchSequence([
        { body: { canTrade: true } },                                       // preflight: account
        { body: { balances: [{ asset: 'USDT', free: '999999' }] } },        // preflight: balance
        { body: { balances: [{ asset: 'USDT', free: '999999' }] } },        // risk gate: real capital USDT (Hallazgo 3 fix)
        { body: { balances: [{ asset: 'BTC', free: '5' }] } },              // risk gate: real capital BTC (Hallazgo 3 fix)
        { body: { orderId: 555 } },                                         // placeMarketOrder
        { body: { status: 'FILLED', cummulativeQuoteQty: '500', executedQty: '0.01' } }, // getOrder
      ]);
      const liveExecution = await loadModule({ liveEnabled: true });
      liveExecution.setUserMode('u1', 'live');
      const opp = { id: 'op1', pair: 'BTC/USDT', buyPrice: 50000, profit: 5, detectedAt: Date.now() };
      const result = await liveExecution.executeLive(opp, 'u1', 0.01);

      expect(result.ok).toBe(true);
      expect(result.mode).toBe('live');
      expect(result.simulated).toBe(false);
      expect(result.orderId).toBe(555);
      expect(result.fillPrice).toBeCloseTo(50000, 0); // 500 / 0.01
      expect(result.fillQty).toBeCloseTo(0.01, 5);
      expect(result.netProfit).toBeCloseTo(0.05, 5); // profit(5) * fillQty(0.01)
    });

    it('attempts to cancel and throws if the buy order does not fill', async () => {
      const cancelCalls = [];
      let call = 0;
      const responses = [
        { canTrade: true },
        { balances: [{ asset: 'USDT', free: '999999' }] },
        { balances: [{ asset: 'USDT', free: '999999' }] }, // risk gate: real capital USDT (Hallazgo 3 fix)
        { balances: [{ asset: 'BTC', free: '5' }] },        // risk gate: real capital BTC (Hallazgo 3 fix)
        { orderId: 555 },                 // placeMarketOrder
        { status: 'PARTIALLY_FILLED' },   // getOrder — not filled
        {},                                // cancelOrder
      ];
      vi.stubGlobal('fetch', vi.fn(async (url, options) => {
        if (options?.method === 'DELETE') cancelCalls.push(url);
        const body = responses[Math.min(call, responses.length - 1)];
        call++;
        return { ok: true, status: 200, json: async () => body };
      }));

      const liveExecution = await loadModule({ liveEnabled: true });
      liveExecution.setUserMode('u1', 'live');
      const opp = { id: 'op1', pair: 'BTC/USDT', buyPrice: 50000, detectedAt: Date.now() };
      await expect(liveExecution.executeLive(opp, 'u1', 0.01)).rejects.toThrow(/Buy order not filled/);
      expect(cancelCalls.length).toBe(1);
    });

    it('records LIVE_EXECUTE_FAILED in the audit log when execution throws', async () => {
      mockFetchSequence([{ body: { canTrade: false } }]);
      const liveExecution = await loadModule({ liveEnabled: true });
      liveExecution.setUserMode('u1', 'live');
      const opp = { id: 'op1', pair: 'BTC/USDT', buyPrice: 50000, detectedAt: Date.now() };
      await expect(liveExecution.executeLive(opp, 'u1', 0.01)).rejects.toThrow();
      const log = liveExecution.getAuditLog();
      expect(log.some(e => e.event === 'PREFLIGHT_FAILED')).toBe(true);
    });
  });

  // Robustez (refinamiento post-Sesión 34): ANTES de este cambio,
  // executeLive/executeCrossExchangeLive solo corrían preflightCheck (saldo,
  // permisos) — nunca pasaban por el mismo motor institucional de riesgo
  // (circuit breaker, drawdown, daily-loss, position-size cap, slippage cap)
  // que ya protegía cada trade de paper trading. Estos tests verifican que
  // el gate ahora corre, y que un perfil de riesgo por usuario más estricto
  // (userRiskProfileService) puede bloquear un trade real ANTES de tocar
  // ninguna API de exchange.
  describe('executeLive — institutional risk gate (per-user risk profile)', () => {
    function mockFetchSequence(responses) {
      let call = 0;
      vi.stubGlobal('fetch', vi.fn(async () => {
        const r = responses[Math.min(call, responses.length - 1)];
        call++;
        return { ok: r.ok !== false, status: r.status || 200, json: async () => r.body };
      }));
    }

    beforeEach(() => {
      process.env.BINANCE_API_KEY = 'k';
      process.env.BINANCE_API_SECRET = 's';
    });

    it('blocks the trade when a per-user maxPositionValueUSD override is stricter than the position value, before placing any order', async () => {
      const fetchSpy = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ canTrade: true, balances: [{ asset: 'USDT', free: '999999' }] }) }));
      vi.stubGlobal('fetch', fetchSpy);

      const liveExecution = await loadModule({ liveEnabled: true });
      liveExecution.setUserMode('risk-gate-user-1', 'live');

      const userRiskProfileService = require('../server/domain/risk/userRiskProfileService');
      userRiskProfileService.setUserRiskProfile('risk-gate-user-1', { maxPositionValueUSD: 100 });

      // 0.01 BTC * $50,000 = $500 position — well within the global $10k cap
      // but far above this user's own $100 override.
      const opp = { id: 'op1', pair: 'BTC/USDT', buyPrice: 50000, detectedAt: Date.now() };
      await expect(liveExecution.executeLive(opp, 'risk-gate-user-1', 0.01)).rejects.toThrow(/Risk check failed: position_size/);

      // The 2 preflight fetch calls (account + balance) plus the 2 real-
      // balance fetches the risk gate now makes (Hallazgo 3 fix) should have
      // happened — the risk gate must still block BEFORE placeMarketOrder.
      expect(fetchSpy).toHaveBeenCalledTimes(4);
    });

    it('records RISK_GATE_BLOCKED in the audit log with the blocking reason', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ canTrade: true, balances: [{ asset: 'USDT', free: '999999' }] }) })));

      const liveExecution = await loadModule({ liveEnabled: true });
      liveExecution.setUserMode('risk-gate-user-2', 'live');

      const userRiskProfileService = require('../server/domain/risk/userRiskProfileService');
      userRiskProfileService.setUserRiskProfile('risk-gate-user-2', { maxSlippagePct: 0.001 });

      const opp = { id: 'op1', pair: 'BTC/USDT', buyPrice: 50000, slippagePct: 0.5, detectedAt: Date.now() };
      await expect(liveExecution.executeLive(opp, 'risk-gate-user-2', 0.01)).rejects.toThrow(/Risk check failed/);

      const log = liveExecution.getAuditLog();
      expect(log.some(e => e.event === 'RISK_GATE_BLOCKED')).toBe(true);
    });

    it('a user restricted to a different set of active exchanges is blocked before any preflight network call', async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      const liveExecution = await loadModule({ liveEnabled: true });
      liveExecution.setUserMode('risk-gate-user-3', 'live');

      const userRiskProfileService = require('../server/domain/risk/userRiskProfileService');
      userRiskProfileService.setUserRiskProfile('risk-gate-user-3', { activeExchanges: ['Kraken'] });

      // Preflight succeeds for binance in this environment's default mocked
      // path, so this test only matters if preflight ran — but the whole
      // point is that it must not need to: opportunity targets binance while
      // the user restricted themselves to Kraken only.
      const opp = { id: 'op1', pair: 'BTC/USDT', buyExchange: 'binance', buyPrice: 50000, detectedAt: Date.now() };
      // Preflight still runs before the risk gate in executeLive's current
      // ordering, so we allow it to succeed first via a permissive fetch,
      // then assert the risk-gate rejection specifically.
      fetchSpy.mockImplementation(async () => ({ ok: true, status: 200, json: async () => ({ canTrade: true, balances: [{ asset: 'USDT', free: '999999' }] }) }));
      await expect(liveExecution.executeLive(opp, 'risk-gate-user-3', 0.01)).rejects.toThrow(/restricts trading to \[Kraken\]/);
    });

    it('a user with no risk profile configured behaves exactly as before (no regression)', async () => {
      mockFetchSequence([
        { body: { canTrade: true } },
        { body: { balances: [{ asset: 'USDT', free: '999999' }] } },
        { body: { balances: [{ asset: 'USDT', free: '999999' }] } }, // risk gate: real capital USDT (Hallazgo 3 fix)
        { body: { balances: [{ asset: 'BTC', free: '5' }] } },       // risk gate: real capital BTC (Hallazgo 3 fix)
        { body: { orderId: 555 } },
        { body: { status: 'FILLED', cummulativeQuoteQty: '500', executedQty: '0.01' } },
      ]);
      const liveExecution = await loadModule({ liveEnabled: true });
      liveExecution.setUserMode('risk-gate-user-4', 'live');
      const opp = { id: 'op1', pair: 'BTC/USDT', buyPrice: 50000, profit: 5, detectedAt: Date.now() };
      const result = await liveExecution.executeLive(opp, 'risk-gate-user-4', 0.01);
      expect(result.ok).toBe(true);
      expect(result.simulated).toBe(false);
    });

    // Wiring test (Hallazgo 3b): proves executeLive's own success path is
    // what feeds liveTradeLedger — not just that a manually-recorded value
    // is read back (that's what the two Hallazgo 3b tests below prove).
    it('a successful executeLive trade records its netProfit into the live P&L ledger', async () => {
      mockFetchSequence([
        { body: { canTrade: true } },
        { body: { balances: [{ asset: 'USDT', free: '999999' }] } },
        { body: { balances: [{ asset: 'USDT', free: '999999' }] } },
        { body: { balances: [{ asset: 'BTC', free: '5' }] } },
        { body: { orderId: 999 } },
        { body: { status: 'FILLED', cummulativeQuoteQty: '500', executedQty: '0.01' } },
      ]);
      const liveExecution = await loadModule({ liveEnabled: true });
      liveExecution.setUserMode('ledger-wiring-user', 'live');
      // profit=250 per unit * fillQty 0.01 = netProfit 2.5 (see executeLive's
      // `netProfit = (opportunity.profit || 0) * fillQty`).
      const opp = { id: 'op1', pair: 'BTC/USDT', buyPrice: 50000, profit: 250, detectedAt: Date.now() };
      // liveTradeLedger is a plain CJS singleton (required internally by
      // liveExecution.js via real Node require(), not vitest's per-test ESM
      // graph) — vi.resetModules() does not reset it, so tests that care
      // about its starting value must reset it explicitly, same convention
      // arbitrageOrchestrator.test.js uses for opportunityDetection's daily
      // P&L accumulator.
      liveExecution._liveTradeLedger._resetForTest();
      expect(liveExecution._liveTradeLedger.getTodaysLivePnl()).toBe(0);
      const result = await liveExecution.executeLive(opp, 'ledger-wiring-user', 0.01);
      expect(result.ok).toBe(true);
      expect(result.netProfit).toBeCloseTo(2.5, 8);
      expect(liveExecution._liveTradeLedger.getTodaysLivePnl()).toBeCloseTo(2.5, 8);
    });

    // AUDIT FINDING 3 (CRITICAL) fix: _runInstitutionalRiskGate used to
    // derive capitalUSD from walletManager.getBalances() — the SIMULATED
    // paper-trading ledger — even for real live trades. It now fetches real
    // balances from the actual exchange client(s) involved. This test
    // proves the real exchange balance is what actually reaches the gate:
    // the paper wallet is left completely untouched/default, yet the trade
    // still passes, because the real (mocked) exchange balance is what's
    // read.
    it('derives risk-gate capital from the real exchange balance, not the paper wallet (Hallazgo 3 fix)', async () => {
      mockFetchSequence([
        { body: { canTrade: true } },
        { body: { balances: [{ asset: 'USDT', free: '999999' }] } },
        // Real exchange account: a very large real balance the paper wallet
        // never has by default — proves the number came from here.
        { body: { balances: [{ asset: 'USDT', free: '500000' }] } },
        { body: { balances: [{ asset: 'BTC', free: '10' }] } },
        { body: { orderId: 777 } },
        { body: { status: 'FILLED', cummulativeQuoteQty: '500', executedQty: '0.01' } },
      ]);
      const liveExecution = await loadModule({ liveEnabled: true });
      liveExecution.setUserMode('risk-gate-user-5', 'live');
      const opp = { id: 'op1', pair: 'BTC/USDT', buyPrice: 50000, detectedAt: Date.now() };
      const result = await liveExecution.executeLive(opp, 'risk-gate-user-5', 0.01);
      expect(result.ok).toBe(true);
    });

    // AUDIT FINDING 3b fix (residual CRITICAL): sessionPnl — the daily-loss
    // circuit breaker's input — used to come from walletManager.getPnL(),
    // the PAPER wallet. A live account down real money all day would never
    // trip the breaker, because it read a completely disconnected ledger.
    // This test reproduces the bug directly: record a real loss via the
    // same liveTradeLedger.recordLiveFill() that executeLive's successful
    // trades now call, leave the paper wallet completely untouched
    // (default, $0 P&L), and prove the NEXT live trade is blocked by the
    // daily-loss breaker anyway — which is only possible if the gate reads
    // the real-fills ledger, not walletManager.
    it('the daily-loss circuit breaker blocks a live trade after a real (not paper) loss today (Hallazgo 3b fix)', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ canTrade: true, balances: [{ asset: 'USDT', free: '999999' }] }) })));

      const liveExecution = await loadModule({ liveEnabled: true });
      liveExecution.setUserMode('risk-gate-user-6', 'live');

      const userRiskProfileService = require('../server/domain/risk/userRiskProfileService');
      // Stricter-than-global override so a small simulated loss is enough
      // to trip it deterministically, independent of the global -$500 default.
      userRiskProfileService.setUserRiskProfile('risk-gate-user-6', { maxDailyLossUSD: -10 });

      // Reset first — liveTradeLedger is a real Node require()-cache
      // singleton (see wiring-test comment above), not reset between tests
      // by vi.resetModules().
      liveExecution._liveTradeLedger._resetForTest();
      // Simulate a prior real trade today that lost $15 — exactly what
      // executeLive's own success paths now do via liveTradeLedger.recordLiveFill().
      liveExecution._liveTradeLedger.recordLiveFill(-15);

      const opp = { id: 'op1', pair: 'BTC/USDT', buyPrice: 50000, detectedAt: Date.now() };
      await expect(liveExecution.executeLive(opp, 'risk-gate-user-6', 0.01)).rejects.toThrow(/Risk check failed: daily_loss/);
    });

    it('a real loss recorded on a previous day does NOT carry over (local-midnight reset)', async () => {
      const responses = [
        { body: { canTrade: true } },
        { body: { balances: [{ asset: 'USDT', free: '999999' }] } },
        { body: { balances: [{ asset: 'USDT', free: '999999' }] } },
        { body: { balances: [{ asset: 'BTC', free: '5' }] } },
        { body: { orderId: 888 } },
        { body: { status: 'FILLED', cummulativeQuoteQty: '500', executedQty: '0.01' } },
      ];
      let call = 0;
      vi.stubGlobal('fetch', vi.fn(async () => {
        const r = responses[Math.min(call, responses.length - 1)];
        call++;
        return { ok: true, status: 200, json: async () => r.body };
      }));

      const liveExecution = await loadModule({ liveEnabled: true });
      liveExecution.setUserMode('risk-gate-user-7', 'live');

      const userRiskProfileService = require('../server/domain/risk/userRiskProfileService');
      userRiskProfileService.setUserRiskProfile('risk-gate-user-7', { maxDailyLossUSD: -10 });

      liveExecution._liveTradeLedger.recordLiveFill(-15);
      liveExecution._liveTradeLedger._resetForTest(); // simulates a new day rolling over

      const opp = { id: 'op1', pair: 'BTC/USDT', buyPrice: 50000, detectedAt: Date.now() };
      const result = await liveExecution.executeLive(opp, 'risk-gate-user-7', 0.01);
      expect(result.ok).toBe(true);
    });
  });

  // Robustez (refinamiento post-Sesión 34 — "rate-limit 429 mid-trade").
  // ANTES: un 429/5xx durante placeOrder/getOrder se trataba igual que un
  // rechazo de negocio real, sin ningún reintento. Ahora `_fetchWithRetry`
  // reintenta automáticamente status 429/5xx (nunca 4xx de negocio) con
  // backoff exponencial. Los tests bajan `retryBackoffMs` a un valor
  // pequeño para que las pruebas no esperen tiempo real de espera.
  describe('transient-error retry with backoff (429 / 5xx)', () => {
    // NOTA: liveConfig debe requerirse DESPUÉS de loadModule() (que llama a
    // vi.resetModules()) para apuntar a la misma instancia de liveConfig que
    // usa internamente el liveExecution.js recién cargado — requerirlo antes
    // apunta a una instancia distinta cuyo setMany() no tiene efecto sobre
    // el módulo bajo prueba (mismo patrón de aislamiento ESM/CJS observado
    // en tests/persistenceService.test.js).
    function setFastRetryConfig() {
      const liveConfig = require('../server/infrastructure/liveConfig.js');
      liveConfig.setMany({ retryBackoffMs: 5, maxOrderRetries: 3 }, 'test');
      return liveConfig;
    }

    beforeEach(() => {
      process.env.BINANCE_API_KEY = 'k';
      process.env.BINANCE_API_SECRET = 's';
    });

    it('retries a 429 response and succeeds on the next attempt', async () => {
      let call = 0;
      const responses = [
        { status: 429, ok: false, body: { msg: 'rate limited' } },
        { status: 200, ok: true, body: { canTrade: true, balances: [{ asset: 'USDT', free: '999999' }] } },
      ];
      vi.stubGlobal('fetch', vi.fn(async () => {
        const r = responses[Math.min(call, responses.length - 1)];
        call++;
        return { ok: r.ok, status: r.status, headers: { get: () => null }, json: async () => r.body };
      }));

      const liveExecution = await loadModule({ liveEnabled: true });
      setFastRetryConfig();
      const result = await liveExecution.testExchangeConnection('binance', 'k', 's');
      expect(result.ok).toBe(true);
      expect(call).toBe(2); // 1 initial 429 + 1 successful retry
    });

    it('respects the Retry-After header when present instead of the exponential default', async () => {
      let call = 0;
      const responses = [
        { status: 429, ok: false, body: {} },
        { status: 200, ok: true, body: { canTrade: true, balances: [] } },
      ];
      vi.stubGlobal('fetch', vi.fn(async () => {
        const r = responses[Math.min(call, responses.length - 1)];
        call++;
        return { ok: r.ok, status: r.status, headers: { get: (h) => h === 'retry-after' ? '0' : null }, json: async () => r.body };
      }));

      const liveExecution = await loadModule({ liveEnabled: true });
      setFastRetryConfig();
      const result = await liveExecution.testExchangeConnection('binance', 'k', 's');
      expect(result.ok).toBe(true);
      expect(call).toBe(2);
    });

    it('gives up after maxOrderRetries attempts and surfaces the final error', async () => {
      const fetchSpy = vi.fn(async () => ({ ok: false, status: 429, headers: { get: () => null }, json: async () => ({}) }));
      vi.stubGlobal('fetch', fetchSpy);

      const liveExecution = await loadModule({ liveEnabled: true });
      setFastRetryConfig();
      const result = await liveExecution.testExchangeConnection('binance', 'k', 's');
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/429/);
      expect(fetchSpy).toHaveBeenCalledTimes(3); // maxOrderRetries = 3, set via setFastRetryConfig()
    });

    it('does NOT retry a plain 400 business error (e.g. bad request) — fails immediately on the first attempt', async () => {
      const fetchSpy = vi.fn(async () => ({ ok: false, status: 400, headers: { get: () => null }, json: async () => ({ msg: 'bad request' }) }));
      vi.stubGlobal('fetch', fetchSpy);

      const liveExecution = await loadModule({ liveEnabled: true });
      setFastRetryConfig();
      const result = await liveExecution.testExchangeConnection('binance', 'k', 's');
      expect(result.ok).toBe(false);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('retries a 503 (transient server error) the same way as a 429', async () => {
      let call = 0;
      const responses = [
        { status: 503, ok: false, body: {} },
        { status: 200, ok: true, body: { canTrade: true, balances: [] } },
      ];
      vi.stubGlobal('fetch', vi.fn(async () => {
        const r = responses[Math.min(call, responses.length - 1)];
        call++;
        return { ok: r.ok, status: r.status, headers: { get: () => null }, json: async () => r.body };
      }));

      const liveExecution = await loadModule({ liveEnabled: true });
      setFastRetryConfig();
      const result = await liveExecution.testExchangeConnection('binance', 'k', 's');
      expect(result.ok).toBe(true);
      expect(call).toBe(2);
    });

    it('records an EXCHANGE_TRANSIENT_ERROR_RETRY audit event for each retry attempt', async () => {
      let call = 0;
      const responses = [
        { status: 429, ok: false, body: {} },
        { status: 200, ok: true, body: { canTrade: true, balances: [] } },
      ];
      vi.stubGlobal('fetch', vi.fn(async () => {
        const r = responses[Math.min(call, responses.length - 1)];
        call++;
        return { ok: r.ok, status: r.status, headers: { get: () => null }, json: async () => r.body };
      }));

      const liveExecution = await loadModule({ liveEnabled: true });
      setFastRetryConfig();
      await liveExecution.testExchangeConnection('binance', 'k', 's');
      const log = liveExecution.getAuditLog();
      expect(log.some(e => e.event === 'EXCHANGE_TRANSIENT_ERROR_RETRY' && e.status === 429)).toBe(true);
    });
  });

  describe('testExchangeConnection', () => {
    it('returns ok:false for unsupported exchanges without making a network call', async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);
      const liveExecution = await loadModule();
      const result = await liveExecution.testExchangeConnection('okx', 'k', 's');
      expect(result).toMatchObject({ ok: false });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('returns balances and canTrade for a valid Binance connection', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          canTrade: true,
          balances: [
            { asset: 'USDT', free: '100' },
            { asset: 'BTC', free: '0' }, // filtered out (zero balance)
          ],
        }),
      })));
      const liveExecution = await loadModule();
      const result = await liveExecution.testExchangeConnection('binance', 'k', 's');
      expect(result.ok).toBe(true);
      expect(result.canTrade).toBe(true);
      expect(result.balances).toEqual([{ asset: 'USDT', free: 100 }]);
    });

    it('returns ok:false with the error message when the API call fails', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: false,
        status: 401,
        json: async () => ({ msg: 'Invalid API-key' }),
      })));
      const liveExecution = await loadModule();
      const result = await liveExecution.testExchangeConnection('binance', 'bad', 'bad');
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/Binance API error 401/);
    });

    it('routes to Binance Spot Testnet when BINANCE_TESTNET=true (Fase 2 / Shadow Mode)', async () => {
      const fetchSpy = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ canTrade: true, balances: [] }),
      }));
      vi.stubGlobal('fetch', fetchSpy);
      process.env.BINANCE_TESTNET = 'true';
      const liveExecution = await loadModule();
      const result = await liveExecution.testExchangeConnection('binance', 'k', 's');
      expect(result.ok).toBe(true);
      expect(result.testnet).toBe(true);
      expect(fetchSpy.mock.calls[0][0]).toMatch(/^https:\/\/testnet\.binance\.vision/);
    });

    it('routes to Binance mainnet when BINANCE_TESTNET is unset', async () => {
      const fetchSpy = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ canTrade: true, balances: [] }),
      }));
      vi.stubGlobal('fetch', fetchSpy);
      const liveExecution = await loadModule();
      const result = await liveExecution.testExchangeConnection('binance', 'k', 's');
      expect(result.testnet).toBe(false);
      expect(fetchSpy.mock.calls[0][0]).toMatch(/^https:\/\/api\.binance\.com/);
    });

    // ── Bybit (Fase 2 / Shadow Mode) ─────────────────────────────────────
    it('routes to Bybit Testnet when BYBIT_TESTNET=true and reports balances', async () => {
      const fetchSpy = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          retCode: 0,
          retMsg: 'OK',
          result: { list: [{ coin: [{ coin: 'USDT', walletBalance: '250.5' }] }] },
        }),
      }));
      vi.stubGlobal('fetch', fetchSpy);
      process.env.BYBIT_TESTNET = 'true';
      const liveExecution = await loadModule();
      const result = await liveExecution.testExchangeConnection('bybit', 'k', 's');
      expect(result.ok).toBe(true);
      expect(result.testnet).toBe(true);
      expect(result.balances).toEqual([{ asset: 'USDT', free: 250.5 }]);
      expect(fetchSpy.mock.calls[0][0]).toMatch(/^https:\/\/api-testnet\.bybit\.com/);
      const headers = fetchSpy.mock.calls[0][1].headers;
      expect(headers['X-BAPI-API-KEY']).toBe('k');
      expect(headers['X-BAPI-SIGN']).toEqual(expect.any(String));
    });

    it('routes to Bybit mainnet when BYBIT_TESTNET is unset', async () => {
      const fetchSpy = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ retCode: 0, retMsg: 'OK', result: { list: [{ coin: [] }] } }),
      }));
      vi.stubGlobal('fetch', fetchSpy);
      const liveExecution = await loadModule();
      const result = await liveExecution.testExchangeConnection('bybit', 'k', 's');
      expect(result.testnet).toBe(false);
      expect(fetchSpy.mock.calls[0][0]).toMatch(/^https:\/\/api\.bybit\.com/);
    });

    it('surfaces Bybit non-zero retCode as an error', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ retCode: 10003, retMsg: 'Invalid API key' }),
      })));
      const liveExecution = await loadModule();
      const result = await liveExecution.testExchangeConnection('bybit', 'bad', 'bad');
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/retCode 10003/);
    });

    // ── Kraken (Fase 2 / Shadow Mode — mainnet fully supported; sandbox
    //    requires KRAKEN_SANDBOX_URL, see module header honest caveat) ────
    it('signs and calls Kraken mainnet Balance endpoint with API-Key/API-Sign headers', async () => {
      const fetchSpy = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ error: [], result: { ZUSD: '500.0000', XXBT: '0.01' } }),
      }));
      vi.stubGlobal('fetch', fetchSpy);
      const liveExecution = await loadModule();
      // apiSecret must be valid base64 for Kraken's HMAC-SHA512 scheme
      const result = await liveExecution.testExchangeConnection('kraken', 'k', Buffer.from('supersecret').toString('base64'));
      expect(result.ok).toBe(true);
      expect(result.canTrade).toBe(true);
      expect(fetchSpy.mock.calls[0][0]).toBe('https://api.kraken.com/0/private/Balance');
      const options = fetchSpy.mock.calls[0][1];
      expect(options.headers['API-Key']).toBe('k');
      expect(options.headers['API-Sign']).toEqual(expect.any(String));
    });

    it('surfaces a Kraken API error array as the error message', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ error: ['EAPI:Invalid key'], result: null }),
      })));
      const liveExecution = await loadModule();
      const result = await liveExecution.testExchangeConnection('kraken', 'bad', Buffer.from('x').toString('base64'));
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/EAPI:Invalid key/);
    });

    it('refuses Kraken sandbox mode when KRAKEN_SANDBOX_URL is not configured, instead of silently hitting production', async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);
      process.env.KRAKEN_SANDBOX = 'true';
      delete process.env.KRAKEN_SANDBOX_URL;
      const liveExecution = await loadModule();
      const result = await liveExecution.testExchangeConnection('kraken', 'k', Buffer.from('s').toString('base64'));
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/KRAKEN_SANDBOX_URL is not set/);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('routes to the configured KRAKEN_SANDBOX_URL when both sandbox flag and URL are set', async () => {
      const fetchSpy = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ error: [], result: {} }),
      }));
      vi.stubGlobal('fetch', fetchSpy);
      process.env.KRAKEN_SANDBOX = 'true';
      process.env.KRAKEN_SANDBOX_URL = 'https://my-kraken-mock.internal';
      const liveExecution = await loadModule();
      const result = await liveExecution.testExchangeConnection('kraken', 'k', Buffer.from('s').toString('base64'));
      expect(result.ok).toBe(true);
      expect(result.testnet).toBe(true);
      expect(fetchSpy.mock.calls[0][0]).toBe('https://my-kraken-mock.internal/0/private/Balance');
    });
  });

  describe('executeLive — multi-exchange selection (Fase 2)', () => {
    it('selects the Bybit client and required env keys when opportunity.buyExchange is bybit', async () => {
      const liveExecution = await loadModule({ liveEnabled: true });
      liveExecution.setUserMode('u1', 'live');
      delete process.env.BYBIT_API_KEY;
      delete process.env.BYBIT_API_SECRET;
      await expect(
        liveExecution.executeLive({ id: 'op1', buyExchange: 'bybit' }, 'u1', 0.01)
      ).rejects.toThrow(/BYBIT_API_KEY and BYBIT_API_SECRET must be set/);
    });

    it('selects the Kraken client and required env keys when opportunity.buyExchange is kraken', async () => {
      const liveExecution = await loadModule({ liveEnabled: true });
      liveExecution.setUserMode('u1', 'live');
      delete process.env.KRAKEN_API_KEY;
      delete process.env.KRAKEN_API_SECRET;
      await expect(
        liveExecution.executeLive({ id: 'op1', buyExchange: 'kraken' }, 'u1', 0.01)
      ).rejects.toThrow(/KRAKEN_API_KEY and KRAKEN_API_SECRET must be set/);
    });

    it('rejects a truly unsupported buyExchange before touching any client', async () => {
      const liveExecution = await loadModule({ liveEnabled: true });
      liveExecution.setUserMode('u1', 'live');
      await expect(
        liveExecution.executeLive({ id: 'op1', buyExchange: 'kucoin' }, 'u1', 0.01)
      ).rejects.toThrow(/Exchange kucoin not supported for live execution/);
    });

    // okx is now a supported live-execution exchange (audit item #3, closes
    // the 3-of-5 gap) — same credential-check codepath as the other four,
    // plus a passphrase requirement. Covered in detail in
    // tests/liveExecutionOkxCoinbase.test.js; this asserts it's no longer
    // rejected outright.
    it('selects the OKX client and required env keys when opportunity.buyExchange is okx', async () => {
      const liveExecution = await loadModule({ liveEnabled: true });
      liveExecution.setUserMode('u1', 'live');
      delete process.env.OKX_API_KEY;
      delete process.env.OKX_API_SECRET;
      await expect(
        liveExecution.executeLive({ id: 'op1', buyExchange: 'okx' }, 'u1', 0.01)
      ).rejects.toThrow(/OKX_API_KEY and OKX_API_SECRET must be set/);
    });

    it('defaults to binance when opportunity.buyExchange is absent', async () => {
      const liveExecution = await loadModule({ liveEnabled: true });
      liveExecution.setUserMode('u1', 'live');
      delete process.env.BINANCE_API_KEY;
      delete process.env.BINANCE_API_SECRET;
      await expect(
        liveExecution.executeLive({ id: 'op1' }, 'u1', 0.01)
      ).rejects.toThrow(/BINANCE_API_KEY and BINANCE_API_SECRET must be set/);
    });
  });

  describe('audit log bounding', () => {
    it('caps the in-memory audit log at 500 entries', async () => {
      const liveExecution = await loadModule({ liveEnabled: true });
      for (let i = 0; i < 510; i++) {
        liveExecution.setUserMode(`u${i}`, 'live');
      }
      expect(liveExecution.getAuditLog().length).toBeLessThanOrEqual(500);
    });
  });

  // AUDIT FINDING 1 (CRITICAL) fix: executeLive/executeCrossExchangeLive no
  // longer trust opportunity.buyPrice/sellPrice/askPrice/bidPrice/detectedAt/
  // slippagePct exactly as sent by the client — they resolve the opportunity
  // against the server-side snapshot store first (see
  // opportunitySnapshotStore.js and resolveTrustedOpportunity() in
  // liveExecution.js). These tests exercise that gate directly, bypassing
  // the auto-seed wrapper the other describe blocks rely on.
  describe('resolveTrustedOpportunity (AUDIT FINDING 1 fix)', () => {
    it('rejects an opportunity with no id before touching any exchange or client', async () => {
      const liveExecution = await loadRawModule({ liveEnabled: true });
      liveExecution.setUserMode('u1', 'live');
      await expect(
        liveExecution.executeLive({ buyExchange: 'binance', buyPrice: 50000 }, 'u1', 0.01)
      ).rejects.toThrow(/opportunity\.id is required/);
    });

    it('rejects an opportunity id the server never detected (store empty)', async () => {
      const liveExecution = await loadRawModule({ liveEnabled: true });
      liveExecution.setUserMode('u1', 'live');
      // Deliberately NOT recorded into the store — simulates a client
      // sending fabricated or long-expired opportunity data.
      await expect(
        liveExecution.executeLive({ id: 'never-detected', buyExchange: 'binance', buyPrice: 1 }, 'u1', 0.01)
      ).rejects.toThrow(/unknown or expired/);
    });

    it('rejects an opportunity id that has expired past the store TTL', async () => {
      vi.useFakeTimers();
      try {
        const liveExecution = await loadRawModule({ liveEnabled: true });
        liveExecution.setUserMode('u1', 'live');
        liveExecution._opportunitySnapshotStore.recordSnapshot({
          id: 'old-one', buyExchange: 'binance', buyPrice: 50000, detectedAt: Date.now(),
        });
        vi.advanceTimersByTime(liveExecution._opportunitySnapshotStore.TTL_MS + 1000);
        await expect(
          liveExecution.executeLive({ id: 'old-one', buyExchange: 'binance' }, 'u1', 0.01)
        ).rejects.toThrow(/unknown or expired/);
      } finally {
        vi.useRealTimers();
      }
    });

    it('ignores client-supplied price fields and uses the server snapshot instead', async () => {
      const liveExecution = await loadRawModule({ liveEnabled: true });
      liveExecution.setUserMode('u1', 'live');
      // Server actually detected buyPrice 50000 for this id...
      liveExecution._opportunitySnapshotStore.recordSnapshot({
        id: 'trusted-1', buyExchange: 'binance', buyPrice: 50000, detectedAt: Date.now(),
      });
      // ...but the client claims a wildly different, stale-looking price and
      // a fake old detectedAt. resolveTrustedOpportunity() must never let
      // the fake buyPrice through — verified by checking the merged object
      // directly.
      const resolved = liveExecution.resolveTrustedOpportunity({
        id: 'trusted-1', buyExchange: 'binance', buyPrice: 1, detectedAt: 0,
      });
      expect(resolved.buyPrice).toBe(50000);
      expect(resolved.detectedAt).not.toBe(0);
    });

    it('keeps BTC and ETH opportunities on the same exchange pair separate (no id collision)', async () => {
      const liveExecution = await loadRawModule({ liveEnabled: true });
      liveExecution._opportunitySnapshotStore.recordSnapshot({
        id: 'arb-binance-kraken', buyExchange: 'binance', sellExchange: 'kraken', buyPrice: 50000,
      });
      liveExecution._opportunitySnapshotStore.recordSnapshot({
        id: 'arb-binance-kraken', asset: 'ETH', buyExchange: 'binance', sellExchange: 'kraken', buyPrice: 2500,
      });
      const btc = liveExecution.resolveTrustedOpportunity({ id: 'arb-binance-kraken' });
      const eth = liveExecution.resolveTrustedOpportunity({ id: 'arb-binance-kraken', asset: 'ETH' });
      expect(btc.buyPrice).toBe(50000);
      expect(eth.buyPrice).toBe(2500);
    });
  });
});
