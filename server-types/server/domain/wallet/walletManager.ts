/**
 * walletManager.ts — kukora arbitrage (audit fix 1.1)
 * Gestiona saldos simulados por exchange
 * Persistencia en memoria + MongoDB opcional
 *
 * FIXES:
 *  - applyTrade does NOT deduct withdrawal fees from P&L
 *    (pre-funded bilateral model: withdrawal = periodic rebalancing cost, not per-trade)
 *  - withdrawalFeeUSD stored as informational field only
 *  - getPnL includes rebalancingCostEstimate
 *  - Balance validation with rollback on integrity failure
 *  - Negative balances rejected, not silently clamped
 *
 * MIGRATION NOTE (audit 1.1): originally compiled to server/walletManager.js.
 *
 * RELOCATION NOTE (Nivel 2 #1 bounded-context reorg, round 12): this file
 * moved from server-types/server/walletManager.ts to
 * server-types/server/domain/walletManager.ts so it now compiles to
 * server/domain/walletManager.js instead. server/walletManager.js is now a
 * backward-compatible re-export shim (require('./domain/walletManager')).
 * Never edit server/domain/walletManager.js directly — it is a generated
 * build artifact; edit this file and run `tsc`.
 *
 * NOTE ON CLASSIFICATION: walletManager isn't 100% "pure" domain logic — it
 * has an optional MongoDB persistence side effect — but its core
 * responsibility (balance tracking, trade application, P&L) is financial
 * business logic, so it's grouped with the other domain/ financial-core
 * modules (feeConfig, advancedRiskEngine) rather than infrastructure/.
 *
 * Typing this module's core data structures (Trade, Wallets, PnLSummary) is
 * the highest-value part of the financial-core TS migration per the audit:
 * a silent `undefined` in `trade.buyPrice` used to be caught only at
 * runtime, sometimes deep inside a P&L calculation. With `strict: true`,
 * the compiler now refuses to build if a caller passes an incomplete trade.
 *
 * SESIÓN 20 (H-6): generalizado a multi-asset (BTC/ETH). Antes,
 * `_applyTradeInternal` operaba siempre contra `wallets.BTC` sin importar
 * qué dijera `trade.asset` — un trade "ETH" debitaba/acreditaba el wallet
 * de BTC bajo una etiqueta falsa, y ni siquiera existía un bucket ETH en
 * `INITIAL_BALANCES`. Ahora hay un wallet ETH real (`WALLET_ETH` env var,
 * default comparable en notional a 1 BTC) y `_applyTradeInternal` elige el
 * bucket correcto según `trade.asset` (default 'BTC' — comportamiento
 * idéntico al de antes para todo caller que nunca puso este campo).
 */

import mongoose, { Document, Model, Schema } from 'mongoose';
import { WITHDRAWAL_FEES, WithdrawalFee } from './feeConfig';
import { logger } from '../../infrastructure/logger';
import { getEnabledExchangeNames } from '../../infrastructure/exchangeRegistry';
import { createTenantStore } from '../../infrastructure/tenantStore';
import { isEnabled as isTenantBotEnabled } from '../../infrastructure/tenantBotState';

// ─── Multi-tenant refinamiento (item 1, post-checkpoint-02) ────────────────
// Cada usuario autenticado (Firebase UID) tiene su PROPIO wallet simulado,
// historial de trades y mutex de ejecución — ya no una sola instancia
// global compartida por todo el proceso. Un `uid` ausente/null (cualquier
// caller que todavía no pasa uno — rebalanceEngine, capitalEfficiency, el
// loop de detección/ejecución compartido, tests viejos) cae en
// tenantStore.DEFAULT_UID, que es exactamente el bucket único que existía
// antes de este refactor: comportamiento 100% compatible para todo el
// código que aún no fue actualizado para pasar `uid` explícitamente. Ver
// server/infrastructure/tenantStore.js para el mecanismo genérico.

// Q2 audit: verbose logs suppressed in production — printed only with
// DEBUG_KUKORA=1 in .env. See arbitrage.routes.js for the same pattern.
const _DEBUG = process.env.DEBUG_KUKORA === '1';
function _warn(...args: unknown[]): void { if (_DEBUG) logger.warn('walletManager', String(args[0]), args.length > 1 ? { extra: args.slice(1) } : undefined); }
function _err(msg: string, meta?: Record<string, unknown>): void { logger.error('walletManager', msg, meta || {}); }

// ─── Types ──────────────────────────────────────────────────────────────────

export interface Wallets {
  BTC: Record<string, number>;
  ETH: Record<string, number>;
  // Item 3 (post-checkpoint-04, generalización multipar): XRP añadido con
  // exactamente el mismo patrón que ETH tuvo en la Sesión 20 (H-6) — su
  // propio bucket real, su propio env var de sizing, en vez de caer
  // silenciosamente en el bucket de BTC como pasaba antes de este fix.
  XRP: Record<string, number>;
  USDT: Record<string, number>;
}

/**
 * resolveWalletAsset(asset) — bucket real para un asset dado.
 * Item 3 fix: antes había DOS sitios (aquí y en opportunityDetection.js)
 * con `asset === 'ETH' ? 'ETH' : 'BTC'` — cualquier asset que no fuera
 * exactamente 'ETH' (incluida XRP) se contabilizaba silenciosamente como
 * BTC. Este fix consolida el check en UN solo lugar y lo extiende a los
 * 3 assets con bucket real hoy (BTC/ETH/XRP).
 *
 * Nota honesta de alcance (no sobre-prometer): `Wallets` sigue siendo un
 * struct de claves fijas, no un mapa dinámico — soportar un asset nuevo
 * todavía requiere una línea aquí + el bucket en `Wallets` +
 * `_buildInitialBalances`. Migrar a `Record<string, Record<string,
 * number>>` (para que CUALQUIER asset futuro funcione sin tocar código)
 * es un cambio de tipo que toca P&L, persistencia y el contrato del
 * frontend — evaluado y diferido, ver ADR-018.
 */
function resolveWalletAsset(asset: string | undefined): 'BTC' | 'ETH' | 'XRP' {
  if (asset === 'ETH' || asset === 'XRP') return asset;
  return 'BTC'; // default explícito — preserva el comportamiento exacto de antes para cualquier caller que no mande asset
}

/** Result of applyRebalanceTransfer — see that function for context. */
export interface RebalanceTransferResult {
  ok: boolean;
  reason?: string;
  balancesAfter?: Wallets;
}

/**
 * Shape of a trade as produced by the detection/execution engine, before
 * enrichment.
 *
 * RELATIONSHIP TO THE CANONICAL `Trade` TYPE (audit committee, sección 12,
 * punto 1): `domain/opportunity.ts` exports the canonical, fully-formed
 * `Trade` — the exact object `executeSimulated()` returns. `IncomingTrade`
 * here is deliberately NOT that same type: it's the permissive pre-
 * enrichment view this module accepts as input (most fields optional, an
 * index signature for forward-compat, `id` allowed as number for legacy
 * test fixtures) — the input contract, not the output contract. Forcing
 * structural identity between an intentionally-permissive input type and
 * the canonical output type would either loosen `Trade` (weakening the
 * contract everywhere else) or break existing narrower callers (partial
 * triangular-leg trades, test fixtures). Kept as two distinct types,
 * cross-referenced here rather than silently duplicated with no
 * acknowledgment of the overlap — the drift the audit flagged was the
 * silence, not the existence of two views over related data.
 */
export interface IncomingTrade {
  id?: string | number;
  type?: string;
  // H-6 fix (Sesión 20, ver MIGRATION_CLEANUP_LOG.md): antes este campo se
  // adjuntaba al trade DESPUÉS de _applyTradeInternal (spread manual en
  // arbitrageOrchestrator.js: `{ ...result.trade, asset: 'ETH' }`) pero la
  // función nunca lo leía — siempre operaba contra `wallets.BTC`, sin
  // importar qué dijera este campo. Un trade "ETH" debitaba/acreditaba el
  // wallet de BTC bajo una etiqueta falsa. Ahora `asset` es parte del
  // contrato de entrada y _applyTradeInternal lo usa para elegir el bucket
  // correcto. Default 'BTC' cuando no se especifica — comportamiento
  // idéntico al de antes para todo el código existente que nunca puso este
  // campo.
  // (Item 3: extendido a XRP con el mismo contrato — ver resolveWalletAsset.)
  asset?: 'BTC' | 'ETH' | 'XRP';
  buyExchange: string;
  sellExchange: string;
  amount: number;
  buyPrice: number;
  sellPrice: number;
  buyFee?: number;
  sellFee?: number;
  grossProfit?: number;
  netProfit?: number;
  netProfitPct?: number;
  slippage?: number;
  slippageMethod?: string;
  spreadPct?: string | number;
  partialFill?: boolean;
  executionMs?: number;
  withdrawalFeeUSD?: number;
  ts?: string | number | Date;
  [key: string]: unknown;
}

/** Trade as stored in tradeHistory after applyTrade succeeds — adds derived fields. */
export interface EnrichedTrade extends IncomingTrade {
  netProfit: number;
  netProfitPct: number;
  withdrawalFees: number;
  withdrawalDetail: WithdrawalFeeBreakdownResult;
  withdrawalModel: 'periodic_rebalancing';
  status: 'profit' | 'loss';
  balancesAfter: Wallets;
}

export interface WithdrawalFeeBreakdownResult {
  btcWithdrawalUSD: number;
  usdtWithdrawalUSD: number;
  totalUSD: number;
}

export type ApplyTradeResult =
  | { ok: true; trade: EnrichedTrade }
  | { ok: false; reason: string };

export interface PairStat {
  count: number;
  totalPnl: number;
  wins: number;
  totalFees: number;
  totalWithdrawalFees: number;
}

export interface SlippageMethodBreakdown {
  real: number;
  fallback: number;
}

export interface PnLSummary {
  totalPnl: number;
  realizedPnl: number;
  unrealizedPnl: number;
  totalTrades: number;
  wins?: number;
  losses?: number;
  winRate: number;
  bestTrade: EnrichedTrade | null;
  worstTrade: EnrichedTrade | null;
  avgExecutionMs: number;
  maxDrawdown: number;
  currentStreak: number;
  currentStreakType: 'win' | 'loss' | null;
  avgNetProfitPct: number;
  totalFees: number;
  totalWithdrawalFees: number;
  slippageMethodBreakdown: SlippageMethodBreakdown;
  pairStats?: Record<string, PairStat>;
  rebalancingCostEstimate: number;
}

interface ArbitrageOpDoc extends Document {
  uid: string | null;
  buyExchange: string;
  sellExchange: string;
  buyPrice: number;
  sellPrice: number;
  amount: number;
  grossProfit: number;
  netProfit: number;
  netProfitPct: number;
  fees: number;
  slippage: number;
  withdrawalFees: number;
  spreadPct: string;
  status: string;
  partialFill: boolean;
  executionMs: number;
  slippageMethod: string;
  rejectionReason: string;
  ts: Date;
}

// ─── Mongo schema ───────────────────────────────────────────────────────────

const ArbitrageOpSchema = new Schema<ArbitrageOpDoc>({
  // A2 (Sesión 2026-07-07, auditoría multi-tenant): antes de este campo,
  // CADA trade persistido a Mongo — del bot compartido O de cualquier
  // tenant vía tenantExecution.js — caía en el mismo documento sin ninguna
  // etiqueta de a quién pertenecía. El estado en memoria (walletManager ya
  // era per-uid) nunca tuvo esta fuga entre tenants, pero la COPIA
  // persistida en Mongo sí mezclaba todo indistinguiblemente — mismo
  // patrón de bug que el bucket BTC/ETH/XRP (ADR-018), aplicado esta vez
  // a la capa de persistencia en vez de a la de wallet. `uid` ausente
  // (undefined) es exactamente el comportamiento de antes de este fix —
  // retrocompatible con cualquier documento ya escrito y con el bot
  // compartido (que sigue llamando applyTrade() sin uid).
  uid:            { type: String, default: null },
  buyExchange:    String,
  sellExchange:   String,
  buyPrice:       Number,
  sellPrice:      Number,
  amount:         Number,
  grossProfit:    Number,
  netProfit:      Number,
  netProfitPct:   Number,
  fees:           Number,
  slippage:       Number,
  withdrawalFees: Number,
  spreadPct:      String,
  status:         String,
  partialFill:    Boolean,
  executionMs:    Number,
  slippageMethod: String,
  rejectionReason: String,
  ts:             { type: Date, default: Date.now },
});

let ArbitrageOp: Model<ArbitrageOpDoc>;
try {
  ArbitrageOp = mongoose.model<ArbitrageOpDoc>('ArbitrageOp');
} catch {
  ArbitrageOp = mongoose.model<ArbitrageOpDoc>('ArbitrageOp', ArbitrageOpSchema);
}

// I-1 fix: INITIAL_BALANCES built dynamically from the exchange registry.
// Any exchange registered with enabled:true automatically gets initial wallet slots.
// Default amounts remain configurable via environment variables.
// Previously hardcoded to 5 exchanges — a 6th exchange added to the registry
// would silently have no wallet, causing undefined balance checks and trade rejections.
function _buildInitialBalances(): Wallets {
  const exchanges = getEnabledExchangeNames();
  const btcAmount  = parseFloat(process.env.WALLET_BTC  || '1');
  // H-6 fix: ETH wallet bucket, sized to a comparable notional value to the
  // BTC default (1 BTC @ ~$107k ≈ 40 ETH @ ~$2.7k) so ETH trades have a
  // realistic amount of headroom before hitting rebalancing, not an
  // arbitrary placeholder. Configurable via WALLET_ETH like its siblings.
  const ethAmount  = parseFloat(process.env.WALLET_ETH  || '40');
  // Item 3: XRP wallet bucket, mismo patrón que ETH arriba. Sizing
  // aproximado a notional comparable (1 BTC @ ~$107k ≈ 45,000 XRP @ ~$2.4).
  // Configurable via WALLET_XRP.
  const xrpAmount  = parseFloat(process.env.WALLET_XRP  || '45000');
  const usdtAmount = parseFloat(process.env.WALLET_USDT || '110000');
  const balances: Wallets = { BTC: {}, ETH: {}, XRP: {}, USDT: {} };
  for (const ex of exchanges) {
    balances.BTC[ex]  = btcAmount;
    balances.ETH[ex]  = ethAmount;
    balances.XRP[ex]  = xrpAmount;
    balances.USDT[ex] = usdtAmount;
  }
  return balances;
}

// Default wallets sized for 0.05 BTC trades at up to $110k/BTC:
//   USDT: $110,000 per exchange → covers ~20 consecutive buys before rebalancing needed
//   BTC:  1 BTC per exchange → covers ~20 sells at 0.05 BTC per trade
// Both configurable via environment variables.
const INITIAL_BALANCES: Wallets = _buildInitialBalances();

const EXCHANGES: string[] = Object.keys(INITIAL_BALANCES.BTC);

interface QueuedTrade { trade: IncomingTrade; resolve: (result: ApplyTradeResult) => void; }

// Per-tenant state bundle: wallets + trade history + the Issue-7 mutex that
// serializes applyTrade for THAT tenant only. Two different users' trades
// no longer queue behind each other's mutex — only concurrent trades for
// the SAME uid do, which is the actual invariant the mutex protects
// (no two trades racing on the same balance snapshot).
interface TenantWalletState {
  wallets: Wallets;
  tradeHistory: EnrichedTrade[];
  tradeLock: boolean;
  tradeQueue: QueuedTrade[];
}

function _freshTenantState(): TenantWalletState {
  return {
    wallets: JSON.parse(JSON.stringify(INITIAL_BALANCES)),
    tradeHistory: [],
    tradeLock: false,
    tradeQueue: [],
  };
}

// checkpoint 27 fix (TechnicalDueDiligence Hallazgo 4 — documented, not
// previously corrected): without `isProtected`, a tenant evicted from this
// LRU while their bot is still enabled would get a completely fresh wallet
// on next access, and the next periodic tick of
// tenantPersistence.persistActiveTenantSnapshots() (every 30s, driven by
// tenantBotState.activeUids()) would then persist that BLANK state to
// Mongo — silently overwriting the tenant's real snapshot. Protecting any
// uid whose bot is currently enabled means the 1000-tenant cap can only
// ever evict inactive tenants, which is the safe/expected behavior: an
// inactive tenant resetting to initial balances on their next visit is
// tolerable (same as before this fix); an active tenant's live wallet
// being wiped mid-session, and that wipe being persisted as truth, is not.
const _tenants = createTenantStore<TenantWalletState>(_freshTenantState, {
  isProtected: (uid: string) => isTenantBotEnabled(uid),
});

// BUG FIX (Área 4 audit): tradeHistory grew unbounded — every completed trade
// was pushed with no cap, unlike every other rolling history buffer in the
// codebase (tradeStateMachine, rebalanceEngine, opportunityLifecycle all use
// a MAX_HISTORY of 200-500). Over a long-running bot session this is an
// unbounded memory leak, and getPnL()/getTradeHistory() do an O(n) scan over
// the full array on every tick (arbitrageOrchestrator calls getPnL() every
// tick). Capped at the same 500 used by tradeStateMachine for consistency.
const MAX_TRADE_HISTORY = 500;

export function getBalances(uid?: string | null): Wallets {
  return JSON.parse(JSON.stringify(_tenants.get(uid).wallets));
}

/**
 * isValidWalletsShape — light structural guard for a persisted `wallets`
 * blob (e.g. restored from EngineSnapshot after a process restart). This is
 * NOT a full schema validator — just enough to reject an obviously
 * corrupted or legacy-shaped document before it overwrites live state,
 * so `setBalances` can reject silently instead of corrupting live state.
 */
export function isValidWalletsShape(obj: unknown): obj is Wallets {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const REQUIRED_BUCKETS: Array<keyof Wallets> = ['BTC', 'ETH', 'XRP', 'USDT'];
  for (const bucket of REQUIRED_BUCKETS) {
    const val = (obj as Record<string, unknown>)[bucket];
    if (!val || typeof val !== 'object' || Array.isArray(val)) return false;
    for (const amount of Object.values(val as Record<string, unknown>)) {
      if (typeof amount !== 'number' || Number.isNaN(amount)) return false;
    }
  }
  return true;
}

/**
 * setBalances — punto 7 de la hoja de ruta (auditoría comité, sección 12):
 * aplica un blob de `wallets` restaurado (p.ej. desde EngineSnapshot al
 * arrancar el proceso) directamente sobre el estado vivo de un tenant.
 * Es la contraparte de `getBalances()`: mismo mecanismo de deep-copy
 * que `resetBalances()` ya usa para escribir en `_tenants`.
 *
 * Valida la forma con `isValidWalletsShape` antes de aplicar — un
 * documento corrupto o con forma legacy se rechaza silenciosamente
 * (retorna `false`) en vez de corromper el estado en memoria.
 *
 * @returns true si se aplicó, false si `wallets` no tenía la forma esperada.
 */
export function setBalances(wallets: unknown, uid?: string | null): boolean {
  if (!isValidWalletsShape(wallets)) return false;
  const state = _tenants.get(uid);
  state.wallets = JSON.parse(JSON.stringify(wallets));
  return true;
}

/**
 * calcWithdrawalFee — computes periodic rebalancing cost (informational only).
 * Models a symmetric round-trip: BTC moves from buy→sell exchange,
 * USDT moves from sell→buy exchange. Amortized as average of both directional fees.
 * Not deducted per trade in pre-funded bilateral model.
 */
export function calcWithdrawalFee(
  buyExchange: string,
  sellExchange: string,
  amount: number,
  buyPrice: number
): WithdrawalFeeBreakdownResult {
  const defaultFee: WithdrawalFee = { BTC: 0.0003, USDT: 6, ETH: 0.0012, XRP: 0.2 };
  const buyFee  = WITHDRAWAL_FEES[buyExchange as keyof typeof WITHDRAWAL_FEES]  || defaultFee;
  const sellFee = WITHDRAWAL_FEES[sellExchange as keyof typeof WITHDRAWAL_FEES] || defaultFee;
  // Round-trip: BTC withdrawal from buy exchange + BTC withdrawal from sell exchange (average)
  const btcWithdrawal  = ((buyFee.BTC + sellFee.BTC) / 2) * buyPrice;
  // Round-trip: USDT withdrawal from sell exchange + USDT withdrawal from buy exchange (average)
  const usdtWithdrawal = (buyFee.USDT + sellFee.USDT) / 2;
  return {
    btcWithdrawalUSD:  +btcWithdrawal.toFixed(4),
    usdtWithdrawalUSD: +usdtWithdrawal.toFixed(4),
    totalUSD:          +(btcWithdrawal + usdtWithdrawal).toFixed(4),
  };
}

/**
 * applyTrade — validates balances BEFORE execution, rejects if insufficient.
 * Wrapped in an async mutex so concurrent calls (event-driven + polling loop)
 * cannot both pass the balance check before either deducts.
 *
 * IMPORTANT: Pre-funded bilateral model — withdrawal fees are NOT deducted per trade.
 * trade.netProfit is already calculated without withdrawal fees in opportunityDetection.js.
 * withdrawalFeeUSD is stored as informational field only.
 *
 * H-6 fix (Sesión 20): the crypto-side leg now operates on `wallets[asset]`
 * (BTC or ETH) instead of always assuming `wallets.BTC`. The USDT leg is
 * always USDT regardless of asset, since both BTC and ETH are quoted in
 * USDT in this model.
 */
async function _applyTradeInternal(trade: IncomingTrade, state: TenantWalletState, uid?: string | null): Promise<ApplyTradeResult> {
  const wallets = state.wallets;
  const tradeHistory = state.tradeHistory;
  const { buyExchange, sellExchange, amount, buyPrice, sellPrice, buyFee, sellFee } = trade;
  // H-6/item 3 fix: pick the real asset bucket via resolveWalletAsset()
  // instead of always assuming BTC. Default 'BTC' preserves exact prior
  // behavior for every existing caller that never set `asset`.
  const asset: 'BTC' | 'ETH' | 'XRP' = resolveWalletAsset(trade.asset);
  const assetWallet = wallets[asset];

  const usdtCost   = buyPrice * amount + (buyFee || 0);
  const assetNeeded = amount;

  const usdtAvailable  = wallets.USDT[buyExchange];
  const assetAvailable = assetWallet[sellExchange];

  if (usdtAvailable === undefined) {
    const reason = `Unknown exchange for USDT wallet: ${buyExchange}`;
    _warn('[walletManager] REJECTED:', reason);
    return { ok: false, reason };
  }
  if (assetAvailable === undefined) {
    const reason = `Unknown exchange for ${asset} wallet: ${sellExchange}`;
    _warn('[walletManager] REJECTED:', reason);
    return { ok: false, reason };
  }
  if (usdtAvailable < usdtCost) {
    const reason = `Insufficient USDT on ${buyExchange}: need $${usdtCost.toFixed(2)}, have $${usdtAvailable.toFixed(2)}`;
    _warn('[walletManager] REJECTED:', reason);
    return { ok: false, reason };
  }
  if (assetAvailable < assetNeeded) {
    const reason = `Insufficient ${asset} on ${sellExchange}: need ${assetNeeded.toFixed(6)}, have ${assetAvailable.toFixed(6)}`;
    _warn('[walletManager] REJECTED:', reason);
    return { ok: false, reason };
  }

  // Informational only — not deducted from balances or P&L
  const wf = calcWithdrawalFee(buyExchange, sellExchange, amount, buyPrice);

  const usdtGain = sellPrice * amount - (sellFee || 0);

  wallets.USDT[buyExchange]  -= usdtCost;
  assetWallet[buyExchange]   += amount;
  assetWallet[sellExchange]  -= amount;
  wallets.USDT[sellExchange] += usdtGain;

  for (const ex of EXCHANGES) {
    if ((wallets.USDT[ex]   !== undefined && wallets.USDT[ex]   < -0.01) ||
        (assetWallet[ex]    !== undefined && assetWallet[ex]    < -0.000001)) {
      _err(`[walletManager] CRITICAL: negative balance on ${ex} after trade ${trade.id} — rolling back`);
      wallets.USDT[buyExchange]  += usdtCost;
      assetWallet[buyExchange]   -= amount;
      assetWallet[sellExchange]  += amount;
      wallets.USDT[sellExchange] -= usdtGain;
      return { ok: false, reason: `Post-execution balance integrity failure on ${ex}` };
    }
  }

  const finalNetProfit    = +(trade.netProfit || 0).toFixed(4);
  const finalNetProfitPct = +((finalNetProfit / (buyPrice * amount)) * 100).toFixed(4);

  const enrichedTrade: EnrichedTrade = {
    ...trade,
    asset,
    netProfit:        finalNetProfit,
    netProfitPct:     finalNetProfitPct,
    // Informational only — reflects periodic rebalancing estimate, not per-trade cost
    withdrawalFees:   trade.withdrawalFeeUSD || 0,
    withdrawalDetail: wf,
    withdrawalModel:  'periodic_rebalancing',
    status:           finalNetProfit > 0 ? 'profit' : 'loss',
    balancesAfter:    JSON.parse(JSON.stringify(wallets)),
  };

  tradeHistory.push(enrichedTrade);
  if (tradeHistory.length > MAX_TRADE_HISTORY) tradeHistory.shift();

  if (mongoose.connection.readyState === 1) {
    try {
      await ArbitrageOp.create({
        uid:            uid ?? null,
        buyExchange:    trade.buyExchange,
        sellExchange:   trade.sellExchange,
        buyPrice:       trade.buyPrice,
        sellPrice:      trade.sellPrice,
        amount:         trade.amount,
        grossProfit:    trade.grossProfit,
        netProfit:      finalNetProfit,
        netProfitPct:   finalNetProfitPct,
        fees:           (trade.buyFee || 0) + (trade.sellFee || 0),
        slippage:       trade.slippage,
        withdrawalFees: trade.withdrawalFeeUSD || 0,
        spreadPct:      String(trade.spreadPct ?? ''),
        status:         enrichedTrade.status,
        partialFill:    !!trade.partialFill,
        executionMs:    trade.executionMs,
        slippageMethod: trade.slippageMethod,
        ts:             new Date(trade.ts as any),
      });
    } catch (e: any) {
      _warn('⚠ ArbitrageOp MongoDB error:', e.message);
    }
  }

  return { ok: true, trade: enrichedTrade };
}

export function resetBalances(uid?: string | null): void {
  _tenants.reset(uid);
}

/**
 * applyRebalanceTransfer — commits a manual/predictive rebalance transfer
 * against the REAL wallet state.
 *
 * ROBUSTNESS FIX (wallets/rebalancing audit): before this function existed,
 * `POST /api/arbitrage/rebalance/execute` called
 * `rebalanceEngine.executeRebalance(suggestion, wallets, btcPrice)` where
 * `wallets` was expected to be a live balances object to mutate in place —
 * but (a) the route was actually calling it with only two arguments
 * (`suggestion, btcPrice`), so `wallets` silently received a *number*
 * instead of a balances object, and (b) even with the arguments fixed,
 * `getBalances()` returns `JSON.parse(JSON.stringify(wallets))` — a deep
 * copy — so mutating it would never have persisted anyway. The net effect:
 * the rebalance-execute endpoint could never have actually moved capital
 * between exchanges; it either failed with a spurious "insufficient
 * balance" error or (if that check were ever bypassed) silently discarded
 * the transfer.
 *
 * This function is the missing persistence path — the rebalance
 * equivalent of what `_applyTradeInternal` does for trades: validate
 * against the live `wallets` object, mutate it in place, and verify no
 * negative balance resulted (rolling back if so) before returning success.
 *
 * Synchronous and does not need the trade mutex: unlike `applyTrade`,
 * there is no `await` between the balance check and the mutation, so
 * JS's run-to-completion semantics already prevent interleaving.
 *
 * NOTE (Sesión 20): asset is typed 'BTC' | 'USDT' here (not ETH) because
 * no caller currently rebalances ETH — the predictive rebalance engine
 * only ever suggests BTC/USDT transfers. If ETH rebalancing is added
 * later, widen this union and `wallets[asset]` continues to work
 * unchanged since Wallets now has an ETH bucket.
 */
export function applyRebalanceTransfer(
  asset: 'BTC' | 'USDT',
  from: string,
  to: string,
  amount: number,
  feeInAssetUnits: number,
  uid?: string | null
): RebalanceTransferResult {
  const state = _tenants.get(uid);
  const bucket = state.wallets[asset];
  if (!bucket || bucket[from] === undefined) {
    return { ok: false, reason: `Unknown exchange for ${asset} wallet: ${from}` };
  }
  if (bucket[to] === undefined) {
    return { ok: false, reason: `Unknown exchange for ${asset} wallet: ${to}` };
  }
  if (!(amount > 0) || !Number.isFinite(amount)) {
    return { ok: false, reason: `Invalid transfer amount for ${asset}: ${amount}` };
  }
  if (!(feeInAssetUnits >= 0) || !Number.isFinite(feeInAssetUnits)) {
    return { ok: false, reason: `Invalid transfer fee for ${asset}: ${feeInAssetUnits}` };
  }
  if (amount <= feeInAssetUnits) {
    return { ok: false, reason: `amount (${amount}) does not cover the ${asset} withdrawal fee (${feeInAssetUnits})` };
  }
  if (bucket[from] < amount) {
    return { ok: false, reason: `Insufficient ${asset} on ${from}: ${bucket[from].toFixed(6)} < ${amount}` };
  }

  bucket[from] -= amount;
  bucket[to]   += amount - feeInAssetUnits;

  // Integrity guard, mirrors _applyTradeInternal — should be unreachable
  // given the checks above, but a rollback is cheap insurance against a
  // wallet ending up in a corrupted (negative) state.
  if (bucket[from] < -0.000001 || bucket[to] < -0.000001) {
    bucket[from] += amount;
    bucket[to]   -= (amount - feeInAssetUnits);
    _err(`[walletManager] CRITICAL: negative balance on ${asset} after rebalance ${from}→${to} — rolling back`);
    return { ok: false, reason: `Post-transfer balance integrity failure on ${asset}` };
  }

  return { ok: true, balancesAfter: JSON.parse(JSON.stringify(state.wallets)) };
}

export function getTradeHistory(uid?: string | null): EnrichedTrade[] {
  return [..._tenants.get(uid).tradeHistory];
}

/**
 * getPnL — returns realized and unrealized P&L.
 * Includes rebalancingCostEstimate for informational display.
 *
 * H-6 fix (Sesión 20): accepts an optional `currentEthPrice` second
 * parameter so unrealized P&L reflects ETH balance drift too, not just
 * BTC. Backward compatible — every existing caller passes only 1 arg,
 * so `currentEthPrice` defaults to `null` and contributes 0, exactly the
 * prior BTC-only behavior.
 */
export function getPnL(currentBtcPrice: number | null = null, currentEthPrice: number | null = null, uid?: string | null, currentXrpPrice: number | null = null): PnLSummary {
  const state = _tenants.get(uid);
  const wallets = state.wallets;
  const tradeHistory = state.tradeHistory;
  if (!tradeHistory.length) {
    return {
      totalPnl: 0, realizedPnl: 0, unrealizedPnl: 0,
      totalTrades: 0, winRate: 0,
      bestTrade: null, worstTrade: null,
      avgExecutionMs: 0, maxDrawdown: 0,
      currentStreak: 0, currentStreakType: null,
      avgNetProfitPct: 0, totalFees: 0, totalWithdrawalFees: 0,
      slippageMethodBreakdown: { real: 0, fallback: 0 },
      rebalancingCostEstimate: 0,
    };
  }

  const wins    = tradeHistory.filter(t => (t.netProfit || 0) > 0);
  const losses  = tradeHistory.filter(t => (t.netProfit || 0) <= 0);
  const realizedPnl = tradeHistory.reduce((s, t) => s + (t.netProfit || 0), 0);
  const winRate  = (wins.length / tradeHistory.length) * 100;

  let unrealizedPnl = 0;
  if (currentBtcPrice != null && currentBtcPrice > 0) {
    const totalCurrentBtc = EXCHANGES.reduce((s, ex) => s + (wallets.BTC[ex] || 0), 0);
    const totalInitialBtc = EXCHANGES.reduce((s, ex) => s + (INITIAL_BALANCES.BTC[ex] || 0), 0);
    unrealizedPnl += (totalCurrentBtc - totalInitialBtc) * currentBtcPrice;
  }
  if (currentEthPrice != null && currentEthPrice > 0) {
    const totalCurrentEth = EXCHANGES.reduce((s, ex) => s + (wallets.ETH[ex] || 0), 0);
    const totalInitialEth = EXCHANGES.reduce((s, ex) => s + (INITIAL_BALANCES.ETH[ex] || 0), 0);
    unrealizedPnl += (totalCurrentEth - totalInitialEth) * currentEthPrice;
  }
  // Item 3: mismo patrón para XRP. currentXrpPrice es opcional y ningún
  // caller existente lo pasa todavía (ver ADR-018) — el bloque queda listo
  // para cuando el orquestador tenga precio de XRP disponible en ese punto.
  if (currentXrpPrice != null && currentXrpPrice > 0) {
    const totalCurrentXrp = EXCHANGES.reduce((s, ex) => s + (wallets.XRP[ex] || 0), 0);
    const totalInitialXrp = EXCHANGES.reduce((s, ex) => s + (INITIAL_BALANCES.XRP[ex] || 0), 0);
    unrealizedPnl += (totalCurrentXrp - totalInitialXrp) * currentXrpPrice;
  }

  const totalPnl = realizedPnl + unrealizedPnl;

  let peak = 0, cum = 0, maxDrawdown = 0;
  for (const t of tradeHistory) {
    cum += t.netProfit || 0;
    if (cum > peak) peak = cum;
    const dd = peak > 0 ? ((peak - cum) / peak) * 100 : 0;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  let currentStreak = 0;
  let currentStreakType: 'win' | 'loss' | null = null;
  for (let i = tradeHistory.length - 1; i >= 0; i--) {
    const isWin = (tradeHistory[i].netProfit || 0) > 0;
    const type: 'win' | 'loss' = isWin ? 'win' : 'loss';
    if (currentStreakType === null) { currentStreakType = type; currentStreak = 1; }
    else if (type === currentStreakType) currentStreak++;
    else break;
  }

  const sorted          = [...tradeHistory].sort((a, b) => (b.netProfit||0) - (a.netProfit||0));
  const avgExecutionMs  = tradeHistory.reduce((s, t) => s + (t.executionMs || 0), 0) / tradeHistory.length;
  const avgNetProfitPct = tradeHistory.reduce((s, t) => s + (t.netProfitPct || 0), 0) / tradeHistory.length;
  const totalFees       = tradeHistory.reduce((s, t) => s + ((t as any).totalFees || (t.buyFee||0) + (t.sellFee||0)), 0);
  const totalWithdrawalFees = tradeHistory.reduce((s, t) => s + (t.withdrawalFees || 0), 0);

  // Rebalancing cost estimate: ~$30 per round, 1 round per 50 trades
  const tradesCount = tradeHistory.length;
  const rebalancingRounds = Math.max(1, Math.ceil(tradesCount / 50));
  const rebalancingCostEstimate = +(rebalancingRounds * 30).toFixed(2);

  const slippageMethodBreakdown: SlippageMethodBreakdown = { real: 0, fallback: 0 };
  tradeHistory.forEach(t => {
    if (t.slippageMethod === 'real') slippageMethodBreakdown.real++;
    else slippageMethodBreakdown.fallback++;
  });

  const pairStats: Record<string, PairStat> = {};
  tradeHistory.forEach(t => {
    const key = `${t.buyExchange}→${t.sellExchange}`;
    if (!pairStats[key]) pairStats[key] = { count: 0, totalPnl: 0, wins: 0, totalFees: 0, totalWithdrawalFees: 0 };
    pairStats[key].count++;
    pairStats[key].totalPnl += t.netProfit || 0;
    pairStats[key].totalFees += ((t as any).totalFees || (t.buyFee||0) + (t.sellFee||0));
    pairStats[key].totalWithdrawalFees = (pairStats[key].totalWithdrawalFees || 0) + (t.withdrawalFees || 0);
    if ((t.netProfit || 0) > 0) pairStats[key].wins++;
  });

  return {
    totalPnl:             +totalPnl.toFixed(4),
    realizedPnl:          +realizedPnl.toFixed(4),
    unrealizedPnl:        +unrealizedPnl.toFixed(4),
    totalTrades:          tradeHistory.length,
    wins:                 wins.length,
    losses:               losses.length,
    winRate:              +winRate.toFixed(1),
    bestTrade:            sorted[0] || null,
    worstTrade:           sorted[sorted.length - 1] || null,
    avgExecutionMs:       +avgExecutionMs.toFixed(1),
    maxDrawdown:          +maxDrawdown.toFixed(2),
    currentStreak,
    currentStreakType,
    avgNetProfitPct:      +avgNetProfitPct.toFixed(4),
    totalFees:            +totalFees.toFixed(4),
    totalWithdrawalFees:  +totalWithdrawalFees.toFixed(4),
    slippageMethodBreakdown,
    pairStats,
    rebalancingCostEstimate,
  };
}

export function getInitialBalances(): Wallets {
  return JSON.parse(JSON.stringify(INITIAL_BALANCES));
}

// Issue 7: Mutex wrapper — serializes all applyTrade calls
export async function applyTrade(trade: IncomingTrade, uid?: string | null): Promise<ApplyTradeResult> {
  const state = _tenants.get(uid);
  if (state.tradeLock) {
    // Queue this call and resolve when it's our turn
    return new Promise<ApplyTradeResult>((resolve) => state.tradeQueue.push({ trade, resolve }));
  }
  state.tradeLock = true;
  try {
    return await _applyTradeInternal(trade, state, uid);
  } finally {
    state.tradeLock = false;
    if (state.tradeQueue.length > 0) {
      const next = state.tradeQueue.shift()!;
      applyTrade(next.trade, uid).then(next.resolve);
    }
  }
}

export { ArbitrageOp, WITHDRAWAL_FEES, EXCHANGES };
