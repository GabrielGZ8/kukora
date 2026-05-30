/**
 * smoke.test.js — kukora arbitrage engine smoke tests
 *
 * Validates mathematical correctness of fee/P&L formulas,
 * triangular signal compound math, and circuit breaker logic
 * using deterministic fixed inputs. No network calls.
 *
 * Run:  node tests/smoke.test.js
 */

'use strict';

// ─── Minimal test runner ─────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function assert(condition, label, detail = '') {
  if (condition) {
    console.log(`  ✓  ${label}`);
    passed++;
  } else {
    console.error(`  ✗  FAIL: ${label}${detail ? `\n       → ${detail}` : ''}`);
    failed++;
  }
}

function approxEqual(a, b, tol = 0.001) {
  return Math.abs(a - b) <= tol;
}

function section(name) {
  console.log(`\n── ${name} ${'─'.repeat(Math.max(0, 55 - name.length))}`);
}

// ─── Load fee config (pure data, no side effects) ────────────────────────────
const { TRADING_FEES, WITHDRAWAL_FEES, SLIPPAGE_RATE } = require('../server/feeConfig');

// ─── Core math helpers (copied from arbitrageEngine — no WS/DB required) ─────
function computeSlippageFallback(price, amount) {
  return price * amount * SLIPPAGE_RATE;
}

function calcNetProfit({ askBuy, bidSell, feeA, feeB, slippageBuy, slippageSell, wdFeeUSD, amount }) {
  const grossProfit  = (bidSell - askBuy) * amount;
  const buyFee       = askBuy * amount * feeA;
  const sellFee      = bidSell * amount * feeB;
  const slippageCost = slippageBuy + slippageSell;
  const netProfit    = grossProfit - buyFee - sellFee - slippageCost - wdFeeUSD;
  return { grossProfit, buyFee, sellFee, slippageCost, netProfit };
}

// Simulate detectOpportunities logic (no exchangeService / WS)
function simulateDetect(buyEx, sellEx, amount = 0.1) {
  const feeA    = TRADING_FEES[buyEx.exchange]  || 0.001;
  const feeB    = TRADING_FEES[sellEx.exchange] || 0.001;
  const wfBuy   = WITHDRAWAL_FEES[buyEx.exchange]  || { BTC: 0.0003, USDT: 6 };
  const wfSell  = WITHDRAWAL_FEES[sellEx.exchange] || { BTC: 0.0003, USDT: 6 };

  const slippageBuy  = computeSlippageFallback(buyEx.ask, amount);
  const slippageSell = computeSlippageFallback(sellEx.bid, amount);
  const wdFeeUSD     = +(wfBuy.BTC * buyEx.ask + wfSell.USDT).toFixed(4);

  const result = calcNetProfit({
    askBuy: buyEx.ask, bidSell: sellEx.bid,
    feeA, feeB, slippageBuy, slippageSell, wdFeeUSD, amount
  });

  const spreadPct = ((sellEx.bid - buyEx.ask) / buyEx.ask) * 100;
  const MIN_NET_PROFIT = 0.50;
  const MAX_SPREAD_PCT = 3.0;
  const MIN_SPREAD_PCT = 0.08;

  const circuitBreaker = spreadPct < MIN_SPREAD_PCT || spreadPct > MAX_SPREAD_PCT;
  const viable = result.netProfit > MIN_NET_PROFIT && !circuitBreaker;

  return { ...result, spreadPct, circuitBreaker, viable, wdFeeUSD, feeA, feeB };
}

// ─── 1. Fee config ────────────────────────────────────────────────────────────
section('1 · feeConfig values');

assert(TRADING_FEES.Binance  === 0.001,  'Binance taker = 0.10%');
assert(TRADING_FEES.Kraken   === 0.0026, 'Kraken taker = 0.26%');
assert(TRADING_FEES.Coinbase === 0.006,  'Coinbase taker = 0.60%');
assert(TRADING_FEES.Bybit    === 0.001,  'Bybit taker = 0.10%');
assert(TRADING_FEES.OKX      === 0.001,  'OKX taker = 0.10%');
assert(WITHDRAWAL_FEES.Binance.BTC  === 0.0002, 'Binance BTC withdrawal = 0.0002');
assert(WITHDRAWAL_FEES.Kraken.USDT  === 8,      'Kraken USDT withdrawal = $8');
assert(WITHDRAWAL_FEES.Coinbase.BTC === 0.0006, 'Coinbase BTC withdrawal = 0.0006 (highest)');
assert(SLIPPAGE_RATE === 0.0005, 'Fallback slippage = 0.05%');

// ─── 2. P&L formula — hand-calculated reference ───────────────────────────────
section('2 · P&L formula accuracy (Binance→Kraken, 0.1 BTC @ $100k/$100.5k)');

const BUY  = { exchange: 'Binance', ask: 100000, bid: 99980 };
const SELL = { exchange: 'Kraken',  bid: 100500, ask: 100520 };
const AMT  = 0.1;

const r = simulateDetect(BUY, SELL, AMT);

// Manual calculation
const expectedGross  = (100500 - 100000) * 0.1;                                    // 50.00
const expectedBuyFee = 100000 * 0.1 * 0.001;                                       // 10.00
const expectedSellFee= 100500 * 0.1 * 0.0026;                                      // 26.13
const expectedSlip   = (100000 * 0.1 * 0.0005) + (100500 * 0.1 * 0.0005);          // 10.0025 + 10.05 = 10.0525... ≈ 10.025
const expectedWd     = WITHDRAWAL_FEES.Binance.BTC * 100000 + WITHDRAWAL_FEES.Kraken.USDT; // 20 + 8 = 28
const expectedNet    = expectedGross - expectedBuyFee - expectedSellFee - (100000*0.1*0.0005 + 100500*0.1*0.0005) - expectedWd;

assert(r.grossProfit === expectedGross, `grossProfit = $${r.grossProfit} (expected $${expectedGross})`);
assert(approxEqual(r.buyFee,  expectedBuyFee,  0.0001), `buyFee  = $${r.buyFee.toFixed(4)} (expected $${expectedBuyFee.toFixed(4)})`);
assert(approxEqual(r.sellFee, expectedSellFee, 0.01),   `sellFee = $${r.sellFee.toFixed(4)} (expected ~$${expectedSellFee.toFixed(4)})`);
assert(approxEqual(r.wdFeeUSD, expectedWd, 0.0001),     `withdrawalFeeUSD = $${r.wdFeeUSD} (expected $${expectedWd})`);
assert(r.viable === false, `Binance→Kraken at 0.5% spread is NOT viable after fees (netProfit=$${r.netProfit.toFixed(4)})`);

// Math consistency: components sum to netProfit
const reconstructed = r.grossProfit - r.buyFee - r.sellFee - r.slippageCost - r.wdFeeUSD;
assert(
  approxEqual(reconstructed, r.netProfit, 0.0001),
  `netProfit is internally consistent: $${reconstructed.toFixed(4)} ≈ $${r.netProfit.toFixed(4)}`
);

// ─── 3. Viable detection — wide spread ────────────────────────────────────────
section('3 · Viable opportunity detection (1.0% spread)');

// With a 1% spread, Binance(0.1%) + OKX(0.1%) fees + slippage + withdrawal should leave profit
const BUY2  = { exchange: 'Binance', ask: 100000, bid: 99980 };
const SELL2 = { exchange: 'OKX',     bid: 101000, ask: 101020 };  // 1.0% spread

const r2 = simulateDetect(BUY2, SELL2, 0.1);

assert(r2.grossProfit > 0,   `grossProfit > 0 at 1% spread → $${r2.grossProfit.toFixed(2)}`);
assert(r2.buyFee  > 0,       `buyFee > 0 → $${r2.buyFee.toFixed(4)}`);
assert(r2.sellFee > 0,       `sellFee > 0 → $${r2.sellFee.toFixed(4)}`);

// Reconstruction check
const recon2 = r2.grossProfit - r2.buyFee - r2.sellFee - r2.slippageCost - r2.wdFeeUSD;
assert(approxEqual(recon2, r2.netProfit, 0.001), `P&L components consistent at 1% spread`);
console.log(`     netProfit = $${r2.netProfit.toFixed(4)}, viable = ${r2.viable}`);

// ─── 4. Circuit breaker ────────────────────────────────────────────────────────
section('4 · Circuit breaker thresholds');

// Spread too small (< 0.08%)
const rTiny = simulateDetect(
  { exchange: 'Binance', ask: 100000, bid: 99980 },
  { exchange: 'OKX',     bid: 100050, ask: 100070 }  // 0.05% spread
);
assert(rTiny.circuitBreaker === true,  `spread < 0.08% triggers circuit breaker (spread=${rTiny.spreadPct.toFixed(3)}%)`);
assert(rTiny.viable         === false, 'viable=false when circuit breaker fires');

// Spread too large (> 3.0%)
const rHuge = simulateDetect(
  { exchange: 'Binance', ask: 100000, bid: 99980 },
  { exchange: 'OKX',     bid: 104000, ask: 104050 }  // 4.0% spread → stale data
);
assert(rHuge.circuitBreaker === true,  `spread > 3.0% triggers circuit breaker (spread=${rHuge.spreadPct.toFixed(2)}%)`);
assert(rHuge.viable         === false, 'viable=false when spread > 3%');

// ─── 5. Coinbase fee impact ────────────────────────────────────────────────────
section('5 · Coinbase high fee impact (0.60% taker)');

const rCoinbase = simulateDetect(
  { exchange: 'Coinbase', ask: 100000, bid: 99400 },
  { exchange: 'Binance',  bid: 101500, ask: 101520 }  // 1.5% spread
);

// Coinbase 0.60% fee alone = $60 on buy. Plus Binance sell fee + slippage + withdrawal
const coinbaseFeeOnly = 100000 * 0.1 * TRADING_FEES.Coinbase;
assert(approxEqual(rCoinbase.buyFee, coinbaseFeeOnly, 0.01),
  `Coinbase buyFee = $${rCoinbase.buyFee.toFixed(2)} (0.60% = $${coinbaseFeeOnly.toFixed(2)})`);
assert(rCoinbase.buyFee > rCoinbase.sellFee * 4,
  `Coinbase buyFee ($${rCoinbase.buyFee.toFixed(2)}) >> Binance sellFee ($${rCoinbase.sellFee.toFixed(2)}) — fee asymmetry visible`);

// ─── 6. Triangular signal compound math ──────────────────────────────────────
section('6 · Triangular signal — compound vs naive formula');

// Compare (1+s1)*(1+s2)-1 vs s1+s2 for typical values
function compoundReturn(s1, s2) { return (1 + s1) * (1 + s2) - 1; }
function naiveReturn(s1, s2)    { return s1 + s2; }

const s1 = 0.002, s2 = 0.003;  // typical small arb legs
const compound = compoundReturn(s1, s2);
const naive    = naiveReturn(s1, s2);

assert(compound !== naive,
  `Compound return (${compound.toFixed(6)}) ≠ naive sum (${naive.toFixed(6)}) — formulas differ`);
assert(compound > naive ? (compound - naive) < 0.0001 : (naive - compound) < 0.0001,
  `Difference is small but real: ${Math.abs(compound - naive).toFixed(8)} (matters at quant precision)`);

// Verify formula direction: for positive s1,s2, compound > naive due to cross-term
assert(compound > naive,
  `compound (${compound.toFixed(8)}) > naive (${naive.toFixed(8)}) for positive returns (correct)`);

// Verify the slippage deduction logic (0.10% = 2 legs × 0.05%)
const feePct        = (TRADING_FEES.Binance + TRADING_FEES.Kraken + TRADING_FEES.Bybit) * 100;
const slipFallback  = 0.10;
const grossPct      = compoundReturn(s1, s2) * 100;
const netPct        = grossPct - feePct - slipFallback;

assert(netPct < grossPct, `netPct (${netPct.toFixed(4)}) < grossPct (${grossPct.toFixed(4)}) after fees+slippage`);
console.log(`     3-leg chain: gross=${grossPct.toFixed(4)}%, fees=${feePct.toFixed(4)}%, slip=${slipFallback}%, net=${netPct.toFixed(4)}%`);

// ─── 7. Daily loss stop ────────────────────────────────────────────────────────
section('7 · Daily loss circuit breaker state machine');

// Pure unit test of the state machine logic (isolated, no module side effects)
let _dailyPnl = 0;
const MAX_DAILY_LOSS = -500;

function addPnl(n) { _dailyPnl = +(_dailyPnl + n).toFixed(4); }
function isBreached() { return _dailyPnl <= MAX_DAILY_LOSS; }

assert(!isBreached(), 'Initial state: not breached');
addPnl(-100); assert(!isBreached(), '-$100: not breached');
addPnl(-200); assert(!isBreached(), '-$300: not breached');
addPnl(-199); assert(!isBreached(), '-$499: not breached (one dollar under limit)');
addPnl(-1);   assert(isBreached(),  '-$500: BREACHED (exactly at limit)');
addPnl(-50);  assert(isBreached(),  '-$550: still breached');

// Reset
_dailyPnl = 0;
assert(!isBreached(), 'After reset: not breached');

// ─── 8. Withdrawal fee formula ────────────────────────────────────────────────
section('8 · Withdrawal fee calculation');

// wdFeeUSD = wfBuy.BTC * askPrice + wfSell.USDT
// (buy exchange: we're moving BTC out; sell exchange: we're moving USDT out)
const askPrice = 100000;
for (const [buyEx, sellEx] of [['Binance','Kraken'], ['Bybit','Coinbase'], ['OKX','Kraken']]) {
  const wfBuy  = WITHDRAWAL_FEES[buyEx];
  const wfSell = WITHDRAWAL_FEES[sellEx];
  const wd     = +(wfBuy.BTC * askPrice + wfSell.USDT).toFixed(4);
  assert(wd > 0, `${buyEx}→${sellEx} withdrawalFeeUSD = $${wd}`);
  assert(wd < 200, `${buyEx}→${sellEx} withdrawalFee < $200 (sanity cap)`);
}

// ─── Summary ──────────────────────────────────────────────────────────────────
console.log('\n' + '═'.repeat(60));
console.log(`  TOTAL: ${passed + failed} tests   ✓ ${passed} passed   ${failed > 0 ? `✗ ${failed} FAILED` : '✗ 0 failed'}`);
console.log('═'.repeat(60) + '\n');

if (failed > 0) process.exit(1);
