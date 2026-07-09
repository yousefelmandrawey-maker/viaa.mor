// api/_lib/retry.js
// Small shared helpers so every outbound call (Supabase, Telegram, Brevo)
// gets the same timeout + retry behavior instead of each file rolling its
// own. No new dependencies.
'use strict';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Rejects `promiseFactory()`'s promise if it doesn't settle within `ms`.
 * promiseFactory receives an AbortSignal it SHOULD pass to fetch, so the
 * underlying request is actually cancelled, not just ignored.
 */
async function withTimeout(promiseFactory, ms, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await promiseFactory(controller.signal);
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`${label || 'Request'} timed out after ${ms}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Retries `fn` with exponential backoff + jitter. `fn` receives the attempt
 * number (1-based) and an AbortSignal for that attempt.
 *
 * `shouldRetry(err)` decides whether a given failure is worth retrying —
 * default treats network errors, timeouts, and 429/5xx as retryable, and
 * anything else (validation errors, 4xx) as final.
 */
async function retryAsync(fn, opts = {}) {
  const {
    retries = 2,
    baseDelayMs = 400,
    timeoutMs = 8000,
    label = 'operation',
    shouldRetry = defaultShouldRetry,
  } = opts;

  let lastErr;
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      return await withTimeout((signal) => fn(attempt, signal), timeoutMs, label);
    } catch (err) {
      lastErr = err;
      const isLastAttempt = attempt === retries + 1;
      if (isLastAttempt || !shouldRetry(err)) {
        console.error(`[${label}] failed on attempt ${attempt}/${retries + 1}:`, err.message);
        throw err;
      }
      const delay = baseDelayMs * 2 ** (attempt - 1) + Math.floor(Math.random() * 150);
      console.warn(`[${label}] attempt ${attempt}/${retries + 1} failed (${err.message}); retrying in ${delay}ms`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

function defaultShouldRetry(err) {
  const status = err.status || err.statusCode;
  if (status) return status === 429 || status >= 500;
  // No status usually means a network-level failure (timeout, DNS, reset) —
  // those are exactly the transient cases retries are for.
  return true;
}

module.exports = { withTimeout, retryAsync, sleep };
