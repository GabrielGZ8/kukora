import NavIcons from './navIcons';

// ─── Nav definition ──────────────────────────────────────────────────────
// Extracted from Layout.jsx (Round 7 — audit 4.3: split large components).
// H-10 (Sesión 26): `label`/`tip` ahora son llaves de i18n (t('nav.xxx'),
// t('navTip.xxx')) resueltas en Layout.jsx en el momento de renderizar, no
// strings fijos — así el nav se traduce completo con el selector de
// idioma. Ver src/i18n/dictionaries/{es,en}.js para los textos reales.
const NAV = [
  { path: '/executive',   labelKey: 'nav.executive',    icon: NavIcons.executive, group: 'arb', badge: 'LIVE', tipKey: 'navTip.executive' },
  { path: '/summary',      labelKey: 'nav.summary',      icon: NavIcons.summary,   group: 'arb', badge: 'LIVE', tipKey: 'navTip.summary' },
  { path: '/arbitrage',    labelKey: 'nav.arbitrage',     icon: NavIcons.arbitrage, group: 'arb', badge: 'LIVE', tipKey: 'navTip.arbitrage' },
  { path: '/arb-backtest', labelKey: 'nav.arbBacktest',   icon: NavIcons.backtest,  group: 'arb',   tipKey: 'navTip.arbBacktest' },
  { path: '/tenant-compare', labelKey: 'nav.tenantCompare', icon: NavIcons.compare, group: 'arb', badge: 'DEMO', tipKey: 'navTip.tenantCompare' },
  { path: '/dashboard',    labelKey: 'nav.dashboard',     icon: NavIcons.dashboard, group: 'core', tipKey: 'navTip.dashboard' },
  { path: '/docs',         labelKey: 'nav.docs',          icon: NavIcons.docs,      group: 'core', tipKey: 'navTip.docs' },
  { path: '/alerts',       labelKey: 'nav.alerts',        icon: NavIcons.alerts,    group: 'tools' },
  { path: '/portfolio',    labelKey: 'nav.portfolio',     icon: NavIcons.portfolio, group: 'tools' },
  { path: '/watchlist',    labelKey: 'nav.watchlist',     icon: NavIcons.watchlist, group: 'tools' },
  { path: '/markets',      labelKey: 'nav.markets',       icon: NavIcons.markets,   group: 'tools' },
  { path: '/analyze',      labelKey: 'nav.analyze',       icon: NavIcons.analyze,   group: 'advanced', badge: 'CSV',  tipKey: 'navTip.analyze' },
  { path: '/compare',      labelKey: 'nav.compare',       icon: NavIcons.compare,   group: 'advanced', tipKey: 'navTip.compare' },
  { path: '/risk',         labelKey: 'nav.risk',          icon: NavIcons.risk,      group: 'advanced', tipKey: 'navTip.risk' },
  { path: '/intelligence', labelKey: 'nav.intelligence',  icon: NavIcons.intel,     group: 'advanced', tipKey: 'navTip.intelligence' },
  { path: '/analytics',    labelKey: 'nav.analytics',     icon: NavIcons.analytics, group: 'advanced', tipKey: 'navTip.analytics' },
  { path: '/heatmap',      labelKey: 'nav.heatmap',       icon: NavIcons.heatmap,   group: 'advanced', tipKey: 'navTip.heatmap' },
  { path: '/analytics-ta', labelKey: 'nav.technicalAnalysis', icon: NavIcons.technical, group: 'research', tipKey: 'navTip.technicalAnalysis' },
  { path: '/forecast',     labelKey: 'nav.forecast',      icon: NavIcons.forecast,  group: 'research', tipKey: 'navTip.forecast' },
  { path: '/regime',       labelKey: 'nav.regime',        icon: NavIcons.regime,    group: 'research', badge: 'AI',   tipKey: 'navTip.regime' },
  { path: '/galaxy',       labelKey: 'nav.galaxy',        icon: NavIcons.galaxy,    group: 'research', badge: 'LIVE', tipKey: 'navTip.galaxy' },
  { path: '/montecarlo',   labelKey: 'nav.montecarlo',    icon: NavIcons.montecarlo,group: 'research', tipKey: 'navTip.montecarlo' },
  { path: '/backtest',     labelKey: 'nav.backtest',      icon: NavIcons.backtest,  group: 'research', tipKey: 'navTip.backtest' },
  { path: '/profile',      labelKey: 'nav.profile',       icon: NavIcons.user,      group: 'info', tipKey: 'navTip.profile' },
  { path: '/settings',     labelKey: 'nav.settings',      icon: NavIcons.settings,  group: 'info', tipKey: 'navTip.settings' },
  { path: '/about',        labelKey: 'nav.about',         icon: NavIcons.about,     group: 'info', tipKey: 'navTip.about' },
];

export default NAV;