import { describe, it, expect, beforeEach } from 'vitest';
import eventStore from '../server/infrastructure/eventStore.js';

const { appendEvent, getEventsForTrade, projectTradeState, replayTrade, getRecentEvents, _resetForTests } = eventStore;

describe('eventStore (partial event sourcing)', () => {
  beforeEach(() => _resetForTests());

  it('appends events with an incrementing per-trade sequence number', () => {
    appendEvent('trade-1', 'trade.requested', { amount: 1 });
    appendEvent('trade-1', 'trade.filled', { amount: 1 });
    const events = getEventsForTrade('trade-1');
    expect(events.map((e) => e.seq)).toEqual([1, 2]);
  });

  it('keeps separate sequences per trade — no cross-contamination', () => {
    appendEvent('trade-a', 'trade.requested', {});
    appendEvent('trade-b', 'trade.requested', {});
    appendEvent('trade-a', 'trade.filled', {});
    expect(getEventsForTrade('trade-a').length).toBe(2);
    expect(getEventsForTrade('trade-b').length).toBe(1);
  });

  it('throws when tradeId is missing', () => {
    expect(() => appendEvent(null, 'trade.requested', {})).toThrow(/tradeId is required/);
  });

  it('projectTradeState returns null for a trade with no events', () => {
    expect(projectTradeState('never-happened')).toBeNull();
  });

  it('projects a fully-filled trade correctly by folding events', () => {
    appendEvent('trade-2', 'trade.requested', { amount: 0.5 });
    appendEvent('trade-2', 'trade.filled', { amount: 0.5 });
    appendEvent('trade-2', 'trade.settled', {});
    const state = projectTradeState('trade-2');
    expect(state.status).toBe('settled');
    expect(state.requestedAmount).toBe(0.5);
    expect(state.filledAmount).toBe(0.5);
  });

  it('projects a partially-filled trade, accumulating fill amounts across multiple partial events', () => {
    appendEvent('trade-3', 'trade.requested', { amount: 1.0 });
    appendEvent('trade-3', 'trade.partial_filled', { amount: 0.3 });
    appendEvent('trade-3', 'trade.partial_filled', { amount: 0.2 });
    const state = projectTradeState('trade-3');
    expect(state.status).toBe('partial_filled');
    expect(state.filledAmount).toBeCloseTo(0.5);
  });

  it('projects a rejected trade with its reason preserved', () => {
    appendEvent('trade-4', 'trade.requested', { amount: 1 });
    appendEvent('trade-4', 'trade.rejected', { reason: 'fees_exceed_profit' });
    const state = projectTradeState('trade-4');
    expect(state.status).toBe('rejected');
    expect(state.reason).toBe('fees_exceed_profit');
  });

  it('flags unknown event types via observability but still records them', () => {
    const event = appendEvent('trade-5', 'trade.something_new', { note: 'future event type' });
    expect(event.type).toBe('trade.something_new');
    expect(getEventsForTrade('trade-5').length).toBe(1);
  });

  it('replayTrade returns both the raw timeline and the projected final state', () => {
    appendEvent('trade-6', 'trade.requested', { amount: 1 });
    appendEvent('trade-6', 'trade.filled', { amount: 1 });
    const replay = replayTrade('trade-6');
    expect(replay.events.length).toBe(2);
    expect(replay.projectedState.status).toBe('filled');
  });

  it('getRecentEvents returns events across all trades, most recent first', () => {
    appendEvent('trade-7', 'trade.requested', {});
    appendEvent('trade-8', 'trade.requested', {});
    const recent = getRecentEvents(10);
    expect(recent[0].tradeId).toBe('trade-8');
    expect(recent[1].tradeId).toBe('trade-7');
  });

  it('never mutates a past event when new events are appended for the same trade', () => {
    appendEvent('trade-9', 'trade.requested', { amount: 1 });
    const snapshot = { ...getEventsForTrade('trade-9')[0] };
    appendEvent('trade-9', 'trade.filled', { amount: 1 });
    const firstEventStillSame = getEventsForTrade('trade-9')[0];
    expect(firstEventStillSame).toEqual(snapshot);
  });
});
