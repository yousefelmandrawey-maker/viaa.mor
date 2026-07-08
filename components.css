'use strict';

/**
 * ── TRAILER RETRY POLICY ────────────────────────────────────────────────
 *
 * Centralizes "what happens when a generation attempt fails" so queue.js
 * (initial failure) and poll.js (failure discovered while polling) apply
 * the exact same policy instead of duplicating retry counting logic.
 *
 * Policy: up to MAX_RETRIES automatic re-attempts (a fresh call to the
 * active provider's generate()), with a short backoff between attempts.
 * After MAX_RETRIES is exhausted, the page is marked 'failed' permanently
 * and a human has to intervene — this pipeline never silently keeps
 * retrying forever, and never fabricates a "ready" result.
 */

const { getActiveProvider } = require('./trailerProviders');

const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = 30_000; // 30s minimum gap before a retry is eligible

/**
 * Attempts to recover from a failed generation by retrying, or gives up
 * and marks the page permanently failed once MAX_RETRIES is exhausted.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} db
 * @param {{ id: string, edition: string, boy_name: string|null, girl_name: string|null,
 *           message: string|null, theme: string|null, trailer_retry_count: number|null }} page
 * @param {string[]} photoUrls
 * @param {string} failureReason
 * @returns {Promise<{ retried: boolean, status: 'pending'|'failed', jobId: string|null }>}
 */
async function handleGenerationFailure(db, page, photoUrls, failureReason) {
  const attemptsSoFar = page.trailer_retry_count || 0;

  if (attemptsSoFar >= MAX_RETRIES) {
    await db
      .from('pages')
      .update({ trailer_status: 'failed' })
      .eq('id', page.id);
    console.error(`[trailer-engine] page ${page.id}: exhausted ${MAX_RETRIES} retries — ${failureReason}`);
    return { retried: false, status: 'failed', jobId: null };
  }

  // Simple linear backoff: wait at least RETRY_BACKOFF_MS before this
  // particular retry attempt runs, so a flaky provider isn't hammered.
  await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS));

  const provider = getActiveProvider();
  const result = await provider.generate({
    pageId: page.id,
    edition: page.edition || 'love',
    boyName: page.boy_name || null,
    girlName: page.girl_name || null,
    message: page.message || null,
    theme: page.theme || null,
    photoUrls: photoUrls || [],
  });

  const newRetryCount = attemptsSoFar + 1;

  if (result.status === 'failed') {
    // The retry attempt itself failed too — record the incremented count
    // so the next failure (whenever it's next observed) knows how many
    // attempts have already been made, but don't mark 'failed' yet unless
    // we've now hit the cap.
    const nowFailed = newRetryCount >= MAX_RETRIES;
    await db
      .from('pages')
      .update({
        trailer_retry_count: newRetryCount,
        trailer_status: nowFailed ? 'failed' : 'pending',
      })
      .eq('id', page.id);
    console.error(`[trailer-engine] page ${page.id}: retry ${newRetryCount}/${MAX_RETRIES} failed — ${result.error}`);
    return { retried: true, status: nowFailed ? 'failed' : 'pending', jobId: null };
  }

  if (result.status === 'ready') {
    // Synchronous provider resolved immediately on retry — still goes
    // through the same "download + upload to Supabase Storage" path as
    // the normal ready flow, handled by the caller (queue.js/poll.js),
    // not here — this function only owns retry bookkeeping.
    await db
      .from('pages')
      .update({ trailer_retry_count: newRetryCount, trailer_job_id: result.jobId || null })
      .eq('id', page.id);
    return { retried: true, status: 'ready', jobId: result.jobId, trailerUrl: result.trailerUrl };
  }

  // 'queued' — back to pending with a fresh jobId, waiting on the next poll.
  await db
    .from('pages')
    .update({
      trailer_retry_count: newRetryCount,
      trailer_status: 'pending',
      trailer_job_id: result.jobId || null,
    })
    .eq('id', page.id);
  console.warn(`[trailer-engine] page ${page.id}: retry ${newRetryCount}/${MAX_RETRIES} re-queued as ${result.jobId}`);
  return { retried: true, status: 'pending', jobId: result.jobId };
}

module.exports = { handleGenerationFailure, MAX_RETRIES, RETRY_BACKOFF_MS };
