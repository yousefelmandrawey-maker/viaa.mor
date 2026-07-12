// api/_lib/security.js — small, focused security helpers shared by every
// API route. No external dependencies.
'use strict';

const crypto = require('crypto');

// Constant-time comparison for secrets (admin token). A plain `===` leaks
// timing information proportional to how many leading characters match,
// which is enough to brute-force a token character-by-character over many
// requests. Always compares equal-length buffers so the operation itself
// doesn't leak length either.
function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a ?? ''));
  const bufB = Buffer.from(String(b ?? ''));
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA); // burn equivalent time, discard result
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

// Locks CORS down to an explicit allow-list instead of '*'. Same-origin
// requests (the actual web app) never need this header at all; it only
// matters for cross-origin callers, which should now be limited to
// whatever ALLOWED_ORIGIN is configured to (or none, by default).
function setSecureHeaders(req, res) {
  const configured = (process.env.ALLOWED_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean);
  const origin = req.headers.origin;
  if (configured.length && origin && configured.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  } else if (!configured.length) {
    // No ALLOWED_ORIGIN configured yet — fall back to same-origin-only
    // behavior (no CORS header at all) rather than '*', so cross-origin
    // reuse of these endpoints doesn't work by default.
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Cache-Control', 'no-store');
}

// Heuristic, not a hard guarantee — genuine bots can spoof headers. This is
// one layer among several (rate limiting, duplicate detection) rather than
// the sole line of defense; see SECURITY.md.
const BOT_UA_PATTERNS = [
  'curl', 'wget', 'python-requests', 'go-http-client', 'okhttp', 'axios',
  'scrapy', 'httpclient', 'libwww', 'bot', 'crawler', 'spider', 'headless',
];

function isSuspiciousRequest(req) {
  const ua = (req.headers['user-agent'] || '').toLowerCase();
  if (!ua) return true; // every real browser sends a User-Agent
  if (BOT_UA_PATTERNS.some((p) => ua.includes(p))) return true;
  // Real browsers submitting a form send an Accept header; a bare script
  // hitting the endpoint directly often omits it entirely.
  if (!req.headers['accept']) return true;
  return false;
}

// Strips internal error detail before it reaches the client. Full detail
// (stack, Supabase error object, etc.) still goes to console.error at the
// call site — this only controls what's returned in the HTTP response.
function publicErrorMessage(err, fallback) {
  if (process.env.NODE_ENV !== 'production') return err?.message || fallback;
  return fallback;
}

module.exports = { timingSafeEqual, setSecureHeaders, isSuspiciousRequest, publicErrorMessage };
