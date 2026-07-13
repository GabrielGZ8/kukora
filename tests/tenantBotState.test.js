'use strict';

/**
 * tenantBotState.test.js — ADR-017, item 1 fase A.
 * Verifica la intención de bot on/off por-tenant, aislada del bot
 * compartido global (arbitrage/subroutes/state.js, no tocado por esta fase).
 */

import { describe, it, expect } from 'vitest';

const tenantBotState = require('../server/infrastructure/tenantBotState');

describe('tenantBotState', () => {
  it('defaults to disabled for a brand-new tenant', () => {
    expect(tenantBotState.isEnabled('fresh-uid')).toBe(false);
  });

  it('setEnabled isolates state between two uids', () => {
    tenantBotState.setEnabled('a1', true);
    expect(tenantBotState.isEnabled('a1')).toBe(true);
    expect(tenantBotState.isEnabled('a2')).toBe(false);
  });

  it('records startedAt when turned on and clears it when turned off', () => {
    tenantBotState.setEnabled('b1', true);
    const onStatus = tenantBotState.getStatus('b1');
    expect(onStatus.startedAt).not.toBeNull();

    tenantBotState.setEnabled('b1', false);
    const offStatus = tenantBotState.getStatus('b1');
    expect(offStatus.startedAt).toBeNull();
  });

  it('activeUids() lists only tenants currently enabled', () => {
    tenantBotState.setEnabled('c1', true);
    tenantBotState.setEnabled('c2', false);
    tenantBotState.setEnabled('c3', true);
    const active = tenantBotState.activeUids();
    expect(active).toContain('c1');
    expect(active).toContain('c3');
    expect(active).not.toContain('c2');
  });
});
