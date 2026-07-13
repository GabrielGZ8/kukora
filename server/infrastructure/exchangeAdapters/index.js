'use strict';

/**
 * exchangeAdapters/index.js — plugin loader.
 *
 * Scans this directory for *.adapter.js files and returns their descriptors.
 * This is what makes exchangeRegistry.js's registration step data-driven
 * instead of a hardcoded list of registerExchange() calls: adding a 6th
 * exchange is now "drop a file here", full stop — exchangeRegistry.js does
 * not need to change at all (see its own header comment for the before/
 * after).
 *
 * Validation happens here, once, at load time — a malformed adapter fails
 * fast with a clear error naming the offending file, rather than surfacing
 * as a confusing runtime bug three layers away in the scoring engine.
 */

const fs = require('fs');
const path = require('path');

const REQUIRED_FIELDS = ['name', 'id', 'wsUrl', 'pairs', 'fees'];

function _validate(descriptor, filename) {
  for (const field of REQUIRED_FIELDS) {
    if (descriptor[field] === undefined) {
      throw new Error(`exchangeAdapters: "${filename}" is missing required field "${field}"`);
    }
  }
  if (!Array.isArray(descriptor.pairs) || descriptor.pairs.length === 0) {
    throw new Error(`exchangeAdapters: "${filename}" — pairs must be a non-empty array`);
  }
  if (typeof descriptor.fees?.taker !== 'number' || typeof descriptor.fees?.maker !== 'number') {
    throw new Error(`exchangeAdapters: "${filename}" — fees.maker and fees.taker must be numbers`);
  }
}

/** Discover and load every adapter in this directory. Pure/sync — safe to call at require-time. */
function loadAdapters() {
  const files = fs.readdirSync(__dirname).filter((f) => f.endsWith('.adapter.js'));
  const descriptors = [];
  for (const file of files) {
    // eslint-disable-next-line global-require
    const descriptor = require(path.join(__dirname, file));
    _validate(descriptor, file);
    descriptors.push(descriptor);
  }
  return descriptors;
}

module.exports = { loadAdapters };
