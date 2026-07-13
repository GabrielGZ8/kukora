import { useState, useCallback, lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import Layout from './components/layout/Layout';
import SplashScreen from './components/common/SplashScreen'; // Issue 18: use canonical common/ version
import ErrorBoundary from './components/common/ErrorBoundary';
import PageSkeleton from './components/common/PageSkeleton';
import { AppStateProvider } from './state/AppStateContext';
import { AuthProvider, useAuth } from './state/AuthContext';
import { I18nProvider } from './i18n/I18nContext';
import LoginPage from './pages/LoginPage';
import RegisterPage from './pages/RegisterPage';

// Lazy loading — each page only loads when navigated to.
// This prevents all pages from initiating polling simultaneously on load.
const ArbitragePage         = lazy(() => import('./pages/ArbitragePage'));
const ExecutiveDashboardPage = lazy(() => import('./pages/ExecutiveDashboardPage'));
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
const AnalyticsPage         = lazy(() => import('./pages/AnalyticsPage'));
const AboutPage             = lazy(() => import('./pages/AboutPage'));
const SummaryPage           = lazy(() => import('./pages/SummaryPage'));
const ArbBacktestPage       = lazy(() => import('./pages/ArbBacktestPage'));
const TenantComparisonPage  = lazy(() => import('./pages/TenantComparisonPage'));
const SettingsPage          = lazy(() => import('./pages/SettingsPage'));
const ProfilePage           = lazy(() => import('./pages/ProfilePage'));
const ErrorPage             = lazy(() => import('./pages/ErrorPage'));
import NotFoundPage from './pages/NotFoundPage';

function PageLoader() {
  return <PageSkeleton />;
}

function ProtectedRoute({ children }) {
  const { isAuthenticated, loading } = useAuth();
  if (loading) return <PageSkeleton />;
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  return children;
}

export default function App() {
  const [splashDone, setSplashDone] = useState(false);
  const handleSplashFinish = useCallback(() => setSplashDone(true), []);

  return (
    <>
      {!splashDone && <SplashScreen onFinish={handleSplashFinish} />}

      <ErrorBoundary>
      <I18nProvider>
      <AuthProvider>
      <AppStateProvider>
      <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <Toaster
          position="top-right"
          toastOptions={{
            style: {
              background: 'var(--bg-elevated)', color: 'var(--text)',
              border: '1px solid var(--border-bright)', borderRadius: '10px',
              fontSize: '13px', fontFamily: 'var(--font-ui)',
              boxShadow: 'var(--shadow-lg)',
            },
            success: { iconTheme: { primary: 'var(--color-green)', secondary: 'var(--bg-surface)' } },
            error:   { iconTheme: { primary: 'var(--color-red)',   secondary: 'var(--bg-surface)' } },
          }}
        />
        <Routes>
          <Route path="/login"    element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
          <Route element={<ProtectedRoute><Layout /></ProtectedRoute>}>
            <Route path="/"             element={<Navigate to="/executive" replace />} />
            <Route path="/executive"    element={<Suspense fallback={<PageLoader />}><ExecutiveDashboardPage /></Suspense>} />
            <Route path="/summary"      element={<Suspense fallback={<PageLoader />}><SummaryPage /></Suspense>} />
            <Route path="/arbitrage"    element={<Suspense fallback={<PageLoader />}><ArbitragePage /></Suspense>} />
            <Route path="/dashboard"    element={<Suspense fallback={<PageLoader />}><DashboardPage /></Suspense>} />
            <Route path="/markets"      element={<Suspense fallback={<PageLoader />}><MarketsPage /></Suspense>} />
            <Route path="/watchlist"    element={<Suspense fallback={<PageLoader />}><WatchlistPage /></Suspense>} />
            <Route path="/analytics"    element={<Suspense fallback={<PageLoader />}><AnalyticsPage /></Suspense>} />
            <Route path="/analytics-ta" element={<Suspense fallback={<PageLoader />}><TechnicalAnalysisPage /></Suspense>} />
            <Route path="/intelligence" element={<Suspense fallback={<PageLoader />}><IntelligencePage /></Suspense>} />
            <Route path="/risk"         element={<Suspense fallback={<PageLoader />}><RiskPage /></Suspense>} />
            <Route path="/forecast"     element={<Suspense fallback={<PageLoader />}><ForecastPage /></Suspense>} />
            <Route path="/portfolio"    element={<Suspense fallback={<PageLoader />}><PortfolioPage /></Suspense>} />
            <Route path="/alerts"       element={<Suspense fallback={<PageLoader />}><AlertsPage /></Suspense>} />
            <Route path="/montecarlo"   element={<Suspense fallback={<PageLoader />}><MonteCarloPage /></Suspense>} />
            <Route path="/backtest"     element={<Suspense fallback={<PageLoader />}><BacktestPage /></Suspense>} />
            <Route path="/arb-backtest" element={<Suspense fallback={<PageLoader />}><ArbBacktestPage /></Suspense>} />
            <Route path="/tenant-compare" element={<Suspense fallback={<PageLoader />}><TenantComparisonPage /></Suspense>} />
            <Route path="/heatmap"      element={<Suspense fallback={<PageLoader />}><HeatmapPage /></Suspense>} />
            <Route path="/compare"      element={<Suspense fallback={<PageLoader />}><ComparePage /></Suspense>} />
            <Route path="/analyze"      element={<Suspense fallback={<PageLoader />}><AnalyzePage /></Suspense>} />
            <Route path="/docs"         element={<Suspense fallback={<PageLoader />}><DocsPage /></Suspense>} />
            <Route path="/regime"       element={<Suspense fallback={<PageLoader />}><MarketRegimePage /></Suspense>} />
            <Route path="/galaxy"       element={<Suspense fallback={<PageLoader />}><CorrelationGalaxyPage /></Suspense>} />
            <Route path="/about"        element={<Suspense fallback={<PageLoader />}><AboutPage /></Suspense>} />
            <Route path="/settings"     element={<Suspense fallback={<PageLoader />}><SettingsPage /></Suspense>} />
            <Route path="/profile"      element={<Suspense fallback={<PageLoader />}><ProfilePage /></Suspense>} />
          </Route>
          <Route path="/404" element={<NotFoundPage />} />
          <Route path="/error" element={<Suspense fallback={<PageLoader />}><ErrorPage /></Suspense>} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </BrowserRouter>
      </AppStateProvider>
      </AuthProvider>
      </I18nProvider>
      </ErrorBoundary>
    </>
  );
}
