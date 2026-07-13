// store.js — domain logic for payment records, now backed by Supabase
// (table: `payments`) instead of Vercel KV. Public-facing identifier is
// `reference_id` (what the URLs / Telegram / admin.html all use); the table's
// own `id` is a Supabase-generated UUID primary key we don't expose.
'use strict';

const { supabaseAdmin, extractStoragePath, getSignedUrl } = require('./storage');

const TABLE = 'payments';
const BUCKET = 'payments';
const SIGNED_URL_TTL_SECONDS = 900; // 15 min — long enough for one admin review pass

async function createPayment(data) {
    const row = {
        reference_id: data.referenceId,
        full_name: data.name,
        email: data.email,
        phone: data.phone,
        payment_method: data.method, // 'vodafone_cash' | 'instapay'
        payment_number: data.senderNumber,
        amount: data.amount,
        screenshot_url: data.screenshotUrl,
        status: 'pending', // pending | approved | rejected
        access_code: null,
        // Links a Premium Trailer purchase back to the page it's for, so
        // success.html can tell queue.js which page to generate a trailer
        // for once this payment is approved. Only sent by payment.js for
        // trailer purchases; regular access-code payments leave this null.
        // Requires: alter table public.payments add column page_id uuid
        // references public.pages(id); — run this migration before relying
        // on the Premium Trailer purchase flow in production.
        page_id: data.pageId || null,
    };
    let { data: inserted, error } = await supabaseAdmin
        .from(TABLE)
        .insert(row)
        .select()
        .single();
    if (error && error.code === '42703') {
        // page_id column doesn't exist in this deployment's schema yet —
        // fall back to creating the payment without it rather than failing
        // the whole submission. The trailer-linking feature is degraded
        // (queue.js will never be called automatically) until the migration
        // above is run, but the payment itself still succeeds.
        const { page_id, ...withoutPageId } = row;
        ({ data: inserted, error } = await supabaseAdmin
            .from(TABLE)
            .insert(withoutPageId)
            .select()
            .single());
    }
    if (error) throw new Error(`Supabase insert (payments) failed: ${error.message}`);
    return toPaymentRecord(inserted);
}

// Anti-abuse: finds a still-pending payment from the same buyer (same
// email + sender number + amount) submitted within the last `windowSeconds`.
// Used to make accidental double-submits (double-click, retry-happy users,
// simple scripted repeats) idempotent instead of creating duplicate rows,
// duplicate Telegram alerts, and duplicate storage uploads.
async function findRecentDuplicate({ email, senderNumber, amount, windowSeconds = 120 }) {
    const since = new Date(Date.now() - windowSeconds * 1000).toISOString();
    const { data, error } = await supabaseAdmin
        .from(TABLE)
        .select('*')
        .eq('email', email)
        .eq('payment_number', senderNumber)
        .eq('amount', amount)
        .eq('status', 'pending')
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
    if (error) throw new Error(`Supabase select (payments) failed: ${error.message}`);
    return data ? toPaymentRecord(data) : null;
}

async function getPayment(referenceId) {
    const { data, error } = await supabaseAdmin
        .from(TABLE)
        .select('*')
        .eq('reference_id', referenceId)
        .maybeSingle();
    if (error) throw new Error(`Supabase select (payments) failed: ${error.message}`);
    return data ? toPaymentRecord(data) : null;
}

async function approvePayment(referenceId, code) {
    const { data, error } = await supabaseAdmin
        .from(TABLE)
        .update({ status: 'approved', access_code: code, approved_at: new Date().toISOString() })
        .eq('reference_id', referenceId)
        .select()
        .single();
    if (error) throw new Error(`Supabase update (payments) failed: ${error.message}`);
    return toPaymentRecord(data);
}

async function rejectPayment(referenceId) {
    const { data, error } = await supabaseAdmin
        .from(TABLE)
        .update({ status: 'rejected' })
        .eq('reference_id', referenceId)
        .select()
        .single();
    if (error) throw new Error(`Supabase update (payments) failed: ${error.message}`);
    return toPaymentRecord(data);
}

async function listPending(limit = 200) {
    const { data, error } = await supabaseAdmin
        .from(TABLE)
        .select('*')
        .eq('status', 'pending')
        .order('created_at', { ascending: false })
        .limit(limit);
    if (error) throw new Error(`Supabase select (payments) failed: ${error.message}`);
    return resolveScreenshotUrls((data || []).map(toPaymentRecord));
}

// Returns every payment regardless of status (pending/approved/rejected),
// newest first. Used by the admin dashboard's Orders tab so approved/
// rejected history is visible too, not just the pending queue. `listPending`
// above is untouched and still drives whatever relied on pending-only.
async function listAll(limit = 500) {
    const { data, error } = await supabaseAdmin
        .from(TABLE)
        .select('*')
        .order('created_at', { ascending: false })
        .limit(limit);
    if (error) throw new Error(`Supabase select (payments) failed: ${error.message}`);
    return resolveScreenshotUrls((data || []).map(toPaymentRecord));
}

// Reads the existing `users` table (access codes issued by approve-payment.js:
// access_code, remaining_generations, active). Schema is untouched here —
// this is read-only.
async function listUsers(limit = 500) {
    const { data, error } = await supabaseAdmin
        .from('users')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(limit);
    if (error) throw new Error(`Supabase select (users) failed: ${error.message}`);
    return (data || []).map(toUserRecord);
}

function toUserRecord(row) {
    return {
        id: row.id ?? row.access_code,
        accessCode: row.access_code,
        remainingGenerations: row.remaining_generations,
        active: !!row.active,
        createdAt: row.created_at ? new Date(row.created_at).getTime() : null,
    };
}

// Normalizes a `payments` row into the shape the rest of the app (telegram
// captions, admin.html, success.html responses) already expects.
function toPaymentRecord(row) {
    return {
        id: row.reference_id,
        name: row.full_name,
        email: row.email,
        phone: row.phone,
        method: row.payment_method,
        senderNumber: row.payment_number,
        amount: row.amount,
        screenshotUrl: row.screenshot_url,
        status: row.status,
        code: row.access_code,
        pageId: row.page_id || null,
        // The `payments` table (as specified) has no `product` column. We don't
        // persist it; infer a human-readable label from the amount instead so
        // Telegram/admin.html still show something meaningful.
        product: String(row.amount) === '100' ? 'Premium Trailer Upgrade' : 'Viaa Access Code',
        createdAt: row.created_at ? new Date(row.created_at).getTime() : null,
        approvedAt: row.approved_at ? new Date(row.approved_at).getTime() : null,
    };
}

// Converts each record's stored screenshot value (a bare storage path for
// rows created after the `payments` bucket went private, or a legacy public
// URL for older rows) into a fresh, short-lived signed URL. Never throws —
// a signing failure for one row just leaves that row's screenshotUrl null
// rather than breaking the whole admin list.
async function resolveScreenshotUrls(records) {
    return Promise.all(
        records.map(async (r) => {
            const path = extractStoragePath(r.screenshotUrl, BUCKET);
            if (!path) return r; // unrecognized value — leave as-is
            const signed = await getSignedUrl(BUCKET, path, SIGNED_URL_TTL_SECONDS);
            return { ...r, screenshotUrl: signed };
        })
    );
}

module.exports = { createPayment, getPayment, approvePayment, rejectPayment, listPending, listAll, listUsers, findRecentDuplicate };