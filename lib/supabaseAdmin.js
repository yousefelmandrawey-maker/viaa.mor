'use strict';

/**
 * Server-side Supabase client. Uses the service role key (never exposed to
 * the browser) so these routes can write to `pages` regardless of RLS
 * policies that rightly restrict what the anon key can do from the client.
 *
 * Required environment variables (set in Vercel project settings):
 *   SUPABASE_URL              - same project URL used in the frontend (SURL)
 *   SUPABASE_SERVICE_ROLE_KEY - service role key, NOT the anon key
 */

const { createClient } = require('@supabase/supabase-js');

let cachedClient = null;

function getSupabaseAdmin() {
  if (cachedClient) return cachedClient;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error(
      '[trailer-engine] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables.'
    );
  }

  cachedClient = createClient(url, key, {
    auth: { persistSession: false },
  });
  return cachedClient;
}

module.exports = { getSupabaseAdmin };
