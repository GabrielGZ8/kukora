'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_LIMIT = exports.DEFAULT_LIMIT = void 0;
exports.validateAlertCreate = validateAlertCreate;
exports.validateAlertUpdate = validateAlertUpdate;
exports.validateWatchlistSave = validateWatchlistSave;
exports.validatePortfolioCreate = validatePortfolioCreate;
exports.parsePagination = parsePagination;
exports.validateArbitrageConfig = validateArbitrageConfig;
/**
 * validation.ts — Manual input validation for persistence endpoints (audit fix 1.1)
 *
 * Deliberately dependency-free (no Joi/Zod/express-validator): the
 * validation surface here is small and stable (alerts, watchlist,
 * portfolio), and a hand-rolled validator keeps the dependency list
 * honest. If the schema surface grows substantially, revisit.
 *
 * Each validate* function returns either:
 *   { valid: true,  value: <cleaned input> }
 *   { valid: false, error: <string message> }
 *
 * Cleaned input means: only known fields are passed through, strings are
 * trimmed, and numbers are coerced/range-checked. Nothing the request body
 * carries is trusted to reach MongoDB unexamined.
 *
 * MIGRATION NOTE (audit 1.1): originally compiled to server/validation.js.
 *
 * RELOCATION NOTE (Nivel 2 #1 bounded-context reorg, round 11): this file
 * moved from server-types/server/validation.ts to
 * server-types/server/domain/validation.ts so it now compiles to
 * server/domain/validation.js instead. server/validation.js is now a
 * backward-compatible re-export shim (require('./domain/validation')) —
 * see that file. Never edit server/domain/validation.js directly — it is
 * a generated build artifact; edit this file and run `tsc`.
 */
const MAX_STRING_LEN = 200;
const MAX_COINS = 200;
function isFiniteNumber(n) {
    return typeof n === 'number' && Number.isFinite(n);
}
function cleanString(v, maxLen = MAX_STRING_LEN) {
    if (typeof v !== 'string')
        return null;
    const trimmed = v.trim();
    if (!trimmed.length || trimmed.length > maxLen)
        return null;
    return trimmed;
}
function validateAlertCreate(body) {
    if (!body || typeof body !== 'object')
        return { valid: false, error: 'Request body must be an object' };
    const coinId = cleanString(body.coinId, 100);
    if (!coinId)
        return { valid: false, error: 'coinId is required (1-100 chars)' };
    const coinName = cleanString(body.coinName, 100);
    if (!coinName)
        return { valid: false, error: 'coinName is required (1-100 chars)' };
    if (body.condition !== 'above' && body.condition !== 'below') {
        return { valid: false, error: "condition must be 'above' or 'below'" };
    }
    if (!isFiniteNumber(body.price) || body.price <= 0 || body.price > 1e12) {
        return { valid: false, error: 'price must be a positive finite number' };
    }
    return {
        valid: true,
        value: { coinId, coinName, condition: body.condition, price: body.price },
    };
}
function validateAlertUpdate(body) {
    if (!body || typeof body !== 'object')
        return { valid: false, error: 'Request body must be an object' };
    const value = {};
    if (body.condition !== undefined) {
        if (body.condition !== 'above' && body.condition !== 'below') {
            return { valid: false, error: "condition must be 'above' or 'below'" };
        }
        value.condition = body.condition;
    }
    if (body.price !== undefined) {
        if (!isFiniteNumber(body.price) || body.price <= 0 || body.price > 1e12) {
            return { valid: false, error: 'price must be a positive finite number' };
        }
        value.price = body.price;
    }
    if (body.triggered !== undefined) {
        value.triggered = Boolean(body.triggered);
    }
    return { valid: true, value };
}
function validateWatchlistSave(body) {
    if (!body || typeof body !== 'object')
        return { valid: false, error: 'Request body must be an object' };
    if (!Array.isArray(body.coins))
        return { valid: false, error: 'coins must be an array' };
    if (body.coins.length > MAX_COINS)
        return { valid: false, error: `coins cannot exceed ${MAX_COINS} entries` };
    const coins = [];
    for (const c of body.coins) {
        const clean = cleanString(c, 100);
        if (!clean)
            return { valid: false, error: 'Each coin id must be a non-empty string (max 100 chars)' };
        coins.push(clean);
    }
    return { valid: true, value: { coins } };
}
function validatePortfolioCreate(body) {
    if (!body || typeof body !== 'object')
        return { valid: false, error: 'Request body must be an object' };
    const coinId = cleanString(body.coinId, 100);
    if (!coinId)
        return { valid: false, error: 'coinId is required (1-100 chars)' };
    const coinName = cleanString(body.coinName, 100);
    if (!coinName)
        return { valid: false, error: 'coinName is required (1-100 chars)' };
    const symbol = cleanString(body.symbol, 20);
    if (!symbol)
        return { valid: false, error: 'symbol is required (1-20 chars)' };
    const image = body.image !== undefined ? cleanString(body.image, 500) : undefined;
    if (body.image !== undefined && !image) {
        return { valid: false, error: 'image must be a string (max 500 chars) when provided' };
    }
    if (!isFiniteNumber(body.quantity) || body.quantity <= 0 || body.quantity > 1e9) {
        return { valid: false, error: 'quantity must be a positive finite number' };
    }
    if (!isFiniteNumber(body.entryPrice) || body.entryPrice <= 0 || body.entryPrice > 1e12) {
        return { valid: false, error: 'entryPrice must be a positive finite number' };
    }
    const value = { coinId, coinName, symbol, quantity: body.quantity, entryPrice: body.entryPrice };
    if (image)
        value.image = image;
    if (body.entryDate !== undefined) {
        const d = new Date(body.entryDate);
        if (Number.isNaN(d.getTime()))
            return { valid: false, error: 'entryDate must be a valid date' };
        value.entryDate = d;
    }
    return { valid: true, value };
}
// ─── Pagination ────────────────────────────────────────────────────────────
exports.DEFAULT_LIMIT = 50;
exports.MAX_LIMIT = 200;
function parsePagination(query) {
    let limit = parseInt(query.limit, 10);
    let offset = parseInt(query.offset, 10);
    if (!Number.isFinite(limit) || limit <= 0)
        limit = exports.DEFAULT_LIMIT;
    if (limit > exports.MAX_LIMIT)
        limit = exports.MAX_LIMIT;
    if (!Number.isFinite(offset) || offset < 0)
        offset = 0;
    return { limit, offset };
}
const RISK_SAFETY_FLOORS = {
    maxDailyLossUSD: { min: -100000, max: -1, desc: 'must be negative (e.g. -500)' },
    maxDrawdownPct: { min: 0.5, max: 100, desc: 'must be between 0.5 and 100' },
    maxConsecutiveFailures: { min: 1, max: 50, desc: 'must be between 1 and 50' },
    emergencyStopThreshold: { min: -1000000, max: -1, desc: 'must be negative' },
    maxWeeklyLossUSD: { min: -1000000, max: -1, desc: 'must be negative (e.g. -2000)' },
    tradeAmountBTC: { min: 0.001, max: 0.5, desc: 'must be between 0.001 and 0.5 BTC' },
};
function validateArbitrageConfig(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return { valid: false, error: 'Request body must be a non-null object' };
    }
    const keys = Object.keys(body);
    if (keys.length === 0) {
        return { valid: false, error: 'Request body must contain at least one parameter to update' };
    }
    for (const [key, floor] of Object.entries(RISK_SAFETY_FLOORS)) {
        if (body[key] === undefined)
            continue;
        const v = Number(body[key]);
        if (!Number.isFinite(v)) {
            return { valid: false, error: `${key}: ${floor.desc} (received: ${JSON.stringify(body[key])})` };
        }
        if (v < floor.min || v > floor.max) {
            return { valid: false, error: `${key}: out of safe range [${floor.min}, ${floor.max}] — ${floor.desc}` };
        }
    }
    if (body.activeExchanges !== undefined) {
        if (!Array.isArray(body.activeExchanges) || body.activeExchanges.length === 0) {
            return { valid: false, error: 'activeExchanges must be a non-empty array of exchange names' };
        }
    }
    if (body.scoringWeights !== undefined) {
        if (typeof body.scoringWeights !== 'object' || body.scoringWeights === null) {
            return { valid: false, error: 'scoringWeights must be an object' };
        }
        const total = Object.values(body.scoringWeights)
            .reduce((s, v) => s + (Number(v) || 0), 0);
        if (Math.abs(total - 1.0) > 0.01) {
            return { valid: false, error: `scoringWeights must sum to 1.0 (got ${total.toFixed(3)})` };
        }
    }
    if (body.feeMode !== undefined && !['taker', 'maker'].includes(body.feeMode)) {
        return { valid: false, error: "feeMode must be 'taker' or 'maker'" };
    }
    if (body.capitalAllocationMode !== undefined && !['equal', 'weighted', 'dynamic'].includes(body.capitalAllocationMode)) {
        return { valid: false, error: "capitalAllocationMode must be 'equal', 'weighted', or 'dynamic'" };
    }
    if (body.tradingMode !== undefined) {
        return { valid: false, error: 'tradingMode is read-only — set via LIVE_TRADING_ENABLED / DEMO_MODE environment variables' };
    }
    return { valid: true, value: body };
}
