'use strict';

/**
 * ── TRAILER STORAGE ─────────────────────────────────────────────────────
 *
 * Pure storage concern: takes a video that a provider says is ready,
 * downloads it, and re-hosts it in Supabase Storage. This exists as its
 * own module (not inlined into queue.js/poll.js) so that:
 *   - AI-provider logic never touches Supabase Storage APIs directly
 *   - Payment logic (success.html → queue.js) never touches video bytes
 *   - Swapping providers never requires touching storage/upload logic
 *
 * Why re-host at all, instead of just saving the provider's URL directly?
 * Provider-hosted URLs are typically temporary (signed, time-limited, or
 * subject to the vendor's own retention policy) — trailer_url is a
 * permanent, user-facing link shown on a published page indefinitely, so
 * it must point at storage we control.
 */

const { getSupabaseAdmin } = require('./supabaseAdmin');

const BUCKET = 'trailers';

/**
 * Downloads the video at `sourceUrl` and uploads it to Supabase Storage
 * under a stable, page-scoped path. Returns the new permanent public URL.
 *
 * @param {string} pageId
 * @param {string} sourceUrl - The provider's (temporary) video URL.
 * @returns {Promise<string>} the permanent Supabase Storage public URL
 */
async function persistTrailerVideo(pageId, sourceUrl) {
  if (!pageId) throw new Error('persistTrailerVideo: missing pageId');
  if (!sourceUrl) throw new Error('persistTrailerVideo: missing sourceUrl');

  const db = getSupabaseAdmin();

  const videoRes = await fetch(sourceUrl);
  if (!videoRes.ok) {
    throw new Error(`persistTrailerVideo: failed to download source video (HTTP ${videoRes.status})`);
  }
  const contentType = videoRes.headers.get('content-type') || 'video/mp4';
  const buffer = Buffer.from(await videoRes.arrayBuffer());

  const path = `${pageId}/trailer-${Date.now()}.mp4`;

  const { error: uploadErr } = await db.storage.from(BUCKET).upload(path, buffer, {
    contentType,
    upsert: true,
  });
  if (uploadErr) {
    throw new Error(`persistTrailerVideo: Supabase Storage upload failed — ${uploadErr.message}`);
  }

  const { data: publicUrlData } = db.storage.from(BUCKET).getPublicUrl(path);
  if (!publicUrlData || !publicUrlData.publicUrl) {
    throw new Error('persistTrailerVideo: could not resolve public URL after upload');
  }

  return publicUrlData.publicUrl;
}

module.exports = { persistTrailerVideo, BUCKET };
