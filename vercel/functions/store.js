// store.js — domain logic for payment records, now backed by Supabase
// (table: `payments`) instead of Vercel KV. Public-facing identifier is
// `reference_id` (what the URLs / Telegram / admin.html all use); the table's
// own `id` is a Supabase-generated UUID primary key we don't expose.
'use strict';

const { supabaseAdmin } = require('./storage');

const TABLE = 'payments';

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
  };
  const { data: inserted, error } = await supabaseAdmin
    .from(TABLE)
    .insert(row)
    .select()
    .single();
  if (error) throw new Error(`Supabase insert (payments) failed: ${error.message}`);
  return toPaymentRecord(inserted);
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
  return (data || []).map(toPaymentRecord);
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
    // The `payments` table (as specified) has no `product` column. We don't
    // persist it; infer a human-readable label from the amount instead so
    // Telegram/admin.html still show something meaningful.
    product: String(row.amount) === '100' ? 'Premium Trailer Upgrade' : 'Viaa Access Code',
    createdAt: row.created_at ? new Date(row.created_at).getTime() : null,
    approvedAt: row.approved_at ? new Date(row.approved_at).getTime() : null,
  };
}

module.exports = { createPayment, getPayment, approvePayment, rejectPayment, listPending };
