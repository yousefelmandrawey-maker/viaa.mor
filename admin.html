'use strict';

/**
 * ── MOCK PROVIDER ───────────────────────────────────────────────────────
 *
 * Stands in for Runway / Luma / Pika during development. It never invents
 * or fabricates a video: it simply accepts the generation request the same
 * way a real async vendor would (returns status: 'queued' + a jobId) and
 * waits for something to call POST /api/trailer/webhook — exactly the
 * same path a real vendor's webhook would hit.
 *
 * In development, you finish a "generation" manually:
 *   curl -X POST https://<host>/api/trailer/webhook \
 *     -H "Content-Type: application/json" \
 *     -d '{"provider":"mock","jobId":"<the jobId returned by generate()>",
 *          "status":"ready","trailerUrl":"https://.../your-test-clip.mp4"}'
 *
 * Swap MOCK for a real vendor by changing TRAILER_PROVIDER in lib/trailerProviders/index.js
 * (or the env var it reads) — no other file needs to change.
 */

const crypto = require('crypto');

/** @type {import('./types').TrailerProvider} */
const mockProvider = {
  name: 'mock',

  async generate(input) {
    if (!input || !input.pageId) {
      return { status: 'failed', jobId: null, trailerUrl: null, error: 'Missing pageId' };
    }
    // A real vendor call would happen here instead of this no-op:
    //   const res = await fetch('https://api.<vendor>.com/v1/generate', { ... });
    //   const body = await res.json();
    //   return { status: 'queued', jobId: body.id, trailerUrl: null, error: null };
    const jobId = `mock_${crypto.randomUUID()}`;
    return { status: 'queued', jobId, trailerUrl: null, error: null };
  },

  // The mock's own "webhook" payload shape is already the normalized shape,
  // so this is an identity pass-through. A real provider's parseWebhook
  // would translate its vendor-specific payload into the same fields.
  parseWebhook(payload) {
    if (!payload || !payload.jobId) return null;
    return {
      jobId: payload.jobId,
      status: payload.status === 'ready' ? 'ready' : 'failed',
      trailerUrl: payload.trailerUrl || null,
      error: payload.error || null,
    };
  },

  // Mock also supports the poll path so api/trailer/poll.js can be tested
  // end-to-end locally without a webhook call. Since the mock has no real
  // backing job store, it simply stays 'pending' forever here — use the
  // webhook curl documented above to actually resolve a mock job in dev.
  async checkStatus(_jobId) {
    return { status: 'pending' };
  },
};

module.exports = mockProvider;
