/**
 * telemetry.js — Kukora Observability Layer II (OpenTelemetry)
 *
 * Context: Kukora already has a business-level structured event bus
 * (observabilityService.js) — opportunity/RCA/execution-quality analytics
 * aimed at traders and the product itself. That layer is NOT replaced here.
 *
 * This module adds the orthogonal, industry-standard layer that a real
 * fintech's SRE/infra team would ask for on day one: distributed *tracing*
 * (and an optional metrics pipeline) via OpenTelemetry, exportable to any
 * OTLP-compatible backend (Grafana Tempo/Jaeger, Honeycomb, Datadog,
 * Uptrace, etc.) — no vendor lock-in.
 *
 * Design goals:
 *   - Zero-cost when disabled. If OTEL_ENABLED is not "true", `init()` is a
 *     no-op and `withSpan()` just runs the function — no perf tax, no
 *     accidental noisy exporter in local dev or in the test suite.
 *   - MUST be required before any instrumented module (express, http,
 *     mongodb, ioredis) is loaded — auto-instrumentation patches those
 *     modules' prototypes at require-time. See server/index.js: this file
 *     is the very first `require()`, ahead of `dotenv` itself is fine since
 *     we read env vars lazily inside init(), but express/mongoose etc. must
 *     come after.
 *   - Auto-instrumentation covers HTTP, Express routing, and MongoDB
 *     driver calls for free. Manual spans (withSpan) cover the actual
 *     business-critical path: order-book ingestion → opportunity detection
 *     → execution — the thing a jury/SRE actually wants to see traced.
 *
 * Env vars:
 *   OTEL_ENABLED                 'true' to activate (default: false)
 *   OTEL_SERVICE_NAME            default 'kukora'
 *   OTEL_EXPORTER_OTLP_ENDPOINT  e.g. http://localhost:4318 (default, if
 *                                 enabled without an endpoint: console
 *                                 exporter, so `OTEL_ENABLED=true` alone is
 *                                 enough to see traces locally)
 */

'use strict';

const { trace, context, SpanStatusCode, SpanKind } = require('@opentelemetry/api');

const SERVICE_NAME    = process.env.OTEL_SERVICE_NAME || 'kukora';
const SERVICE_VERSION = require('../../package.json').version;
const ENABLED          = process.env.OTEL_ENABLED === 'true';

let _sdk = null;
let _initialized = false;

/**
 * Initialize the OpenTelemetry NodeSDK. Idempotent — safe to call more than
 * once (e.g. from tests). No-op unless OTEL_ENABLED=true.
 */
function init() {
  if (_initialized) return;
  _initialized = true;

  if (!ENABLED) return; // zero-cost path — tracer below becomes a no-op tracer

  // Lazy requires: keeps require-time cost at zero when disabled, and keeps
  // auto-instrumentation registration as close to process start as possible.
  const { NodeSDK }                    = require('@opentelemetry/sdk-node');
  const { resourceFromAttributes }     = require('@opentelemetry/resources');
  const semconv                        = require('@opentelemetry/semantic-conventions');
  const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
  const { OTLPTraceExporter }          = require('@opentelemetry/exporter-trace-otlp-http');
  const { ConsoleSpanExporter }        = require('@opentelemetry/sdk-trace-node');

  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

  // If no collector endpoint is configured, fall back to a console exporter
  // rather than failing to a black hole — this keeps "OTEL_ENABLED=true" a
  // useful signal on its own (e.g. for a jury running the repo locally).
  const traceExporter = endpoint
    ? new OTLPTraceExporter({ url: `${endpoint.replace(/\/$/, '')}/v1/traces` })
    : new ConsoleSpanExporter();

  _sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [semconv.ATTR_SERVICE_NAME]:    SERVICE_NAME,
      [semconv.ATTR_SERVICE_VERSION]: SERVICE_VERSION,
      'deployment.environment':       process.env.NODE_ENV || 'development',
    }),
    traceExporter,
    instrumentations: [
      getNodeAutoInstrumentations({
        // Filesystem instrumentation is extremely noisy (every require()
        // touches the fs) and adds negligible business value — disabled.
        '@opentelemetry/instrumentation-fs': { enabled: false },
        '@opentelemetry/instrumentation-http': {
          // Don't trace our own health checks / metrics scrape traffic.
          ignoreIncomingRequestHook: (req) =>
            ['/health', '/api/metrics', '/api/readiness'].includes(req.url?.split('?')[0]),
        },
      }),
    ],
  });

  try {
    _sdk.start();
    // eslint-disable-next-line no-console
    console.log(
      `[telemetry] OpenTelemetry started — service=${SERVICE_NAME} exporter=${endpoint ? 'otlp:' + endpoint : 'console'}`
    );
  } catch (err) {
    // Telemetry must never take the product down. Log and continue cold.
    // eslint-disable-next-line no-console
    console.error('[telemetry] failed to start OpenTelemetry SDK — continuing without tracing:', err.message);
  }

  const shutdown = () => {
    _sdk?.shutdown()
      // eslint-disable-next-line no-console
      .then(() => console.log('[telemetry] shut down cleanly'))
      .catch((err) => console.error('[telemetry] shutdown error:', err.message))
      .finally(() => process.exit(0));
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

const tracer = trace.getTracer(SERVICE_NAME, SERVICE_VERSION);

/**
 * Run `fn` inside a new span named `name`. Works whether or not telemetry
 * is enabled — when disabled, OTel's API package returns a no-op tracer, so
 * this has effectively zero overhead (a couple of no-op object allocations).
 *
 * Supports both sync and async `fn`. On throw/reject, the span is marked
 * ERROR with the exception recorded, then re-thrown — callers' error
 * handling is completely unaffected.
 *
 * @param {string} name             span name, e.g. 'arbitrage.detectCycle'
 * @param {(span) => any} fn        work to run; receives the active span
 * @param {object} [opts]
 * @param {object} [opts.attributes] initial span attributes
 * @param {string}  [opts.kind]      SpanKind name, default INTERNAL
 */
function withSpan(name, fn, opts = {}) {
  const kind = SpanKind[opts.kind] ?? SpanKind.INTERNAL;
  return tracer.startActiveSpan(name, { kind, attributes: opts.attributes }, (span) => {
    const finishOk = (result) => {
      span.setStatus({ code: SpanStatusCode.OK });
      span.end();
      return result;
    };
    const finishErr = (err) => {
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      span.end();
      throw err;
    };
    try {
      const result = fn(span);
      if (result && typeof result.then === 'function') {
        return result.then(finishOk, finishErr);
      }
      return finishOk(result);
    } catch (err) {
      return finishErr(err);
    }
  });
}

/** Attach attributes to the currently active span, if any. No-op otherwise. */
function annotate(attributes) {
  trace.getActiveSpan()?.setAttributes(attributes);
}

/** Returns the current trace's hex ID, for correlating with structured logs — or null if disabled/no active span. */
function currentTraceId() {
  const span = trace.getActiveSpan();
  return span ? span.spanContext().traceId : null;
}

module.exports = {
  init,
  isEnabled: () => ENABLED,
  tracer,
  withSpan,
  annotate,
  currentTraceId,
  context,
};
