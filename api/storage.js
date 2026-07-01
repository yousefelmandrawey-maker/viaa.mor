// storage.js — Supabase service-role client used by the backend.
// Replaces the previous Vercel KV wrapper. Requires SUPABASE_URL and
// SUPABASE_SERVICE_ROLE_KEY (service role, NOT the public anon key) so the
// backend can read/write the `payments` table and the `payments` storage
// bucket regardless of RLS policies.
'use strict';

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ufxixlqznhzyfrartjgp.supabase.co';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SERVICE_ROLE_KEY) {
  // Fail loudly at import time in logs, but don't crash the module — routes
  // will surface a clear 500 instead of a confusing client error.
  console.error('SUPABASE_SERVICE_ROLE_KEY is not configured — backend cannot read/write payments.');
}

const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY || 'missing-service-role-key', {
  auth: { persistSession: false },
});

module.exports = { supabaseAdmin, SUPABASE_URL };
