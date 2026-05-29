import { useState, useCallback, lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import Layout from './components/layout/Layout';
import SplashScreen from './components/SplashScreen';

// Lazy loading — cada página solo carga cuando se navega a ella
// Esto evita que TODAS las páginas hagan polling al mismo tiempo al inicio
const ArbitragePage         = lazy(() => import('./pages/ArbitragePage'));
const DashboardPage         = lazy(() => import('./pages/DashboardPage'));
const MarketsPage           = lazy(() => import('./pages/MarketsPage'));
const WatchlistPage         = lazy(() => import('./pages/WatchlistPage'));
const TechnicalAnalysisPage = lazy(() => import('./pages/TechnicalAnalysisPage'));
const IntelligencePage      = lazy(() => import('./pages/IntelligencePage'));
const RiskPage              = lazy(() => import('./pages/RiskPage'));
const ForecastPage          = lazy(() => import('./pages/ForecastPage'));
const PortfolioPage         = lazy(() => import('./pages/PortfolioPage'));
const AlertsPage            = lazy(() => import('./pages/AlertsPage'));
const MonteCarloPage        = lazy(() => import('./pages/MonteCarloPage'));
const BacktestPage          = lazy(() => import('./pages/BacktestPage'));
const HeatmapPage           = lazy(() => import('./pages/HeatmapPage'));
const ComparePage           = lazy(() => import('./pages/ComparePage'));
const AnalyzePage           = lazy(() => import('./pages/AnalyzePage'));
const DocsPage              = lazy(() => import('./pages/DocsPage'));
const MarketRegimePage      = lazy(() => import('./pages/MarketRegimePage'));
const CorrelationGalaxyPage = lazy(() => import('./pages/CorrelationGalaxyPage'));

function PageLoader() {
  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: 200 }}>
      <div className="spinner" />
    </div>
  );
}

export default function App() {
  const [splashDone, setSplashDone] = useState(false);
  const handleSplashFinish = useCallback(() => setSplashDone(true), []);

  return (
    <>
      {!splashDone && <SplashScreen onFinish={handleSplashFinish} />}

      <BrowserRouter>
        <Toaster
          position="top-right"
          toastOptions={{
            style: {
              background: '#fff', color: '#0f1117',
              border: '1px solid #e5e7eb', borderRadius: '10px',
              fontSize: '13px', fontFamily: 'Inter, system-ui, sans-serif',
              boxShadow: '0 4px 16px rgba(0,0,0,0.08)',
            },
            success: { iconTheme: { primary: '#00b87a', secondary: '#fff' } },
            error:   { iconTheme: { primary: '#f03e3e', secondary: '#fff' } },
          }}
        />
        <Routes>
          <Route element={<Layout />}>
            <Route path="/"             element={<Navigate to="/arbitrage" replace />} />
            <Route path="/arbitrage"    element={<Suspense fallback={<PageLoader />}><ArbitragePage /></Suspense>} />
            <Route path="/dashboard"    element={<Suspense fallback={<PageLoader />}><DashboardPage /></Suspense>} />
            <Route path="/markets"      element={<Suspense fallback={<PageLoader />}><MarketsPage /></Suspense>} />
            <Route path="/watchlist"    element={<Suspense fallback={<PageLoader />}><WatchlistPage /></Suspense>} />
            <Route path="/analytics"    element={<Suspense fallback={<PageLoader />}><TechnicalAnalysisPage /></Suspense>} />
            <Route path="/intelligence" element={<Suspense fallback={<PageLoader />}><IntelligencePage /></Suspense>} />
            <Route path="/risk"         element={<Suspense fallback={<PageLoader />}><RiskPage /></Suspense>} />
            <Route path="/forecast"     element={<Suspense fallback={<PageLoader />}><ForecastPage /></Suspense>} />
            <Route path="/portfolio"    element={<Suspense fallback={<PageLoader />}><PortfolioPage /></Suspense>} />
            <Route path="/alerts"       element={<Suspense fallback={<PageLoader />}><AlertsPage /></Suspense>} />
            <Route path="/montecarlo"   element={<Suspense fallback={<PageLoader />}><MonteCarloPage /></Suspense>} />
            <Route path="/backtest"     element={<Suspense fallback={<PageLoader />}><BacktestPage /></Suspense>} />
            <Route path="/heatmap"      element={<Suspense fallback={<PageLoader />}><HeatmapPage /></Suspense>} />
            <Route path="/compare"      element={<Suspense fallback={<PageLoader />}><ComparePage /></Suspense>} />
            <Route path="/analyze"      element={<Suspense fallback={<PageLoader />}><AnalyzePage /></Suspense>} />
            <Route path="/docs"         element={<Suspense fallback={<PageLoader />}><DocsPage /></Suspense>} />
            <Route path="/regime"       element={<Suspense fallback={<PageLoader />}><MarketRegimePage /></Suspense>} />
            <Route path="/galaxy"       element={<Suspense fallback={<PageLoader />}><CorrelationGalaxyPage /></Suspense>} />
          </Route>
          <Route path="*" element={<Navigate to="/arbitrage" replace />} />
        </Routes>
      </BrowserRouter>
    </>
  );
}
