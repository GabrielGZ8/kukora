import { describe, it, expect, beforeEach } from 'vitest';
import featureFlags from '../server/infrastructure/featureFlags.js';

const {
  listFlags, getDefinition, getValue, isEnabled,
  setFlag, setTenantOverride, clearTenantOverride, getHistory, _resetForTests,
} = featureFlags;

describe('featureFlags', () => {
  beforeEach(() => _resetForTests());

  it('lists every registered flag with its default value', () => {
    const flags = listFlags();
    expect(flags.length).toBeGreaterThan(0);
    const killSwitch = flags.find((f) => f.key === 'killSwitchTrading');
    expect(killSwitch.currentValue).toBe(false);
    expect(killSwitch.type).toBe('boolean');
  });

  it('throws on unknown flag keys — no silent typo bugs', () => {
    expect(() => getValue('thisFlagDoesNotExist')).toThrow(/unknown flag/);
    expect(() => setFlag('thisFlagDoesNotExist', true)).toThrow(/unknown flag/);
  });

  it('boolean flags evaluate via isEnabled and default to their declared default', () => {
    expect(isEnabled('killSwitchTrading')).toBe(false);
    setFlag('killSwitchTrading', true, { userId: 'test-admin' });
    expect(isEnabled('killSwitchTrading')).toBe(true);
  });

  it('rejects wrong-typed values for a boolean flag', () => {
    expect(() => setFlag('killSwitchTrading', 'yes')).toThrow(/expects boolean/);
  });

  it('rejects out-of-range values for a percentage flag', () => {
    expect(() => setFlag('smartOrderRouterV2', 150)).toThrow(/0,100/);
  });

  it('rejects values outside the declared set for an enum flag', () => {
    expect(() => setFlag('aggressiveRebalancing', 'not_a_real_mode')).toThrow(/expects one of/);
  });

  it('percentage flags bucket deterministically per tenant (same tenant => same result every time)', () => {
    setFlag('smartOrderRouterV2', 50);
    const results = new Set();
    for (let i = 0; i < 20; i++) {
      results.add(isEnabled('smartOrderRouterV2', { tenantId: 'tenant-abc' }));
    }
    // Same tenant, same flag, same percentage => always the same boolean.
    expect(results.size).toBe(1);
  });

  it('percentage flag at 0 is off for everyone, at 100 is on for everyone', () => {
    setFlag('smartOrderRouterV2', 0);
    expect(isEnabled('smartOrderRouterV2', { tenantId: 'tenant-x' })).toBe(false);
    setFlag('smartOrderRouterV2', 100);
    expect(isEnabled('smartOrderRouterV2', { tenantId: 'tenant-x' })).toBe(true);
  });

  it('tenant overrides take precedence over the global value', () => {
    setFlag('statArbEngine', true);
    setTenantOverride('statArbEngine', 'tenant-1', false, { userId: 'admin' });
    expect(isEnabled('statArbEngine', { tenantId: 'tenant-1' })).toBe(false);
    expect(isEnabled('statArbEngine', { tenantId: 'tenant-2' })).toBe(true); // unaffected
  });

  it('clearing a tenant override reverts to the global value', () => {
    setFlag('statArbEngine', true);
    setTenantOverride('statArbEngine', 'tenant-1', false);
    clearTenantOverride('statArbEngine', 'tenant-1');
    expect(isEnabled('statArbEngine', { tenantId: 'tenant-1' })).toBe(true);
  });

  it('refuses tenant overrides on flags marked non-tenant-overridable', () => {
    expect(() => setTenantOverride('killSwitchTrading', 'tenant-1', true))
      .toThrow(/does not support tenant overrides/);
  });

  it('enum flags refuse boolean evaluation — they must be read via getValue()', () => {
    expect(() => isEnabled('aggressiveRebalancing')).toThrow(/enum flag/);
    expect(getValue('aggressiveRebalancing')).toBe('reactive');
  });

  it('records every mutation in the audit history, most recent first', () => {
    setFlag('statArbEngine', false, { userId: 'alice' });
    setFlag('statArbEngine', true, { userId: 'bob' });
    const history = getHistory(10);
    expect(history[0].actor).toBe('bob');
    expect(history[0].previous).toBe(false);
    expect(history[0].value).toBe(true);
    expect(history[1].actor).toBe('alice');
  });

  it('getDefinition returns full metadata for a known flag and throws for unknown ones', () => {
    expect(getDefinition('operationalDashboard').type).toBe('boolean');
    expect(() => getDefinition('nope')).toThrow(/unknown flag/);
  });
});
