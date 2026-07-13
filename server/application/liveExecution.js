'use strict';
/**
 * liveExecution.js — Kukora Live Trading Engine
 *
 * Provides executeLive() that places real orders on exchange REST APIs
 * (mainnet by default; set <EXCHANGE>_TESTNET / KRAKEN_SANDBOX_URL to
 * route to the exchange's sandbox/testnet environment for Fase 2 / Shadow
 * Mode validation — see docs/RoadmapToProduction.md).
 * Toggle between paper/live via POST /api/arbitrage/mode
 *
 * Security:
 *   - API keys loaded from env only, never stored in DB
 *   - Hard pre-flight checks before any order placement
 *   - Emergency kill switch: LIVE_TRADING_ENABLED=true required
 *   - All live orders logged to audit trail
 *
 * Supported exchanges (all five now implemented — closes the "3-of-5
 * exchanges support real live execution" gap flagged in the July 2026
 * engineering audit; OKX/Coinbase previously fell back silently to paper
 * mode whenever they appeared as buyExchange/sellExchange in live mode):
 *   - Binance — mainnet (api.binance.com) + testnet (testnet.binance.vision),
 *     toggled with BINANCE_TESTNET=true.
 *   - Bybit   — mainnet (api.bybit.com) + testnet (api-testnet.bybit.com),
 *     toggled with BYBIT_TESTNET=true. Uses the v5 unified-account API
 *     (HMAC-SHA256 over timestamp+apiKey+recvWindow+payload, X-BAPI-* headers).
 *   - Kraken  — mainnet (api.kraken.com), HMAC-SHA512 signing (nonce +
 *     SHA256(nonce+postdata), API-Sign header) — this is Kraken's real
 *     production auth scheme and is fully implemented.
 *     HONEST CAVEAT: unlike Binance/Bybit, Kraken does not publish an
 *     official Spot sandbox. KrakenClient accepts a `sandbox` flag that
 *     points requests at KRAKEN_SANDBOX_URL (env-configurable) instead of
 *     api.kraken.com, for teams that stand up their own mock or use Kraken
 *     Futures Demo (demo-futures.kraken.com — a different API surface, not
 *     drop-in compatible with Spot). Until KRAKEN_SANDBOX_URL is set,
 *     sandbox mode refuses to run rather than silently falling back to
 *     production and risking real capital (see testExchangeConnection()).
 *   - OKX     — mainnet (www.okx.com), HMAC-SHA256 signing per OKX v5 spec
 *     (base64 over ISO-8601-timestamp+method+requestPath+body,
 *     OK-ACCESS-* headers). Requires a THIRD credential beyond key/secret:
 *     OK-ACCESS-PASSPHRASE, set when the API key was created — stored as
 *     OKX_API_PASSPHRASE (the encrypted secretsVault only vaults key+secret
 *     today; the passphrase is env-only until the vault schema is extended).
 *     HONEST CAVEAT: OKX has no separate demo host — `OKX_DEMO_TRADING=true`
 *     sets the `x-simulated-trading: 1` header against the same
 *     www.okx.com endpoint (OKX's actual demo-trading mechanism), not a
 *     different URL like Binance/Bybit testnets.
 *   - Coinbase — mainnet (api.coinbase.com), Advanced Trade API, HMAC-SHA256
 *     signing (hex over unix-timestamp+method+path+body, CB-ACCESS-* headers).
 *     HONEST CAVEAT: Coinbase Advanced Trade has no widely-documented public
 *     sandbox equivalent to Binance/Bybit testnets as of this writing — the
 *     `testnet` constructor flag exists for interface parity with the other
 *     four clients but is currently a no-op; there is nowhere for it to
 *     safely route to. Validate against a small real position before
 *     enabling live mode for Coinbase.
 *
 * Each client shares the same shape (constructor(apiKey, apiSecret, opts),
 * _sign(), getAccountInfo(), getBalance(), placeMarketOrder(), getOrder(),
 * cancelOrder()) so getExchangeClient() below can select one generically.
 *
 * checkpoint-37 (per-user live trading): _resolveCredentials() below tries
 * a user's OWN connected exchange credentials (userSecretsVault.js) first,
 * falling back to the global vault/env (secretsVault.js) exactly as
 * before — purely additive, no existing single-operator deployment sees
 * any behavior change. executeLive/executeCrossExchangeLive also now gate
 * on userLiveModeService.isLiveModeEnabled(userId) — see
 * _requireUserLiveModeEnabled() — on TOP OF (never instead of) the existing
 * LIVE_ENABLED / getUserMode()==='live' gate.
 */

const crypto = require('crypto');
const { logger } = require('../infrastructure/logger');
const exchangeRateLimiter = require('../infrastructure/exchangeRateLimiter');
const alertWebhookService = require('../infrastructure/alertWebhookService');
const tradeStateMachine = require('../domain/analytics/tradeStateMachine');
const smartOrderRouter = require('../domain/engines/smartOrderRouter');
const secretsVault = require('../infrastructure/secretsVault');
// checkpoint-37: per-user exchange credentials (extends the global-only
// secretsVault with a per-userId store — see userSecretsVault.js header for
// the full design rationale). Additive only: _resolveCredentials() below
// tries this first and falls back to secretsVault.getCredentials() exactly
// as before for any user who never connected their own exchange keys.
const userSecretsVault = require('../infrastructure/userSecretsVault');
// checkpoint-37: per-user live-trading toggle — gates executeLive/
// executeCrossExchangeLive on top of (never instead of) the existing
// global LIVE_ENABLED kill switch. See userLiveModeService.js header.
const userLiveModeService = require('../infrastructure/userLiveModeService');
const persistenceService = require('../infrastructure/persistenceService');
const advRisk = require('../domain/risk/advancedRiskEngine');
const liveTradeLedger = require('../domain/wallet/liveTradeLedger');
const userRiskProfileService = require('../domain/risk/userRiskProfileService');
const liveConfig = require('../infrastructure/liveConfig');
const opportunitySnapshotStore = require('../domain/engines/opportunitySnapshotStore');
const obs = require('../infrastructure/observabilityService');
// ADR-019 §5 (real-money path): unlike the shared paper-trading bot, real
// executions here have a genuine fillPrice that can diverge from the
// pre-trade referencePrice — a real signal recordSlippageBias() can use.
// See _recordRealizedSlippageBias() below for why maxSlippagePct is used
// as the "modeled/acceptable" baseline rather than a fabricated per-leg
// model split.
const { recordSlippageBias } = require('../infrastructure/exchangeReliabilityDynamic');

// ─── ADR-019 Part C: recovery classification (logging-only) ───────────────
function _logRecoveryClassification(scenario, context, tradeId) {
  if (!liveConfig.get('recoveryClassificationEnabled')) return;
  try {
    const classification = tradeStateMachine.determineRecoveryAction(scenario, context);
    obs.emit('RISK', 'risk.recovery_classification', {
      tradeId,
      scenario,
      recommended: classification.action,
      reason: classification.reason,
      priority: classification.priority,
      urgent: !!classification.urgent,
      actualAction: 'emergency_flatten', // _emergencyFlatten is always what actually runs today
      note: classification.action === 'emergency_liquidation' || classification.action === 'hedge'
        ? 'classification agrees with the flatten path taken'
        : 'classification would have chosen a different action (retry/cancel/hedge) — informational only, no behavior change',
    }, 'info');
  } catch (e) {
    // Classification is observability-only — never let it block recovery.
    obs.emit('RISK', 'risk.recovery_classification_error', { tradeId, scenario, error: e.message }, 'warn');
  }
}

// ─── ADR-019 §5 (real-money path): genuine realized-vs-modeled slippage ────
function _recordRealizedSlippageBias(exchange, side, referencePrice, fillPrice) {
  try {
    if (!referencePrice || referencePrice <= 0 || fillPrice == null) return;
    // BUY: paying more than referencePrice is adverse slippage.
    // SELL: receiving less than referencePrice is adverse slippage.
    const adverseDeltaPct = side === 'SELL'
      ? ((referencePrice - fillPrice) / referencePrice) * 100
      : ((fillPrice - referencePrice) / referencePrice) * 100;
    const budgetPct = liveConfig.get('maxSlippagePct') || 0;
    recordSlippageBias(exchange, adverseDeltaPct - budgetPct);
  } catch (e) {
    obs.emit('RISK', 'risk.slippage_bias_record_error', { exchange, side, error: e.message }, 'warn');
  }
}


const LIVE_ENABLED = process.env.LIVE_TRADING_ENABLED === 'true';

// ─── Transient-error retry with backoff ────────────────────────────────────
async function _fetchWithRetry(url, options, exchangeLabel) {
  const maxAttempts = Math.max(1, liveConfig.get('maxOrderRetries'));
  const baseDelayMs = liveConfig.get('retryBackoffMs');
  let res;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    res = await fetch(url, options);
    const isRetryableStatus = res.status === 429 || res.status >= 500;
    if (!isRetryableStatus || attempt === maxAttempts - 1) return res;

    const retryAfterHeader = typeof res.headers?.get === 'function' ? res.headers.get('retry-after') : null;
    const delayMs = retryAfterHeader && !isNaN(Number(retryAfterHeader))
      ? Number(retryAfterHeader) * 1000
      : baseDelayMs * (2 ** attempt);
    const cappedDelayMs = Math.min(delayMs, 5000); // bounded — arbitrage windows are seconds, not minutes

    _audit({
      event: 'EXCHANGE_TRANSIENT_ERROR_RETRY',
      exchange: exchangeLabel,
      status: res.status,
      attempt: attempt + 1,
      maxAttempts,
      delayMs: cappedDelayMs,
    });
    await new Promise(r => setTimeout(r, cappedDelayMs));
  }
  return res;
}

// ─── Exchange API Clients ─────────────────────────────────────────────────
class ExchangeClientBase {
  constructor(exchangeLabel, exchangeAuditLabel) {
    this._exchangeLabel = exchangeLabel;
    this._exchangeAuditLabel = exchangeAuditLabel;
  }

  async getBalance(asset) {
    const account = await this.getAccountInfo();
    const bal = account.balances?.find(b => b.asset === asset);
    return bal ? bal.free : 0;
  }

  async _fetchJson(url, options, checkBusinessError) {
    const res = await _fetchWithRetry(url, options, this._exchangeAuditLabel);
    const data = await res.json();
    if (!res.ok) throw new Error(`${this._exchangeLabel} API error ${res.status}: ${JSON.stringify(data)}`);
    if (checkBusinessError) checkBusinessError(data);
    return data;
  }
}

class BinanceClient extends ExchangeClientBase {
  constructor(apiKey, apiSecret, { testnet = false } = {}) {
    super('Binance', 'binance');
    this.apiKey    = apiKey;
    this.apiSecret = apiSecret;
    this.baseUrl   = testnet
      ? 'https://testnet.binance.vision'
      : 'https://api.binance.com';
    this.testnet   = testnet;
  }

  _sign(params) {
    const qs = new URLSearchParams(params).toString();
    return crypto.createHmac('sha256', this.apiSecret).update(qs).digest('hex');
  }

  async _request(method, path, params = {}) {
    const timestamp = Date.now();
    const allParams = { ...params, timestamp };
    const signature = this._sign(allParams);
    const qs = new URLSearchParams({ ...allParams, signature }).toString();

    const url = `${this.baseUrl}${path}${method === 'GET' ? '?' + qs : ''}`;
    const options = {
      method,
      headers: {
        'X-MBX-APIKEY': this.apiKey,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    };
    if (method === 'POST') options.body = qs;

    return this._fetchJson(url, options);
  }

  async getAccountInfo() {
    const raw = await this._request('GET', '/api/v3/account');
    return {
      canTrade: raw.canTrade,
      balances: (raw.balances || []).map(b => ({ asset: b.asset, free: parseFloat(b.free || '0') })),
    };
  }
  async getOrderBook(symbol, limit = 5) {
    const res = await fetch(`${this.baseUrl}/api/v3/depth?symbol=${symbol}&limit=${limit}`);
    return res.json();
  }
  async placeMarketOrder(symbol, side, quantity) {
    return this._request('POST', '/api/v3/order', {
      symbol,
      side: side.toUpperCase(),
      type: 'MARKET',
      quantity: quantity.toFixed(6),
    });
  }
  async placeLimitOrder(symbol, side, quantity, price) {
    return this._request('POST', '/api/v3/order', {
      symbol,
      side: side.toUpperCase(),
      type: 'LIMIT',
      timeInForce: 'GTC',
      quantity: quantity.toFixed(6),
      price: price.toFixed(2),
    });
  }
  async placeOrder(symbol, side, quantity, { type = 'MARKET', price } = {}) {
    if (type === 'MARKET') return this.placeMarketOrder(symbol, side, quantity);
    if (type === 'LIMIT_IOC') {
      return this._request('POST', '/api/v3/order', {
        symbol, side: side.toUpperCase(), type: 'LIMIT', timeInForce: 'IOC',
        quantity: quantity.toFixed(6), price: price.toFixed(2),
      });
    }
    if (type === 'LIMIT_MAKER') {
      return this._request('POST', '/api/v3/order', {
        symbol, side: side.toUpperCase(), type: 'LIMIT_MAKER',
        quantity: quantity.toFixed(6), price: price.toFixed(2),
      });
    }
    throw new Error(`Unsupported order type: ${type}`);
  }
  async getOrder(symbol, orderId) {
    return this._request('GET', '/api/v3/order', { symbol, orderId });
  }
  async cancelOrder(symbol, orderId) {
    return this._request('DELETE', '/api/v3/order', { symbol, orderId });
  }
  async checkWithdrawalPermission() {
    const res = await this._request('GET', '/sapi/v1/account/apiRestrictions');
    return {
      verifiable: true,
      withdrawalEnabled: !!res.enableWithdrawals,
      detail: `Binance apiRestrictions.enableWithdrawals=${!!res.enableWithdrawals}`,
    };
  }
}

class BybitClient extends ExchangeClientBase {
  constructor(apiKey, apiSecret, { testnet = false } = {}) {
    super('Bybit', 'bybit');
    this.apiKey     = apiKey;
    this.apiSecret  = apiSecret;
    this.testnet    = testnet;
    this.recvWindow = '5000';
    this.baseUrl = testnet
      ? 'https://api-testnet.bybit.com'
      : 'https://api.bybit.com';
  }

  _sign(timestamp, payload) {
    const message = `${timestamp}${this.apiKey}${this.recvWindow}${payload}`;
    return crypto.createHmac('sha256', this.apiSecret).update(message).digest('hex');
  }

  async _request(method, path, params = {}) {
    const timestamp = Date.now().toString();
    let url = `${this.baseUrl}${path}`;
    let payload = '';
    const options = { method, headers: {} };

    if (method === 'GET') {
      const qs = new URLSearchParams(params).toString();
      payload = qs;
      if (qs) url += `?${qs}`;
    } else {
      payload = JSON.stringify(params);
      options.body = payload;
      options.headers['Content-Type'] = 'application/json';
    }

    const signature = this._sign(timestamp, payload);
    options.headers = {
      ...options.headers,
      'X-BAPI-API-KEY':    this.apiKey,
      'X-BAPI-SIGN':       signature,
      'X-BAPI-TIMESTAMP':  timestamp,
      'X-BAPI-RECV-WINDOW': this.recvWindow,
    };

    return this._fetchJson(url, options, (data) => {
      if (data.retCode !== undefined && data.retCode !== 0) {
        throw new Error(`Bybit API error (retCode ${data.retCode}): ${data.retMsg}`);
      }
    });
  }

  async getAccountInfo() {
    const res = await this._request('GET', '/v5/account/wallet-balance', { accountType: 'UNIFIED' });
    const account = res.result?.list?.[0];
    return {
      canTrade: true,
      balances: (account?.coin || []).map(c => ({
        asset: c.coin,
        free: parseFloat(c.walletBalance || c.availableToWithdraw || '0'),
      })),
    };
  }
  async getOrderBook(symbol, limit = 5) {
    const res = await fetch(`${this.baseUrl}/v5/market/orderbook?category=spot&symbol=${symbol}&limit=${limit}`);
    return res.json();
  }
  async placeMarketOrder(symbol, side, quantity) {
    const res = await this._request('POST', '/v5/order/create', {
      category:  'spot',
      symbol,
      side:      side[0].toUpperCase() + side.slice(1).toLowerCase(),
      orderType: 'Market',
      qty:       quantity.toString(),
    });
    return res.result;
  }
  async placeOrder(symbol, side, quantity, { type = 'MARKET', price } = {}) {
    if (type === 'MARKET') return this.placeMarketOrder(symbol, side, quantity);
    const timeInForce = type === 'LIMIT_MAKER' ? 'PostOnly' : type === 'LIMIT_IOC' ? 'IOC' : null;
    if (!timeInForce) throw new Error(`Unsupported order type: ${type}`);
    const res = await this._request('POST', '/v5/order/create', {
      category:  'spot',
      symbol,
      side:      side[0].toUpperCase() + side.slice(1).toLowerCase(),
      orderType: 'Limit',
      qty:       quantity.toString(),
      price:     price.toString(),
      timeInForce,
    });
    return res.result;
  }
  async getOrder(symbol, orderId) {
    const res = await this._request('GET', '/v5/order/realtime', { category: 'spot', symbol, orderId });
    return res.result?.list?.[0] || {};
  }
  async cancelOrder(symbol, orderId) {
    const res = await this._request('POST', '/v5/order/cancel', { category: 'spot', symbol, orderId });
    return res.result;
  }
  async checkWithdrawalPermission() {
    const res = await this._request('GET', '/v5/user/query-api');
    const result = res.result || {};
    if (result.readOnly === true || result.readOnly === 1) {
      return { verifiable: true, withdrawalEnabled: false, detail: 'Bybit key is read-only (readOnly=true) — cannot withdraw' };
    }
    const walletPerms = result.permissions?.Wallet || [];
    const looksLikeWithdraw = walletPerms.some(p => /withdraw/i.test(String(p)));
    return {
      verifiable: true,
      withdrawalEnabled: looksLikeWithdraw,
      detail: `Bybit Wallet permissions (heuristic check): [${walletPerms.join(', ')}]`,
    };
  }
}

class KrakenClient extends ExchangeClientBase {
  constructor(apiKey, apiSecret, { sandbox = false } = {}) {
    super('Kraken', 'kraken');
    this.apiKey    = apiKey;
    this.apiSecret = apiSecret;
    this.sandbox   = sandbox;
    this.sandboxUrl = process.env.KRAKEN_SANDBOX_URL || null;
  }

  _baseUrl() {
    if (!this.sandbox) return 'https://api.kraken.com';
    if (!this.sandboxUrl) {
      throw new Error(
        'Kraken sandbox mode requested but KRAKEN_SANDBOX_URL is not set. ' +
        'Kraken does not publish an official Spot sandbox — point this at ' +
        'your own mock endpoint before enabling shadow-mode trades, rather ' +
        'than risking real capital against api.kraken.com.'
      );
    }
    return this.sandboxUrl;
  }

  _sign(path, nonce, postData) {
    const secretBuf = Buffer.from(this.apiSecret, 'base64');
    const hash = crypto.createHash('sha256').update(nonce + postData).digest();
    const hmac = crypto.createHmac('sha512', secretBuf)
      .update(Buffer.concat([Buffer.from(path), hash]))
      .digest('base64');
    return hmac;
  }

  async _privateRequest(path, params = {}) {
    const nonce = Date.now().toString();
    const postData = new URLSearchParams({ ...params, nonce }).toString();
    const signature = this._sign(path, nonce, postData);

    const data = await this._fetchJson(`${this._baseUrl()}${path}`, {
      method: 'POST',
      headers: {
        'API-Key':     this.apiKey,
        'API-Sign':    signature,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: postData,
    }, (d) => {
      if (d.error && d.error.length) throw new Error(`Kraken API error: ${d.error.join(', ')}`);
    });
    return data.result;
  }

  async getAccountInfo() {
    const balance = await this._privateRequest('/0/private/Balance');
    return {
      canTrade: true,
      balances: Object.entries(balance || {}).map(([asset, free]) => ({ asset, free: parseFloat(free) })),
    };
  }
  async getOrderBook(pair, count = 5) {
    const res = await fetch(`${this._baseUrl()}/0/public/Depth?pair=${pair}&count=${count}`);
    return res.json();
  }
  async placeMarketOrder(pair, side, volume) {
    const result = await this._privateRequest('/0/private/AddOrder', {
      pair,
      type:      side.toLowerCase(),
      ordertype: 'market',
      volume:    volume.toString(),
    });
    return { orderId: result?.txid?.[0], raw: result };
  }
  async placeOrder(pair, side, volume, { type = 'MARKET', price } = {}) {
    if (type === 'MARKET') return this.placeMarketOrder(pair, side, volume);
    const params = {
      pair, type: side.toLowerCase(), ordertype: 'limit',
      volume: volume.toString(), price: price.toString(),
    };
    if (type === 'LIMIT_IOC') params.timeinforce = 'IOC';
    else if (type === 'LIMIT_MAKER') params.oflags = 'post';
    else throw new Error(`Unsupported order type: ${type}`);
    const result = await this._privateRequest('/0/private/AddOrder', params);
    return { orderId: result?.txid?.[0], raw: result };
  }
  async getOrder(pair, orderId) {
    const result = await this._privateRequest('/0/private/QueryOrders', { txid: orderId });
    return result?.[orderId] || {};
  }
  async cancelOrder(pair, orderId) {
    return this._privateRequest('/0/private/CancelOrder', { txid: orderId });
  }
  async checkWithdrawalPermission() {
    return {
      verifiable: false,
      withdrawalEnabled: null,
      detail: 'Kraken has no API endpoint to query an API key\'s own permissions — cannot be verified programmatically. Requires manual user attestation.',
    };
  }
}

function _toDashSymbol(symbol) {
  if (symbol.includes('-')) return symbol.toUpperCase();
  const m = symbol.match(/^([A-Z0-9]{2,10}?)(USDT|USDC|USD|EUR|BTC)$/i);
  if (!m) return symbol.toUpperCase();
  return `${m[1].toUpperCase()}-${m[2].toUpperCase()}`;
}

class OKXClient extends ExchangeClientBase {
  constructor(apiKey, apiSecret, { passphrase, testnet = false } = {}) {
    super('OKX', 'okx');
    this.apiKey     = apiKey;
    this.apiSecret  = apiSecret;
    this.passphrase = passphrase;
    this.testnet    = testnet;
    this.baseUrl    = 'https://www.okx.com';
  }

  _sign(timestamp, method, requestPath, body) {
    const prehash = `${timestamp}${method}${requestPath}${body}`;
    return crypto.createHmac('sha256', this.apiSecret).update(prehash).digest('base64');
  }

  async _request(method, path, { query = {}, body = null } = {}) {
    const qs = Object.keys(query).length ? `?${new URLSearchParams(query).toString()}` : '';
    const requestPath = `${path}${qs}`;
    const bodyStr = body ? JSON.stringify(body) : '';
    const timestamp = new Date().toISOString();
    const signature = this._sign(timestamp, method, requestPath, bodyStr);

    const headers = {
      'OK-ACCESS-KEY':        this.apiKey,
      'OK-ACCESS-SIGN':       signature,
      'OK-ACCESS-TIMESTAMP':  timestamp,
      'OK-ACCESS-PASSPHRASE': this.passphrase || '',
      'Content-Type':         'application/json',
    };
    if (this.testnet) headers['x-simulated-trading'] = '1';

    const options = { method, headers };
    if (bodyStr) options.body = bodyStr;

    return this._fetchJson(`${this.baseUrl}${requestPath}`, options, (data) => {
      if (data.code !== undefined && data.code !== '0') {
        throw new Error(`OKX API error (code ${data.code}): ${data.msg}`);
      }
    });
  }

  async getAccountInfo() {
    const res = await this._request('GET', '/api/v5/account/balance');
    const details = res.data?.[0]?.details || [];
    return {
      canTrade: true,
      balances: details.map(d => ({ asset: d.ccy, free: parseFloat(d.availBal || '0') })),
    };
  }
  async getOrderBook(symbol, limit = 5) {
    const res = await fetch(`${this.baseUrl}/api/v5/market/books?instId=${_toDashSymbol(symbol)}&sz=${limit}`);
    return res.json();
  }
  async placeMarketOrder(symbol, side, quantity) {
    const instId = _toDashSymbol(symbol);
    const res = await this._request('POST', '/api/v5/trade/order', {
      body: { instId, tdMode: 'cash', side: side.toLowerCase(), ordType: 'market', sz: quantity.toString() },
    });
    return { orderId: res.data?.[0]?.ordId, instId, raw: res.data?.[0] };
  }
  async placeOrder(symbol, side, quantity, { type = 'MARKET', price } = {}) {
    if (type === 'MARKET') return this.placeMarketOrder(symbol, side, quantity);
    const ordType = type === 'LIMIT_MAKER' ? 'post_only' : type === 'LIMIT_IOC' ? 'ioc' : null;
    if (!ordType) throw new Error(`Unsupported order type: ${type}`);
    const instId = _toDashSymbol(symbol);
    const res = await this._request('POST', '/api/v5/trade/order', {
      body: { instId, tdMode: 'cash', side: side.toLowerCase(), ordType, sz: quantity.toString(), px: price.toString() },
    });
    return { orderId: res.data?.[0]?.ordId, instId, raw: res.data?.[0] };
  }
  async getOrder(symbol, orderId) {
    const res = await this._request('GET', '/api/v5/trade/order', { query: { instId: _toDashSymbol(symbol), ordId: orderId } });
    return res.data?.[0] || {};
  }
  async cancelOrder(symbol, orderId) {
    return this._request('POST', '/api/v5/trade/cancel-order', { body: { instId: _toDashSymbol(symbol), ordId: orderId } });
  }
  async checkWithdrawalPermission() {
    const res = await this._request('GET', '/api/v5/account/config');
    const perm = res.data?.[0]?.perm || '';
    const perms = perm.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    return {
      verifiable: true,
      withdrawalEnabled: perms.includes('withdraw'),
      detail: `OKX account/config perm="${perm}"`,
    };
  }
}

class CoinbaseClient extends ExchangeClientBase {
  constructor(apiKey, apiSecret, { testnet = false } = {}) {
    super('Coinbase', 'coinbase');
    this.apiKey    = apiKey;
    this.apiSecret = apiSecret;
    this.testnet   = testnet; // no-op placeholder — see file header caveat
    this.baseUrl   = 'https://api.coinbase.com';
  }

  _sign(timestamp, method, requestPath, body) {
    const prehash = `${timestamp}${method}${requestPath}${body}`;
    return crypto.createHmac('sha256', this.apiSecret).update(prehash).digest('hex');
  }

  async _request(method, path, body = null) {
    const bodyStr = body ? JSON.stringify(body) : '';
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = this._sign(timestamp, method, path, bodyStr);

    const options = {
      method,
      headers: {
        'CB-ACCESS-KEY':       this.apiKey,
        'CB-ACCESS-SIGN':      signature,
        'CB-ACCESS-TIMESTAMP': timestamp,
        'Content-Type':        'application/json',
      },
    };
    if (bodyStr) options.body = bodyStr;

    return this._fetchJson(`${this.baseUrl}${path}`, options, (data) => {
      if (data.error != null) throw new Error(`Coinbase API error: ${data.error} — ${data.message || data.error_details || ''}`);
    });
  }

  async getAccountInfo() {
    const res = await this._request('GET', '/api/v3/brokerage/accounts');
    const accounts = res.accounts || [];
    return {
      canTrade: true,
      balances: accounts.map(a => ({ asset: a.currency, free: parseFloat(a.available_balance?.value || '0') })),
    };
  }
  async getOrderBook(symbol, limit = 5) {
    const productId = _toDashSymbol(symbol);
    const res = await fetch(`${this.baseUrl}/api/v3/brokerage/market/product_book?product_id=${productId}&limit=${limit}`);
    return res.json();
  }
  async placeMarketOrder(symbol, side, quantity) {
    const productId = _toDashSymbol(symbol);
    const clientOrderId = crypto.randomUUID();
    const res = await this._request('POST', '/api/v3/brokerage/orders', {
      client_order_id: clientOrderId,
      product_id:      productId,
      side:            side.toUpperCase(),
      order_configuration: { market_market_ioc: { base_size: quantity.toString() } },
    });
    return { orderId: res.order_id || res.success_response?.order_id, clientOrderId, productId, raw: res };
  }
  async placeOrder(symbol, side, quantity, { type = 'MARKET', price } = {}) {
    if (type === 'MARKET') return this.placeMarketOrder(symbol, side, quantity);
    const productId = _toDashSymbol(symbol);
    const clientOrderId = crypto.randomUUID();
    let orderConfig;
    if (type === 'LIMIT_IOC') {
      orderConfig = { limit_limit_ioc: { base_size: quantity.toString(), limit_price: price.toString() } };
    } else if (type === 'LIMIT_MAKER') {
      orderConfig = { limit_limit_gtc: { base_size: quantity.toString(), limit_price: price.toString(), post_only: true } };
    } else {
      throw new Error(`Unsupported order type: ${type}`);
    }
    const res = await this._request('POST', '/api/v3/brokerage/orders', {
      client_order_id: clientOrderId, product_id: productId, side: side.toUpperCase(),
      order_configuration: orderConfig,
    });
    return { orderId: res.order_id || res.success_response?.order_id, clientOrderId, productId, raw: res };
  }
  async getOrder(symbol, orderId) {
    const res = await this._request('GET', `/api/v3/brokerage/orders/historical/${orderId}`);
    return res.order || {};
  }
  async cancelOrder(symbol, orderId) {
    return this._request('POST', '/api/v3/brokerage/orders/batch_cancel', { order_ids: [orderId] });
  }
  async checkWithdrawalPermission() {
    const res = await this._request('GET', '/api/v3/brokerage/key_permissions');
    return {
      verifiable: true,
      withdrawalEnabled: !!res.can_transfer,
      detail: `Coinbase key_permissions.can_transfer=${!!res.can_transfer}`,
    };
  }
}

function getExchangeClient(exchange, apiKey, apiSecret, extra = {}) {
  switch (exchange) {
    case 'binance':
      return new BinanceClient(apiKey, apiSecret, { testnet: process.env.BINANCE_TESTNET === 'true' });
    case 'bybit':
      return new BybitClient(apiKey, apiSecret, { testnet: process.env.BYBIT_TESTNET === 'true' });
    case 'kraken':
      return new KrakenClient(apiKey, apiSecret, { sandbox: process.env.KRAKEN_SANDBOX === 'true' });
    case 'okx':
      return new OKXClient(apiKey, apiSecret, {
        passphrase: extra.passphrase || process.env.OKX_API_PASSPHRASE,
        testnet:    process.env.OKX_DEMO_TRADING === 'true',
      });
    case 'coinbase':
      return new CoinbaseClient(apiKey, apiSecret, { testnet: false });
    default:
      return null;
  }
}

const EXCHANGE_ENV_KEYS = {
  binance:  { key: 'BINANCE_API_KEY',  secret: 'BINANCE_API_SECRET' },
  bybit:    { key: 'BYBIT_API_KEY',    secret: 'BYBIT_API_SECRET' },
  kraken:   { key: 'KRAKEN_API_KEY',   secret: 'KRAKEN_API_SECRET' },
  okx:      { key: 'OKX_API_KEY',      secret: 'OKX_API_SECRET', passphrase: 'OKX_API_PASSPHRASE' },
  coinbase: { key: 'COINBASE_API_KEY', secret: 'COINBASE_API_SECRET' },
};

/**
 * _resolveCredentials — checkpoint-37: tries the user's OWN connected
 * exchange credentials first (userSecretsVault), falls back to the global
 * vault/env (secretsVault.getCredentials) exactly as before. Additive —
 * `source` on the return value is 'user' | 'vault' | 'env' for audit
 * logging (see credSource in executeLive / credentialSource in
 * executeCrossExchangeLive).
 */
async function _resolveCredentials(userId, exchange, envKeys) {
  const userCreds = await userSecretsVault.getUserCredentials(userId, exchange);
  if (userCreds && userCreds.apiKey && userCreds.apiSecret) {
    return {
      apiKey: userCreds.apiKey,
      apiSecret: userCreds.apiSecret,
      passphrase: userCreds.apiPassphrase || null,
      source: 'user',
    };
  }
  const globalCreds = secretsVault.getCredentials(exchange, envKeys);
  return {
    apiKey: globalCreds.apiKey,
    apiSecret: globalCreds.apiSecret,
    passphrase: null,
    source: globalCreds.source,
  };
}

const _auditLog = [];
const MAX_AUDIT = 500;

function _audit(entry) {
  _auditLog.unshift({ ...entry, ts: new Date().toISOString() });
  if (_auditLog.length > MAX_AUDIT) _auditLog.pop();
  logger.info('liveExecution', entry.event, entry);
}

function getAuditLog() { return [..._auditLog]; }

const _userModes = new Map();

function setUserMode(userId, mode) {
  if (!['paper', 'live'].includes(mode)) throw new Error('Invalid mode');
  if (mode === 'live' && !LIVE_ENABLED) {
    throw new Error('Live trading is disabled. Set LIVE_TRADING_ENABLED=true in environment.');
  }
  _userModes.set(userId, mode);
  _audit({ event: 'MODE_CHANGED', userId, mode });
}

function getUserMode(userId) {
  return _userModes.get(userId) || 'paper';
}

function resolveTrustedOpportunity(clientOpportunity) {
  const id = clientOpportunity && clientOpportunity.id;
  if (!id) {
    throw new Error('opportunity.id is required — cannot execute against an opportunity the server never detected');
  }
  const snapshot = opportunitySnapshotStore.getSnapshot(id, clientOpportunity.asset);
  if (!snapshot) {
    throw new Error(
      `Opportunity ${id} is unknown or expired (server keeps detected opportunities for ${opportunitySnapshotStore.TTL_MS}ms) — ` +
      `re-scan required. Client-supplied opportunity data is never trusted directly for live execution.`
    );
  }
  return { ...snapshot.op, _snapshotAgeMs: snapshot.ageMs };
}

async function preflightCheck(client, opportunity, amount) {
  const checks = { passed: true, errors: [] };

  try {
    const account = await client.getAccountInfo();
    if (!account.canTrade) {
      checks.errors.push('Account cannot trade (check API permissions)');
      checks.passed = false;
    }
  } catch (e) {
    checks.errors.push(`API key invalid: ${e.message}`);
    checks.passed = false;
    return checks;
  }

  try {
    const usdtBalance = await client.getBalance('USDT');
    const requiredUSDT = amount * (opportunity.buyPrice || opportunity.askPrice || 50000);
    if (usdtBalance < requiredUSDT * 1.02) {
      checks.errors.push(`Insufficient USDT balance: ${usdtBalance.toFixed(2)} < ${requiredUSDT.toFixed(2)} required`);
      checks.passed = false;
    }
  } catch (e) {
    checks.errors.push(`Balance check failed: ${e.message}`);
    checks.passed = false;
  }

  const ageMs = Date.now() - (opportunity.detectedAt || 0);
  if (ageMs > 2000) {
    checks.errors.push(`Opportunity stale (${ageMs}ms old, max 2000ms)`);
    checks.passed = false;
  }

  return checks;
}

async function _fetchRealCapitalUSD(clients, baseAsset, refPrice) {
  let usdt = 0;
  let base = 0;
  for (const client of clients) {
    if (!client) continue;
    try {
      usdt += await client.getBalance('USDT');
    } catch (e) { /* fail-safe: contributes 0 */ }
    try {
      base += await client.getBalance(baseAsset);
    } catch (e) { /* fail-safe: contributes 0 */ }
  }
  return usdt + base * refPrice;
}

async function _runInstitutionalRiskGate(opportunity, amount, userId, exchangesInvolved, clients = []) {
  const overrides = userRiskProfileService.getEffectiveConfig(userId);

  if (overrides.activeExchanges) {
    const allowedLower = overrides.activeExchanges.map(e => e.toLowerCase());
    const disallowed = exchangesInvolved.filter(ex => !allowedLower.includes(ex.toLowerCase()));
    if (disallowed.length > 0) {
      return `User risk profile restricts trading to [${overrides.activeExchanges.join(', ')}] — ${disallowed.join(', ')} not allowed`;
    }
  }

  const sessionPnl   = liveTradeLedger.getTodaysLivePnl();
  const refPrice     = opportunity.buyPrice || opportunity.askPrice || 50000;
  const baseAsset    = (opportunity.pair || 'BTC/USDT').split('/')[0] || 'BTC';
  const capitalUSD   = await _fetchRealCapitalUSD(clients, baseAsset, refPrice);

  const riskOpportunity = {
    buyPrice:    refPrice,
    tradeAmount: amount,
    slippagePct: opportunity.slippagePct || 0,
  };

  const riskCheck = advRisk.preTradeRiskCheck(riskOpportunity, {}, capitalUSD, sessionPnl, {
    maxPositionValueUSD: overrides.maxPositionValueUSD,
    maxDailyLossUSD:     overrides.maxDailyLossUSD,
    maxSlippagePct:      overrides.maxSlippagePct,
  });

  if (!riskCheck.ok) {
    return `Risk check failed: ${riskCheck.blockedBy}`;
  }
  return null;
}

/**
 * _requireUserLiveModeEnabled — checkpoint-37: gate on top of (never
 * instead of) the existing LIVE_ENABLED/user-mode==='live' gate. A user can
 * only reach real order placement if BOTH:
 *   1. The server permits live trading globally (LIVE_ENABLED, checked by
 *      the mode==='paper'/!LIVE_ENABLED branch at the top of executeLive/
 *      executeCrossExchangeLive — unchanged), AND
 *   2. THIS user explicitly activated live mode themselves via
 *      POST /api/user/live-mode (userLiveModeService.isLiveModeEnabled) —
 *      which itself required >=1 connected exchange, confirmed 2FA, and an
 *      explicit risk-disclaimer acceptance (see userLiveModeService.js and
 *      userExchangeCredentials.routes.js).
 * Rejects with a clear error rather than silently falling back to paper —
 * a user who flips getUserMode() to 'live' without ever completing the
 * activation flow must see a real rejection, not a trade that quietly no-ops.
 */
function _requireUserLiveModeEnabled(userId) {
  if (!userLiveModeService.isLiveModeEnabled(userId)) {
    throw new Error(
      'Live trading is not enabled for this account. Connect an exchange and enable ' +
      'real-money trading from Settings (requires 2FA confirmation and accepting the risk disclaimer) ' +
      'before executing live trades.'
    );
  }
}

async function executeLive(rawOpportunity, userId, amount) {
  const mode = getUserMode(userId);
  const tradeId = `live-${Date.now()}-${crypto.randomUUID()}`;

  if (mode === 'paper' || !LIVE_ENABLED) {
    _audit({ event: 'PAPER_EXECUTE', tradeId, userId, opportunity: rawOpportunity && rawOpportunity.id, amount, mode });
    return { ok: true, tradeId, mode: 'paper', simulated: true };
  }

  // checkpoint-37: per-user live-mode toggle gate — see doc comment above.
  try {
    _requireUserLiveModeEnabled(userId);
  } catch (e) {
    _audit({ event: 'LIVE_EXECUTE_FAILED', tradeId, userId, error: e.message });
    throw e;
  }

  let opportunity;
  try {
    opportunity = resolveTrustedOpportunity(rawOpportunity);
  } catch (e) {
    _audit({ event: 'OPPORTUNITY_REJECTED', tradeId, userId, opportunityId: rawOpportunity && rawOpportunity.id, error: e.message });
    throw e;
  }

  const exchange = (opportunity.buyExchange || 'binance').toLowerCase();
  const envKeys  = EXCHANGE_ENV_KEYS[exchange];
  if (!envKeys) {
    const err = `Exchange ${exchange} not supported for live execution`;
    _audit({ event: 'LIVE_EXECUTE_FAILED', tradeId, userId, error: err });
    throw new Error(err);
  }

  const { apiKey, apiSecret, passphrase, source: credSource } = await _resolveCredentials(userId, exchange, envKeys);
  if (!apiKey || !apiSecret) {
    const err = `${envKeys.key} and ${envKeys.secret} must be set for live trading on ${exchange} (or connect your own key via POST /api/user/exchange-credentials)`;
    _audit({ event: 'LIVE_EXECUTE_FAILED', tradeId, userId, error: err });
    throw new Error(err);
  }
  const okxPassphrase = passphrase || process.env[envKeys.passphrase];
  if (exchange === 'okx' && !okxPassphrase) {
    const err = `${envKeys.passphrase} must be set for live trading on okx (or include apiPassphrase when connecting your own key)`;
    _audit({ event: 'LIVE_EXECUTE_FAILED', tradeId, userId, error: err });
    throw new Error(err);
  }

  const client = getExchangeClient(exchange, apiKey, apiSecret, { passphrase: okxPassphrase });
  const testnet = process.env.BINANCE_TESTNET === 'true'
    || process.env.BYBIT_TESTNET === 'true'
    || process.env.KRAKEN_SANDBOX === 'true'
    || process.env.OKX_DEMO_TRADING === 'true';
  const symbol = (opportunity.pair || 'BTC/USDT').replace('/', '');

  exchangeRateLimiter.assertWithinLimit(exchange, 1);

  const preflight = await preflightCheck(client, opportunity, amount);
  if (!preflight.passed) {
    const err = `Pre-flight failed: ${preflight.errors.join('; ')}`;
    _audit({ event: 'PREFLIGHT_FAILED', tradeId, userId, errors: preflight.errors });
    throw new Error(err);
  }

  const riskBlockReason = await _runInstitutionalRiskGate(opportunity, amount, userId, [exchange], [client]);
  if (riskBlockReason) {
    _audit({ event: 'RISK_GATE_BLOCKED', tradeId, userId, exchange, reason: riskBlockReason });
    throw new Error(riskBlockReason);
  }

  _audit({ event: 'LIVE_EXECUTE_START', tradeId, userId, exchange, symbol, amount, testnet, credSource, opportunity: opportunity.id });

  try {
    exchangeRateLimiter.assertWithinLimit(exchange, 1);
    const buyOrder = await client.placeMarketOrder(symbol, 'BUY', amount);
    _audit({ event: 'BUY_ORDER_PLACED', tradeId, orderId: buyOrder.orderId, symbol, amount });

    await new Promise(r => setTimeout(r, 500));
    exchangeRateLimiter.assertWithinLimit(exchange, 1);
    const buyFill = await client.getOrder(symbol, buyOrder.orderId);

    if (buyFill.status !== 'FILLED') {
      await client.cancelOrder(symbol, buyOrder.orderId).catch(() => {});
      throw new Error(`Buy order not filled: ${buyFill.status}`);
    }

    const fillPrice  = parseFloat(buyFill.cummulativeQuoteQty) / parseFloat(buyFill.executedQty);
    const fillQty    = parseFloat(buyFill.executedQty);
    const netProfit  = (opportunity.profit || 0) * fillQty;

    _audit({
      event: 'LIVE_EXECUTE_SUCCESS',
      tradeId,
      userId,
      symbol,
      fillPrice,
      fillQty,
      netProfit,
      orderId: buyOrder.orderId,
    });

    liveTradeLedger.recordLiveFill(netProfit);
    _recordRealizedSlippageBias(exchange, 'BUY', opportunity.buyPrice || opportunity.askPrice, fillPrice);

    alertWebhookService
      .alertTradeExecuted({ id: tradeId, buyExchange: exchange, sellExchange: exchange, amount, netProfit, buyPrice: fillPrice, sellPrice: fillPrice, totalFees: 0, slippage: 0 })
      .catch(() => {});

    return {
      ok: true,
      tradeId,
      mode: 'live',
      simulated: false,
      orderId: buyOrder.orderId,
      fillPrice,
      fillQty,
      netProfit,
    };
  } catch (e) {
    _audit({ event: 'LIVE_EXECUTE_FAILED', tradeId, userId, error: e.message });
    throw e;
  }
}

async function testExchangeConnection(exchange, apiKey, apiSecret, apiPassphrase) {
  const client = getExchangeClient(exchange, apiKey, apiSecret, { passphrase: apiPassphrase });
  if (!client) {
    return { ok: false, error: `Exchange ${exchange} not supported yet` };
  }
  if (exchange === 'okx' && !apiPassphrase && !process.env.OKX_API_PASSPHRASE) {
    return { ok: false, error: 'OKX requires apiPassphrase (the third credential set when the API key was created)' };
  }

  const sandboxFlag = exchange === 'binance' ? process.env.BINANCE_TESTNET === 'true'
    : exchange === 'bybit'   ? process.env.BYBIT_TESTNET === 'true'
    : exchange === 'kraken'  ? process.env.KRAKEN_SANDBOX === 'true'
    : exchange === 'okx'     ? process.env.OKX_DEMO_TRADING === 'true'
    : false;

  try {
    const account = await client.getAccountInfo();
    const result = {
      ok: true,
      canTrade: account.canTrade,
      balances: account.balances
        ?.filter(b => parseFloat(b.free) > 0)
        ?.map(b => ({ asset: b.asset, free: parseFloat(b.free) }))
        ?.slice(0, 10),
    };
    result.testnet = sandboxFlag;
    return result;
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * checkWithdrawalPermission — checkpoint-37: thin wrapper exposing each
 * client's checkWithdrawalPermission() to the routes layer, so
 * userExchangeCredentials.routes.js doesn't need to know about the five
 * concrete client classes. Returns the same { verifiable, withdrawalEnabled,
 * detail } shape every client implements — see each class's own doc
 * comment above for exchange-specific caveats (Kraken is always
 * verifiable:false; Bybit is a documented heuristic).
 */
async function checkWithdrawalPermission(exchange, apiKey, apiSecret, apiPassphrase) {
  const client = getExchangeClient(exchange, apiKey, apiSecret, { passphrase: apiPassphrase });
  if (!client) throw new Error(`Exchange ${exchange} not supported yet`);
  return client.checkWithdrawalPermission();
}

function _normalizeOrderStatus(exchange, status) {
  if (exchange === 'bybit') {
    const filled    = status.orderStatus === 'Filled';
    const fillQty   = parseFloat(status.cumExecQty || '0');
    const fillPrice = parseFloat(status.avgPrice || '0');
    return { filled, fillPrice, fillQty, rawStatus: status.orderStatus };
  }
  if (exchange === 'kraken') {
    const filled    = status.status === 'closed';
    const fillQty   = parseFloat(status.vol_exec || '0');
    const cost      = parseFloat(status.cost || '0');
    const fillPrice = fillQty > 0 ? cost / fillQty : 0;
    return { filled, fillPrice, fillQty, rawStatus: status.status };
  }
  if (exchange === 'okx') {
    const filled    = status.state === 'filled';
    const fillQty   = parseFloat(status.accFillSz || '0');
    const fillPrice = parseFloat(status.avgPx || '0');
    return { filled, fillPrice, fillQty, rawStatus: status.state };
  }
  if (exchange === 'coinbase') {
    const filled    = status.status === 'FILLED';
    const fillQty   = parseFloat(status.filled_size || '0');
    const fillPrice = parseFloat(status.average_filled_price || '0');
    return { filled, fillPrice, fillQty, rawStatus: status.status };
  }
  const filled    = status.status === 'FILLED';
  const fillQty   = parseFloat(status.executedQty || '0');
  const fillPrice = fillQty > 0 ? parseFloat(status.cummulativeQuoteQty || '0') / fillQty : 0;
  return { filled, fillPrice, fillQty, rawStatus: status.status };
}

async function preflightSellSide(client, opportunity, amount, baseAsset = 'BTC') {
  const checks = { passed: true, errors: [] };
  try {
    const account = await client.getAccountInfo();
    if (!account.canTrade) {
      checks.errors.push('Sell-side account cannot trade (check API permissions)');
      checks.passed = false;
    }
  } catch (e) {
    checks.errors.push(`Sell-side API key invalid: ${e.message}`);
    checks.passed = false;
    return checks;
  }

  try {
    const baseBalance = await client.getBalance(baseAsset);
    if (baseBalance < amount * 1.001) {
      checks.errors.push(`Insufficient ${baseAsset} balance on sell exchange: ${baseBalance} < ${amount} required`);
      checks.passed = false;
    }
  } catch (e) {
    checks.errors.push(`Sell-side balance check failed: ${e.message}`);
    checks.passed = false;
  }

  const ageMs = Date.now() - (opportunity.detectedAt || 0);
  if (ageMs > 2000) {
    checks.errors.push(`Opportunity stale (${ageMs}ms old, max 2000ms)`);
    checks.passed = false;
  }

  return checks;
}

async function _placeAndConfirm(exchange, client, symbol, side, amount, tradeId, legLabel, opts = {}) {
  try {
    exchangeRateLimiter.assertWithinLimit(exchange, 1);

    let routeDecision = { type: 'MARKET', price: null, reason: 'no referencePrice supplied — plain market order' };
    if (opts.referencePrice) {
      routeDecision = smartOrderRouter.decideOrderType(side, opts.referencePrice, { urgent: opts.urgent });
    }

    const order = await client.placeOrder(symbol, side, amount, { type: routeDecision.type, price: routeDecision.price });
    const orderId = order.orderId || order.orderLinkId || order.id;
    _audit({
      event: `LEG_${legLabel}_SENT`, tradeId, exchange, symbol, side, amount, orderId,
      orderType: routeDecision.type, limitPrice: routeDecision.price, routeReason: routeDecision.reason,
    });

    await new Promise(r => setTimeout(r, 500));
    exchangeRateLimiter.assertWithinLimit(exchange, 1);
    const status = await client.getOrder(symbol, orderId);
    const norm = _normalizeOrderStatus(exchange, status);

    if (!norm.filled) {
      await client.cancelOrder(symbol, orderId).catch(() => {});

      if (norm.fillQty > 0) {
        const fillRatio = norm.fillQty / amount;
        const tier = tradeStateMachine.classifyFillTier(fillRatio);
        _audit({
          event: `LEG_${legLabel}_PARTIAL_FILL`, tradeId, exchange, symbol, orderId,
          fillQty: norm.fillQty, fillPrice: norm.fillPrice, requestedAmount: amount,
          fillRatio: +fillRatio.toFixed(4), tier, rawStatus: norm.rawStatus,
        });
        return {
          filled: false, partial: true, orderId,
          fillQty: norm.fillQty, fillPrice: norm.fillPrice, fillRatio, tier,
          error: `${legLabel} order partially filled (${(fillRatio * 100).toFixed(1)}%, tier=${tier}): ${norm.rawStatus}`,
        };
      }

      _audit({ event: `LEG_${legLabel}_TIMEOUT`, tradeId, exchange, symbol, orderId, rawStatus: norm.rawStatus });
      return { filled: false, orderId, error: `${legLabel} order not filled: ${norm.rawStatus}` };
    }

    _audit({ event: `LEG_${legLabel}_CONFIRMED`, tradeId, exchange, symbol, orderId, fillPrice: norm.fillPrice, fillQty: norm.fillQty });
    return { filled: true, orderId, fillPrice: norm.fillPrice, fillQty: norm.fillQty };
  } catch (e) {
    _audit({ event: `LEG_${legLabel}_ERROR`, tradeId, exchange, symbol, error: e.message });
    return { filled: false, error: e.message };
  }
}

async function _emergencyFlatten(exchange, client, symbol, qty, tradeId, closeSide) {
  try {
    const order = await client.placeMarketOrder(symbol, closeSide, qty);
    const orderId = order.orderId || order.orderLinkId || order.id;
    _audit({ event: 'CLOSE_NOW_SENT', tradeId, exchange, symbol, side: closeSide, qty, orderId });
    return { ok: true, orderId };
  } catch (e) {
    _audit({ event: 'CLOSE_NOW_FAILED', tradeId, exchange, symbol, side: closeSide, qty, error: e.message });
    return { ok: false, error: e.message };
  }
}

async function executeCrossExchangeLive(rawOpportunity, userId, amount) {
  const mode = getUserMode(userId);
  const tradeId = `xlive-${Date.now()}-${crypto.randomUUID()}`;

  if (mode === 'paper' || !LIVE_ENABLED) {
    _audit({ event: 'PAPER_EXECUTE_CROSS', tradeId, userId, opportunity: rawOpportunity && rawOpportunity.id, amount, mode });
    return { ok: true, tradeId, mode: 'paper', simulated: true };
  }

  // checkpoint-37: per-user live-mode toggle gate — see doc comment above
  // executeLive().
  try {
    _requireUserLiveModeEnabled(userId);
  } catch (e) {
    _audit({ event: 'CROSS_EXECUTE_FAILED', tradeId, userId, error: e.message });
    throw e;
  }

  let opportunity;
  try {
    opportunity = resolveTrustedOpportunity(rawOpportunity);
  } catch (e) {
    _audit({ event: 'OPPORTUNITY_REJECTED', tradeId, userId, opportunityId: rawOpportunity && rawOpportunity.id, error: e.message });
    throw e;
  }

  const buyExchange  = (opportunity.buyExchange  || '').toLowerCase();
  const sellExchange = (opportunity.sellExchange || '').toLowerCase();

  if (!buyExchange || !sellExchange) {
    const err = 'opportunity.buyExchange and opportunity.sellExchange are both required for cross-exchange execution';
    _audit({ event: 'CROSS_EXECUTE_FAILED', tradeId, userId, error: err });
    throw new Error(err);
  }
  if (buyExchange === sellExchange) {
    const err = 'buyExchange and sellExchange must differ for cross-exchange execution';
    _audit({ event: 'CROSS_EXECUTE_FAILED', tradeId, userId, error: err });
    throw new Error(err);
  }

  const buyEnvKeys  = EXCHANGE_ENV_KEYS[buyExchange];
  const sellEnvKeys = EXCHANGE_ENV_KEYS[sellExchange];
  if (!buyEnvKeys || !sellEnvKeys) {
    const err = `Exchange pair ${buyExchange}/${sellExchange} not fully supported for live execution`;
    _audit({ event: 'CROSS_EXECUTE_FAILED', tradeId, userId, error: err });
    throw new Error(err);
  }

  const buyCreds  = await _resolveCredentials(userId, buyExchange, buyEnvKeys);
  const sellCreds = await _resolveCredentials(userId, sellExchange, sellEnvKeys);
  const buyApiKey     = buyCreds.apiKey;
  const buyApiSecret  = buyCreds.apiSecret;
  const sellApiKey    = sellCreds.apiKey;
  const sellApiSecret = sellCreds.apiSecret;
  if (!buyApiKey || !buyApiSecret) {
    const err = `${buyEnvKeys.key} and ${buyEnvKeys.secret} must be set for live trading on ${buyExchange} (or connect your own key via POST /api/user/exchange-credentials)`;
    _audit({ event: 'CROSS_EXECUTE_FAILED', tradeId, userId, error: err });
    throw new Error(err);
  }
  if (!sellApiKey || !sellApiSecret) {
    const err = `${sellEnvKeys.key} and ${sellEnvKeys.secret} must be set for live trading on ${sellExchange} (or connect your own key via POST /api/user/exchange-credentials)`;
    _audit({ event: 'CROSS_EXECUTE_FAILED', tradeId, userId, error: err });
    throw new Error(err);
  }
  const buyOkxPassphrase  = buyCreds.passphrase  || process.env[buyEnvKeys.passphrase];
  const sellOkxPassphrase = sellCreds.passphrase || process.env[sellEnvKeys.passphrase];
  if (buyExchange === 'okx' && !buyOkxPassphrase) {
    const err = `${buyEnvKeys.passphrase} must be set for live trading on okx (or include apiPassphrase when connecting your own key)`;
    _audit({ event: 'CROSS_EXECUTE_FAILED', tradeId, userId, error: err });
    throw new Error(err);
  }
  if (sellExchange === 'okx' && !sellOkxPassphrase) {
    const err = `${sellEnvKeys.passphrase} must be set for live trading on okx (or include apiPassphrase when connecting your own key)`;
    _audit({ event: 'CROSS_EXECUTE_FAILED', tradeId, userId, error: err });
    throw new Error(err);
  }

  const buyClient  = getExchangeClient(buyExchange, buyApiKey, buyApiSecret, { passphrase: buyOkxPassphrase });
  const sellClient = getExchangeClient(sellExchange, sellApiKey, sellApiSecret, { passphrase: sellOkxPassphrase });

  const rawPair = (opportunity.pair || 'BTC/USDT');
  const candidate = rawPair.replace('/', '').split(/[→\s]/)[0];
  const symbol = /^[A-Z]{2,10}(USDT|USD|BTC|EUR)$/i.test(candidate) ? candidate.toUpperCase() : 'BTCUSDT';
  const baseAsset = symbol.replace(/(USDT|USD|EUR)$/, '') || 'BTC';

  const [buyPreflight, sellPreflight] = await Promise.all([
    preflightCheck(buyClient, opportunity, amount),
    preflightSellSide(sellClient, opportunity, amount, baseAsset),
  ]);
  if (!buyPreflight.passed || !sellPreflight.passed) {
    const errors = [...buyPreflight.errors, ...sellPreflight.errors];
    const err = `Pre-flight failed: ${errors.join('; ')}`;
    _audit({ event: 'CROSS_PREFLIGHT_FAILED', tradeId, userId, buyExchange, sellExchange, errors });
    throw new Error(err);
  }

  const riskBlockReason = await _runInstitutionalRiskGate(opportunity, amount, userId, [buyExchange, sellExchange], [buyClient, sellClient]);
  if (riskBlockReason) {
    _audit({ event: 'CROSS_RISK_GATE_BLOCKED', tradeId, userId, buyExchange, sellExchange, reason: riskBlockReason });
    throw new Error(riskBlockReason);
  }

  _audit({ event: 'CROSS_EXECUTE_START', tradeId, userId, buyExchange, sellExchange, symbol, amount, opportunity: opportunity.id, credentialSource: { buy: buyCreds.source, sell: sellCreds.source } });

  await persistenceService.markPendingExecution({
    tradeId, userId, buyExchange, sellExchange, symbol, amount, opportunityId: opportunity.id,
  });

  const buyReferencePrice  = opportunity.buyPrice  || opportunity.askPrice || null;
  const sellReferencePrice = opportunity.sellPrice || opportunity.bidPrice || null;

  try {
    const [buyOutcome, sellOutcome] = await Promise.all([
      _placeAndConfirm(buyExchange,  buyClient,  symbol, 'BUY',  amount, tradeId, 'BUY',  { referencePrice: buyReferencePrice,  urgent: true }),
      _placeAndConfirm(sellExchange, sellClient, symbol, 'SELL', amount, tradeId, 'SELL', { referencePrice: sellReferencePrice, urgent: true }),
    ]);

  if (buyOutcome.filled && sellOutcome.filled) {
    const fillQty = Math.min(buyOutcome.fillQty, sellOutcome.fillQty);
    const grossProfit = (sellOutcome.fillPrice - buyOutcome.fillPrice) * fillQty;
    _audit({
      event: 'CROSS_EXECUTE_SUCCESS', tradeId, userId, buyExchange, sellExchange, symbol,
      buyFillPrice: buyOutcome.fillPrice, sellFillPrice: sellOutcome.fillPrice, fillQty, grossProfit,
    });
    liveTradeLedger.recordLiveFill(grossProfit);
    _recordRealizedSlippageBias(buyExchange, 'BUY', buyReferencePrice, buyOutcome.fillPrice);
    _recordRealizedSlippageBias(sellExchange, 'SELL', sellReferencePrice, sellOutcome.fillPrice);
    alertWebhookService
      .alertTradeExecuted({ id: tradeId, buyExchange, sellExchange, amount: fillQty, netProfit: grossProfit, buyPrice: buyOutcome.fillPrice, sellPrice: sellOutcome.fillPrice, totalFees: 0, slippage: 0 })
      .catch(() => {});
    return {
      ok: true, tradeId, mode: 'live', simulated: false,
      buyExchange, sellExchange, symbol,
      buyOrderId: buyOutcome.orderId, sellOrderId: sellOutcome.orderId,
      buyFillPrice: buyOutcome.fillPrice, sellFillPrice: sellOutcome.fillPrice,
      fillQty, grossProfit,
    };
  }

  const buyQty  = buyOutcome.fillQty  || 0;
  const sellQty = sellOutcome.fillQty || 0;

  if (buyQty === 0 && sellQty === 0) {
    const err = `Cross-exchange execution failed on both legs: buy=${buyOutcome.error}; sell=${sellOutcome.error}`;
    _audit({ event: 'CROSS_EXECUTE_FAILED', tradeId, userId, buyExchange, sellExchange, error: err });
    throw new Error(err);
  }

  const netQty = +(buyQty - sellQty).toFixed(8);

  if (Math.abs(netQty) < 1e-8) {
    const fillQty = buyQty;
    const grossProfit = (sellOutcome.fillPrice - buyOutcome.fillPrice) * fillQty;
    const tier = tradeStateMachine.classifyFillTier(fillQty / amount);
    _audit({
      event: 'CROSS_EXECUTE_SUCCESS_PARTIAL', tradeId, userId, buyExchange, sellExchange, symbol,
      buyFillPrice: buyOutcome.fillPrice, sellFillPrice: sellOutcome.fillPrice, fillQty, grossProfit, tier,
    });
    liveTradeLedger.recordLiveFill(grossProfit);
    _recordRealizedSlippageBias(buyExchange, 'BUY', buyReferencePrice, buyOutcome.fillPrice);
    _recordRealizedSlippageBias(sellExchange, 'SELL', sellReferencePrice, sellOutcome.fillPrice);
    alertWebhookService
      .alertTradeExecuted({ id: tradeId, buyExchange, sellExchange, amount: fillQty, netProfit: grossProfit, buyPrice: buyOutcome.fillPrice, sellPrice: sellOutcome.fillPrice, totalFees: 0, slippage: 0 })
      .catch(() => {});
    return {
      ok: true, tradeId, mode: 'live', simulated: false, partialTier: tier,
      buyExchange, sellExchange, symbol,
      buyOrderId: buyOutcome.orderId, sellOrderId: sellOutcome.orderId,
      buyFillPrice: buyOutcome.fillPrice, sellFillPrice: sellOutcome.fillPrice,
      fillQty, grossProfit,
    };
  }

  if (netQty > 0) {
    const incompleteRatio = amount > 0 ? sellQty / amount : 0;
    const tier = tradeStateMachine.classifyFillTier(incompleteRatio);

    if (tier === 'mid' && sellOutcome.partial) {
      const completion = await _placeAndConfirm(sellExchange, sellClient, symbol, 'SELL', netQty, tradeId, 'SELL_RESIDUAL', { referencePrice: sellOutcome.fillPrice, urgent: true });
      if (completion.filled) {
        const blendedSellPrice = (sellOutcome.fillPrice * sellQty + completion.fillPrice * completion.fillQty) / (sellQty + completion.fillQty);
        const fillQty = buyQty;
        const grossProfit = (blendedSellPrice - buyOutcome.fillPrice) * fillQty;
        _audit({ event: 'CROSS_RESIDUAL_COMPLETED', tradeId, userId, exchange: sellExchange, qty: netQty, tier });
        liveTradeLedger.recordLiveFill(grossProfit);
        _recordRealizedSlippageBias(buyExchange, 'BUY', buyReferencePrice, buyOutcome.fillPrice);
        _recordRealizedSlippageBias(sellExchange, 'SELL', sellReferencePrice, blendedSellPrice);
        alertWebhookService
          .alertTradeExecuted({ id: tradeId, buyExchange, sellExchange, amount: fillQty, netProfit: grossProfit, buyPrice: buyOutcome.fillPrice, sellPrice: blendedSellPrice, totalFees: 0, slippage: 0 })
          .catch(() => {});
        return {
          ok: true, tradeId, mode: 'live', simulated: false, partialTier: tier, residualCompleted: true,
          buyExchange, sellExchange, symbol,
          buyOrderId: buyOutcome.orderId, sellOrderId: sellOutcome.orderId,
          buyFillPrice: buyOutcome.fillPrice, sellFillPrice: blendedSellPrice,
          fillQty, grossProfit,
        };
      }
    }

    _audit({ event: 'INCOMPLETE_LEG_DETECTED', tradeId, userId, openLeg: 'buy', exchange: buyExchange, qty: netQty, tier, sellError: sellOutcome.error });
    _logRecoveryClassification('buy_succeeded_sell_failed', { retryCount: 0, residualUSD: netQty * (buyOutcome.fillPrice || 0) }, tradeId);
    const recovery = await _emergencyFlatten(buyExchange, buyClient, symbol, netQty, tradeId, 'SELL');
    _audit({ event: recovery.ok ? 'CROSS_PARTIAL_RECOVERED' : 'CROSS_PARTIAL_UNRECOVERED', tradeId, userId, recovery, tier });
    alertWebhookService
      .alertLivePartialFailure({ tradeId, filledExchange: buyExchange, failedExchange: sellExchange, qty: netQty, recovered: recovery.ok, manualInterventionRequired: !recovery.ok })
      .catch(() => {});
    const err = new Error(
      `Sell leg on ${sellExchange} failed (${sellOutcome.error}); buy leg on ${buyExchange} residual (${netQty}) was flattened ` +
      `${recovery.ok ? 'successfully' : '— FAILED, MANUAL INTERVENTION REQUIRED'}.`
    );
    err.partial = true;
    err.recovery = recovery;
    err.tier = tier;
    throw err;
  }

  const residualQty = Math.abs(netQty);
  const incompleteRatio = amount > 0 ? buyQty / amount : 0;
  const tier = tradeStateMachine.classifyFillTier(incompleteRatio);

  if (tier === 'mid' && buyOutcome.partial) {
    const completion = await _placeAndConfirm(buyExchange, buyClient, symbol, 'BUY', residualQty, tradeId, 'BUY_RESIDUAL', { referencePrice: buyOutcome.fillPrice, urgent: true });
    if (completion.filled) {
      const blendedBuyPrice = (buyOutcome.fillPrice * buyQty + completion.fillPrice * completion.fillQty) / (buyQty + completion.fillQty);
      const fillQty = sellQty;
      const grossProfit = (sellOutcome.fillPrice - blendedBuyPrice) * fillQty;
      _audit({ event: 'CROSS_RESIDUAL_COMPLETED', tradeId, userId, exchange: buyExchange, qty: residualQty, tier });
      liveTradeLedger.recordLiveFill(grossProfit);
      _recordRealizedSlippageBias(buyExchange, 'BUY', buyReferencePrice, blendedBuyPrice);
      _recordRealizedSlippageBias(sellExchange, 'SELL', sellReferencePrice, sellOutcome.fillPrice);
      alertWebhookService
        .alertTradeExecuted({ id: tradeId, buyExchange, sellExchange, amount: fillQty, netProfit: grossProfit, buyPrice: blendedBuyPrice, sellPrice: sellOutcome.fillPrice, totalFees: 0, slippage: 0 })
        .catch(() => {});
      return {
        ok: true, tradeId, mode: 'live', simulated: false, partialTier: tier, residualCompleted: true,
        buyExchange, sellExchange, symbol,
        buyOrderId: buyOutcome.orderId, sellOrderId: sellOutcome.orderId,
        buyFillPrice: blendedBuyPrice, sellFillPrice: sellOutcome.fillPrice,
        fillQty, grossProfit,
      };
    }
  }

  _audit({ event: 'INCOMPLETE_LEG_DETECTED', tradeId, userId, openLeg: 'sell', exchange: sellExchange, qty: residualQty, tier, buyError: buyOutcome.error });
  _logRecoveryClassification('sell_succeeded_buy_failed', { retryCount: 0, residualUSD: residualQty * (sellOutcome.fillPrice || 0) }, tradeId);
  const recovery = await _emergencyFlatten(sellExchange, sellClient, symbol, residualQty, tradeId, 'BUY');
  _audit({ event: recovery.ok ? 'CROSS_PARTIAL_RECOVERED' : 'CROSS_PARTIAL_UNRECOVERED', tradeId, userId, recovery, tier });
  alertWebhookService
    .alertLivePartialFailure({ tradeId, filledExchange: sellExchange, failedExchange: buyExchange, qty: residualQty, recovered: recovery.ok, manualInterventionRequired: !recovery.ok })
    .catch(() => {});
  const err = new Error(
    `Buy leg on ${buyExchange} failed (${buyOutcome.error}); sell leg on ${sellExchange} residual (${residualQty}) was covered ` +
    `${recovery.ok ? 'successfully' : '— FAILED, MANUAL INTERVENTION REQUIRED'}.`
  );
  err.partial = true;
  err.recovery = recovery;
  err.tier = tier;
  throw err;
  } finally {
    await persistenceService.resolvePendingExecution(tradeId).catch(() => {});
  }
}

module.exports = {
  executeLive,
  executeCrossExchangeLive,
  setUserMode,
  getUserMode,
  getAuditLog,
  testExchangeConnection,
  checkWithdrawalPermission,
  getExchangeClient,
  getExchangeRateLimitStatus: exchangeRateLimiter.getStatus,
  EXCHANGE_ENV_KEYS,
  LIVE_ENABLED,
  BinanceClient,
  BybitClient,
  KrakenClient,
  OKXClient,
  CoinbaseClient,
  ExchangeClientBase,
  _runInstitutionalRiskGate,
  resolveTrustedOpportunity,
  _opportunitySnapshotStore: opportunitySnapshotStore,
  _liveTradeLedger: liveTradeLedger,
  _recordRealizedSlippageBias,
  _resolveCredentials,
};
