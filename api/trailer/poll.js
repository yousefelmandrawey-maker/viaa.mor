'use strict';

/**
 * /api/trailer/poll
 *
 * Runs on a schedule (see vercel.json cron entry) rather than being called
 * by the frontend. Responsible for requirement #4 ("Poll the provider") —
 * for providers like Luma that have no webhook, this is the only way a
 * 'pending' job ever moves forward.
 *
 * For every page currently trailer_status = 'pending':
 *   1. Ask the active provider's checkStatus(jobId) — never assumes; only
 *      trusts what the provider actually reports.
 *   2. 'ready'   → download the video and upload it to Supabase Storage
 *                  (lib/trailerStorage.js), then set trailer_url + status='ready'.
 *   3. 'failed'  → hand off to lib/trailerRetry.js, which retries
 *                  automatically up to MAX_RETRIES before permanently
 *                  marking the page 'failed'.
 *   4. 'pending' → left untouched; will be checked again next run.
 *
 * Providers without checkStatus (webhook-only providers) are simply skipped
 * here — their pages resolve via api/trailer/webhook.js instead.
 */

const { getSupabaseAdmin } = require('../../lib/supabaseAdmin');
const { getActiveProvider } = require('../../lib/trailerProviders');
const { persistTrailerVideo } = require('../../lib/trailerStorage');
const { handleGenerationFailure } = require('../../lib/trailerRetry');

let checkRateLimit;
try {
    ({ checkRateLimit } = require('../_lib/rateLimit'));
} catch (_) {
    checkRateLimit = async () => ({ allowed: true, degraded: true });
}

const MAX_PAGES_PER_RUN = 25; // keep each cron invocation bounded

module.exports = async function handler(req, res) {
    // Allow Vercel Cron (GET) and manual/admin triggering (POST) alike.
    if (req.method !== 'GET' && req.method !== 'POST') {
        res.status(405).json({ success: false, error: 'Method not allowed' });
        return;
    }

    // SECURITY: this route has no authentication — Vercel Cron calls it via
    // unauthenticated GET on schedule, and it was documented as also allowing
    // manual/admin POST. Since it takes no user-supplied input (no body/query
    // params are read below) it can't leak or corrupt arbitrary data, but an
    // open endpoint that calls a billed third-party provider's checkStatus
    // for every pending page is still worth capping against being hit far
    // more often than the 2-minute cron schedule intends. This limiter is
    // shared across all callers (no per-IP key), which is deliberate: the
    // goal is bounding total invocation frequency, not identifying a caller.
    //
    // Stronger option, not applied here since it requires confirming exact
    // current Vercel behavior against their docs rather than assuming it:
    // Vercel can inject a `CRON_SECRET` bearer token automatically on its own
    // cron-triggered requests, checkable here to distinguish real cron calls
    // from anyone else hitting this URL. Worth wiring in if confirmed.
    const rl = await checkRateLimit('trailer-poll:global', 10, 60); // 10/min total
    if (!rl.allowed) {
        res.status(429).json({ success: false, error: 'Poll invoked too frequently' });
        return;
    }

    const provider = getActiveProvider();

    if (typeof provider.checkStatus !== 'function') {
        // Nothing to do — this provider only resolves via webhook.
        res.status(200).json({ success: true, checked: 0, note: `Provider "${provider.name}" has no checkStatus; skipping poll.` });
        return;
    }

    const db = getSupabaseAdmin();
    const results = { checked: 0, ready: 0, retried: 0, failed: 0, stillPending: 0, errors: [] };

    try {
        const { data: pendingPages, error: listErr } = await db
            .from('pages')
            .select('id, edition, boy_name, girl_name, message, theme, trailer_job_id, trailer_retry_count')
            .eq('trailer_status', 'pending')
            .not('trailer_job_id', 'is', null)
            .limit(MAX_PAGES_PER_RUN);

        if (listErr) throw listErr;

        for (const page of pendingPages || []) {
            results.checked++;
            try {
                const statusResult = await provider.checkStatus(page.trailer_job_id);

                if (statusResult.status === 'ready') {
                    if (!statusResult.trailerUrl) {
                        throw new Error('Provider reported ready with no trailerUrl');
                    }
                    const trailerUrl = await persistTrailerVideo(page.id, statusResult.trailerUrl);
                    await db
                        .from('pages')
                        .update({ trailer_status: 'ready', trailer_url: trailerUrl })
                        .eq('id', page.id);
                    results.ready++;
                    continue;
                }

                if (statusResult.status === 'failed') {
                    const { data: photos } = await db.from('photos').select('photo_url').eq('page_id', page.id);
                    const photoUrls = (photos || []).map((p) => p.photo_url);
                    const retryOutcome = await handleGenerationFailure(db, page, photoUrls, statusResult.error);

                    if (retryOutcome.status === 'ready' && retryOutcome.trailerUrl) {
                        const trailerUrl = await persistTrailerVideo(page.id, retryOutcome.trailerUrl);
                        await db.from('pages').update({ trailer_status: 'ready', trailer_url: trailerUrl }).eq('id', page.id);
                        results.ready++;
                    } else if (retryOutcome.status === 'failed') {
                        results.failed++;
                    } else {
                        results.retried++;
                    }
                    continue;
                }

                // Still 'pending' per the provider — nothing to do this run.
                results.stillPending++;
            } catch (pageErr) {
                console.error(`[trailer-engine] poll error for page ${page.id}:`, pageErr);
                results.errors.push({ pageId: page.id, error: pageErr.message });
            }
        }

        res.status(200).json({ success: true, ...results });
    } catch (err) {
        console.error('[trailer-engine] poll fatal error:', err);
        res.status(500).json({ success: false, error: 'Internal error during trailer poll' });
    }
};