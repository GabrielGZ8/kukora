/**
 * ExecutiveDashboardPage.jsx — Kukora
 *
 * Auditoría de comité 2026-07-08, hoja de ruta #6: "Diseñar una vista de
 * entrada única y canónica (probablemente ExecutiveDashboard promovido a
 * landing post-login) que dirija al jurado hacia VWAP L2 y risk
 * management explicados, en vez de dejar que compitan en igualdad de peso
 * visual con paneles secundarios."
 *
 * ANTES de esta página: `ExecutiveDashboard.jsx` (components/common/) ya
 * existía como el diseño correcto para resolver el problema de densidad
 * de navegación (409 líneas, un resumen de una sola pantalla), pero solo
 * vivía como una pestaña más (`activeTab === 'executive'`) dentro de
 * `ArbitragePage.jsx` — al mismo nivel de peso visual que 18 pestañas más.
 * Un jurado que aterrizaba en `/summary` (el default anterior) o en
 * `/dashboard` (destino del login) nunca la veía a menos que supiera
 * navegar manualmente a esa pestaña específica.
 *
 * ESTA PÁGINA la promueve a ruta de primer nivel (`/executive`) y pasa a
 * ser el destino canónico tanto de `/` como del login/registro exitoso
 * (ver src/App.jsx y src/pages/LoginPage.jsx/RegisterPage.jsx). Reutiliza
 * el mismo hook `useArbitrageStream()` que ya usa ArbitragePage para
 * alimentar `data` — mismo stream, sin fetch adicional, sin acoplar esta
 * página a ArbitragePage.
 *
 * `SummaryPage` (/summary) y `DashboardPage` (/dashboard) se mantienen
 * accesibles vía nav para quien quiera el detalle histórico/de mercado
 * respectivamente — esta página no las reemplaza, resuelve cuál es la
 * puerta de entrada por defecto.
 */
import { useNavigate } from 'react-router-dom';
import { useArbitrageStream } from '../hooks/useArbitrageStream';
import ExecutiveDashboard from '../components/common/ExecutiveDashboard';
import { PageHeader } from '../components/common/PageHeader';
import { useTranslation } from '../i18n/I18nContext';

export default function ExecutiveDashboardPage() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { data, connected } = useArbitrageStream();

  return (
    <div>
      <PageHeader
        title={t('executive.title')}
        description={t('executive.description')}
        live={connected}
        actions={
          <button
            onClick={() => navigate('/arbitrage')}
            style={{
              background: 'var(--accent, #5741D9)', color: '#fff', border: 'none',
              borderRadius: 8, padding: '8px 16px', fontSize: 12, fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            Explorar motor en vivo →
          </button>
        }
      />
      <ExecutiveDashboard data={data} />
    </div>
  );
}