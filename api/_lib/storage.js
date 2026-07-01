'use strict';

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

let supabaseAdmin = null;

if (SUPABASE_URL && SERVICE_ROLE_KEY) {
  supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
}

function assertConfigured() {
  if (!SUPABASE_URL) {
    throw new Error('SUPABASE_URL is missing');
  }

  if (!SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY is missing');
  }

  return supabaseAdmin;
}

module.exports = {
  supabaseAdmin,
  assertConfigured,
  SUPABASE_URL,
};
