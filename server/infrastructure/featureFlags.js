/**
 * featureFlags.js — Kukora Feature Flag Framework
 *
 * Distinct from liveConfig.js on purpose: liveConfig holds *continuous
 * trading parameters* (thresholds, weights, fee assumptions) that traders
 * tune. Feature flags are *binary/enum toggles for code paths* — kill
 * switches, gradual rollouts, and per-tenant enablement — the kind of
 * control an SRE reaches for at 2am, or a PM reaches for to roll a new
 * engine out to 10% of tenants before flipping it on for everyone.
 *
 * Supported flag types:
 *   boolean     — on/off. Optional per-tenant override.
 *   percentage  — 0-100 rollout. Deterministic bucketing by tenantId, so the
 *                 same tenant always lands on the same side of the flag
 *                 (no flapping between requests).
 *   enum        — one of a fixed set of string variants (e.g. routing
 *                 strategy A/B/C).
 *
 * Design:
 *   - All flags are declared up front in FLAG_DEFINITIONS — no flag can be
 *     read or written unless it's registered here first. This prevents the
 *     classic feature-flag-sprawl failure mode (typo'd flag keys silently
 *     evaluating to `undefined`/falsy forever).
 *   - Every mutation is recorded in an in-memory audit history (mirrors the
 *     pattern already used by liveConfig's _history) and emitted on the
 *     existing observability bus under the CONFIG category — no new
 *     dashboard plumbing needed, it shows up in observabilityService's
 *     existing event stream / getDashboard() feed.
 *   - Kill switches (killSwitchTrading, killSwitchTenantExecution) are
 *     boolean flags whose *true* value means "operation halted" — inverted
 *     naming is intentional so the *default* (false) is always the safe,
 *     fully-operational state, and a flag flip during an incident is a
 *     single unambiguous action.
 */

'use strict';

const crypto = require('crypto');
const obs = require('./observabilityService');

// ─── Flag catalogue ────────────────────────────────────────────────────────
// Add new flags here. Nowhere else. This is the single source of truth.
const FLAG_DEFINITIONS = Object.freeze({
  killSwitchTrading: {
    type: 'boolean', default: false, tenantOverridable: false,
    tags: ['risk', 'kill-switch'],
    description: 'Global emergency stop. When true, executeBestOpportunity() short-circuits for every tenant and the shared bot — no new trades, existing state untouched. The single highest-authority flag in the system.',
  },
  killSwitchTenantExecution: {
    type: 'boolean', default: false, tenantOverridable: false,
    tags: ['risk', 'kill-switch'],
    description: 'Halts the per-tenant execution pass (runTenantExecutionPass) only. Shared bot keeps running. Use to isolate a tenant-layer incident without stopping the whole engine.',
  },
  smartOrderRouterV2: {
    type: 'percentage', default: 0, tenantOverridable: true,
    tags: ['execution', 'rollout'],
    description: 'Gradual rollout of the v2 smart order router decision policy. 0 = fully on legacy policy, 100 = fully on v2. Bucketing is deterministic per tenant.',
  },
  multiHopArbitrageUI: {
    type: 'boolean', default: true, tenantOverridable: true,
    tags: ['ui', 'experimental'],
    description: 'Show multi-hop (Bellman-Ford N-hop cycle) signals in the UI. Independent from liveConfig.multiHopEnabled, which controls whether the engine actually *executes* multi-hop trades — this only controls visibility.',
  },
  statArbEngine: {
    type: 'boolean', default: true, tenantOverridable: true,
    tags: ['strategy'],
    description: 'Enables the statistical-arbitrage (Z-score pair trading) signal engine. Off = engine does not run for that scope, saving CPU on every tick.',
  },
  operationalDashboard: {
    type: 'boolean', default: true, tenantOverridable: false,
    tags: ['ops'],
    description: 'Exposes the internal /api/ops operational dashboard endpoints. Can be turned off to reduce attack surface in a locked-down deployment.',
  },
  aggressiveRebalancing: {
    type: 'enum', default: 'reactive', enumValues: ['reactive', 'predictive', 'hybrid'], tenantOverridable: true,
    tags: ['rebalance'],
    description: 'Rebalance trigger strategy. reactive = threshold-only (current default behavior). predictive = act on anticipated imbalance from recent trade direction bias. hybrid = both.',
  },
});

// ─── Runtime state ─────────────────────────────────────────────────────────
const _global = new Map();     // key -> value
const _tenantOverrides = new Map(); // `${tenantId}::${key}` -> value
const _history = [];           // rolling audit log, most recent last
const MAX_HISTORY = 500;

for (const [key, def] of Object.entries(FLAG_DEFINITIONS)) {
  _global.set(key, def.default);
}

function _assertKnownFlag(key) {
  if (!FLAG_DEFINITIONS[key]) {
    throw new Error(`featureFlags: unknown flag "${key}" — register it in FLAG_DEFINITIONS before use`);
  }
}

function _validateValue(key, value) {
  const def = FLAG_DEFINITIONS[key];
  if (def.type === 'boolean' && typeof value !== 'boolean') {
    throw new Error(`featureFlags: "${key}" expects boolean, got ${typeof value}`);
  }
  if (def.type === 'percentage') {
    if (typeof value !== 'number' || value < 0 || value > 100) {
      throw new Error(`featureFlags: "${key}" expects a number in [0,100], got ${value}`);
    }
  }
  if (def.type === 'enum' && !def.enumValues.includes(value)) {
    throw new Error(`featureFlags: "${key}" expects one of [${def.enumValues.join(', ')}], got ${value}`);
  }
}

/** Deterministic 0-99 bucket for (tenantId, flagKey) — stable across evaluations. */
function _bucket(tenantId, key) {
  const hash = crypto.createHash('sha1').update(`${tenantId || 'anonymous'}::${key}`).digest();
  return hash.readUInt16BE(0) % 100;
}

function _recordHistory(entry) {
  _history.push(entry);
  if (_history.length > MAX_HISTORY) _history.shift();
  obs.emit('CONFIG', 'featureFlag.changed', entry, 'info');
}

// ─── Public API ─────────────────────────────────────────────────────────────

/** List all flag definitions plus their current global value — for the ops dashboard / admin UI. */
function listFlags() {
  return Object.entries(FLAG_DEFINITIONS).map(([key, def]) => ({
    key,
    ...def,
    currentValue: _global.get(key),
  }));
}

function getDefinition(key) {
  _assertKnownFlag(key);
  return { key, ...FLAG_DEFINITIONS[key] };
}

/**
 * Resolve a flag's effective value for an optional tenant context.
 * Resolution order: tenant override → global value → definition default.
 */
function getValue(key, ctx = {}) {
  _assertKnownFlag(key);
  const def = FLAG_DEFINITIONS[key];
  const { tenantId } = ctx;

  if (def.tenantOverridable && tenantId) {
    const overrideKey = `${tenantId}::${key}`;
    if (_tenantOverrides.has(overrideKey)) return _tenantOverrides.get(overrideKey);
  }

  const globalValue = _global.has(key) ? _global.get(key) : def.default;

  if (def.type === 'percentage') {
    // Percentage flags resolve to a boolean "is this scope inside the
    // rollout bucket" given the configured percentage — that's what call
    // sites actually want (isEnabled), while getValue() on a percentage
    // flag returns the raw rollout number itself for dashboards.
    return globalValue;
  }
  return globalValue;
}

/**
 * Boolean evaluation convenience — the call most feature-gated code paths
 * actually use. For percentage flags, this performs the deterministic
 * bucket check; for boolean flags it's a direct passthrough; enum flags
 * are not boolean-evaluable (use getValue() and compare).
 */
function isEnabled(key, ctx = {}) {
  _assertKnownFlag(key);
  const def = FLAG_DEFINITIONS[key];

  if (def.type === 'enum') {
    throw new Error(`featureFlags: "${key}" is an enum flag — use getValue() and compare, not isEnabled()`);
  }
  if (def.type === 'boolean') {
    return Boolean(getValue(key, ctx));
  }
  // percentage
  const pct = getValue(key, ctx);
  return _bucket(ctx.tenantId, key) < pct;
}

/** Set the global value for a flag. */
function setFlag(key, value, actor = {}) {
  _assertKnownFlag(key);
  _validateValue(key, value);
  const previous = _global.get(key);
  _global.set(key, value);
  _recordHistory({
    ts: new Date().toISOString(), key, scope: 'global',
    previous, value, actor: actor.userId || actor.source || 'unknown',
  });
  return { key, value, previous };
}

/** Set a per-tenant override. Rejects tenant overrides for flags marked tenantOverridable: false. */
function setTenantOverride(key, tenantId, value, actor = {}) {
  _assertKnownFlag(key);
  const def = FLAG_DEFINITIONS[key];
  if (!def.tenantOverridable) {
    throw new Error(`featureFlags: "${key}" does not support tenant overrides`);
  }
  if (!tenantId) throw new Error('featureFlags: tenantId is required for setTenantOverride');
  _validateValue(key, value);

  const overrideKey = `${tenantId}::${key}`;
  const previous = _tenantOverrides.get(overrideKey);
  _tenantOverrides.set(overrideKey, value);
  _recordHistory({
    ts: new Date().toISOString(), key, scope: 'tenant', tenantId,
    previous, value, actor: actor.userId || actor.source || 'unknown',
  });
  return { key, tenantId, value, previous };
}

/** Remove a tenant override, reverting that tenant to the global value. */
function clearTenantOverride(key, tenantId, actor = {}) {
  _assertKnownFlag(key);
  const overrideKey = `${tenantId}::${key}`;
  const existed = _tenantOverrides.delete(overrideKey);
  if (existed) {
    _recordHistory({
      ts: new Date().toISOString(), key, scope: 'tenant', tenantId,
      previous: 'overridden', value: 'cleared', actor: actor.userId || actor.source || 'unknown',
    });
  }
  return { key, tenantId, cleared: existed };
}

function getHistory(limit = 100) {
  return _history.slice(-limit).reverse();
}

/** Test-only: reset all flags to their declared defaults and wipe overrides/history. */
function _resetForTests() {
  _global.clear();
  _tenantOverrides.clear();
  _history.length = 0;
  for (const [key, def] of Object.entries(FLAG_DEFINITIONS)) {
    _global.set(key, def.default);
  }
}

module.exports = {
  FLAG_DEFINITIONS,
  listFlags,
  getDefinition,
  getValue,
  isEnabled,
  setFlag,
  setTenantOverride,
  clearTenantOverride,
  getHistory,
  _resetForTests,
};
