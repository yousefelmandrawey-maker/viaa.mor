'use strict';

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Supabase-js has no built-in per-request timeout, so every call made
// through this client (storage upload, table reads/writes) used to be able
// to hang for the entire lifetime of the serverless function if Supabase
// stalled. This wraps its internal fetch with a hard timeout instead.
const SUPABASE_TIMEOUT_MS = 10000;

function timeoutFetch(url, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SUPABASE_TIMEOUT_MS);
    return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

let supabaseAdmin = null;

if (SUPABASE_URL && SERVICE_ROLE_KEY) {
    supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
        auth: { persistSession: false },
        global: { fetch: timeoutFetch },
    });
}

function assertConfigured() {
    if (!SUPABASE_URL) {
        const err = new Error('SUPABASE_URL is missing in environment variables.');
        err.code = 'MISSING_SUPABASE_URL';
        throw err;
    }

    if (!SERVICE_ROLE_KEY) {
        const err = new Error('SUPABASE_SERVICE_ROLE_KEY is missing in environment variables.');
        err.code = 'MISSING_SERVICE_ROLE_KEY';
        throw err;
    }

    return supabaseAdmin;
}

// Extracts a bare storage path from either a bare path (new rows, post
// private-bucket migration) or a legacy public URL (rows written before the
// `payments` bucket was switched to private — see SECURITY.md). Returns
// null if the value isn't recognized so callers can leave it untouched.
function extractStoragePath(value, bucket) {
    if (!value) return null;
    const marker = `/storage/v1/object/public/${bucket}/`;
    if (value.includes(marker)) return value.split(marker)[1];
    if (value.startsWith('http')) return null; // unrecognized external URL
    return value; // already a bare path
}

// Generates a short-lived signed URL for a private-bucket object. Returns
// null (rather than throwing) on failure so a screenshot render issue in
// admin.html never blocks the rest of the payments list from loading.
async function getSignedUrl(bucket, path, expiresInSeconds = 900) {
    if (!supabaseAdmin || !path) return null;
    try {
        const { data, error } = await supabaseAdmin.storage.from(bucket).createSignedUrl(path, expiresInSeconds);
        if (error) throw error;
        return data?.signedUrl || null;
    } catch (err) {
        console.error(`[storage] createSignedUrl failed for bucket="${bucket}" path="${path}":`, err.message);
        return null;
    }
}

module.exports = {
    supabaseAdmin,
    assertConfigured,
    extractStoragePath,
    getSignedUrl,
    SUPABASE_URL,
};