import { Component } from 'react';

/**
 * ErrorBoundary — catches render-time errors in the React tree below it.
 *
 * I-4 fix: now supports two usage modes:
 *
 *  1. Full-page boundary (existing): wraps the whole app. Any error shows
 *     the "Something went wrong" full-screen fallback with a reload button.
 *
 *  2. Inline boundary: pass `inline` prop to wrap individual panels/sections.
 *     These show a compact in-place error card so a broken widget doesn't
 *     take down the rest of the page. Critical for ArbitragePage where many
 *     panels consume real-time SSE data that can arrive in unexpected shapes.
 *
 * Usage:
 *   <ErrorBoundary>             ← full page fallback
 *   <ErrorBoundary inline>      ← compact panel fallback
 *   <ErrorBoundary inline label="Opportunity Panel">  ← named for easier debugging
 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    const label = this.props.label || (this.props.inline ? 'inline' : 'page');
    // eslint-disable-next-line no-console
    console.error(`[ErrorBoundary:${label}] Render error captured:`, error, info?.componentStack);
  }

  handleReset = () => {
    this.setState({ error: null });
  };

  handleReload = () => {
    window.location.reload();
  };

  render() {
    const { error } = this.state;
    const { inline, label, children } = this.props;
    if (!error) return children;

    if (inline) {
      return (
        <div style={{
          padding: '16px 20px', borderRadius: 10, textAlign: 'center',
          background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.2)',
          color: 'var(--text-muted, #94a3b8)', fontSize: 13,
        }}>
          <span style={{ color: '#ef4444', fontWeight: 700 }}>⚠ </span>
          {label ? `${label} ` : ''}failed to render.
          {import.meta?.env?.DEV && (
            <pre style={{
              fontSize: 10, color: '#f59e0b', marginTop: 8,
              textAlign: 'left', whiteSpace: 'pre-wrap',
            }}>{String(error?.message || error)}</pre>
          )}
          <button
            onClick={this.handleReset}
            style={{
              marginTop: 8, padding: '4px 12px', borderRadius: 6, fontSize: 12,
              background: 'rgba(239,68,68,0.15)', color: '#ef4444',
              border: '1px solid rgba(239,68,68,0.25)', cursor: 'pointer', display: 'block', margin: '8px auto 0',
            }}
          >
            Retry
          </button>
        </div>
      );
    }

    return (
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        height: '100vh', width: '100%', textAlign: 'center', padding: 32, gap: 16,
        background: 'var(--bg-base, #0b0e14)', color: 'var(--text, #e2e8f0)',
        fontFamily: 'var(--font-ui, Inter, system-ui, sans-serif)',
      }}>
        <div style={{
          width: 52, height: 52, borderRadius: 14,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(239,68,68,0.12)', color: '#ef4444', fontSize: 24, fontWeight: 800,
        }}>!</div>
        <div style={{ fontSize: 18, fontWeight: 700 }}>Something went wrong</div>
        <div style={{ fontSize: 13, color: 'var(--text-muted, #94a3b8)', maxWidth: 420 }}>
          This view hit an unexpected error and couldn&apos;t render. You can try reloading —
          your data on the server is unaffected.
        </div>
        {import.meta?.env?.DEV && (
          <pre style={{
            fontSize: 11, color: '#f59e0b', background: 'rgba(245,158,11,0.08)',
            padding: 12, borderRadius: 8, maxWidth: 600, overflow: 'auto', textAlign: 'left',
          }}>{String(error?.stack || error?.message || error)}</pre>
        )}
        <button
          onClick={this.handleReload}
          style={{
            marginTop: 4, padding: '8px 18px', borderRadius: 8, fontSize: 13, fontWeight: 700,
            background: 'var(--color-primary, #FF2D78)', color: '#fff', border: 'none', cursor: 'pointer',
          }}
        >
          Reload page
        </button>
      </div>
    );
  }
}
