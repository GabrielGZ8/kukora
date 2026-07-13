'use strict';

/**
 * server/repositories/index.js — Repository Layer barrel (audit Level 3 #3;
 * refactorizado en la sesión de cierre del hallazgo estructural "repositorio
 * único de 315 líneas" de la auditoría de comité 2026-07-08, sección de
 * Arquitectura).
 *
 * Este archivo era antes 315 líneas conteniendo 5 responsabilidades
 * distintas (BaseRepository, 3 repos concretos, MockRepository, factory).
 * Ahora cada una vive en su propio archivo bajo server/repositories/,
 * mismo patrón que la reorganización de domain/ en subcarpetas (hallazgo
 * #3 de la hoja de ruta de 8 puntos, ya cerrado):
 *
 *   - baseRepository.js       → BaseRepository + _logDbError
 *   - alertRepository.js      → AlertRepository
 *   - watchlistRepository.js  → WatchlistRepository
 *   - portfolioRepository.js  → PortfolioRepository
 *   - mockRepository.js       → MockRepository (para tests)
 *
 * Este barrel NO cambia la API pública: sigue exportando exactamente los
 * mismos 6 nombres (BaseRepository, AlertRepository, WatchlistRepository,
 * PortfolioRepository, MockRepository, buildRepositories) desde el mismo
 * path (`server/repositories/index.js` / `require('../repositories')`),
 * así que ningún consumidor (alerts/watchlist/portfolio.routes.js,
 * tests/repositories.test.js, tests/repositories-real.test.js) necesitó
 * cambiar una sola línea.
 */

const { BaseRepository } = require('./baseRepository');
const { AlertRepository } = require('./alertRepository');
const { WatchlistRepository } = require('./watchlistRepository');
const { PortfolioRepository } = require('./portfolioRepository');
const { MockRepository } = require('./mockRepository');

/**
 * Build concrete repositories from the models index.
 * Called lazily so require('./models') doesn't run at import time (safe for tests).
 */
function buildRepositories() {
  const { Alert, Watchlist, Portfolio } = require('../models');
  return {
    alerts:    new AlertRepository(Alert),
    watchlist: new WatchlistRepository(Watchlist),
    portfolio: new PortfolioRepository(Portfolio),
  };
}

module.exports = {
  BaseRepository,
  AlertRepository,
  WatchlistRepository,
  PortfolioRepository,
  MockRepository,
  buildRepositories,
};
