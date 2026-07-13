import { useEffect, useRef } from 'react';

// ─── BirdsAnimation ──────────────────────────────────────────────────────
// Extracted from Layout.jsx (Round 7 — audit 4.3: split large components).
const TOTAL_BIRDS = 14;
const GROUPS = {
  bullish: [
    { size: 3, xBase: -40,   yBase: 14, spread: 16 },
    { size: 4, xBase: -240,  yBase: 22, spread: 20 },
    { size: 3, xBase: -480,  yBase: 10, spread: 14 },
    { size: 2, xBase: -660,  yBase: 30, spread: 12 },
    { size: 1, xBase: -820,  yBase: 18, spread: 0  },
    { size: 1, xBase: -1000, yBase: 28, spread: 0  },
  ],
  neutral: [
    { size: 3, xBase: -60,  yBase: 16, spread: 16 },
    { size: 1, xBase: -280, yBase: 26, spread: 0  },
    { size: 3, xBase: -500, yBase: 12, spread: 14 },
    { size: 1, xBase: -720, yBase: 32, spread: 0  },
    { size: 1, xBase: -900, yBase: 20, spread: 0  },
  ],
  bearish: [
    { size: 1, xBase: -80,  yBase: 28, spread: 0  },
    { size: 3, xBase: -320, yBase: 20, spread: 12 },
    { size: 1, xBase: -600, yBase: 34, spread: 0  },
  ],
};
function birdPath(wing)      { const up = wing * 8; return `M 0,0 Q -11,${-up-3} -20,${-up+3}`; }
function birdPathRight(wing) { const up = wing * 8; return `M 0,0 Q 11,${-up-3} 20,${-up+3}`; }

function initBirds(trend, speedMult) {
  const groups = GROUPS[trend] || GROUPS.neutral;
  const birds = [];
  groups.forEach((g, gi) => {
    for (let k = 0; k < g.size; k++) {
      const xOff = k * (g.spread * 0.6) * (Math.random() * 0.4 + 0.8);
      const yOff = k * (g.spread * 0.4) * (Math.random() * 0.6 - 0.3);
      birds.push({
        id: birds.length, x: g.xBase - xOff,
        y: g.yBase + yOff + (Math.random() - 0.5) * 4,
        speed: (0.45 + Math.random() * 0.2 + gi * 0.04) * speedMult,
        scale: 0.52 + Math.random() * 0.32,
        wingPhase: Math.random() * Math.PI * 2,
        wingSpeed: 1.1 + Math.random() * 0.6,
        yDrift: (Math.random() - 0.5) * 0.10,
      });
    }
  });
  while (birds.length < TOTAL_BIRDS) {
    birds.push({ id: birds.length, x: -9999, y: 0, speed: 0, scale: 0, wingPhase: 0, wingSpeed: 1, yDrift: 0, inactive: true });
  }
  return birds;
}

export default function BirdsAnimation({ marketTrend = 'neutral' }) {
  const svgRef = useRef(null);
  const birds  = useRef([]);
  const cfgMap = {
    bullish: { speedMult: 1.35, opacity: 0.62 },
    bearish: { speedMult: 0.68, opacity: 0.44 },
    neutral: { speedMult: 1.00, opacity: 0.56 },
  };
  const cfg = cfgMap[marketTrend] || cfgMap.neutral;
  useEffect(() => { birds.current = initBirds(marketTrend, cfg.speedMult); }, [marketTrend]); // eslint-disable-line react-hooks/exhaustive-deps -- cfg derives from marketTrend; tracking marketTrend is sufficient
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    let raf, t = 0;
    const getW = () => svg.getBoundingClientRect().width || 1000;
    const tick = () => {
      t++;
      const W = getW();
      birds.current.forEach((b) => {
        if (b.inactive) return;
        b.x += b.speed; b.y += b.yDrift;
        if (b.y < 5)  { b.y = 5;  b.yDrift =  Math.abs(b.yDrift); }
        if (b.y > 46) { b.y = 46; b.yDrift = -Math.abs(b.yDrift); }
        if (b.x > W + 80) { b.x = -80 - Math.random() * 120; b.y = 8 + Math.random() * 34; b.yDrift = (Math.random() - 0.5) * 0.10; }
        const wing = Math.sin(t * b.wingSpeed * 0.07 + b.wingPhase);
        const el = svg.querySelector(`#brd-${b.id}`);
        if (!el) return;
        el.setAttribute('transform', `translate(${b.x.toFixed(1)},${b.y.toFixed(1)}) scale(${b.scale.toFixed(2)})`);
        el.querySelector('.lw')?.setAttribute('d', birdPath(wing));
        el.querySelector('.rw')?.setAttribute('d', birdPathRight(wing));
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [marketTrend]);
  return (
    <svg ref={svgRef} style={{ position:'absolute',left:0,top:0,width:'100%',height:'100%',pointerEvents:'none',overflow:'hidden' }} aria-hidden="true">
      {Array.from({ length: TOTAL_BIRDS }, (_, i) => (
        <g key={i} id={`brd-${i}`} style={{ opacity: cfg.opacity, transition: 'opacity 0.6s' }}>
          <circle cx={0} cy={0} r={2.0} fill="var(--text-muted)" />
          <path className="lw" d={birdPath(0)} fill="none" stroke="var(--text-muted)" strokeWidth={2.6} strokeLinecap="round" />
          <path className="rw" d={birdPathRight(0)} fill="none" stroke="var(--text-muted)" strokeWidth={2.6} strokeLinecap="round" />
        </g>
      ))}
    </svg>
  );
}
