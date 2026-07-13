// ─── Arbitrage Page Tab Configuration ────────────────────────────────────
// Extracted from ArbitragePage.jsx (Round 7 — audit 4.3: split large components).
// Round 8 (design pass): emoji labels replaced with plain text + an `icon`
// key resolved against arbTabIcons.jsx in the tab bar renderer. No tabs,
// groups, or ids were removed — this is a visual-only change.
export const ARBITRAGE_TABS = [
  { id:'bot',           icon:'bot',            label:'Opportunities',       group:'core',      desc:'Real-time bilateral detection — VWAP L2, composite scoring, fill probability, rejection reason per opportunity' },
  { id:'mybot',         icon:'mybot',          label:'My Bot',              group:'core',      desc:'Your own isolated paper-trading bot — personal wallet, P&L, config overrides and risk guard, separate from the shared bot' },
  { id:'lifecycle',     icon:'lifecycle',      label:'Trades & Execution',  group:'core',      desc:'Audited trade history: e2e latency, fill ratio, gross spread, fees, net P&L, state per trade' },
  { id:'audit',         icon:'audit',          label:'Audited P&L',         group:'core',      desc:'Institutional P&L with cent-accurate reconciliation, MTM, breakdown by pair, CSV and HTML report export' },
  { id:'rebalance',     icon:'rebalance',      label:'Inventory & Wallets', group:'inventory', desc:'Pre-funded balances per exchange, rebalance urgency, inventory pressure, estimated transfer cost' },
  { id:'watchdog',      icon:'watchdog',       label:'Risk & Health',       group:'inventory', desc:'Active circuit breakers, stale feeds, disconnected exchanges, drawdown, high latency, overall system health' },
  { id:'capital',       icon:'capital',        label:'Capital Efficiency',  group:'inventory', desc:'Capital utilization per exchange, hourly ROI, idle capital percentage, recommended optimal distribution' },
  { id:'triangular',    icon:'triangular',     label:'Triangular Arb',      group:'research',  desc:'3-leg intra-exchange routes — shares the same scoring and market data infrastructure as bilateral arb' },
  { id:'quant',         icon:'quant',          label:'StatArb',             group:'research',  desc:'Statistical signals: Z-score, EWMA, half-life estimation, mean reversion — shares the same risk infrastructure' },
  { id:'heatmap',       icon:'heatmap',        label:'Spread Heatmap',      group:'research',  desc:'Spread heatmap across 5 exchanges — identifies which pairs show the most persistent edge' },
  { id:'microstructure',icon:'microstructure', label:'Microstructure',      group:'research',  desc:'Opportunity decay curves and latency racing — shows how long an opportunity lives before it collapses' },
  { id:'intelligence',  icon:'intelligence',   label:'Intelligence',        group:'research',  desc:'Exchange rankings by reliability, spread volatility, liquidity deterioration predictions' },
  { id:'control',       icon:'control',        label:'Parameters',         group:'ops',       desc:'Hot-reload all engine parameters — minScore, fees, slippage, risk limits, capital, scoring weights' },
  { id:'executive',     icon:'executive',      label:'Executive Dashboard', group:'ops',       desc:'Consolidated KPIs: equity curve, institutional metrics, session summary' },
  { id:'adaptive',      icon:'adaptive',       label:'Adaptive System',     group:'ops',       desc:'Auto-detection of optimal parameters: dynamic exchange reliability, real-time scoring adjustment' },
  { id:'stress',        icon:'stress',         label:'Stress Test',        group:'ops',       desc:'Live adverse scenarios: fee shock, liquidity crunch, extreme slippage — validates engine robustness' },
  { id:'adversarial',   icon:'adversarial',    label:'Adversarial',        group:'ops',       desc:'Mid-flight failures: buy success / sell failure, timeout, API outage — tests the recovery engine' },
  { id:'speed',         icon:'speed',          label:'Latency',             group:'ops',       desc:'End-to-end benchmark: WS vs polling, detection, decision and execution time in microseconds' },
  { id:'replay',        icon:'replay',         label:'Replay',              group:'ops',       desc:'Reproduces captured real market moments — reconstructs market state at the time of each opportunity' },
];

export const TAB_GROUPS = [
  { key:'core',      label:'Core',        color:'#FF2D78', ids:['bot','mybot','lifecycle','audit'] },
  { key:'inventory', label:'Inventory',   color:'#00b87a', ids:['rebalance','watchdog','capital'] },
  { key:'research',  label:'Modules',     color:'#8b5cf6', ids:['triangular','quant','heatmap','microstructure','intelligence'] },
  { key:'ops',       label:'Operational', color:'#0052FF', ids:['control','executive','adaptive','stress','adversarial','speed','replay'] },
];
