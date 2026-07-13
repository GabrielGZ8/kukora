'use strict';

/**
 * tenantConfig.test.js — ADR-017, item 1 fase A.
 * Verifica que los overrides por-tenant nunca mutan el config global y
 * que dos uids no se pisan entre sí.
 */

import { describe, it, expect, afterEach } from 'vitest';

const liveConfig = require('../server/infrastructure/liveConfig');
const tenantConfig = require('../server/infrastructure/tenantConfig');

describe('tenantConfig', () => {
  afterEach(() => {
    liveConfig.reset('test-cleanup');
    tenantConfig.resetAll('u1');
    tenantConfig.resetAll('u2');
  });

  it('getEffective falls back to the global liveConfig value when there is no override', () => {
    expect(tenantConfig.getEffective('u1', 'minScore')).toBe(liveConfig.get('minScore'));
  });

  it('setMany applies a validated override without touching the global config', () => {
    const globalBefore = liveConfig.get('minScore');
    const result = tenantConfig.setMany('u1', { minScore: 42 });
    expect(result.ok).toBe(true);
    expect(tenantConfig.getEffective('u1', 'minScore')).toBe(42);
    expect(liveConfig.get('minScore')).toBe(globalBefore); // global untouched
  });

  it('rejects unknown parameters and invalid values, mirroring liveConfig.setMany', () => {
    const result = tenantConfig.setMany('u1', { notARealKey: 1, minScore: -999 });
    expect(result.ok).toBe(false);
    expect(result.rejected.length).toBeGreaterThan(0);
  });

  it('isolates overrides between two different uids', () => {
    tenantConfig.setMany('u1', { minScore: 10 });
    tenantConfig.setMany('u2', { minScore: 20 });
    expect(tenantConfig.getEffective('u1', 'minScore')).toBe(10);
    expect(tenantConfig.getEffective('u2', 'minScore')).toBe(20);
  });

  it('clearOverride reverts a single key back to the global value', () => {
    tenantConfig.setMany('u1', { minScore: 10 });
    tenantConfig.clearOverride('u1', 'minScore');
    expect(tenantConfig.getEffective('u1', 'minScore')).toBe(liveConfig.get('minScore'));
  });

  it('resetAll clears every override for that tenant only', () => {
    tenantConfig.setMany('u1', { minScore: 10 });
    tenantConfig.setMany('u2', { minScore: 20 });
    tenantConfig.resetAll('u1');
    expect(tenantConfig.getOverrides('u1')).toEqual({});
    expect(tenantConfig.getEffective('u2', 'minScore')).toBe(20);
  });
});
