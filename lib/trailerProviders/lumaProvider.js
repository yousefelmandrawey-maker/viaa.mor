'use strict';

/**
 * ── LUMA DREAM MACHINE PROVIDER ─────────────────────────────────────────
 *
 * Real integration with Luma's Dream Machine video generation API.
 * Chosen for this sprint because its API is the simplest of the three
 * allowed options to integrate correctly: a single POST to create a
 * generation, a single GET to check its state — no multi-step asset
 * upload pipeline (Runway) and no queue-priority tiers to reason about
 * (Pika). It is poll-only (no webhook), which is why api/trailer/poll.js
 * exists — the task requires polling regardless of provider, so this is
 * a natural fit rather than a workaround.
 *
 * Docs (for reference, subject to Luma's own versioning):
 *   POST https://api.lumalabs.ai/dream-machine/v1/generations
 *   GET  https://api.lumalabs.ai/dream-machine/v1/generations/{id}
 *
 * Required environment variable:
 *   LUMA_API_KEY
 *
 * This module owns 100% of the Luma-specific request/response shape.
 * Nothing outside lib/trailerProviders/ ever sees a Luma field name —
 * queue.js and poll.js only ever see the generic TrailerProvider contract.
 */

const LUMA_API_BASE = 'https://api.lumalabs.ai/dream-machine/v1';

function buildPrompt(input) {
    // The prompt is intentionally built from real page data only — names,
    // theme, and message — never invented content. Luma is text/image-to-video,
    // so a strong text prompt plus (if available) a reference photo is used.
    const names = [input.boyName, input.girlName].filter(Boolean).join(' & ');
    const themeMood = input.theme ? `in a ${input.theme.replace(/_/g, ' ')} visual style` : '';
    const base = names
        ? `A cinematic, emotional short trailer celebrating ${names}${themeMood ? ' ' + themeMood : ''}. Soft lighting, gentle camera motion, romantic atmosphere.`
        : `A cinematic, emotional short trailer${themeMood ? ' ' + themeMood : ''}. Soft lighting, gentle camera motion.`;
    return base;
}

/** @type {import('./types').TrailerProvider} */
const lumaProvider = {
    name: 'luma',

    async generate(input) {
        if (!input || !input.pageId) {
            return { status: 'failed', jobId: null, trailerUrl: null, error: 'Missing pageId' };
        }

        const apiKey = process.env.LUMA_API_KEY;
        if (!apiKey) {
            return { status: 'failed', jobId: null, trailerUrl: null, error: 'LUMA_API_KEY is not configured' };
        }

        const body = {
            prompt: buildPrompt(input),
            model: 'ray-2', // required by Luma's current API; Ray 1 is retired,
            // Ray 2 is the current supported model as of this writing
            aspect_ratio: '9:16', // vertical, matching the Reels/TikTok-style trailer format
            loop: false,
        };
        // If the page has a photo, use it as the generation's starting frame —
        // Luma supports an image reference via keyframes.
        if (input.photoUrls && input.photoUrls.length > 0) {
            body.keyframes = { frame0: { type: 'image', url: input.photoUrls[0] } };
        }

        try {
            const res = await fetch(`${LUMA_API_BASE}/generations`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${apiKey}`,
                },
                body: JSON.stringify(body),
            });

            const data = await res.json().catch(() => null);

            if (!res.ok || !data || !data.id) {
                return {
                    status: 'failed',
                    jobId: null,
                    trailerUrl: null,
                    error: (data && (data.detail || data.message)) || `Luma create-generation failed (HTTP ${res.status})`,
                };
            }

            // Luma has no webhook — this job is always 'queued' until poll.js
            // calls checkStatus() and finds it done.
            return { status: 'queued', jobId: data.id, trailerUrl: null, error: null };
        } catch (err) {
            return { status: 'failed', jobId: null, trailerUrl: null, error: err.message || 'Network error calling Luma' };
        }
    },

    // Luma is poll-only — it never calls our webhook, so parseWebhook is
    // intentionally not implemented. api/trailer/webhook.js already handles
    // a provider not supporting webhooks with a clean 501, so this is safe.
    parseWebhook: null,

    async checkStatus(jobId) {
        const apiKey = process.env.LUMA_API_KEY;
        if (!apiKey) {
            return { status: 'failed', error: 'LUMA_API_KEY is not configured' };
        }

        try {
            const res = await fetch(`${LUMA_API_BASE}/generations/${encodeURIComponent(jobId)}`, {
                headers: { Authorization: `Bearer ${apiKey}` },
            });
            const data = await res.json().catch(() => null);

            if (!res.ok || !data) {
                return { status: 'failed', error: `Luma status check failed (HTTP ${res.status})` };
            }

            if (data.state === 'completed' && data.assets && data.assets.video) {
                return { status: 'ready', trailerUrl: data.assets.video };
            }
            if (data.state === 'failed') {
                return { status: 'failed', error: data.failure_reason || 'Luma reported generation failure' };
            }
            // 'queued' or 'dreaming' → still in progress.
            return { status: 'pending' };
        } catch (err) {
            return { status: 'failed', error: err.message || 'Network error checking Luma status' };
        }
    },
};

module.exports = lumaProvider;