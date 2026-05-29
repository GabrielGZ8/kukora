// ─── TooltipHint.jsx ──────────────────────────────────────────────────────
// Tooltip contextual reutilizable con posicionamiento automático
// Uso: <TooltipHint text="Explicación aquí"><button>?</button></TooltipHint>
// Props: text, position ('top'|'bottom'|'left'|'right'), maxWidth, children

import { useState, useRef, useEffect } from 'react';

export function TooltipHint({ text, position = 'top', maxWidth = 220, children, delay = 300 }) {
  const [visible, setVisible]   = useState(false);
  const [coords,  setCoords]    = useState({ top: 0, left: 0 });
  const timerRef  = useRef(null);
  const wrapRef   = useRef(null);
  const tipRef    = useRef(null);

  const show = () => {
    timerRef.current = setTimeout(() => setVisible(true), delay);
  };
  const hide = () => {
    clearTimeout(timerRef.current);
    setVisible(false);
  };

  useEffect(() => () => clearTimeout(timerRef.current), []);

  useEffect(() => {
    if (!visible || !wrapRef.current || !tipRef.current) return;
    const wrap = wrapRef.current.getBoundingClientRect();
    const tip  = tipRef.current.getBoundingClientRect();
    const gap  = 8;
    let top = 0, left = 0;

    if (position === 'top') {
      top  = wrap.top  - tip.height - gap + window.scrollY;
      left = wrap.left + wrap.width / 2 - tip.width / 2 + window.scrollX;
    } else if (position === 'bottom') {
      top  = wrap.bottom + gap + window.scrollY;
      left = wrap.left + wrap.width / 2 - tip.width / 2 + window.scrollX;
    } else if (position === 'left') {
      top  = wrap.top  + wrap.height / 2 - tip.height / 2 + window.scrollY;
      left = wrap.left - tip.width - gap + window.scrollX;
    } else if (position === 'right') {
      top  = wrap.top  + wrap.height / 2 - tip.height / 2 + window.scrollY;
      left = wrap.right + gap + window.scrollX;
    }

    // Clamp to viewport
    left = Math.max(8, Math.min(left, window.innerWidth - tip.width - 8));
    top  = Math.max(8, top);

    setCoords({ top, left });
  }, [visible, position]);

  return (
    <>
      <span
        ref={wrapRef}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        style={{ display: 'inline-flex', alignItems: 'center' }}
      >
        {children}
      </span>

      {visible && (
        <div
          ref={tipRef}
          style={{
            position: 'fixed',
            top: coords.top, left: coords.left,
            zIndex: 2000,
            maxWidth,
            background: '#1a1d27',
            color: '#f0f2f7',
            fontSize: 11, fontWeight: 500, lineHeight: 1.5,
            padding: '7px 10px',
            borderRadius: 8,
            boxShadow: '0 4px 16px rgba(0,0,0,0.20)',
            pointerEvents: 'none',
            animation: 'fadeIn 0.12s ease',
            whiteSpace: position === 'left' || position === 'right' ? 'nowrap' : 'normal',
          }}
        >
          {text}
          {/* Arrow */}
          <div style={{
            position: 'absolute',
            width: 0, height: 0,
            ...(position === 'top'    && { bottom: -5, left: '50%', transform: 'translateX(-50%)', borderLeft: '5px solid transparent', borderRight: '5px solid transparent', borderTop: '5px solid #1a1d27' }),
            ...(position === 'bottom' && { top: -5, left: '50%', transform: 'translateX(-50%)', borderLeft: '5px solid transparent', borderRight: '5px solid transparent', borderBottom: '5px solid #1a1d27' }),
            ...(position === 'left'   && { right: -5, top: '50%', transform: 'translateY(-50%)', borderTop: '5px solid transparent', borderBottom: '5px solid transparent', borderLeft: '5px solid #1a1d27' }),
            ...(position === 'right'  && { left: -5, top: '50%', transform: 'translateY(-50%)', borderTop: '5px solid transparent', borderBottom: '5px solid transparent', borderRight: '5px solid #1a1d27' }),
          }} />
        </div>
      )}
    </>
  );
}

// ─── HelpBadge ────────────────────────────────────────────────────────────
// Botón de ayuda circular con tooltip — uso: <HelpBadge text="..." />
export function HelpBadge({ text, position = 'top' }) {
  return (
    <TooltipHint text={text} position={position}>
      <button style={{
        width: 16, height: 16, borderRadius: '50%', flexShrink: 0,
        background: 'var(--bg-surface-3)',
        border: '1px solid var(--border-bright)',
        color: 'var(--text-dim)', fontSize: 9, fontWeight: 800,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        cursor: 'help', lineHeight: 1, padding: 0,
        transition: 'all 0.15s',
      }}
        onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-surface-3)'; e.currentTarget.style.color = 'var(--text)'; }}
        onMouseLeave={e => { e.currentTarget.style.background = 'var(--bg-surface-3)'; e.currentTarget.style.color = 'var(--text-dim)'; }}
      >
        ?
      </button>
    </TooltipHint>
  );
}
