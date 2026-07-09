// api/submit-payment.js
// POST  /api/submit-payment   — multipart form: name, email, phone, amount, method, senderNumber, screenshot(file)
// GET   /api/submit-payment?id=p_xxx                          — poll payment status (used by success.html)
// GET   /api/submit-payment?admin=1&token=...&action=list      — admin.html pending list
'use strict';

const Busboy = require('busboy');
const { assertConfigured, getSignedUrl } = require('./_lib/storage');
const store = require('./_lib/store');
const ids = require('./_lib/ids');
const telegram = require('./_lib/telegram');
const { retryAsync } = require('./_lib/retry');
const { checkRateLimit, clientIp } = require('./_lib/rateLimit');
const { setSecureHeaders, isSuspiciousRequest, publicErrorMessage, timingSafeEqual } = require('./_lib/security');

const MAX_FILE_BYTES = 8 * 1024 * 1024; // 8MB
const MAX_FIELD_LEN = 500; // guard against absurdly long text fields
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);
const ALLOWED_METHODS = new Set(['vodafone_cash', 'instapay']);
const BUCKET = 'payments';
const PARSE_TIMEOUT_MS = 15000; // guard against a stalled/slow upload stream

function parseMultipart(req) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const done = (fn) => (...args) => { if (!settled) { settled = true; fn(...args); } };
        const resolveOnce = done(resolve);
        const rejectOnce = done(reject);

        const timer = setTimeout(() => {
            rejectOnce(new Error('Upload timed out — please check your connection and try again.'));
        }, PARSE_TIMEOUT_MS);

        let busboy;
        try {
            busboy = Busboy({ headers: req.headers, limits: { fileSize: MAX_FILE_BYTES, fields: 20 } });
        } catch (err) {
            clearTimeout(timer);
            return rejectOnce(new Error('Malformed upload request.'));
        }

        const fields = {};
        let fileBuffer = null;
        let fileInfo = null;
        let fileTooBig = false;

        busboy.on('field', (name, val) => {
            fields[name] = typeof val === 'string' ? val.slice(0, MAX_FIELD_LEN) : val;
        });

        busboy.on('file', (name, stream, info) => {
            const chunks = [];
            stream.on('limit', () => { fileTooBig = true; stream.resume(); });
            stream.on('data', (chunk) => chunks.push(chunk));
            stream.on('end', () => {
                if (!fileTooBig) {
                    fileBuffer = Buffer.concat(chunks);
                    fileInfo = info;
                }
            });
        });

        busboy.on('error', (err) => { clearTimeout(timer); rejectOnce(err); });
        busboy.on('finish', () => {
            clearTimeout(timer);
            if (fileTooBig) return rejectOnce(new Error('Screenshot is too large (max 8MB).'));
            resolveOnce({ fields, file: fileBuffer ? { buffer: fileBuffer, info: fileInfo } : null });
        });

        req.on('aborted', () => { clearTimeout(timer); rejectOnce(new Error('Client disconnected during upload.')); });

        req.pipe(busboy);
    });
}

function isValidEmail(e) {
    return typeof e === 'string' && e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

// Loose international-friendly phone check: digits, spaces, +, -, ( ) only,
// 7-20 chars. Not trying to fully validate a phone number, just reject
// obvious garbage before it reaches Telegram/Brevo/admin.html.
function isValidPhone(p) {
    return typeof p === 'string' && /^[0-9+\-()\s]{7,20}$/.test(p.trim());
}

function isValidAmount(a) {
    if (a === undefined || a === null || a === '') return true; // defaults to '99' downstream
    return /^\d{1,7}(\.\d{1,2})?$/.test(String(a).trim());
}

module.exports = async function handler(req, res) {
    setSecureHeaders(req, res);
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.status(204).end();

    const requestId = ids.newPaymentId().replace('p_', 'req_');
    try {
        if (req.method === 'GET') return await handleGet(req, res);
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
        return await handlePost(req, res, requestId);
    } catch (err) {
        console.error(`[submit-payment][${requestId}] unhandled error:`, err);
        return res.status(500).json({ error: publicErrorMessage(err, 'Server error'), requestId });
    }
};

async function handleGet(req, res) {
    const { id, admin, action } = req.query || {};
    // Admin token travels via the Authorization header, never the query
    // string — a token in a URL lands in server access logs, any proxy/CDN
    // logs in front of Vercel, and browser history. See admin.html, which
    // sends `Authorization: Bearer <token>`.
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    const ip = clientIp(req);

    if (admin) {
        // Separate, tighter limit keyed by IP — this is the admin surface,
        // brute-forcing ADMIN_TOKEN is the main threat here, not volume.
        const rl = await checkRateLimit(`admin-get:${ip}`, 60, 60);
        if (!rl.allowed) return res.status(429).json({ error: 'Too many requests, please slow down' });

        if (!process.env.ADMIN_TOKEN || !timingSafeEqual(token, process.env.ADMIN_TOKEN)) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        if (action === 'list') {
            // Unchanged: pending-only, kept for backward compatibility with
            // anything already relying on this exact response shape.
            const records = await store.listPending();
            return res.status(200).json({ payments: records });
        }
        if (action === 'all') {
            // New: every order regardless of status, for the Orders tab's
            // reporting view (search/filter/pagination happen client-side).
            const records = await store.listAll();
            return res.status(200).json({ payments: records });
        }
        if (action === 'users') {
            // New: read-only view of the `users` table (access codes issued).
            const users = await store.listUsers();
            return res.status(200).json({ users });
        }
        return res.status(400).json({ error: 'Unknown admin action' });
    }

    if (!id || typeof id !== 'string' || id.length > 100) {
        return res.status(400).json({ error: 'Missing or invalid id' });
    }

    // Status polling is unauthenticated by design (success.html needs it
    // right after checkout, before any login), so it's the easiest target
    // for scripted enumeration of reference IDs. Rate limit by IP; the ID
    // space (16 random hex chars) already makes guessing infeasible, this
    // just caps how fast a single client can try.
    const rl = await checkRateLimit(`poll:${ip}`, 120, 60);
    if (!rl.allowed) return res.status(429).json({ error: 'Too many requests, please slow down' });

    const record = await store.getPayment(id);
    if (!record) return res.status(404).json({ error: 'Not found' });
    return res.status(200).json({
        status: record.status,
        code: record.status === 'approved' ? record.code : null,
        product: record.product,
        pageId: record.pageId,
    });
}

async function handlePost(req, res, requestId) {
    const log = (msg, extra) => console.log(`[submit-payment][${requestId}] ${msg}`, extra || '');
    const ip = clientIp(req);

    // Bot protection: heuristic header check first (cheapest, catches most
    // scripted/naive bot traffic before it reaches the multipart parser).
    if (isSuspiciousRequest(req)) {
        log(`blocked suspicious request, ip=${ip} ua=${req.headers['user-agent'] || '(none)'}`);
        // Deliberately vague/generic response — don't tell an automated
        // client exactly which signal tripped so it can't be tuned around.
        return res.status(400).json({ error: 'Request could not be processed', requestId });
    }

    // Anti-abuse: cap submissions per IP. Generous enough for a real person
    // retrying a failed payment a few times, tight enough to blunt scripted
    // spam/flooding of the Telegram channel and storage bucket.
    const rl = await checkRateLimit(`submit:${ip}`, 8, 900); // 8 per 15 min
    if (!rl.allowed) {
        log(`rate limited, ip=${ip}`);
        return res.status(429).json({ error: 'Too many submissions — please wait a few minutes and try again', requestId });
    }

    let fields, file;
    try {
        ({ fields, file } = await parseMultipart(req));
    } catch (err) {
        log('multipart parse failed:', err.message);
        return res.status(400).json({ error: err.message || 'Could not read upload', requestId });
    }

    const { name, email, phone, amount, method, senderNumber, pageId } = fields;

    if (!name || !name.trim() || name.trim().length > 120) {
        return res.status(400).json({ error: 'Name is required (max 120 characters)', requestId });
    }
    if (!isValidEmail(email)) return res.status(400).json({ error: 'Valid email is required', requestId });
    if (!isValidPhone(phone)) return res.status(400).json({ error: 'Valid phone number is required', requestId });
    if (!ALLOWED_METHODS.has(method)) {
        return res.status(400).json({ error: 'Invalid payment method', requestId });
    }
    if (!senderNumber || !isValidPhone(senderNumber)) {
        return res.status(400).json({ error: 'The number you paid from is required', requestId });
    }
    if (!isValidAmount(amount)) {
        return res.status(400).json({ error: 'Invalid amount', requestId });
    }
    // pageId is optional — only sent by payment.js for a Premium Trailer
    // purchase (regular access-code payments have no associated page yet).
    // Loosely validated as UUID-shaped since it's the pages.id primary key;
    // Supabase's own query will 404 downstream on anything that doesn't
    // actually match a row, so this is just basic input hygiene, not the
    // full authorization check (see queue.js for that).
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (pageId !== undefined && pageId !== '' && !UUID_RE.test(String(pageId).trim())) {
        return res.status(400).json({ error: 'Invalid pageId', requestId });
    }
    const cleanPageId = (pageId && UUID_RE.test(String(pageId).trim())) ? String(pageId).trim() : null;

    if (!file) return res.status(400).json({ error: 'Payment screenshot is required', requestId });
    if (!file.buffer || file.buffer.length === 0) {
        return res.status(400).json({ error: 'Screenshot upload was empty, please try again', requestId });
    }
    if (file.info && file.info.mimeType && !ALLOWED_MIME.has(file.info.mimeType)) {
        return res.status(400).json({ error: 'Screenshot must be an image (jpg, png, webp, heic)', requestId });
    }

    const cleanEmail = email.trim().toLowerCase();
    const cleanSender = senderNumber.trim();
    const cleanAmount = amount || '99';

    // Anti-abuse: also cap by email specifically, independent of IP — this
    // catches abuse that rotates IPs but reuses (or randomizes) an email
    // less effectively, and mainly protects a single victim's inbox/Telegram
    // from being flooded if their email is reused maliciously.
    const emailRl = await checkRateLimit(`submit-email:${cleanEmail}`, 5, 3600); // 5 per hour
    if (!emailRl.allowed) {
        log(`rate limited by email, email=${cleanEmail}`);
        return res.status(429).json({ error: 'Too many submissions for this email — please wait and try again', requestId });
    }

    // Anti-abuse: idempotency for accidental double-submits (double-click,
    // a retried request after a slow response, etc.) — same buyer, same
    // sender number, same amount, still pending, within the last 2 minutes.
    // Returns the existing record instead of creating a duplicate payment,
    // duplicate Telegram alert, and duplicate storage upload.
    try {
        const dup = await store.findRecentDuplicate({ email: cleanEmail, senderNumber: cleanSender, amount: cleanAmount });
        if (dup) {
            log(`duplicate submission detected, reusing existing id=${dup.id}`);
            return res.status(200).json({ success: true, id: dup.id, requestId, deduped: true });
        }
    } catch (err) {
        // Duplicate-check failing should never block a legitimate payment —
        // log and continue as if none was found.
        console.error(`[submit-payment][${requestId}] duplicate check failed, continuing:`, err.message);
    }

    const referenceId = ids.newPaymentId();
    log(`validated submission, referenceId=${referenceId} email=${cleanEmail}`);

    let screenshotPath = null;
    let screenshotUrlForTelegram = null;
    try {
        // Fail fast with a specific message if SUPABASE_SERVICE_ROLE_KEY isn't
        // set, instead of letting the upload call below fail with an opaque
        // Supabase auth error.
        const client = assertConfigured();

        const ext = (file.info?.filename?.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
        const path = `${referenceId}.${ext}`;
        const contentType = file.info?.mimeType || 'image/jpeg';

        log(`uploading to bucket="${BUCKET}" path="${path}" contentType="${contentType}" size=${file.buffer.length}`);

        // Transient network/5xx failures during upload are retried; a bad
        // config (missing bucket, auth) fails fast since retrying won't help.
        const uploadData = await retryAsync(
            async () => {
                const { data, error } = await client.storage
                    .from(BUCKET)
                    .upload(path, file.buffer, { contentType, upsert: false });
                if (error) {
                    const wrapped = new Error(error.message);
                    wrapped.status = error.status || error.statusCode;
                    wrapped.name = error.name;
                    wrapped.cause = error.cause;
                    throw wrapped;
                }
                return data;
            },
            { retries: 2, baseDelayMs: 500, timeoutMs: 12000, label: `${requestId}.supabase-upload` }
        );

        log('upload succeeded', uploadData);

        // The `payments` bucket should be PRIVATE (see SECURITY.md) — we
        // store the bare path, not a public URL. A fresh signed URL is
        // minted on demand: once now for the Telegram alert (short-lived),
        // and again later whenever admin.html loads the pending list.
        screenshotPath = path;
        screenshotUrlForTelegram = await getSignedUrl(BUCKET, path, 600); // 10 min, just for this alert
    } catch (err) {
        console.error(`[submit-payment][${requestId}] screenshot upload failed:`, {
            message: err.message,
            name: err.name,
            status: err.status || err.statusCode,
            cause: err.cause,
            bucket: BUCKET,
        });
        // Client gets a generic message + requestId only — the previous
        // version returned the raw Supabase error, bucket name, and a
        // config hint directly in the response body, which is useful for
        // debugging but also hands an attacker infra detail for free. Full
        // detail is still in the server log above, keyed by requestId.
        return res.status(502).json({
            error: publicErrorMessage(err, 'Could not upload screenshot, please try again'),
            requestId,
        });
    }

    let record;
    try {
        record = await retryAsync(
            () => store.createPayment({
                referenceId,
                name: name.trim(),
                email: cleanEmail,
                phone: phone.trim(),
                amount: cleanAmount,
                method,
                senderNumber: cleanSender,
                screenshotUrl: screenshotPath, // bare storage path — see SECURITY.md
                pageId: cleanPageId,
            }),
            { retries: 1, baseDelayMs: 400, timeoutMs: 8000, label: `${requestId}.create-payment-row` }
        );
    } catch (err) {
        // The screenshot is already uploaded at this point; log the orphaned
        // file path so it can be cleaned up / the row created manually if the
        // DB write keeps failing, rather than silently losing the payment.
        console.error(`[submit-payment][${requestId}] DB insert failed after successful upload. Orphaned screenshot path: ${screenshotPath}`, err);
        return res.status(502).json({ error: 'Could not save payment record, please try again or contact support', requestId });
    }

    log(`payment recorded, id=${record.id}`);

    const methodLabel = method === 'vodafone_cash' ? 'Vodafone Cash' : 'InstaPay';
    const caption = [
        '🆕 <b>New Payment — Pending Approval</b>',
        `👤 ${escapeHtml(record.name)}`,
        `📧 ${escapeHtml(record.email)}`,
        `📱 ${escapeHtml(record.phone)}`,
        `💳 ${methodLabel} · sent from ${escapeHtml(record.senderNumber)}`,
        `💰 ${escapeHtml(String(record.amount))} EGP — ${escapeHtml(record.product)}`,
        `🆔 <code>${record.id}</code>`,
        '',
        '👉 Approve or reject this in admin.html',
    ].join('\n');

    try {
        await telegram.notifyNewPayment({ screenshotUrl: screenshotUrlForTelegram, caption });
    } catch (err) {
        // Notification is best-effort only (already retried internally) — the
        // payment is already recorded and visible in admin.html either way.
        console.error(`[submit-payment][${requestId}] Telegram notify failed after retries:`, err.message);
    }

    return res.status(200).json({ success: true, id: record.id, requestId });
}

function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}