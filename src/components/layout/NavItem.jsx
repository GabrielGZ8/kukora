import { NavLink } from 'react-router-dom';
import { TooltipHint } from '../common/TooltipHint';
import { useTranslation } from '../../i18n/I18nContext';

// ─── NavItem ─────────────────────────────────────────────────────────────
// Extracted from Layout.jsx (Round 7 — audit 4.3: split large components).
// H-10 (Sesión 26): item.label/item.tip fijos → item.labelKey/item.tipKey
// resueltos aquí con t(), para que el nav se traduzca completo al cambiar
// de idioma sin tener que re-montar NAV.
export default function NavItem({ item, indent = false }) {
  const { t } = useTranslation();
  const label = item.labelKey ? t(item.labelKey) : item.label;
  const tip   = item.tipKey   ? t(item.tipKey)   : item.tip;
  const link = (
    <NavLink
      to={item.path}
      style={({ isActive }) => ({
        display: 'flex', alignItems: 'center', gap: 8,
        padding: indent ? '5px 10px 5px 26px' : '7px 10px',
        borderRadius: 8,
        fontSize: indent ? 12 : 12.5,
        fontWeight: isActive ? 700 : 500,
        color: isActive ? 'var(--color-primary)' : indent ? 'var(--text-dim)' : 'var(--text-muted)',
        background: isActive ? 'var(--color-primary-dim)' : 'transparent',
        border: isActive ? '1px solid rgba(255,45,120,0.15)' : '1px solid transparent',
        textDecoration: 'none',
        transition: 'all 0.13s ease',
        marginBottom: 1, minWidth: 0,
        outline: 'none',
      })}
      onMouseEnter={e => {
        if (!e.currentTarget.getAttribute('aria-current')) {
          e.currentTarget.style.background = 'var(--bg-surface-2)';
          e.currentTarget.style.color = 'var(--text)';
        }
      }}
      onMouseLeave={e => {
        if (!e.currentTarget.getAttribute('aria-current')) {
          e.currentTarget.style.background = '';
          e.currentTarget.style.color = '';
        }
      }}
    >
      <span style={{ width: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, opacity: indent ? 0.7 : 1 }}>
        {item.icon}
      </span>
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      {item.badge && (
        <span style={{
          fontSize: 8, fontWeight: 800, flexShrink: 0,
          color: item.badge === 'AI' ? 'var(--color-primary)' : item.badge === 'LIVE' ? 'var(--color-green)' : 'var(--color-blue)',
          background: item.badge === 'AI' ? 'var(--color-primary-dim)' : item.badge === 'LIVE' ? 'var(--color-green-dim)' : 'var(--color-blue-dim)',
          padding: '1px 5px', borderRadius: 4, letterSpacing: '0.04em',
        }}>
          {item.badge}
        </span>
      )}
    </NavLink>
  );
  return tip ? (
    <TooltipHint key={item.path} text={tip} position="right">{link}</TooltipHint>
  ) : link;
}
