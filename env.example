/**
 * ── TRAILER PROVIDER CONTRACT ──────────────────────────────────────────────
 *
 * Every generation backend (mock, Runway, Luma, Pika, ...) must implement
 * exactly this shape. Nothing outside lib/trailerProviders/ may know which
 * concrete provider is active — routes only ever call provider.generate()
 * and, for async providers, receive callbacks through the single webhook
 * route (api/trailer/webhook.js), never through a provider-specific path.
 *
 * This file has no runtime logic. It exists so every provider module and
 * every route can be checked against one shared shape by inspection.
 *
 * @typedef {Object} TrailerGenerationInput
 * @property {string} pageId          - Supabase pages.id this trailer belongs to.
 * @property {string} edition         - 'love' | 'friendship' (drives prompt tone/aspect).
 * @property {string|null} boyName    - Or first-person name; naming kept generic.
 * @property {string|null} girlName
 * @property {string|null} message    - The page's core message, used as prompt seed.
 * @property {string|null} theme      - Theme id (e.g. 'classic', 'midnight') — drives visual style.
 * @property {string[]} photoUrls     - Public URLs of the page's uploaded photos, if any.
 *
 * @typedef {Object} TrailerGenerationResult
 * @property {'queued'|'ready'|'failed'} status
 *   - 'queued': provider is async; a job was accepted, no video yet. The
 *     provider is responsible for calling POST /api/trailer/webhook with
 *     { jobId, status: 'ready', trailerUrl } (or status: 'failed') once done.
 *   - 'ready': provider is synchronous (or mocked) and the video is already
 *     available at trailerUrl. The caller must persist trailerUrl itself.
 *   - 'failed': provider rejected the request outright (bad input, quota, etc).
 * @property {string|null} jobId      - Provider's own job/generation id, if async. Stored so the
 *                                      webhook can be matched back to the right page.
 * @property {string|null} trailerUrl - Present only when status === 'ready'.
 * @property {string|null} error      - Present only when status === 'failed'.
 *
 * @typedef {Object} TrailerProvider
 * @property {string} name - Machine name, e.g. 'mock' | 'runway' | 'luma' | 'pika'.
 * @property {(input: TrailerGenerationInput) => Promise<TrailerGenerationResult>} generate
 * @property {((payload: any) => { jobId: string, status: 'ready'|'failed', trailerUrl?: string, error?: string }) | null} parseWebhook
 *   - Optional: normalizes a provider's raw webhook payload into the shape
 *     api/trailer/webhook.js expects. Providers without a webhook (e.g. Luma,
 *     which is poll-only) can leave this null.
 * @property {((jobId: string) => Promise<{ status: 'pending'|'ready'|'failed', trailerUrl?: string, error?: string }>) | null} checkStatus
 *   - Optional: actively asks the provider whether a queued job has finished.
 *     Required for poll-only providers (Luma); providers that only push via
 *     webhook can leave this null. api/trailer/poll.js calls this on a
 *     schedule for every page still 'pending'.
 */

module.exports = {};
