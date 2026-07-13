/**
 * PageSkeleton — shown via Suspense while a lazy page chunk loads.
 *
 * Replaces the old bare centered spinner. A skeleton that hints at the
 * page's eventual structure (header + metric row + content blocks) reduces
 * perceived load time and avoids the layout "pop" when real content
 * replaces a tiny spinner with a full-height page.
 */
function shimmer() {
  return {
    background: 'linear-gradient(90deg, var(--bg-surface-2) 25%, var(--bg-surface-3) 37%, var(--bg-surface-2) 63%)',
    backgroundSize: '400% 100%',
    animation: 'kukora-skeleton-shimmer 1.4s ease infinite',
    borderRadius: 8,
  };
}

export default function PageSkeleton({ metrics = 4 }) {
  return (
    <div style={{ padding: '4px 0' }} aria-busy="true" aria-label="Loading page">
      <style>{`
        @keyframes kukora-skeleton-shimmer {
          0%   { background-position: 100% 50%; }
          100% { background-position: 0% 50%; }
        }
      `}</style>

      {/* Header row: title + action button */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div style={{ width: 220, height: 22, ...shimmer() }} />
        <div style={{ width: 110, height: 32, ...shimmer() }} />
      </div>

      {/* Metric card row */}
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${metrics}, 1fr)`, gap: 12, marginBottom: 20 }}>
        {Array.from({ length: metrics }, (_, i) => (
          <div key={i} style={{ height: 86, padding: 14, ...shimmer() }} />
        ))}
      </div>

      {/* Main content block */}
      <div style={{ height: 280, marginBottom: 16, ...shimmer() }} />

      {/* Secondary row */}
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12 }}>
        <div style={{ height: 180, ...shimmer() }} />
        <div style={{ height: 180, ...shimmer() }} />
      </div>
    </div>
  );
}
