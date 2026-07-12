// api/_lib/rateLimit.js — sliding-window rate limiting backed by a Postgres
// function (see sql/security_migrations.sql: check_rate_limit) so counts are
// shared across all serverless instances, not per-warm-lambda memory.
'use strict';

const { supabaseAdmin } = require('./storage');

/**
 * Returns { allowed, degraded }. `degraded: true` means the rate-limit check
 * itself failed (DB/network issue) — we fail OPEN rather than blocking every
 * payment because the limiter is down, but this is logged so a sustained
 * outage is visible and can be investigated.
 */
async function checkRateLimit(key, limit, windowSeconds) {
  if (!supabaseAdmin) return { allowed: true, degraded: true };
  try {
    const { data, error } = await supabaseAdmin.rpc('check_rate_limit', {
      p_key: key,
      p_limit: limit,
      p_window_seconds: windowSeconds,
    });
    if (error) throw error;
    return { allowed: data === true, degraded: false };
  } catch (err) {
    console.error(`[rate-limit] check failed for key="${key}":`, err.message);
    return { allowed: true, degraded: true };
  }
}

// Best-effort client IP extraction behind Vercel's proxy. Not spoof-proof on
// its own (see SECURITY.md for the trust model) but sufficient as a rate
// limiting key alongside other signals (email, admin token identity).
function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

module.exports = { checkRateLimit, clientIp };
