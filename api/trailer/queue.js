'use strict';

/**
 * POST /api/trailer/queue
 * Body: { pageId: string }
 *
 * Called exactly once — by success.html, right after a Premium Trailer
 * payment is confirmed approved. Responsible for:
 *   1. Loading the page's own data (names, message, theme, photos) to build
 *      the generation input — the pipeline never invents page content.
 *   2. Calling the active provider's generate().
 *   3. Persisting the result:
 *        - queued  → trailer_status = 'pending', trailer_job_id stored.
 *                    api/trailer/poll.js (on a schedule) checks the provider
 *                    until it finishes.
 *        - ready   → the video is downloaded and re-hosted in Supabase
 *                    Storage (lib/trailerStorage.js) before trailer_url is
 *                    ever saved — only a synchronous/mock provider hits this
 *                    branch directly from here.
 *        - failed  → does NOT immediately give up. lib/trailerRetry.js
 *                    retries automatically (see MAX_RETRIES) before the page
 *                    is ever marked 'failed' for real.
 *
 * This route is idempotent per pageId: if a job is already pending, it will
 * not double-queue — it returns the existing job status instead.
 */

const { getSupabaseAdmin } = require('../../lib/supabaseAdmin');
const { getActiveProvider } = require('../../lib/trailerProviders');
const { persistTrailerVideo } = require('../../lib/trailerStorage');
const { handleGenerationFailure } = require('../../lib/trailerRetry');

// Reuses the same sliding-window limiter as the payment API (backed by the
// check_rate_limit Postgres function — see api/_lib/rateLimit.js). Imported
// directly since this file's lib/ tree is separate from api/_lib/; if this
// path doesn't match the real deployed layout, adjust to wherever
// check_rate_limit is actually callable from here.
let checkRateLimit;
try {
  ({ checkRateLimit } = require('../_lib/rateLimit'));
} catch (_) {
  // If the shared limiter isn't reachable from this file's location in the
  // real deployment, fail safe to "no extra limiting" rather than crash the
  // route — the trailer_type gate below is still enforced either way.
  checkRateLimit = async () => ({ allowed: true, degraded: true });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ success: false, error: 'Method not allowed' });
    return;
  }

  const { pageId } = req.body || {};
  if (!pageId || typeof pageId !== 'string' || pageId.length > 100) {
    res.status(400).json({ success: false, error: 'Missing pageId' });
    return;
  }

  // This endpoint calls a billed third-party provider (Luma/Runway/Pika).
  // Rate limit by pageId first — cheap, and caps repeated-trigger abuse
  // against one specific page regardless of caller IP.
  const rl = await checkRateLimit(`trailer-queue:${pageId}`, 5, 3600); // 5/hour/page
  if (!rl.allowed) {
    res.status(429).json({ success: false, error: 'Too many requests for this page, please try again later' });
    return;
  }

  const db = getSupabaseAdmin();

  try {
    const { data: page, error: pageErr } = await db
      .from('pages')
      .select('id, edition, boy_name, girl_name, message, theme, trailer_type, trailer_status, trailer_job_id, trailer_retry_count')
      .eq('id', pageId)
      .single();

    if (pageErr || !page) {
      res.status(404).json({ success: false, error: 'Page not found' });
      return;
    }

    // AUTHORIZATION GATE
    //
    // This route is called by success.html immediately after a Premium
    // Trailer payment is approved, with no session/login of its own (the
    // Builder is anonymous, gated only by an access code). Verify server-
    // side that an APPROVED payment actually exists for THIS exact pageId —
    // not just that the page was created with trailer_type='premium', which
    // only proves intent, not payment. This requires the payments.page_id
    // column (see store.js's createPayment) — if that column doesn't exist
    // yet in a given deployment (pre-migration), fall back to the weaker
    // trailer_type check so the route doesn't hard-fail, but log loudly
    // since that fallback is a real, known gap.
    let hasApprovedPayment = false;
    try {
      const { data: paymentMatch, error: payErr } = await db
        .from('payments')
        .select('id')
        .eq('page_id', pageId)
        .eq('status', 'approved')
        .limit(1)
        .maybeSingle();
      if (payErr && payErr.code === '42703') {
        console.error('[trailer-engine] queue: payments.page_id column missing — falling back to trailer_type-only check. Run the migration in store.js\'s createPayment comment.');
        hasApprovedPayment = page.trailer_type === 'premium';
      } else if (payErr) {
        throw payErr;
      } else {
        hasApprovedPayment = !!paymentMatch;
      }
    } catch (err) {
      console.error('[trailer-engine] queue: payment verification failed:', err.message);
      res.status(502).json({ success: false, error: 'Could not verify payment for this page' });
      return;
    }

    if (!hasApprovedPayment) {
      res.status(403).json({ success: false, error: 'No approved Premium Trailer payment found for this page' });
      return;
    }

    // Idempotency guard: don't double-queue a page that's already pending.
    if (page.trailer_status === 'pending' && page.trailer_job_id) {
      res.status(200).json({
        success: true,
        status: 'pending',
        jobId: page.trailer_job_id,
        note: 'Generation already in progress for this page.',
      });
      return;
    }

    const { data: photos } = await db
      .from('photos')
      .select('photo_url')
      .eq('page_id', pageId);
    const photoUrls = (photos || []).map((p) => p.photo_url);

    const provider = getActiveProvider();

    const result = await provider.generate({
      pageId: page.id,
      edition: page.edition || 'love',
      boyName: page.boy_name || null,
      girlName: page.girl_name || null,
      message: page.message || null,
      theme: page.theme || null,
      photoUrls,
    });

    if (result.status === 'failed') {
      // Do not mark 'failed' immediately — try automatic retries first,
      // per the shared retry policy (up to MAX_RETRIES, then permanent fail).
      const retryOutcome = await handleGenerationFailure(db, page, photoUrls, result.error);
      if (retryOutcome.status === 'ready') {
        const trailerUrl = await persistTrailerVideo(pageId, retryOutcome.trailerUrl);
        await db.from('pages').update({ trailer_status: 'ready', trailer_url: trailerUrl }).eq('id', pageId);
        res.status(200).json({ success: true, status: 'ready', trailerUrl });
        return;
      }
      res.status(retryOutcome.status === 'failed' ? 502 : 200).json({
        success: retryOutcome.status !== 'failed',
        status: retryOutcome.status,
        error: retryOutcome.status === 'failed' ? (result.error || 'Provider rejected the request after retries') : undefined,
        jobId: retryOutcome.jobId,
      });
      return;
    }

    if (result.status === 'ready') {
      // Synchronous/mock provider path — download the video for real and
      // re-host it in Supabase Storage rather than trusting a (likely
      // temporary) provider-hosted URL directly.
      const trailerUrl = await persistTrailerVideo(pageId, result.trailerUrl);
      await db
        .from('pages')
        .update({
          trailer_type: 'premium',
          trailer_status: 'ready',
          trailer_url: trailerUrl,
          trailer_job_id: result.jobId || null,
        })
        .eq('id', pageId);
      res.status(200).json({ success: true, status: 'ready', trailerUrl });
      return;
    }

    // Default / real-world path: 'queued'. Store the job id so poll.js
    // (and, for providers that support it, the webhook) can match progress
    // back to this page; status is 'pending' until generation completes.
    await db
      .from('pages')
      .update({
        trailer_type: 'premium',
        trailer_status: 'pending',
        trailer_job_id: result.jobId || null,
      })
      .eq('id', pageId);

    res.status(200).json({ success: true, status: 'pending', jobId: result.jobId });
  } catch (err) {
    console.error('[trailer-engine] queue error:', err);
    res.status(500).json({ success: false, error: 'Internal error queueing trailer generation' });
  }
};
