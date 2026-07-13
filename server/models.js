'use strict';

const mongoose = require('mongoose');

// ─── User ──────────────────────────────────────────────────────────────────
const UserSchema = new mongoose.Schema({
  email:            { type: String, required: true, unique: true, lowercase: true, trim: true },
  // passwordHash is only required for local accounts. Google-only accounts
  // (authProvider: 'google') never receive a password unless the user later
  // sets one — see POST /api/auth/google and the "link" path in that route.
  passwordHash:     {
    type: String, default: null,
    required: function () { return this.authProvider === 'local'; },
  },
  name:             { type: String, default: '' },
  avatarUrl:        { type: String, default: '' },
  // 'local'  → email + password (bcrypt)
  // 'google' → Firebase Google sign-in only, no local password set
  authProvider:     { type: String, enum: ['local', 'google'], default: 'local' },
  // Firebase UID for the linked Google identity. Sparse + unique so multiple
  // local-only users (googleId: undefined) don't collide on the index.
  googleId:         { type: String, default: null, unique: true, sparse: true },
  // 'user'     → standard authenticated user, read + own-tenant actions only
  // 'operator' → can flip non-kill-switch feature flags, trigger background
  //              jobs, and other day-to-day ops actions (see rbac.js)
  // 'admin'    → operator + the most sensitive actions (kill switches, user
  //              management). Synced from ADMIN_EMAILS on every login — see
  //              auth.js _resolveRole().
  role:             { type: String, enum: ['user', 'operator', 'admin'], default: 'user' },
  createdAt:        { type: Date, default: Date.now },
  lastLoginAt:      { type: Date },
  refreshTokenHash: { type: String, default: null },
  onboardingDone:   { type: Boolean, default: false },
});
// Note: unique: true on the email field already creates the index; the
// explicit UserSchema.index({ email: 1 }) below was redundant and caused
// a mongoose "Duplicate schema index" warning. Removed.


// ─── Engine Snapshot (GAP 3 — persist critical engine state) ──────────────
// Punto 7 (auditoría comité, sección 12): `wallets` agregado para persistir
// balances simulados junto al resto del snapshot de motor — antes de este
// campo, un reinicio del proceso (deploy, crash, idle timeout) perdía
// silenciosamente todo el estado de wallet aunque equityCurve/dailyPnl sí
// sobrevivían. Mixed (no un sub-schema estricto) para que el shape lo
// defina walletManager.Wallets sin duplicar la validación acá — ver
// isValidWalletsShape() en walletManager.ts, que es quien valida antes de
// aplicar un valor restaurado.
const EngineSnapshotSchema = new mongoose.Schema({
  userId:      { type: String, required: true },
  date:        { type: String, required: true },   // 'YYYY-MM-DD'
  equityCurve: { type: [mongoose.Schema.Types.Mixed], default: [] },
  dailyPnl:    { type: Number, default: 0 },
  totalTrades: { type: Number, default: 0 },
  counters:    { type: mongoose.Schema.Types.Mixed, default: {} },
  tradeLog:    { type: [mongoose.Schema.Types.Mixed], default: [] },
  wallets:     { type: mongoose.Schema.Types.Mixed, default: null },
  updatedAt:   { type: Date, default: Date.now },
});
EngineSnapshotSchema.index({ userId: 1, date: 1 }, { unique: true });

// ─── Token blacklist (logout invalidation) ────────────────────────────────
const TokenBlacklistSchema = new mongoose.Schema({
  jti:       { type: String, required: true, unique: true },
  expiresAt: { type: Date, required: true },
});
TokenBlacklistSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// ─── Alerts ───────────────────────────────────────────────────────────────
// Issue 16: userId is required (removed 'default' sentinel) to enforce ownership.
// Issue 21: Added compound index on userId+createdAt for O(log n) queries.
const AlertSchema = new mongoose.Schema({
  userId:    { type: String, required: true, index: true },
  coinId:    { type: String, required: true },
  coinName:  { type: String, required: true },
  condition: { type: String, enum: ['above', 'below'], required: true },
  price:     { type: Number, required: true },
  triggered: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
});
// Issue 21: Compound index for efficient per-user listing
AlertSchema.index({ userId: 1, createdAt: -1 });

const WatchlistSchema = new mongoose.Schema({
  // Issue 16: userId required; one watchlist per user enforced by unique index
  userId: { type: String, required: true },
  coins:  [String],
});
// Issue 21: Unique index — one watchlist document per user
WatchlistSchema.index({ userId: 1 }, { unique: true });

const PortfolioSchema = new mongoose.Schema({
  // Issue 16: userId required
  userId:          { type: String, required: true, index: true },
  coinId:          { type: String, required: true },
  coinName:        { type: String, required: true },
  symbol:          { type: String, required: true },
  image:           { type: String },
  quantity:        { type: Number, required: true },
  entryPrice:      { type: Number, required: true },
  entryDate:       { type: Date, default: Date.now },
  createdAt:       { type: Date, default: Date.now },
  // I-7 fix: idempotency key for safe client retries on network failures
  _idempotencyKey: { type: String, default: null },
});
// Issue 21: Compound index for efficient per-user portfolio listing
PortfolioSchema.index({ userId: 1, createdAt: -1 });
// I-7 fix: partial index for idempotency key lookup (only indexes non-null keys)
PortfolioSchema.index({ userId: 1, _idempotencyKey: 1, createdAt: 1 }, { sparse: true });

// ─── User Trading Config (GAP 4 — per-user pair config) ───────────────────
const UserTradingConfigSchema = new mongoose.Schema({
  userId:     { type: String, required: true, unique: true },
  pairs:      { type: [String], default: ['BTC/USDT'] },  // enabled pairs
  allocation: { type: mongoose.Schema.Types.Mixed, default: { 'BTC/USDT': 1.0 } },
  mode:       { type: String, enum: ['paper', 'live'], default: 'paper' },
  // riskProfile (refinamiento post-Sesión 34): overrides opcionales por
  // usuario sobre los límites de riesgo GLOBALES de liveConfig, consumidos
  // por userRiskProfileService.getEffectiveConfig() y aplicados en
  // preTradeRiskCheck(...) justo antes de una ejecución live/cross-exchange
  // de ESE usuario. Cada campo null = "usar el default global"; un valor
  // presente siempre se recorta (nunca se relaja) contra el límite global
  // vigente — ver `_clampToGlobal()` en userRiskProfileService.js.
  riskProfile: {
    maxPositionValueUSD: { type: Number, default: null },
    maxDailyLossUSD:     { type: Number, default: null },
    maxSlippagePct:      { type: Number, default: null },
    maxDrawdownPct:      { type: Number, default: null },
    activeExchanges:     { type: [String], default: null },
    updatedAt:           { type: String, default: null },
  },
  // checkpoint-37: per-user live-trading toggle (userLiveModeService.js).
  // Best-effort persistence only — see that module's header for why this
  // is fire-and-forget (unlike UserExchangeCredential below, which is not).
  liveTradingEnabled:        { type: Boolean, default: false },
  liveTradingEnabledAt:      { type: Date, default: null },
  liveTradingDisclaimerHash: { type: String, default: null },
  updatedAt:  { type: Date, default: Date.now },
});

// ─── Per-user exchange credentials (checkpoint-37: per-user live trading) ──
// Extiende el patrón de secretsVault.js (bóveda GLOBAL, un solo archivo
// cifrado en disco) a credenciales POR USUARIO. Mismo cifrado AES-256-GCM
// que secretsVault (misma KUKORA_MASTER_KEY, mismas encrypt()/decrypt()) —
// ver server/infrastructure/userSecretsVault.js, que es el único módulo que
// lee/escribe este modelo. apiKeyEnc/apiSecretEnc/apiPassphraseEnc guardan
// el payload `iv:authTag:ciphertext` que produce secretsVault.encrypt(), NUNCA
// texto plano. Un índice único compuesto (userId, exchange) — un usuario solo
// puede tener una credencial vigente por exchange; reconectar sobreescribe
// (upsert), no duplica.
const UserExchangeCredentialSchema = new mongoose.Schema({
  userId:          { type: String, required: true },
  exchange:        { type: String, required: true }, // siempre lowercase — ver userSecretsVault.js
  apiKeyEnc:       { type: String, required: true },
  apiSecretEnc:    { type: String, required: true },
  apiPassphraseEnc:{ type: String, default: null }, // solo OKX
  connectedAt:     { type: Date, default: Date.now },
  updatedAt:       { type: Date, default: Date.now },
});
UserExchangeCredentialSchema.index({ userId: 1, exchange: 1 }, { unique: true });

// ─── System Notifications (bell icon — distinct from price Alert above) ───
// userId: 'broadcast' for system-wide engine events (circuit breaker, drawdown,
// etc. — the arbitrage engine is a single global instance, not per-user, so
// these fire without per-request context). A real userId is reserved for any
// future per-user notification type. Mirrors the 'default' sentinel already
// used by Alert/Watchlist above for the same single-tenant-engine reason.
//
// readBy (not a single `read` boolean): a broadcast notification is shared
// across every account, but "read" state is inherently per-viewer — userA
// dismissing it must not mark it read for userB. readBy tracks which user
// ids have seen this particular notification.
const NotificationSchema = new mongoose.Schema({
  userId:    { type: String, required: true, default: 'broadcast', index: true },
  event:     { type: String, required: true },   // e.g. 'circuit_breaker_activated'
  title:     { type: String, required: true },
  severity:  { type: String, enum: ['info', 'warn', 'critical'], default: 'info' },
  readBy:    { type: [String], default: [] },
  createdAt: { type: Date, default: Date.now, index: true },
});
NotificationSchema.index({ userId: 1, createdAt: -1 });

// ─── Pending Execution — crash recovery for in-flight cross-exchange trades
// (auditoría comité, Sesión 34, P1 #2). Antes de esta sesión, el registro de
// una ejecución en curso ("CROSS_EXECUTE_START") solo vivía en un array en
// memoria (`_auditLog` de liveExecution.js) — si el proceso moría entre que
// se colocó la pata BUY y se colocó/confirmó la pata SELL, ese registro se
// perdía por completo al reiniciar, y no había forma programática de saber
// "¿quedó una pata abierta sin cubrir de la sesión anterior?" salvo grepeando
// logs a mano. Este modelo persiste un marcador ANTES de colocar cualquier
// pata y se borra (resolve) cuando el trade termina — éxito, hedge parcial,
// o emergency-flatten. Si al arrancar quedan documentos sin resolver, es
// evidencia directa de una caída a mitad de ejecución y se loggea como alerta
// crítica (ver `checkPendingExecutionsOnBoot` en server/index.js) — el
// sistema NO intenta adivinar o revertir solo; solo señala para revisión
// manual, que es lo correcto cuando el dato es "no sabemos en qué quedó esta
// pata" y hay dinero real de por medio.
const PendingExecutionSchema = new mongoose.Schema({
  tradeId:       { type: String, required: true, unique: true },
  userId:        { type: String, required: true },
  buyExchange:   { type: String },
  sellExchange:  { type: String },
  symbol:        { type: String },
  amount:        { type: Number },
  opportunityId: { type: String },
  createdAt:     { type: Date, default: Date.now },
});

module.exports = {
  User:               mongoose.model('User',               UserSchema),
  EngineSnapshot:     mongoose.model('EngineSnapshot',     EngineSnapshotSchema),
  PendingExecution:   mongoose.model('PendingExecution',   PendingExecutionSchema),
  TokenBlacklist:     mongoose.model('TokenBlacklist',     TokenBlacklistSchema),
  Alert:              mongoose.model('Alert',              AlertSchema),
  Watchlist:          mongoose.model('Watchlist',          WatchlistSchema),
  Portfolio:          mongoose.model('Portfolio',          PortfolioSchema),
  UserTradingConfig:  mongoose.model('UserTradingConfig',  UserTradingConfigSchema),
  Notification:       mongoose.model('Notification',       NotificationSchema),
  UserExchangeCredential: mongoose.model('UserExchangeCredential', UserExchangeCredentialSchema),
};
