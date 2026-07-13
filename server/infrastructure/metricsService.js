'use strict';

/**
 * metricsService.js — In-process metrics for GET /api/metrics
 *
 * v2 — Structured counters + histograms + Prometheus-compatible text export.
 *
 * Design philosophy:
 *   - Zero external dependencies (no prom-client)
 *   - Single file drop-in for future prom-client swap (same interface)
 *   - Prometheus text format output lets Railway / Grafana Cloud scrape directly
 *   - Histograms use fixed buckets matching p50/p95/p99 needs for trading latency
 *
 * Counters:    monotonic, reset on restart, O(1) increment
 * Histograms:  fixed-bucket, observe(name, value), computes p50/p95/p99
 * Gauges:      current value, can go up or down
 */

const START_TS = Date.now();

// ─── Counters ────────────────────────────────────────────────────────────────
const _counters = {
  requests_total:             0,
  errors_total:               0,
  detection_cycles_total:     0,
  trades_executed_total:      0,
  trades_rejected_total:      0,
  opportunities_detected_total: 0,
  websocket_reconnects_total: 0,
  config_changes_total:       0,
  rebalances_triggered_total: 0,
  circuit_breaks_total:       0,
};

// ─── Gauges ──────────────────────────────────────────────────────────────────
const _gauges = {
  live_exchanges:       0,    // number of exchanges with live WS feeds
  active_opportunities: 0,    // currently tracked live opportunities
  heap_used_bytes:      0,    // updated on snapshot()
  daily_pnl_usd:        0,    // current session daily P&L
};

// ─── Histograms ──────────────────────────────────────────────────────────────
// Fixed bucket boundaries in milliseconds for latency tracking
const LATENCY_BUCKETS_MS = [1, 5, 10, 25, 50, 100, 200, 500, 1000, 2000, 5000];
const _histograms = {};

function _initHistogram(name) {
  _histograms[name] = {
    buckets: LATENCY_BUCKETS_MS.map(le => ({ le, count: 0 })),
    sum:     0,
    count:   0,
    samples: [], // rolling 1000 samples for percentile computation
  };
}

// Pre-initialize known histograms
[
  'detection_latency_ms',
  'execution_latency_ms',
  'api_response_ms',
  'ws_feed_latency_ms',
].forEach(_initHistogram);

// ─── Public API ──────────────────────────────────────────────────────────────

function increment(name, by = 1) {
  if (!(name in _counters)) _counters[name] = 0;
  _counters[name] += by;
}

function setGauge(name, value) {
  _gauges[name] = typeof value === 'number' ? value : 0;
}

function observe(name, valueMs) {
  if (!_histograms[name]) _initHistogram(name);
  const h = _histograms[name];

  h.sum   += valueMs;
  h.count += 1;

  // Increment all bucket counters where le >= value (cumulative)
  for (const b of h.buckets) {
    if (valueMs <= b.le) b.count++;
  }

  // Rolling samples for percentile computation (max 1000)
  h.samples.push(valueMs);
  if (h.samples.length > 1000) h.samples.shift();
}

function _percentile(sortedArr, p) {
  if (!sortedArr.length) return null;
  const idx = Math.floor(p * sortedArr.length);
  return sortedArr[Math.min(idx, sortedArr.length - 1)];
}

function histogramStats(name) {
  const h = _histograms[name];
  if (!h || !h.count) return null;

  const sorted = [...h.samples].sort((a, b) => a - b);
  return {
    count:  h.count,
    sum:    +h.sum.toFixed(2),
    mean:   +(h.sum / h.count).toFixed(2),
    p50:    +(_percentile(sorted, 0.50) || 0).toFixed(2),
    p95:    +(_percentile(sorted, 0.95) || 0).toFixed(2),
    p99:    +(_percentile(sorted, 0.99) || 0).toFixed(2),
    max:    +(sorted[sorted.length - 1] || 0).toFixed(2),
    min:    +(sorted[0] || 0).toFixed(2),
  };
}

function snapshot() {
  // Refresh heap gauge on every snapshot
  _gauges.heap_used_bytes = process.memoryUsage().heapUsed;

  const histSnaps = {};
  for (const name of Object.keys(_histograms)) {
    const s = histogramStats(name);
    if (s) histSnaps[name] = s;
  }

  return {
    counters:          { ..._counters },
    gauges:            { ..._gauges },
    histograms:        histSnaps,
    uptime_seconds:    Math.floor((Date.now() - START_TS) / 1000),
  };
}

/**
 * prometheusText() — emit metrics in Prometheus text format (v0.0.4).
 * Suitable for scraping by Grafana Cloud, Datadog Agent, Victoria Metrics, etc.
 * Endpoint: GET /api/metrics?format=prometheus (or Accept: text/plain)
 */
function prometheusText() {
  const lines = [];
  const ts = Date.now();

  // Counters
  for (const [name, val] of Object.entries(_counters)) {
    lines.push(`# TYPE kukora_${name} counter`);
    lines.push(`kukora_${name} ${val} ${ts}`);
  }

  // Gauges
  _gauges.heap_used_bytes = process.memoryUsage().heapUsed;
  for (const [name, val] of Object.entries(_gauges)) {
    lines.push(`# TYPE kukora_${name} gauge`);
    lines.push(`kukora_${name} ${val} ${ts}`);
  }

  // Uptime
  lines.push(`# TYPE kukora_uptime_seconds gauge`);
  lines.push(`kukora_uptime_seconds ${Math.floor((Date.now() - START_TS) / 1000)} ${ts}`);

  // Histograms
  for (const [name, h] of Object.entries(_histograms)) {
    if (!h.count) continue;
    lines.push(`# TYPE kukora_${name} histogram`);
    for (const b of h.buckets) {
      lines.push(`kukora_${name}_bucket{le="${b.le}"} ${b.count} ${ts}`);
    }
    lines.push(`kukora_${name}_bucket{le="+Inf"} ${h.count} ${ts}`);
    lines.push(`kukora_${name}_sum ${h.sum.toFixed(2)} ${ts}`);
    lines.push(`kukora_${name}_count ${h.count} ${ts}`);
  }

  return lines.join('\n') + '\n';
}

module.exports = { increment, setGauge, observe, snapshot, prometheusText, histogramStats };
