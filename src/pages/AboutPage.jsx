import { useState, useEffect } from 'react';

export default function AboutPage() {
  return (
    <div className="page-enter" style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      {/* Header Section */}
      <div style={{
        padding: '40px',
        background: 'var(--brand-gradient)',
        borderRadius: 'var(--radius-xl)',
        color: '#fff',
        display: 'flex',
        alignItems: 'center',
        gap: 32,
        boxShadow: 'var(--shadow-lg)',
        position: 'relative',
        overflow: 'hidden'
      }}>
        {/* Decorative elements */}
        <div style={{
          position: 'absolute', top: -20, right: -20, width: 200, height: 200,
          background: 'rgba(255,255,255,0.1)', borderRadius: '50%'
        }} />

        <img
          src="/avatar.jpg"
          alt="Gabriel G.Z."
          style={{
            width: 120, height: 120, borderRadius: '50%',
            objectFit: 'cover',
            objectPosition: 'center top',
            border: '4px solid rgba(255,255,255,0.4)',
            flexShrink: 0
          }}
        />

        <div>
          <h1 style={{ margin: 0, fontSize: 32, fontWeight: 900, letterSpacing: '-0.03em' }}>Gabriel G. Z.</h1>
          <p style={{ margin: '8px 0 0', fontSize: 18, opacity: 0.9, fontWeight: 500 }}>
            Quantitative Developer & Fintech Enthusiast
          </p>
          <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
            {['Blockchain', 'Arbitrage', 'React', 'Node.js'].map(tag => (
              <span key={tag} style={{
                background: 'rgba(255,255,255,0.2)',
                padding: '4px 12px',
                borderRadius: 99,
                fontSize: 12,
                fontWeight: 700
              }}>
                {tag}
              </span>
            ))}
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 1fr', gap: 24 }}>
        {/* Bio & Vision */}
        <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <h3 style={{ margin: 0, fontSize: 18, fontWeight: 800 }}>Sobre Mí</h3>

          <p style={{ fontSize: 14, color: 'var(--text-muted)', lineHeight: 1.6 }}>
            Soy <strong>Ingeniero Mecatrónico</strong> y desarrollador apasionado por la tecnología, el emprendimiento y la creación de soluciones con impacto real. Me gusta enfrentar desafíos complejos, aprender constantemente y construir productos desde cero, siempre con un enfoque en la calidad, la mejora continua y el valor que pueden aportar a las personas.
          </p>

          <p style={{ fontSize: 14, color: 'var(--text-muted)', lineHeight: 1.6 }}>
            <strong>Kukora</strong> nació durante este hackathon como una forma de explorar la intersección entre las finanzas y la tecnología, desarrollando un sistema capaz de analizar mercados en tiempo real y detectar oportunidades de arbitraje. Para mí, programar no es solo escribir código, sino convertir ideas en herramientas útiles que resuelvan problemas de forma inteligente y acerquen tecnologías complejas a más personas.
          </p>



          <div style={{ marginTop: 8 }}>
            <h4 style={{ fontSize: 13, fontWeight: 700, marginBottom: 12 }}>¿Por qué Kukora?</h4>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {[
                { icon: '↯', title: 'Velocidad', desc: 'Detección en milisegundos mediante WebSockets.' },
                { icon: '∑', title: 'Análisis Profundo', desc: 'Modelos matemáticos aplicados al trading real.' },
                { icon: '◱', title: 'UX Premium', desc: 'Interfaces diseñadas para analistas modernos.' }
              ].map(item => (
                <div key={item.title} style={{ display: 'flex', gap: 12, alignItems: 'start' }}>
                  <span style={{ fontSize: 18 }}>{item.icon}</span>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 700 }}>{item.title}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>{item.desc}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Contact & Socials */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          <div className="card">
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 800, marginBottom: 16 }}>Conecta Conmigo</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <a href="mailto:gabrielgarziaz@gmail.com" className="btn btn-secondary" style={{ width: '100%', justifyContent: 'start', textDecoration: 'none' }}>
                <span style={{ marginRight: 8 }}>📧</span> Email: gabrielgarziaz@gmail.com
              </a>
              <a href="https://www.linkedin.com/in/gabrielgarzia/" target="_blank" rel="noopener noreferrer" className="btn btn-secondary" style={{ width: '100%', justifyContent: 'start', textDecoration: 'none' }}>
                <span style={{ marginRight: 8 }}>🔗</span> LinkedIn
              </a>
              <a href="https://github.com/GabrielGZ8" target="_blank" rel="noopener noreferrer" className="btn btn-secondary" style={{ width: '100%', justifyContent: 'start', textDecoration: 'none' }}>
                <span style={{ marginRight: 8 }}>💻</span> GitHub
              </a>
            </div>
          </div>

          <div className="card-glass" style={{ border: '1px solid var(--color-primary-glow)' }}>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 800, color: 'var(--color-primary)', marginBottom: 8 }}>
              Kukora Hackathon Project
            </h3>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0 }}>
              Este proyecto fue desarrollado íntegramente por mí para demostrar las capacidades
              de un stack moderno en entornos de alta frecuencia y baja latencia.
            </p>
            <div style={{ marginTop: 16, fontSize: 11, fontWeight: 700, color: 'var(--text-dim)', textAlign: 'center' }}>
              Hecho ❤️ en MEXICO
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
