import { useState } from 'react';
import { usePolling } from '../hooks/usePolling';
import { api } from '../api';
import { PriceChart } from '../components/common/PriceChart';
import { useTranslation } from '../i18n/I18nContext';

const COINS = [
  { id:'bitcoin',      label:'BTC' },
  { id:'ethereum',     label:'ETH' },
  { id:'solana',       label:'SOL' },
  { id:'binancecoin',  label:'BNB' },
  { id:'ripple',       label:'XRP' },
];
const PERIODS = [{ label:'7d', days:7 },{ label:'30d', days:30 },{ label:'90d', days:90 }];

const fmtP = v => v >= 1 ? `$${v.toLocaleString('en',{maximumFractionDigits:2})}` : `$${v?.toFixed(5)}`;

export default function AnalyticsPage() {
  const { t } = useTranslation();
  const [coin, setCoin]     = useState(COINS[0]);
  const [period, setPeriod] = useState(PERIODS[1]);

  const { data: hist, loading } = usePolling(
    () => api.history(coin.id, period.days),
    120000,
    [coin.id, period.days]
  );
  const { data: mkt } = usePolling(() => api.markets(50), 30000);

  const prices = (hist?.prices || []).map(([,p]) => p);
  const chartData = (hist?.prices || []).map(([ts, price]) => ({
    date: new Date(ts).toLocaleDateString('es-MX',{ month:'short', day:'numeric' }),
    price,
  }));

  const currentCoin = (mkt?.coins || []).find(c => c.id === coin.id);
  const currentPrice = currentCoin?.current_price;

  // Metrics cuantitativas
  const max  = prices.length ? Math.max(...prices) : null;
  const min  = prices.length ? Math.min(...prices) : null;
  const mean = prices.length ? prices.reduce((a,b)=>a+b,0)/prices.length : null;
  const ret  = prices.length > 1 ? ((prices[prices.length-1]-prices[0])/prices[0]*100) : null;
  const vol  = mean && prices.length > 1
    ? (Math.sqrt(prices.reduce((acc,v)=>acc+(v-mean)**2,0)/prices.length)/mean*100)
    : null;

  // Sharpe ratio aproximado (ret/vol, sin risk-free rate)
  const sharpe = ret != null && vol ? (ret / vol).toFixed(2) : null;

  const StatCard = ({ label, value, color, sub }) => (
    <div className="card">
      <div style={{ fontSize:22, fontWeight:800, color: color||'var(--text)' }}>{value}</div>
      <div style={{ fontSize:12, color:'var(--text-muted)', marginTop:4 }}>{label}</div>
      {sub && <div style={{ fontSize:11, color:'var(--text-dim)', marginTop:2 }}>{sub}</div>}
    </div>
  );

  return (
    <div>
      <div style={{ marginBottom:20 }}>
        <h2 style={{ fontSize:20, fontWeight:800, marginBottom:4 }}>⬡ {t('analyticsPage.title')}</h2>
        <p style={{ fontSize:13, color:'var(--text-muted)' }}>{t('analyticsPage.subtitle')}</p>
      </div>

      {/* Selectors */}
      <div style={{ display:'flex', gap:8, marginBottom:20, flexWrap:'wrap' }}>
        {COINS.map(c => (
          <button key={c.id} onClick={() => setCoin(c)}
            className={`btn ${coin.id===c.id?'btn-primary':'btn-secondary'}`}>
            {c.label}
          </button>
        ))}
        <div style={{ marginLeft:'auto', display:'flex', gap:8 }}>
          {PERIODS.map(p => (
            <button key={p.label} onClick={() => setPeriod(p)}
              className={`btn btn-sm ${period.days===p.days?'btn-primary':'btn-secondary'}`}>
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* Chart card */}
      <div className="card" style={{ marginBottom:20 }}>
        <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', marginBottom:20 }}>
          <div>
            <div style={{ fontSize:26, fontWeight:900, letterSpacing:'-1px' }}>
              {currentPrice ? fmtP(currentPrice) : '—'}
            </div>
            <div style={{ fontSize:13, color:'var(--text-muted)', marginTop:2 }}>
              {coin.label} / USD · {period.label} {t('analyticsPage.historicalSuffix')}
            </div>
          </div>
          {ret != null && (
            <div>
              <div style={{ fontSize:20, fontWeight:800, color: ret>=0?'var(--color-green)':'var(--color-red)', textAlign:'right' }}>
                {ret>=0?'+':''}{ret.toFixed(2)}%
              </div>
              <div style={{ fontSize:11, color:'var(--text-muted)', textAlign:'right' }}>{t('analyticsPage.returnLabel')} {period.label}</div>
            </div>
          )}
        </div>
        {loading
          ? <div style={{ height:250, display:'flex', alignItems:'center', justifyContent:'center' }}><div className="spinner" /></div>
          : <PriceChart data={chartData} height={250} />
        }
      </div>

      {/* Stats */}
      <div className="grid-4" style={{ marginBottom:20 }}>
        <StatCard label={`${t('analyticsPage.statMaxLabel')} ${period.label}`}  value={max  ? fmtP(max)  : '—'} color="var(--color-green)"  sub={t('analyticsPage.subHighPrice')} />
        <StatCard label={`${t('analyticsPage.statMinLabel')} ${period.label}`}   value={min  ? fmtP(min)  : '—'} color="var(--color-red)"    sub={t('analyticsPage.subLowPrice')} />
        <StatCard label={t('analyticsPage.statAvgLabel')}             value={mean ? fmtP(mean) : '—'} color="var(--color-blue)"   sub={`${t('analyticsPage.subAvgPrefix')} ${period.label}`} />
        <StatCard label={t('analyticsPage.statVolLabel')}               value={vol  ? `${vol.toFixed(2)}%` : '—'} color="var(--color-yellow)" sub={t('analyticsPage.subStdDev')} />
      </div>

      {/* Extra metrics */}
      <div className="grid-2">
        <div className="card">
          <div style={{ fontSize:13, color:'var(--text-muted)', fontWeight:600, marginBottom:16 }}>{t('analyticsPage.advancedMetricsTitle')}</div>
          {[
            { label: t('analyticsPage.sharpeLabel'), value: sharpe ?? '—', sub: t('analyticsPage.sharpeSub') },
            { label: t('analyticsPage.priceRangeLabel'), value: (max&&min) ? `${fmtP(min)} – ${fmtP(max)}` : '—', sub:`spread ${period.label}` },
            { label: t('analyticsPage.returnVsBtcLabel'), value: currentCoin ? `${currentCoin.price_change_percentage_7d_in_currency?.toFixed(2)}%` : '—', sub: t('analyticsPage.returnVsBtcSub') },
          ].map(r => (
            <div key={r.label} style={{ display:'flex', justifyContent:'space-between', padding:'10px 0', borderBottom:'1px solid var(--border)' }}>
              <div>
                <div style={{ fontSize:13, fontWeight:500 }}>{r.label}</div>
                <div style={{ fontSize:11, color:'var(--text-dim)' }}>{r.sub}</div>
              </div>
              <div style={{ fontWeight:700, fontSize:14 }}>{r.value}</div>
            </div>
          ))}
        </div>

        <div className="card">
          <div style={{ fontSize:13, color:'var(--text-muted)', fontWeight:600, marginBottom:16 }}>{t('analyticsPage.liveMarketDataTitle')}</div>
          {currentCoin && [
            { label: t('analyticsPage.marketCapLabel'), value:`$${(currentCoin.market_cap/1e9).toFixed(2)}B` },
            { label: t('analyticsPage.volume24hLabel'), value:`$${(currentCoin.total_volume/1e9).toFixed(2)}B` },
            { label: t('analyticsPage.rankingLabel'), value:`#${currentCoin.market_cap_rank}` },
            { label: t('analyticsPage.athLabel'), value: fmtP(currentCoin.ath) },
            { label: t('analyticsPage.sinceAthLabel'), value:`${currentCoin.ath_change_percentage?.toFixed(1)}%` },
          ].map(r => (
            <div key={r.label} style={{ display:'flex', justifyContent:'space-between', padding:'10px 0', borderBottom:'1px solid var(--border)' }}>
              <div style={{ fontSize:13, fontWeight:500 }}>{r.label}</div>
              <div style={{ fontWeight:700, fontSize:13 }}>{r.value}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
