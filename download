'use strict';

/**
 * ── PROVIDER REGISTRY ───────────────────────────────────────────────────
 *
 * This is the ONLY file that should ever change when swapping AI vendors.
 * Every route (api/trailer/*.js) imports getActiveProvider() from here —
 * never a concrete provider module directly.
 *
 * Currently connected: Luma Dream Machine ('luma'), set as the default.
 * 'mock' remains available for local development (TRAILER_PROVIDER=mock).
 *
 * To swap to a different real vendor later:
 *   1. Add lib/trailerProviders/runwayProvider.js (or pika.js) implementing
 *      the same TrailerProvider shape as lumaProvider.js.
 *   2. Register it in the PROVIDERS map below.
 *   3. Set TRAILER_PROVIDER=runway (or pika) in your environment.
 * No changes needed in api/trailer/queue.js, api/trailer/poll.js,
 * api/trailer/webhook.js, success.html, love.html, friendship.html, or app.html.
 */

const mockProvider = require('./mockProvider');
const lumaProvider = require('./lumaProvider');

const PROVIDERS = {
  mock: mockProvider,
  luma: lumaProvider,
  // runway: require('./runwayProvider'),  // add once implemented
  // pika:   require('./pikaProvider'),    // add once implemented
};

function getActiveProvider() {
  const key = (process.env.TRAILER_PROVIDER || 'luma').toLowerCase();
  const provider = PROVIDERS[key];
  if (!provider) {
    throw new Error(
      `[trailer-engine] Unknown TRAILER_PROVIDER "${key}". Known providers: ${Object.keys(PROVIDERS).join(', ')}`
    );
  }
  return provider;
}

module.exports = { getActiveProvider, PROVIDERS };
