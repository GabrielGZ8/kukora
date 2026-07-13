'use strict';

/**
 * server/repositories/alertRepository.js — Alert entity repository.
 * Extraído de repositories/index.js (ver baseRepository.js para el
 * contexto completo del refactor).
 */

const { BaseRepository } = require('./baseRepository');

class AlertRepository extends BaseRepository {
  /** @param {import('mongoose').Model} AlertModel */
  constructor(AlertModel) { super(AlertModel); }

  async listForUser(userId) {
    return this.findByUser(userId);
  }

  async addAlert(userId, alertData) {
    return this.create(userId, alertData);
  }

  async deleteAlert(userId, alertId) {
    return this.deleteByUser(userId, alertId);
  }

  async updateAlert(userId, alertId, patch) {
    return this.updateByUser(userId, alertId, patch);
  }
}

module.exports = { AlertRepository };
