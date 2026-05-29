import { useState } from 'react';

import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';

import Layout from './components/layout/Layout';
import SplashScreen from './components/SplashScreen';

import DashboardPage         from './pages/DashboardPage';
import MarketsPage           from './pages/MarketsPage';
import WatchlistPage         from './pages/WatchlistPage';
import TechnicalAnalysisPage from './pages/TechnicalAnalysisPage';
import IntelligencePage      from './pages/IntelligencePage';
import RiskPage              from './pages/RiskPage';
import ForecastPage          from './pages/ForecastPage';
import PortfolioPage         from './pages/PortfolioPage';
import AlertsPage            from './pages/AlertsPage';
import MonteCarloPage        from './pages/MonteCarloPage';
import BacktestPage          from './pages/BacktestPage';
import HeatmapPage           from './pages/HeatmapPage';
import MarketRegimePage      from './pages/MarketRegimePage';
import CorrelationGalaxyPage from './pages/CorrelationGalaxyPage';
import ComparePage           from './pages/ComparePage';

export default function App() {

  const [showSplash, setShowSplash] = useState(true);

  return (
    <>
      {/* SPLASH SCREEN */}
      {showSplash && (
        <SplashScreen
          onFinish={() => setShowSplash(false)}
        />
      )}

      {/* APP */}
      <BrowserRouter>

        <Toaster
          position="top-right"
          toastOptions={{
            style: {
              background: 'var(--bg-elevated)',
              color: 'var(--text)',
              border: '1px solid var(--border-bright)',
              fontFamily: 'var(--font-ui)',
            },
          }}
        />

        <Routes>

          <Route element={<Layout />}>

            <Route
              path="/"
              element={<Navigate to="/dashboard" replace />}
            />

            <Route
              path="/dashboard"
              element={<DashboardPage />}
            />

            <Route
              path="/markets"
              element={<MarketsPage />}
            />

            <Route
              path="/watchlist"
              element={<WatchlistPage />}
            />

            <Route
              path="/analytics"
              element={<TechnicalAnalysisPage />}
            />

            <Route
              path="/intelligence"
              element={<IntelligencePage />}
            />

            <Route
              path="/risk"
              element={<RiskPage />}
            />

            <Route
              path="/forecast"
              element={<ForecastPage />}
            />

            <Route
              path="/portfolio"
              element={<PortfolioPage />}
            />

            <Route
              path="/alerts"
              element={<AlertsPage />}
            />

            <Route
              path="/montecarlo"
              element={<MonteCarloPage />}
            />

            <Route
              path="/backtest"
              element={<BacktestPage />}
            />

            <Route
              path="/heatmap"
              element={<HeatmapPage />}
            />

            <Route
              path="/compare"
              element={<ComparePage />}
            />

            <Route
              path="/regime"
              element={<MarketRegimePage />}
            />

            <Route
              path="/galaxy"
              element={<CorrelationGalaxyPage />}
            />

          </Route>

          <Route
            path="*"
            element={<Navigate to="/dashboard" replace />}
          />

        </Routes>

      </BrowserRouter>
    </>
  );
}