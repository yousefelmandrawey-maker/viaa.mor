// api/submit-payment.js
// POST  /api/submit-payment   — multipart form: name, email, phone, amount, method, senderNumber, screenshot(file)
// GET   /api/submit-payment?id=p_xxx                          — poll payment status (used by success.html)
// GET   /api/submit-payment?admin=1&token=...&action=list      — admin.html pending list
'use strict';

const Busboy = require('busboy');
const { supabaseAdmin } = require('./_lib/storage');
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
    const ext = (file.info?.filename?.split('.').pop() || 'jpg').toLowerCase();
    const path = `${referenceId}.${ext}`;
    const { error: uploadErr } = await supabaseAdmin.storage
      .from(BUCKET)
      .upload(path, file.buffer, {
        contentType: file.info?.mimeType || 'image/jpeg',
        upsert: false,
      });
    if (uploadErr) throw uploadErr;
    const { data: pub } = supabaseAdmin.storage.from(BUCKET).getPublicUrl(path);
    screenshotUrl = pub.publicUrl;
  } catch (err) {
    console.error('Supabase storage upload failed:', err);
    return res.status(500).json({ error: 'Could not upload screenshot, please try again' });
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
