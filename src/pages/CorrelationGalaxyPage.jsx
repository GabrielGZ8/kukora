import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { PageHeader } from '../components/common/PageHeader';

const COIN_GROUPS = [
  { id: 'bitcoin',      label: 'BTC',  color: '#F7931A', group: 'Core',  size: 38 },
  { id: 'ethereum',     label: 'ETH',  color: '#627EEA', group: 'Core',  size: 28 },
  { id: 'solana',       label: 'SOL',  color: '#9945FF', group: 'L1',    size: 22 },
  { id: 'binancecoin',  label: 'BNB',  color: '#F3BA2F', group: 'L1',    size: 20 },
  { id: 'ripple',       label: 'XRP',  color: '#00AAE4', group: 'DeFi',  size: 18 },
  { id: 'cardano',      label: 'ADA',  color: '#0D47A1', group: 'L1',    size: 16 },
  { id: 'avalanche-2',  label: 'AVAX', color: '#E84142', group: 'L1',    size: 16 },
  { id: 'dogecoin',     label: 'DOGE', color: '#C2A633', group: 'Meme',  size: 14 },
];

const COIN_IDS = COIN_GROUPS.map(c => c.id).join(',');

export default function CorrelationGalaxyPage() {
  const canvasRef = useRef(null);
  const animRef   = useRef(null);
  const stateRef  = useRef({ nodes: [], edges: [], matrix: null, hoveredId: null });
  const [loading, setLoading]   = useState(true);
  const [hovered, setHovered]   = useState(null);
  const [period, setPeriod]     = useState(30);
  const [matrix, setMatrix]     = useState(null);

  const initNodes = (mat) => {
    const nodes = COIN_GROUPS.map((c, i) => {
      const angle = i === 0 ? 0 : ((i - 1) / (COIN_GROUPS.length - 1)) * Math.PI * 2;
      const orbit = i === 0 ? 0 : 165 + (i % 2 === 0 ? 18 : -8);
      return {
        ...c,
        baseAngle: angle, baseOrbit: orbit,
        x: 0, y: 0,
        phase: Math.random() * Math.PI * 2,
        orbitDelta: (Math.random() - 0.5) * 0.0006,
      };
    });

    const edges = [];
    COIN_GROUPS.forEach((a, i) => {
      COIN_GROUPS.forEach((b, j) => {
        if (j <= i) return;
        const val = mat?.[a.id]?.[b.id];
        if (val != null && Math.abs(val) > 0.25) edges.push({ a: a.id, b: b.id, correlation: val });
      });
    });

    stateRef.current.nodes = nodes;
    stateRef.current.edges = edges;
    stateRef.current.matrix = mat;
    setMatrix(mat);
  };

  useEffect(() => {
    setLoading(true);
    api.get(`/api/crypto/correlation?coins=${COIN_IDS}&days=${period}`)
      .then(d => { initNodes(d.matrix); setLoading(false); })
      .catch(() => { initNodes(null); setLoading(false); });
  }, [period]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || loading) return;
    const ctx = canvas.getContext('2d');

    const resize = () => {
      canvas.width  = canvas.offsetWidth  * window.devicePixelRatio;
      canvas.height = canvas.offsetHeight * window.devicePixelRatio;
      ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
    };
    resize();

    const getLogicalSize = () => ({
      W: canvas.offsetWidth,
      H: canvas.offsetHeight,
    });

    const draw = (ts) => {
      const { W, H } = getLogicalSize();
      const cx = W / 2, cy = H / 2;
      const t = ts * 0.001;

      ctx.clearRect(0, 0, W, H);

      const { nodes, edges, hoveredId } = stateRef.current;

      // Subtle dot grid background
      ctx.fillStyle = 'rgba(0,0,0,0.04)';
      for (let gx = 0; gx < W; gx += 36) {
        for (let gy = 0; gy < H; gy += 36) {
          ctx.beginPath();
          ctx.arc(gx, gy, 1, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // Animate node positions
      nodes.forEach(n => {
        if (n.id === 'bitcoin') {
          n.x = cx + Math.sin(t * 0.3) * 3;
          n.y = cy + Math.cos(t * 0.25) * 3;
        } else {
          const angle = n.baseAngle + t * n.orbitDelta * 50;
          const floatX = Math.sin(t * 0.7 + n.phase) * 7;
          const floatY = Math.cos(t * 0.5 + n.phase) * 5;
          n.x = cx + Math.cos(angle) * n.baseOrbit + floatX;
          n.y = cy + Math.sin(angle) * n.baseOrbit + floatY;
        }
      });

      // Draw edges
      edges.forEach(e => {
        const na = nodes.find(n => n.id === e.a);
        const nb = nodes.find(n => n.id === e.b);
        if (!na || !nb) return;

        const corr   = e.correlation;
        const absC   = Math.abs(corr);
        const isHov  = hoveredId && (e.a === hoveredId || e.b === hoveredId);
        const alpha  = isHov ? Math.min(0.85, absC * 0.9) : Math.min(0.35, absC * 0.45);
        const lw     = isHov ? absC * 2.5 + 1 : absC * 1.2 + 0.5;
        const posClr = corr > 0 ? `rgba(0,184,122,${alpha})` : `rgba(240,62,62,${alpha})`;

        ctx.save();
        ctx.strokeStyle = posClr;
        ctx.lineWidth   = lw;
        if (!isHov) ctx.setLineDash([5, 7]);
        ctx.lineDashOffset = corr > 0 ? -(t * 18) : (t * 18);

        // Curved path
        const midX = (na.x + nb.x) / 2 + Math.sin(t * 0.5 + na.phase) * 16;
        const midY = (na.y + nb.y) / 2 + Math.cos(t * 0.4 + nb.phase) * 12;
        ctx.beginPath();
        ctx.moveTo(na.x, na.y);
        ctx.quadraticCurveTo(midX, midY, nb.x, nb.y);
        ctx.stroke();
        ctx.setLineDash([]);

        // Correlation value on hovered edges
        if (isHov) {
          const lx = (na.x + nb.x) / 2;
          const ly = (na.y + nb.y) / 2 - 8;
          ctx.font = '600 10px Inter, system-ui';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillStyle = '#fff';
          const tw = ctx.measureText(`${(corr * 100).toFixed(0)}%`).width + 10;
          ctx.fillRect(lx - tw / 2, ly - 9, tw, 18);
          ctx.strokeStyle = posClr.replace(/[\d.]+\)$/, '0.5)');
          ctx.lineWidth = 1;
          ctx.strokeRect(lx - tw / 2, ly - 9, tw, 18);
          ctx.fillStyle = corr > 0 ? 'rgba(0,130,90,1)' : 'rgba(180,40,40,1)';
          ctx.fillText(`${(corr * 100).toFixed(0)}%`, lx, ly);
        }
        ctx.restore();
      });

      // Draw nodes
      nodes.forEach(n => {
        const isHov = n.id === hoveredId;
        const pulse = 1 + Math.sin(t * 1.8 + n.phase) * 0.06;
        const r     = (n.size / 2) * (isHov ? 1.25 : pulse);

        // Glow halo
        const halo = ctx.createRadialGradient(n.x, n.y, r * 0.4, n.x, n.y, r * 2.8);
        halo.addColorStop(0, n.color + '30');
        halo.addColorStop(1, 'transparent');
        ctx.beginPath();
        ctx.arc(n.x, n.y, r * 2.8, 0, Math.PI * 2);
        ctx.fillStyle = halo;
        ctx.fill();

        // Node fill
        ctx.beginPath();
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
        ctx.fillStyle = isHov ? n.color : n.color + 'E0';
        ctx.shadowColor = n.color;
        ctx.shadowBlur  = isHov ? 16 : 8;
        ctx.fill();
        ctx.shadowBlur  = 0;

        // Border
        ctx.strokeStyle = isHov ? '#fff' : 'rgba(255,255,255,0.6)';
        ctx.lineWidth   = isHov ? 2.5 : 1.5;
        ctx.stroke();

        // Label
        ctx.fillStyle     = '#fff';
        ctx.font          = `${isHov ? '800' : '700'} ${isHov ? 11 : 9.5}px Inter, system-ui`;
        ctx.textAlign     = 'center';
        ctx.textBaseline  = 'middle';
        ctx.shadowBlur    = 0;
        ctx.fillText(n.label, n.x, n.y);
      });

      animRef.current = requestAnimationFrame(draw);
    };

    animRef.current = requestAnimationFrame(draw);

    const onMove = (e) => {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const found = stateRef.current.nodes.find(n => {
        const dx = n.x - mx, dy = n.y - my;
        return Math.sqrt(dx * dx + dy * dy) < n.size;
      });
      stateRef.current.hoveredId = found?.id || null;
      setHovered(found || null);
    };
    canvas.addEventListener('mousemove', onMove);
    canvas.addEventListener('mouseleave', () => {
      stateRef.current.hoveredId = null;
      setHovered(null);
    });

    const observer = new ResizeObserver(() => { resize(); });
    observer.observe(canvas);

    return () => {
      cancelAnimationFrame(animRef.current);
      canvas.removeEventListener('mousemove', onMove);
      observer.disconnect();
    };
  }, [loading]);

  return (
    <div className="page-enter">
      <PageHeader
        title="Correlation Galaxy"
        description="Red de correlaciones animada · hover para ver valores · verde = positiva · rojo = negativa"
        badge="LIVE"
        badgeColor="var(--color-blue)"
        live
        help="Mueve el cursor sobre un nodo para ver sus correlaciones con todos los demás activos. Las líneas sólidas indican correlación fuerte."
      />

      {/* Controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Periodo:</span>
        {[7, 14, 30, 60].map(d => (
          <button
            key={d}
            className={`btn btn-sm ${period === d ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => setPeriod(d)}
          >
            {d}d
          </button>
        ))}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 16, alignItems: 'center', flexShrink: 0 }}>
          {[
            { color: 'var(--color-green)', label: 'Correlación positiva' },
            { color: 'var(--color-red)',   label: 'Correlación negativa' },
          ].map(({ color, label }) => (
            <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-muted)' }}>
              <div style={{ width: 18, height: 2, background: color, borderRadius: 1 }} />
              {label}
            </div>
          ))}
        </div>
      </div>

      {/* Canvas container */}
      <div style={{ position: 'relative', borderRadius: 'var(--radius-xl)', overflow: 'hidden', border: '1px solid var(--border)', background: 'var(--bg-surface)', boxShadow: 'var(--shadow-card)' }}>
        {loading && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 12, background: 'var(--bg-surface)', zIndex: 10 }}>
            <div className="spinner" />
            <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>Calculando correlaciones…</div>
          </div>
        )}

        <canvas
          ref={canvasRef}
          style={{ width: '100%', height: 500, display: 'block' }}
        />

        {/* Hovered info panel */}
        {hovered && matrix && (
          <div style={{
            position: 'absolute', top: 14, right: 14,
            background: '#fff',
            border: '1px solid var(--border)',
            borderLeft: `3px solid ${hovered.color}`,
            borderRadius: 'var(--radius-lg)',
            padding: '12px 14px', minWidth: 160,
            boxShadow: 'var(--shadow-card)',
          }}>
            <div style={{ fontSize: 15, fontWeight: 900, color: hovered.color, marginBottom: 2, fontFamily: 'var(--font-mono)' }}>{hovered.label}</div>
            <div style={{ fontSize: 10, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10 }}>{hovered.group}</div>
            {COIN_GROUPS.filter(c => c.id !== hovered.id).map(c => {
              const val = matrix[hovered.id]?.[c.id];
              if (val == null) return null;
              const color = val > 0 ? 'var(--color-green)' : 'var(--color-red)';
              return (
                <div key={c.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 11, marginBottom: 4, alignItems: 'center' }}>
                  <span style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontWeight: 600 }}>{c.label}</span>
                  <span style={{ fontWeight: 800, fontFamily: 'var(--font-mono)', color }}>{(val * 100).toFixed(0)}%</span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Legend */}
      <div style={{ display: 'flex', gap: 10, marginTop: 14, flexWrap: 'wrap' }}>
        {COIN_GROUPS.map(c => (
          <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--text-muted)' }}>
            <div style={{ width: 9, height: 9, borderRadius: '50%', background: c.color, flexShrink: 0 }} />
            <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>{c.label}</span>
            <span style={{ color: 'var(--text-dim)', fontSize: 9 }}>({c.group})</span>
          </div>
        ))}
      </div>
    </div>
  );
}
