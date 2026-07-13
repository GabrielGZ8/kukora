// @vitest-environment jsdom
/**
 * tests/components/ScoreCard.test.jsx — Frontend/UX phase (2026-07-09).
 *
 * First jsdom/@testing-library component test in this project — the
 * frontend previously had zero component-level test coverage (all 1728
 * prior tests exercise `server/` only). Added specifically to prove a real
 * defect, not for decorative coverage: before this session, ScoreCard
 * rendered a `<div onClick={...}>` with no keyboard affordance at all, so a
 * keyboard-only user landing on the Intelligence/Markets pages could not
 * open any ranked asset's detail view — a real, user-facing accessibility
 * bug on a component reused across multiple pages, not just IntelligencePage.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ScoreCard from '../../src/components/common/ScoreCard';

const item = { id: 'BTC', name: 'Bitcoin', score: 82, label: 'Strong', labelColor: 'green' };

describe('ScoreCard', () => {
  it('renders as plain, non-interactive content when no onClick is passed (read-only usage)', () => {
    render(<ScoreCard item={item} />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('exposes an accessible button role and is reachable by keyboard Tab when onClick is passed', async () => {
    const onClick = vi.fn();
    render(<ScoreCard item={item} onClick={onClick} />);

    const card = screen.getByRole('button');
    await userEvent.tab();
    expect(card).toHaveFocus();
  });

  it('activates onClick when Enter is pressed while focused (mouse-only click handlers do not do this by default on a div)', async () => {
    const onClick = vi.fn();
    render(<ScoreCard item={item} onClick={onClick} />);

    const card = screen.getByRole('button');
    card.focus();
    await userEvent.keyboard('{Enter}');

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('activates onClick when Space is pressed while focused', async () => {
    const onClick = vi.fn();
    render(<ScoreCard item={item} onClick={onClick} />);

    const card = screen.getByRole('button');
    card.focus();
    await userEvent.keyboard(' ');

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('still responds to a real mouse click (regression guard — the keyboard fix must not break the existing mouse path)', async () => {
    const onClick = vi.fn();
    render(<ScoreCard item={item} onClick={onClick} />);

    await userEvent.click(screen.getByRole('button'));

    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
