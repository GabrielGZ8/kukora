// ─── PageHeader.jsx ───────────────────────────────────────────────────────
// Header reutilizable para todas las páginas
// Props: title, description, badge, badgeColor, actions, backPath, backLabel

import { useNavigate } from 'react-router-dom';
import { HelpBadge } from './TooltipHint';

export function PageHeader({
  title,
  description,
  badge,
  badgeColor,
  help,
  actions,
  backPath,
  backLabel,
  live = false,
  style = {},
}) {
  const navigate = useNavigate();

  return (
    <div style={{ marginBottom: 22, ...style }}>
      {backPath && (
        <button
          onClick={() => navigate(backPath)}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 5,
            background: 'none', border: 'none', padding: '0 0 8px',
            fontSize: 12, color: 'var(--text-dim)', cursor: 'pointer',
            fontFamily: 'var(--font-ui)', fontWeight: 500,
            transition: 'color 0.15s',
          }}
          onMouseEnter={e => { e.currentTarget.style.color = 'var(--text)'; }}
          onMouseLeave={e => { e.currentTarget.style.color = 'var(--text-dim)'; }}
        >
          ← {backLabel || 'Volver'}
        </button>
      )}

      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <h2 style={{ fontSize: 20, fontWeight: 800, letterSpacing: '-0.3px', lineHeight: 1.2 }}>
              {title}
            </h2>
            {badge && (
              <span style={{
                fontSize: 9, fontWeight: 800, letterSpacing: '0.06em',
                textTransform: 'uppercase', flexShrink: 0,
                color: badgeColor || 'var(--color-primary)',
                background: badgeColor ? `${badgeColor}15` : 'var(--color-primary-dim)',
                padding: '2px 8px', borderRadius: 99,
                border: `1px solid ${badgeColor ? `${badgeColor}25` : 'rgba(255,45,120,0.2)'}`,
              }}>
                {badge}
              </span>
            )}
            {live && (
              <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <span style={{
                  width: 6, height: 6, borderRadius: '50%',
                  background: 'var(--color-green)',
                  boxShadow: '0 0 0 0 rgba(0,184,122,0.4)',
                  animation: 'pulseAnim 2s infinite', flexShrink: 0,
                  display: 'inline-block',
                }} />
                <span style={{ fontSize: 10, color: 'var(--text-dim)', fontWeight: 600 }}>Live</span>
              </span>
            )}
            {help && <HelpBadge text={help} />}
          </div>
          {description && (
            <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.5 }}>
              {description}
            </p>
          )}
        </div>

        {actions && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            {actions}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── SectionHeader ────────────────────────────────────────────────────────
export function SectionHeader({ title, description, actions, help }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 14, gap: 12 }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>{title}</div>
          {help && <HelpBadge text={help} />}
        </div>
        {description && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{description}</div>}
      </div>
      {actions && <div style={{ flexShrink: 0 }}>{actions}</div>}
    </div>
  );
}

// ─── EmptyState ────────────────────────────────────────────────────────────
export function EmptyState({ icon = '◈', title, description, action, onAction }) {
  return (
    <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--text-muted)' }}>
      <div style={{ fontSize: 40, marginBottom: 14, opacity: 0.25 }}>{icon}</div>
      <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 6 }}>{title}</div>
      {description && <div style={{ fontSize: 12, color: 'var(--text-dim)', maxWidth: 280, margin: '0 auto 16px', lineHeight: 1.5 }}>{description}</div>}
      {action && onAction && (
        <button className="btn btn-primary btn-sm" onClick={onAction}>{action}</button>
      )}
    </div>
  );
}
