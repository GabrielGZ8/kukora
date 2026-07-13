import { useEffect, useState } from "react";

const MIN_DISPLAY_MS = 3200;
const FADE_MS = 700;
const HEALTH_TIMEOUT_MS = 2500;

export default function SplashScreen({ onFinish }) {
  const [hide, setHide] = useState(false);
  // Real system status, pulled from /health rather than a hardcoded label.
  // Falls back to a neutral "connecting" message if the request is slow
  // or fails — the splash should never look like it's lying about status.
  const [status, setStatus] = useState({ label: 'Connecting to engine…', ok: null });

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);

    fetch('/health', { signal: controller.signal })
      .then(r => r.json())
      .then(d => {
        if (cancelled) return;
        const engineUp = d?.engine?.running !== false;
        const dbInfo = d?.db?.connected ? 'DB connected' : 'in-memory mode';
        setStatus({
          label: engineUp ? `Engine online · ${dbInfo}` : 'Engine starting…',
          ok: !!d?.ok && engineUp,
        });
      })
      .catch(() => {
        if (!cancelled) setStatus({ label: 'Starting up…', ok: false });
      })
      .finally(() => clearTimeout(timer));

    return () => { cancelled = true; clearTimeout(timer); controller.abort(); };
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      setHide(true);

      setTimeout(() => {
        onFinish?.();
      }, FADE_MS);
    }, MIN_DISPLAY_MS);

    return () => clearTimeout(timer);
  }, [onFinish]);

  return (
    <>
      <style>{`
        .splash-screen {
          position: fixed;
          inset: 0;
          z-index: 999999;

          display: flex;
          justify-content: center;
          align-items: center;

          overflow: hidden;

          background:
            radial-gradient(circle at top left, rgba(255,45,114,0.08), transparent 35%),
            radial-gradient(circle at bottom right, rgba(255,138,77,0.08), transparent 35%),
            white;

          transition: opacity 0.7s ease;
        }

        .splash-screen.hide {
          opacity: 0;
          pointer-events: none;
        }

        .brand-wrapper {
          display: flex;
          flex-direction: column;
          align-items: center;

          /* SOLO CENTRA MEJOR EL BLOQUE */
          transform: translateX(-4px);
        }

        .logo-container {
          position: relative;
          width: 180px;
          height: 180px;
        }

        .piece {
          position: absolute;
          opacity: 0;
        }

        .piece-left {
          width: 65px;
          height: 180px;

          left: 10px;
          top: 10px;

          border-radius: 999px;

          background: linear-gradient(
            180deg,
            #ff2d72 0%,
            #d10088 55%,
            #ff7a59 100%
          );

          transform: translateY(35px) scale(0.8);

          animation:
            leftAppear 0.9s
            cubic-bezier(0.22, 1, 0.36, 1)
            forwards;
        }

        .piece-bottom {
          width: 70px;
          height: 70px;

          right: 20px;
          bottom: -10px;

          border-radius: 0 100px 100px 100px;

          background: linear-gradient(
            135deg,
            #ff9a5a 0%,
            #ff2d72 100%
          );

          transform:
            translateY(25px)
            rotate(-18deg)
            scale(0.7);
 
          animation:
            bottomAppear 0.8s
            cubic-bezier(0.22, 1, 0.36, 1)
            forwards;

          animation-delay: 0.8s;
        }

        .piece-dot {
          width: 52px;
          height: 52px;
 
          right: 35px;
          top: 50px;

          border-radius: 50%;

          background: linear-gradient(
            180deg,
            #ff2d72 0%,
            #ff4f6d 100%
          );

          transform: scale(0);

          animation:
            dotAppear 0.45s ease forwards;

          animation-delay: 1.55s;
        }

        .kukora-text {
          margin-top: 30px;

          font-size: 3rem;
          font-weight: 700;

          letter-spacing: -0.06em;

          color: #111827;

          opacity: 0;
          transform: translateY(10px);

          animation:
            textAppear 0.7s ease forwards;

          animation-delay: 2s;

          font-family:
            Inter,
            SF Pro Display,
            system-ui,
            sans-serif;
        }

        .kukora-subtitle {
          margin-top: -8px;

          font-size: 0.95rem;
          font-weight: 500;

          letter-spacing: 0.04em;

          color: #64748b;

          opacity: 0;
          transform: translateY(10px);

          animation:
            textAppear 0.7s ease forwards;

          animation-delay: 2.2s;

          font-family:
            Inter,
            SF Pro Display,
            system-ui,
            sans-serif;
        }

        @keyframes leftAppear {
          to {
            opacity: 1;
            transform: translateY(0) scale(1);
          }
        }

        @keyframes bottomAppear {
          to {
            opacity: 1;
            transform:
              translateY(0)
              rotate(0deg)
              scale(1);
          }
        }

        @keyframes dotAppear {
          0% {
            opacity: 0;
            transform: scale(0);
          }

          70% {
            opacity: 1;
            transform: scale(1.15);
          }

          100% {
            opacity: 1;
            transform: scale(1);
          }
        }

        @keyframes textAppear {
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }

        .kukora-status {
          margin-top: 14px;
          display: flex;
          align-items: center;
          gap: 7px;
          font-size: 0.75rem;
          font-weight: 600;
          letter-spacing: 0.03em;
          color: #94a3b8;
          opacity: 0;
          animation: textAppear 0.7s ease forwards;
          animation-delay: 2.4s;
          font-family: Inter, SF Pro Display, system-ui, sans-serif;
        }

        .status-dot {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          flex-shrink: 0;
          transition: background 0.3s ease;
        }
      `}</style>
 
      <div className={`splash-screen ${hide ? "hide" : ""}`}>

        <div className="brand-wrapper">

          <div className="logo-container">

            <div className="piece piece-left"></div>

            <div className="piece piece-bottom"></div>

            <div className="piece piece-dot"></div>

          </div>

          <h1 className="kukora-text">
            Kukora
          </h1>

          <div className="kukora-subtitle">
            Bitcoin Arbitrage Platform
          </div>

          <div className="kukora-status">
            <span
              className="status-dot"
              style={{
                background: status.ok === null ? '#94a3b8' : status.ok ? '#22c55e' : '#f59e0b',
              }}
            />
            {status.label}
          </div>

        </div>

      </div>
    </>
  );
}