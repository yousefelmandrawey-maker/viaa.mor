// api/approve-payment.js
// POST /api/approve-payment   body: { adminToken, id, action: "approve" | "reject" }
// Called only from admin.html. No Telegram webhook, no inline buttons.
'use strict';

const { supabaseAdmin, assertConfigured } = require('./_lib/storage');
const store = require('./_lib/store');
const ids = require('./_lib/ids');
const telegram = require('./_lib/telegram');
const brevo = require('./_lib/brevo');
const { retryAsync } = require('./_lib/retry');
const { checkRateLimit, clientIp } = require('./_lib/rateLimit');
const { setSecureHeaders, timingSafeEqual, publicErrorMessage } = require('./_lib/security');

module.exports = async function handler(req, res) {
    setSecureHeaders(req, res);
    res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    let body = req.body;
    if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch { body = {}; }
    }
    body = body || {};

    const { adminToken, id, action } = body;
    const logId = typeof id === 'string' ? id : 'unknown';
    const ip = clientIp(req);

    try {
        // Fail fast with a specific, actionable error if SUPABASE_URL /
        // SUPABASE_SERVICE_ROLE_KEY aren't configured, instead of letting a
        // null supabaseAdmin client blow up later with an opaque
        // "Cannot read properties of null" deep inside a DB call.
        assertConfigured();

        // Rate limit before touching the token comparison at all — the main
        // defense against brute-forcing ADMIN_TOKEN. 20/min is generous for
        // legitimate admin.html usage (one click = one request) but caps a
        // brute-force attempt to a few thousand guesses/day, nowhere near
        // enough to crack a long random token.
        const rl = await checkRateLimit(`approve:${ip}`, 20, 60);
        if (!rl.allowed) return res.status(429).json({ error: 'Too many requests, please slow down' });

        if (!process.env.ADMIN_TOKEN || !timingSafeEqual(adminToken, process.env.ADMIN_TOKEN)) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        if (!id || typeof id !== 'string' || id.length > 100 || !['approve', 'reject'].includes(action)) {
            return res.status(400).json({ error: 'Invalid request' });
        }

        const record = await store.getPayment(id);
        if (!record) return res.status(404).json({ error: 'Not found' });
        // This status check IS the idempotency guard — a double click or a
        // retried request from the admin UI can never approve/reject twice or
        // issue two access codes for the same payment.
        if (record.status !== 'pending') return res.status(409).json({ error: `Already ${record.status}` });

        if (action === 'approve') {
            const code = ids.newAccessCode();

            try {
                await retryAsync(
                    () => insertSupabaseAccessCode(code),
                    { retries: 2, baseDelayMs: 400, timeoutMs: 8000, label: `${logId}.insert-access-code` }
                );
            } catch (err) {
                console.error(`[approve-payment][${logId}] failed to create access code after retries:`, err.message);
                return res.status(502).json({ error: 'Could not create access code, please try again' });
            }

            try {
                await retryAsync(
                    () => store.approvePayment(id, code),
                    { retries: 2, baseDelayMs: 400, timeoutMs: 8000, label: `${logId}.approve-payment-row` }
                );
            } catch (err) {
                // The access code row already exists at this point but the payment
                // wasn't marked approved — log loudly so this doesn't get lost, since
                // a retry from the admin UI would otherwise still see status=pending
                // and correctly re-attempt (idempotent), but a second code would be
                // minted. Flag it clearly for manual follow-up either way.
                console.error(`[approve-payment][${logId}] payments row update failed after access code ${code} was already created:`, err.message);
                return res.status(502).json({ error: 'Access code created but payment record update failed — contact support', code });
            }

            console.log(`[approve-payment][${logId}] approved, code issued`);

            try {
                await brevo.sendAccessCodeEmail({ to: record.email, name: record.name, code, product: record.product });
            } catch (err) {
                // Code is already issued & saved; the buyer can still see it on
                // success.html even if the email send fails (already retried
                // internally by brevo.js). Log only.
                console.error(`[approve-payment][${logId}] Brevo email failed after retries:`, err.message);
            }

            try {
                await telegram.notifyStatusChange({ text: `✅ Approved in admin.html — ${record.name} (${id})\nCode: ${code}` });
            } catch (err) {
                console.error(`[approve-payment][${logId}] Telegram status notify failed after retries:`, err.message);
            }

            return res.status(200).json({ success: true, code });
        }

        await retryAsync(
            () => store.rejectPayment(id),
            { retries: 2, baseDelayMs: 400, timeoutMs: 8000, label: `${logId}.reject-payment-row` }
        );
        console.log(`[approve-payment][${logId}] rejected`);

        try {
            await telegram.notifyStatusChange({ text: `❌ Rejected in admin.html — ${record.name} (${id})` });
        } catch (err) {
            console.error(`[approve-payment][${logId}] Telegram status notify failed after retries:`, err.message);
        }
        return res.status(200).json({ success: true });
    } catch (err) {
        console.error(`[approve-payment][${logId}] error:`, err);
        return res.status(500).json({ error: 'Server error' });
    }
};

// Inserts the issued code into the EXISTING Supabase `users` table, using the
// exact same shape the Builder already writes client-side (access_code,
// remaining_generations, active). Schema is untouched. Uses the service-role
// key (same client as storage.js) so it bypasses RLS reliably.
async function insertSupabaseAccessCode(code) {
    const { error } = await supabaseAdmin
        .from('users')
        .insert({ access_code: code, remaining_generations: 1, active: true });
    if (error) {
        const wrapped = new Error(`Supabase insert (users) failed: ${error.message}`);
        wrapped.status = error.status || error.statusCode;
        throw wrapped;
    }
}