// api/approve-payment.js
// POST /api/approve-payment   body: { adminToken, id, action: "approve" | "reject" }
// Called only from admin.html. No Telegram webhook, no inline buttons.
'use strict';

const { supabaseAdmin } = require('./_lib/storage');
const store = require('./_lib/store');
const ids = require('./_lib/ids');
const telegram = require('./_lib/telegram');
const brevo = require('./_lib/brevo');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  try {
    const { adminToken, id, action } = body;
    if (!process.env.ADMIN_TOKEN || adminToken !== process.env.ADMIN_TOKEN) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (!id || !['approve', 'reject'].includes(action)) {
      return res.status(400).json({ error: 'Invalid request' });
    }

    const record = await store.getPayment(id);
    if (!record) return res.status(404).json({ error: 'Not found' });
    if (record.status !== 'pending') return res.status(409).json({ error: `Already ${record.status}` });

    if (action === 'approve') {
      const code = ids.newAccessCode();
      await insertSupabaseAccessCode(code);
      await store.approvePayment(id, code);

      try {
        await brevo.sendAccessCodeEmail({ to: record.email, name: record.name, code, product: record.product });
      } catch (err) {
        // Code is already issued & saved; the buyer can still see it on
        // success.html even if the email send fails. Log only.
        console.error('Brevo email failed:', err);
      }

      try {
        await telegram.notifyStatusChange({ text: `✅ Approved in admin.html — ${record.name} (${id})\nCode: ${code}` });
      } catch (err) {
        console.error('Telegram status notify failed:', err);
      }

      return res.status(200).json({ success: true, code });
    }

    await store.rejectPayment(id);
    try {
      await telegram.notifyStatusChange({ text: `❌ Rejected in admin.html — ${record.name} (${id})` });
    } catch (err) {
      console.error('Telegram status notify failed:', err);
    }
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('approve-payment error:', err);
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
  if (error) throw new Error(`Supabase insert (users) failed: ${error.message}`);
}
