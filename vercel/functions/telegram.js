// telegram.js — notification-only Telegram Bot API client.
// No inline buttons, no callback queries, no webhook. Approval happens
// exclusively in admin.html. Requires TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID.
'use strict';

const API = (token) => `https://api.telegram.org/bot${token}`;

function getEnv() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    throw new Error('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID are not configured');
  }
  return { token, chatId };
}

async function callApi(token, method, payload) {
  const res = await fetch(`${API(token)}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(`Telegram ${method} failed: ${data.description || res.status}`);
  }
  return data.result;
}

// Fire-and-forget style notification — no reply_markup, no buttons.
async function notifyNewPayment({ screenshotUrl, caption }) {
  const { token, chatId } = getEnv();
  if (screenshotUrl) {
    return callApi(token, 'sendPhoto', {
      chat_id: chatId,
      photo: screenshotUrl,
      caption,
      parse_mode: 'HTML',
    });
  }
  return callApi(token, 'sendMessage', {
    chat_id: chatId,
    text: caption,
    parse_mode: 'HTML',
  });
}

// Optional follow-up notification once admin.html approves/rejects, purely
// informational — still no buttons, no webhook involved.
async function notifyStatusChange({ text }) {
  const { token, chatId } = getEnv();
  return callApi(token, 'sendMessage', { chat_id: chatId, text, parse_mode: 'HTML' });
}

module.exports = { notifyNewPayment, notifyStatusChange };
