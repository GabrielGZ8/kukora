// src/utils/a11y.js — Frontend/UX phase (2026-07-09).
//
// Finding: several list-item/card components use a bare `<div onClick={...}>`
// as an interactive control (ScoreCard, AdversarialPanel's run history rows,
// IntelligencePage's coin cards — both the grid and the leaderboard rows).
// A `<div>` has no default keyboard behavior and no accessible role, so a
// keyboard-only or screen-reader user could not activate any of these at
// all — no Tab stop, no Enter/Space activation. This is a genuine WCAG 2.1.1
// (Keyboard) + 4.1.2 (Name, Role, Value) violation, not a style nit.
//
// `clickableDivProps(onClick)` returns the exact prop set that makes a div
// behave like a button for assistive tech and keyboard users, without
// changing its visual layout (unlike swapping to a real <button>, which
// would require overriding default button display/box-sizing behavior in
// several call sites that rely on block-level flex children).
//
// If `onClick` is falsy, returns `{}` — a purely decorative div (no handler)
// must not gain a false "this is interactive" signal (role="button" with no
// action would be worse than no role at all).
export function clickableDivProps(onClick) {
  if (!onClick) return {};
  return {
    role: 'button',
    tabIndex: 0,
    onClick,
    onKeyDown: (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault(); // stop Space from scrolling the page
        onClick(e);
      }
    },
  };
}
