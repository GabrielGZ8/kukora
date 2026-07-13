// tests/setupJsdom.js — Frontend/UX phase (2026-07-09).
// Registers @testing-library/jest-dom's matchers (toHaveFocus, toBeInTheDocument,
// etc.) for the jsdom-environment component tests under tests/components/.
// Kept separate from tests/setup.js (the global mongoose mock for server
// tests) so node-environment server tests never pay the cost of loading
// jsdom-only matchers they don't use.
import '@testing-library/jest-dom/vitest';
