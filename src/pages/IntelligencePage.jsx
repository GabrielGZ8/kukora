import { useState } from 'react';
import { usePolling } from '../hooks/usePolling';
import { api } from '../api';
import AnomalyAlert from '../components/common/AnomalyAlert';
import { useTranslation } from '../i18n/I18nContext';

import ScoreCard from '../components/common/ScoreCard';
import RankingTable from '../components/common/RankingTable';
import { TrendCard, VolatilityCard, MomentumCard, PerformanceCard } from '../components/common/MetricWidgets';
import { clickableDivProps } from '../utils/a11y';

const COINS_OPTIONS = ['bitcoin,ethereum,solana,binancecoin,ripple', 'bitcoin,ethereum,solana,binancecoin,ripple,cardano,dogecoin,polkadot'];
const PERIODS = [{ label: '7d', days: 7 }, { label: '30d', days: 30 }, { label: '90d', days: 90 }];
const COIN_LIST = [
  { id: 'bitcoin', label: 'BTC' }, { id: 'ethereum', label: 'ETH' },
  { id: 'solana', label: 'SOL' }, { id: 'binancecoin', label: 'BNB' }, { id: 'ripple', label: 'XRP' },
];

function Section({ title, sub, children, action }) {
  return (
    <div style={{ marginBottom: 28 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 14 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 800 }}>{title}</div>
          {sub && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{sub}</div>}
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

function Loader() {
  return <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}><div className="spinner" /></div>;
}

export default function IntelligencePage() {
  const { t } = useTranslation();
  const [period, setPeriod]   = useState(PERIODS[1]);
  const [focusCoin, setFocus] = useState('bitcoin');

  // Overview — top 20 coins with trend and anomaly scores computed server-side
  const { data: overview, loading: ovLoading } = usePolling(
    () => api.get('/api/crypto/overview'),
    90_000, []
  );

  // Scores ranking
  const { data: scores, loading: scLoading } = usePolling(
    () => api.get(`/api/crypto/scores?coins=${COINS_OPTIONS[1]}&days=${period.days}`),
    120_000, [period.days]
  );

  // Anomalies batch
  const { data: anomalies, loading: _anLoading } = usePolling(
    () => api.get(`/api/crypto/anomalies?coins=${COINS_OPTIONS[1]}&days=${period.days}`),
    90_000, [period.days]
  );

  // Deep analytics for focused coin
  const { data: analytics, loading: analLoading } = usePolling(
    () => api.get(`/api/crypto/coin/${focusCoin}/analytics?days=${period.days}`),
    60_000, [focusCoin, period.days]
  );

  const overviewCoins = overview?.coins || [];
  const highAnomalies = (anomalies || []).filter(a => a.anomaly?.level === 'high');
  const medAnomalies  = (anomalies || []).filter(a => a.anomaly?.level === 'medium');

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
        <div />
        <div style={{ display: 'flex', gap: 6 }}>
          {PERIODS.map(p => (
            <button key={p.label} className={`btn btn-sm ${period.days === p.days ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setPeriod(p)}>{p.label}</button>
          ))}
        </div>
      </div>

      {/* Anomaly alerts strip */}
      {(highAnomalies.length > 0 || medAnomalies.length > 0) && (
        <Section title={t('intelligencePage.anomaliesTitle')} sub={`${highAnomalies.length} ${t('intelligencePage.anomalyHigh')} · ${medAnomalies.length} ${t('intelligencePage.anomalyMedium')} · ${t('common.period')} ${period.label}`}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {[...highAnomalies, ...medAnomalies].slice(0, 5).map(a => (
              <AnomalyAlert key={a.id} anomaly={a.anomaly} name={a.name || a.id} compact />
            ))}
          </div>
        </Section>
      )}

      {/* Market overview cards */}
      <Section title={t('intelligencePage.marketSummaryTitle')} sub={t('intelligencePage.marketSummarySub')}>
        {ovLoading ? <Loader /> : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 10 }}>
            {overviewCoins.slice(0, 12).map(c => {
              const up = c.change24h >= 0;
              const anomColor = c.anomaly?.level === 'high' ? 'var(--color-red)' : c.anomaly?.level === 'medium' ? 'var(--color-yellow)' : 'var(--color-green)';
              return (
                <div key={c.id} {...clickableDivProps(() => setFocus(c.id))}
                  style={{ padding: '12px 14px', borderRadius: 'var(--radius-lg)', background: 'var(--bg-surface)', border: `1px solid ${focusCoin === c.id ? 'var(--color-primary)' : 'var(--border)'}`, boxShadow: 'var(--shadow-card)', cursor: 'pointer', transition: 'all var(--transition)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      {c.image && <img src={c.image} alt="" style={{ width: 18, height: 18, borderRadius: '50%' }} />}
                      <span style={{ fontWeight: 800, fontSize: 12 }}>{c.symbol}</span>
                    </div>
                    <div style={{ width: 7, height: 7, borderRadius: '50%', background: anomColor, marginTop: 2 }} title={`${t('intelligencePage.anomalyTooltipPrefix')} ${c.anomaly?.level}`} />
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 3 }}>
                    ${c.price >= 1 ? c.price.toLocaleString('en', { maximumFractionDigits: 2 }) : c.price?.toFixed(5)}
                  </div>
                  <div style={{ fontSize: 11, fontWeight: 600, color: up ? 'var(--color-green)' : 'var(--color-red)' }}>
                    {up ? '+' : ''}{c.change24h?.toFixed(2)}%
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 4 }}>{c.trend}</div>
                </div>
              );
            })}
          </div>
        )}
      </Section>

      {/* Deep analytics for focused coin */}
      <Section title={`${t('intelligencePage.deepAnalysisPrefix')} ${COIN_LIST.find(c => c.id === focusCoin)?.label || focusCoin}`} sub={t('intelligencePage.deepAnalysisSub')}>
        {analLoading ? <Loader /> : analytics ? (
          <div>
            <div className="grid-4" style={{ marginBottom: 16 }}>
              <TrendCard {...(analytics.trend)} />
              <VolatilityCard value={analytics.metrics?.volatility} label={t('intelligencePage.volatilityLabel')} />
              <MomentumCard value={analytics.metrics?.momentum} label={`${t('intelligencePage.momentumLabelPrefix')} · ${period.label}`} />
              <PerformanceCard totalReturn={analytics.metrics?.totalReturn} sharpe={analytics.metrics?.sharpe} drawdown={analytics.metrics?.drawdown} period={period.label} />
            </div>
          </div>
        ) : <div style={{ color: 'var(--text-dim)', fontSize: 13 }}>{t('intelligencePage.selectCoinPrompt')}</div>}
      </Section>

      {/* Scoring ranking */}
      <Section title={t('intelligencePage.scoringTitle')} sub={`${t('intelligencePage.scoringSubPrefix')} momentum 30% · volatility 25% · performance 25% · volume 20% · ${period.label}`}>
        {scLoading ? <Loader /> : (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
            <RankingTable items={scores || []} title={t('intelligencePage.fullRankingTitle')} onSelect={item => setFocus(item.id)} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {(scores || []).slice(0, 4).map((item, i) => (
                <ScoreCard key={item.id} item={item} rank={i + 1} onClick={() => setFocus(item.id)} />
              ))}
            </div>
          </div>
        )}
      </Section>

      {/* Gainers / Losers / Volatile */}
      {!ovLoading && overview && (
        <Section title={t('intelligencePage.gainersLosersTitle')} sub={t('intelligencePage.gainersLosersSub')}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 }}>
            {[
              { label: t('intelligencePage.topGainers'), items: overview.gainers, colorKey: 'green', field: 'change24h' },
              { label: t('intelligencePage.topLosers'),  items: overview.losers,  colorKey: 'red',   field: 'change24h' },
              { label: t('intelligencePage.mostVolatile'), items: overview.mostVolatile, colorKey: 'yellow', field: 'volatility' },
            ].map(({ label, items, colorKey, field }) => (
              <div key={label} className="card" style={{ padding: 0, overflow: 'hidden' }}>
                <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', fontSize: 12, fontWeight: 700 }}>{label}</div>
                {(items || []).map((c, i) => (
                  <div key={c.id} {...clickableDivProps(() => setFocus(c.id))}
                    style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 16px', borderBottom: i < 4 ? '1px solid var(--border)' : 'none', cursor: 'pointer' }}
                    onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-surface-2)'}
                    onMouseLeave={e => e.currentTarget.style.background = ''}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      {c.image && <img src={c.image} alt="" style={{ width: 20, height: 20, borderRadius: '50%' }} />}
                      <span style={{ fontWeight: 700, fontSize: 12 }}>{c.symbol}</span>
                    </div>
                    <span style={{ fontSize: 12, fontWeight: 700, color: colorKey === 'green' ? 'var(--color-green)' : colorKey === 'red' ? 'var(--color-red)' : 'var(--color-yellow)' }}>
                      {field === 'change24h' ? `${c[field] >= 0 ? '+' : ''}${c[field]?.toFixed(2)}%` : `${c[field]}`}
                    </span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}
