// brevo.js — sends the access-code email via Brevo's transactional email API.
// Requires BREVO_API_KEY env var. Optionally BREVO_SENDER_EMAIL / BREVO_SENDER_NAME.
'use strict';

async function sendAccessCodeEmail({ to, name, code, product }) {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) throw new Error('BREVO_API_KEY is not configured');

  const senderEmail = process.env.BREVO_SENDER_EMAIL || 'no-reply@viaa.app';
  const senderName = process.env.BREVO_SENDER_NAME || 'Viaa';
  const firstName = (name || '').split(' ')[0] || 'there';

  const html = `
    <div style="font-family:Inter,Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#F8FAFC;border-radius:16px">
      <h2 style="color:#1E293B;margin:0 0 8px">Hi ${escapeHtml(firstName)}, your payment is confirmed ❤️</h2>
      <p style="color:#64748B;font-size:15px;line-height:1.6">
        Thank you for your payment${product ? ` for <strong>${escapeHtml(product)}</strong>` : ''}.
        Here is your one-time access code:
      </p>
      <div style="background:#FFFFFF;border:1px solid rgba(0,0,0,.08);border-radius:12px;padding:18px;text-align:center;margin:20px 0">
        <span style="font-size:24px;letter-spacing:2px;font-weight:700;color:#FF8A65">${escapeHtml(code)}</span>
      </div>
      <p style="color:#64748B;font-size:13px;line-height:1.6">
        This code can be used once. Keep it safe — it will not be shown again after use.
      </p>
    </div>`;

  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'api-key': apiKey,
    },
    body: JSON.stringify({
      sender: { email: senderEmail, name: senderName },
      to: [{ email: to, name: name || undefined }],
      subject: 'Your access code is ready ❤️',
      htmlContent: html,
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Brevo send failed: ${res.status} ${errText}`);
  }
  return res.json().catch(() => ({}));
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

module.exports = { sendAccessCodeEmail };
