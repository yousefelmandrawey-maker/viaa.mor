// api/submit-payment.js
// POST  /api/submit-payment   — multipart form: name, email, phone, amount, method, senderNumber, screenshot(file)
// GET   /api/submit-payment?id=p_xxx                          — poll payment status (used by success.html)
// GET   /api/submit-payment?admin=1&token=...&action=list      — admin.html pending list
'use strict';

const Busboy = require('busboy');
const { supabaseAdmin, assertConfigured } = require('./_lib/storage');
const store = require('./_lib/store');
const ids = require('./_lib/ids');
const telegram = require('./_lib/telegram');

const MAX_FILE_BYTES = 8 * 1024 * 1024; // 8MB
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);
const BUCKET = 'payments';

function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const busboy = Busboy({ headers: req.headers, limits: { fileSize: MAX_FILE_BYTES } });
    const fields = {};
    let fileBuffer = null;
    let fileInfo = null;
    let fileTooBig = false;

    busboy.on('field', (name, val) => { fields[name] = val; });

    busboy.on('file', (name, stream, info) => {
      const chunks = [];
      stream.on('limit', () => { fileTooBig = true; });
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('end', () => {
        if (!fileTooBig) {
          fileBuffer = Buffer.concat(chunks);
          fileInfo = info;
        }
      });
    });

    busboy.on('error', reject);
    busboy.on('finish', () => {
      if (fileTooBig) return reject(new Error('Screenshot is too large (max 8MB).'));
      resolve({ fields, file: fileBuffer ? { buffer: fileBuffer, info: fileInfo } : null });
    });

    req.pipe(busboy);
  });
}

function isValidEmail(e) {
  return typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    if (req.method === 'GET') return handleGet(req, res);
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    return handlePost(req, res);
  } catch (err) {
    console.error('submit-payment error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

async function handleGet(req, res) {
  const { id, admin, token, action } = req.query || {};

  if (admin) {
    if (!process.env.ADMIN_TOKEN || token !== process.env.ADMIN_TOKEN) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (action === 'list') {
      const records = await store.listPending();
      return res.status(200).json({ payments: records });
    }
    return res.status(400).json({ error: 'Unknown admin action' });
  }

  if (!id) return res.status(400).json({ error: 'Missing id' });
  const record = await store.getPayment(id);
  if (!record) return res.status(404).json({ error: 'Not found' });
  return res.status(200).json({
    status: record.status,
    code: record.status === 'approved' ? record.code : null,
    product: record.product,
  });
}

async function handlePost(req, res) {
  const { fields, file } = await parseMultipart(req);
  const { name, email, phone, amount, method, senderNumber } = fields;

  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
  if (!isValidEmail(email)) return res.status(400).json({ error: 'Valid email is required' });
  if (!phone || !phone.trim()) return res.status(400).json({ error: 'Phone is required' });
  if (!['vodafone_cash', 'instapay'].includes(method)) {
    return res.status(400).json({ error: 'Invalid payment method' });
  }
  if (!senderNumber || !senderNumber.trim()) {
    return res.status(400).json({ error: 'The number you paid from is required' });
  }
  if (!file) return res.status(400).json({ error: 'Payment screenshot is required' });
  if (file.info && file.info.mimeType && !ALLOWED_MIME.has(file.info.mimeType)) {
    return res.status(400).json({ error: 'Screenshot must be an image (jpg, png, webp, heic)' });
  }

  const referenceId = ids.newPaymentId();

  let screenshotUrl = null;
  try {
    // Fail fast with a specific message if SUPABASE_SERVICE_ROLE_KEY isn't
    // set, instead of letting the upload call below fail with an opaque
    // Supabase auth error.
    const client = assertConfigured();

    const ext = (file.info?.filename?.split('.').pop() || 'jpg').toLowerCase();
    const path = `${referenceId}.${ext}`;
    const contentType = file.info?.mimeType || 'image/jpeg';

    console.log(`[submit-payment] uploading to bucket="${BUCKET}" path="${path}" contentType="${contentType}" size=${file.buffer.length}`);

    const { data: uploadData, error: uploadErr } = await client.storage
      .from(BUCKET)
      .upload(path, file.buffer, { contentType, upsert: false });

    if (uploadErr) {
      // Log the full Supabase error object server-side (status, statusCode,
      // name, message — whatever Supabase attached) for real diagnosis.
      console.error('[submit-payment] Supabase storage upload failed:', {
        message: uploadErr.message,
        name: uploadErr.name,
        status: uploadErr.status || uploadErr.statusCode,
        cause: uploadErr.cause,
        raw: uploadErr,
      });
      throw uploadErr;
    }

    console.log('[submit-payment] upload succeeded:', uploadData);

    const { data: pub, error: urlErr } = client.storage.from(BUCKET).getPublicUrl(path);
    if (urlErr) {
      console.error('[submit-payment] getPublicUrl failed:', urlErr);
      throw urlErr;
    }
    if (!pub?.publicUrl) {
      throw new Error(`getPublicUrl returned no URL for bucket "${BUCKET}" path "${path}" — check the bucket exists and is set to public.`);
    }
    screenshotUrl = pub.publicUrl;
  } catch (err) {
    console.error('[submit-payment] screenshot upload failed:', err);
    // Return the REAL failure instead of a generic message, so the actual
    // Supabase/config error is visible in the frontend and in logs.
    return res.status(500).json({
      error: err.message || 'Could not upload screenshot, please try again',
      code: err.code || err.name || null,
      details: {
        bucket: BUCKET,
        status: err.status || err.statusCode || null,
        hint: err.code === 'MISSING_SERVICE_ROLE_KEY'
          ? 'SUPABASE_SERVICE_ROLE_KEY is missing/invalid in Vercel env vars.'
          : 'Check the bucket name, that it exists in this Supabase project, and that SUPABASE_SERVICE_ROLE_KEY is the service_role key (not anon).',
      },
    });
  }

  const record = await store.createPayment({
    referenceId,
    name: name.trim(),
    email: email.trim(),
    phone: phone.trim(),
    amount: amount || '99',
    method,
    senderNumber: senderNumber.trim(),
    screenshotUrl,
  });

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
    await telegram.notifyNewPayment({ screenshotUrl, caption });
  } catch (err) {
    // Notification is best-effort only — the payment is already recorded
    // and visible in admin.html either way.
    console.error('Telegram notify failed:', err);
  }

  return res.status(200).json({ success: true, id: record.id });
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
