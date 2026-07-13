/**
 * design-system/index.jsx — Audit fix 2.4
 *
 * Primitive presentational components that consume the CSS design tokens
 * defined in src/styles/global.css (--color-*, --text-*, --bg-*, --radius-*,
 * --shadow-*, --font-*) instead of components hardcoding values inline.
 *
 * WHY THIS EXISTS
 * ─────────────────
 * The audit found that components like Layout.jsx duplicate design values
 * inline (`style={{ fontSize: 9, fontWeight: 800, letterSpacing: '0.10em' }}`)
 * across dozens of call sites. When a value needs to change, every call site
 * has to be found and updated by hand, and divergence creeps in over time.
 *
 * These primitives are the first step toward a real design system: new code
 * should reach for <Text>, <Badge>, <Card>, <MetricValue> instead of writing
 * raw `style={{...}}` objects with hardcoded colors/sizes. Existing components
 * are NOT being mass-migrated in this round (that's a much higher-risk change
 * across 60+ files) — this lays the foundation so future work and new pages
 * can build on tokens consistently from here on.
 *
 * USAGE
 * ─────
 *   <Text size="sm" weight="bold" color="dim">Label</Text>
 *   <Badge tone="green">LIVE</Badge>
 *   <Card padding="md">...</Card>
 *   <MetricValue value={1234.56} prefix="$" tone="green" size="lg" />
 */

import { forwardRef } from 'react';

// ─── Text ───────────────────────────────────────────────────────────────────
// Typographic primitive. All sizing/weight/color values map to CSS tokens —
// no component using <Text> should ever need a raw fontSize/color override.
const TEXT_SIZES = {
  xs:   '10px',
  sm:   '12px',
  base: '13px',
  md:   '14px',
  lg:   '16px',
  xl:   '20px',
  xxl:  '28px',
};

const TEXT_WEIGHTS = {
  normal: 400,
  medium: 500,
  semibold: 600,
  bold: 700,
  black: 800,
};

const TEXT_COLORS = {
  default: 'var(--text)',
  muted:   'var(--text-muted)',
  dim:     'var(--text-dim)',
  primary: 'var(--color-primary)',
  green:   'var(--color-green)',
  red:     'var(--color-red)',
  yellow:  'var(--color-yellow)',
  blue:    'var(--color-blue)',
  purple:  'var(--color-purple)',
};

export const Text = forwardRef(function Text(
  {
    as: Component = 'span',
    size = 'base',
    weight = 'normal',
    color = 'default',
    mono = false,
    uppercase = false,
    truncate = false,
    style,
    children,
    ...rest
  },
  ref
) {
  return (
    <Component
      ref={ref}
      style={{
        fontSize:      TEXT_SIZES[size]   || size,
        fontWeight:    TEXT_WEIGHTS[weight] ?? weight,
        color:         TEXT_COLORS[color] || color,
        fontFamily:    mono ? 'var(--font-mono)' : 'var(--font-ui)',
        textTransform: uppercase ? 'uppercase' : undefined,
        letterSpacing: uppercase ? '0.08em' : undefined,
        overflow:      truncate ? 'hidden' : undefined,
        textOverflow:  truncate ? 'ellipsis' : undefined,
        whiteSpace:    truncate ? 'nowrap' : undefined,
        ...style,
      }}
      {...rest}
    >
      {children}
    </Component>
  );
});

// ─── Badge ──────────────────────────────────────────────────────────────────
// Small status/label pill. `tone` maps to the semantic color tokens so a
// "LIVE" badge is always the same green everywhere it appears.
const BADGE_TONES = {
  default: { bg: 'var(--bg-surface-3)',    fg: 'var(--text-muted)',   border: 'var(--border)' },
  primary: { bg: 'var(--color-primary-dim)', fg: 'var(--color-primary)', border: 'var(--color-primary-glow)' },
  green:   { bg: 'var(--color-green-dim)',  fg: 'var(--color-green)',  border: 'var(--color-green-dim)' },
  red:     { bg: 'var(--color-red-dim)',    fg: 'var(--color-red)',    border: 'var(--color-red-dim)' },
  yellow:  { bg: 'var(--color-yellow-dim)', fg: 'var(--color-yellow)', border: 'var(--color-yellow-dim)' },
  blue:    { bg: 'var(--color-blue-dim)',   fg: 'var(--color-blue)',   border: 'var(--color-blue-dim)' },
  purple:  { bg: 'var(--color-purple-dim)', fg: 'var(--color-purple)', border: 'var(--color-purple-dim)' },
};

export function Badge({ tone = 'default', children, style, ...rest }) {
  const c = BADGE_TONES[tone] || BADGE_TONES.default;
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '2px 7px',
        borderRadius: 'var(--radius-sm)',
        fontSize: 9,
        fontWeight: 800,
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
        background: c.bg,
        color: c.fg,
        border: `1px solid ${c.border}`,
        lineHeight: 1.4,
        ...style,
      }}
      {...rest}
    >
      {children}
    </span>
  );
}

// ─── Card ───────────────────────────────────────────────────────────────────
// Surface container. Replaces the common pattern of inline
// `style={{ background: 'var(--bg-surface)', border: ..., borderRadius: ... }}`.
const CARD_PADDING = {
  none: 0,
  sm:   '10px',
  md:   '16px',
  lg:   '24px',
};

export const Card = forwardRef(function Card(
  { padding = 'md', elevated = false, glass = false, style, children, ...rest },
  ref
) {
  return (
    <div
      ref={ref}
      style={{
        background: glass ? 'var(--bg-surface-2)' : 'var(--bg-surface)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-lg)',
        boxShadow: elevated ? 'var(--shadow-card)' : undefined,
        backdropFilter: glass ? 'blur(12px)' : undefined,
        padding: CARD_PADDING[padding] ?? padding,
        ...style,
      }}
      {...rest}
    >
      {children}
    </div>
  );
});

// ─── MetricValue ────────────────────────────────────────────────────────────
// Formats a numeric KPI (P&L, price, percentage) with consistent sign-coloring
// and monospace alignment. Centralizes the "green if positive, red if negative"
// pattern that's currently duplicated across MetricCard, ExecutiveDashboard,
// ArbKpiPanel, and others.
export function MetricValue({
  value,
  prefix = '',
  suffix = '',
  decimals = 2,
  size = 'lg',
  signed = false,
  tone, // explicit override; otherwise inferred from sign when `signed` is true
  style,
  ...rest
}) {
  const num = Number(value);
  const isNeg = signed && num < 0;
  const isPos = signed && num > 0;
  const resolvedTone = tone || (isNeg ? 'red' : isPos ? 'green' : 'default');
  const formatted = Number.isFinite(num)
    ? `${signed && num > 0 ? '+' : ''}${num.toFixed(decimals)}`
    : '—';

  return (
    <Text size={size} weight="bold" color={resolvedTone} mono style={style} {...rest}>
      {prefix}{formatted}{suffix}
    </Text>
  );
}

export default { Text, Badge, Card, MetricValue };
