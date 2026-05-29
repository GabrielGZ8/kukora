import { useEffect, useState } from "react";

export default function SplashScreen({ onFinish }) {
  const [hide, setHide] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      setHide(true);

      setTimeout(() => {
        onFinish?.();
      }, 700);
    }, 3200); 
 
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
            Plataforma fintech
          </div>

        </div>

      </div>
    </>
  );
}