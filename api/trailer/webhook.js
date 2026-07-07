'use strict';

/**
 * POST /api/trailer/webhook
 *
 * The single callback endpoint every provider (mock, Runway, Luma, Pika)
 * calls when a generation job finishes. This route never knows vendor
 * specifics — it delegates payload parsing to the active provider's
 * parseWebhook(), which normalizes any vendor shape into:
 *   { jobId, status: 'ready'|'failed', trailerUrl?, error? }
 *
 * This is what makes the pipeline swappable: adding Runway/Luma/Pika only
 * means writing that provider's parseWebhook() — this route, queue.js,
 * and every frontend file stay untouched.
 *
 * SECURITY: this endpoint is unauthenticated at the HTTP layer by nature —
 * it's called by a third-party vendor, not our own frontend, so there's no
 * user session or admin token to check. Without *some* check, anyone who
 * finds this URL could POST a fake "ready" status for any existing jobId,
 * pointing trailerUrl at a URL of their choosing — persistTrailerVideo()
 * would then download and re-host that as the page's public trailer video,
 * for a page they have no relationship to.
 *
 * Fix: require a shared secret via `Authorization: Bearer <TRAILER_WEBHOOK_SECRET>`,
 * checked with the same timingSafeEqual used for ADMIN_TOKEN elsewhere in
 * this codebase. Whichever real provider is wired up (Runway/Pika/etc.)
 * needs to be configured to send this header — most webhook-capable
 * vendors support a custom header or HMAC-signed request; consult that
 * vendor's docs for the exact mechanism and prefer their native signature
 * scheme over this shared secret if they offer one. This shared-secret
 * check is deliberately provider-agnostic so it protects the endpoint the
 * moment ANY provider with parseWebhook is activated, not just the ones
 * anticipated today.
 *
 * Today's default provider (Luma) is poll-only (parseWebhook: null), so
 * this route 501s before reaching the check below — but the check must
 * exist now, not be deferred until a real webhook-based provider is added,
 * since "add the provider" and "add the auth" are easy to accidentally
 * ship as two separate changes.
 */

const { getSupabaseAdmin } = require('../../lib/supabaseAdmin');
const { getActiveProvider } = require('../../lib/trailerProviders');
const { persistTrailerVideo } = require('../../lib/trailerStorage');
const { handleGenerationFailure } = require('../../lib/trailerRetry');
const crypto = require('crypto');

// Local copy of the timing-safe comparison used by api/_lib/security.js —
// duplicated rather than cross-imported because this file lives under
// api/trailer/ (a separate lib/ tree from api/_lib/) and a relative import
// across that boundary can't be verified against the real deployed layout
// from here. Keep this in sync with api/_lib/security.js's timingSafeEqual
// if that implementation ever changes.
function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a ?? ''));
  const bufB = Buffer.from(String(b ?? ''));
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ success: false, error: 'Method not allowed' });
    return;
  }

  const provider = getActiveProvider();

  if (typeof provider.parseWebhook !== 'function') {
    res.status(501).json({
      success: false,
      error: `Active provider "${provider.name}" does not implement parseWebhook — poll-only providers (e.g. Luma) resolve via api/trailer/poll.js instead.`,
    });
    return;
  }

  // Shared-secret check — see the file-level comment above for why this
  // exists and what a real provider integration should do instead/in
  // addition, per that vendor's own signature scheme.
  const secret = process.env.TRAILER_WEBHOOK_SECRET;
  if (!secret) {
    console.error('[trailer-engine] webhook rejected: TRAILER_WEBHOOK_SECRET is not configured');
    res.status(503).json({ success: false, error: 'Webhook not configured' });
    return;
  }
  const authHeader = req.headers['authorization'] || '';
  const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!timingSafeEqual(provided, secret)) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }

  const normalized = provider.parseWebhook(req.body);
  if (!normalized || !normalized.jobId) {
    res.status(400).json({ success: false, error: 'Unrecognized or invalid webhook payload' });
    return;
  }

  const db = getSupabaseAdmin();

  try {
    const { data: page, error: findErr } = await db
      .from('pages')
      .select('id, edition, boy_name, girl_name, message, theme, trailer_retry_count')
      .eq('trailer_job_id', normalized.jobId)
      .single();

    if (findErr || !page) {
      res.status(404).json({ success: false, error: 'No page matches this jobId' });
      return;
    }

    if (normalized.status === 'ready') {
      if (!normalized.trailerUrl) {
        res.status(400).json({ success: false, error: 'status ready but no trailerUrl provided' });
        return;
      }
      // Download the video for real and re-host it in Supabase Storage —
      // the only write that ever sets trailer_url. Nothing in this pipeline
      // fabricates a URL or trusts a provider's (typically temporary) link
      // for permanent, published-page display.
      const trailerUrl = await persistTrailerVideo(page.id, normalized.trailerUrl);
      await db
        .from('pages')
        .update({ trailer_status: 'ready', trailer_url: trailerUrl })
        .eq('id', page.id);
      res.status(200).json({ success: true, pageId: page.id, status: 'ready' });
      return;
    }

    // Failed generation: apply the shared retry policy before giving up,
    // same as queue.js and poll.js — never immediately marks 'failed'.
    const { data: photos } = await db.from('photos').select('photo_url').eq('page_id', page.id);
    const photoUrls = (photos || []).map((p) => p.photo_url);
    const retryOutcome = await handleGenerationFailure(db, page, photoUrls, normalized.error);

    if (retryOutcome.status === 'ready' && retryOutcome.trailerUrl) {
      const trailerUrl = await persistTrailerVideo(page.id, retryOutcome.trailerUrl);
      await db.from('pages').update({ trailer_status: 'ready', trailer_url: trailerUrl }).eq('id', page.id);
      res.status(200).json({ success: true, pageId: page.id, status: 'ready' });
      return;
    }

    res.status(200).json({
      success: true,
      pageId: page.id,
      status: retryOutcome.status,
      error: retryOutcome.status === 'failed' ? (normalized.error || null) : undefined,
    });
  } catch (err) {
    console.error('[trailer-engine] webhook error:', err);
    res.status(500).json({ success: false, error: 'Internal error processing webhook' });
  }
};
