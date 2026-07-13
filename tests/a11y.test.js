'use strict';

/**
 * tests/a11y.test.js — Frontend/UX phase (2026-07-09).
 *
 * Proves the actual defect this helper fixes: several `<div onClick={...}>`
 * list-item/card components (ScoreCard, AdversarialPanel's history rows,
 * IntelligencePage's coin cards) were keyboard-inert — no role, no tab
 * stop, no Enter/Space activation. A mouse-only interaction pattern on
 * what is functionally a button is a real WCAG 2.1.1 + 4.1.2 violation,
 * not a cosmetic nit.
 */

import { describe, it, expect, vi } from 'vitest';
import { clickableDivProps } from '../src/utils/a11y.js';

describe('clickableDivProps', () => {
  it('returns {} (no role, no handlers) when onClick is not provided — a decorative div must not falsely claim to be interactive', () => {
    expect(clickableDivProps(undefined)).toEqual({});
    expect(clickableDivProps(null)).toEqual({});
  });

  it('exposes role="button" and a tab stop when onClick is provided', () => {
    const onClick = vi.fn();
    const props = clickableDivProps(onClick);
    expect(props.role).toBe('button');
    expect(props.tabIndex).toBe(0);
    expect(props.onClick).toBe(onClick);
  });

  it('activates onClick on Enter and prevents default (so Enter cannot also submit a surrounding form unexpectedly)', () => {
    const onClick = vi.fn();
    const { onKeyDown } = clickableDivProps(onClick);
    const event = { key: 'Enter', preventDefault: vi.fn() };
    onKeyDown(event);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
  });

  it('activates onClick on Space and prevents default (so Space cannot also scroll the page — the actual native <button> behavior)', () => {
    const onClick = vi.fn();
    const { onKeyDown } = clickableDivProps(onClick);
    const event = { key: ' ', preventDefault: vi.fn() };
    onKeyDown(event);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
  });

  it('ignores every other key (e.g. Tab, ArrowDown) — must not hijack normal keyboard navigation', () => {
    const onClick = vi.fn();
    const { onKeyDown } = clickableDivProps(onClick);
    for (const key of ['Tab', 'ArrowDown', 'a', 'Escape']) {
      onKeyDown({ key, preventDefault: vi.fn() });
    }
    expect(onClick).not.toHaveBeenCalled();
  });
});
