// telegram.js — notification-only Telegram Bot API client.
// No inline buttons, no callback queries, no webhook. Approval happens
// exclusively in admin.html. Requires TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID.
'use strict';

const { retryAsync } = require('./retry');

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
    return retryAsync(
        async (attempt, signal) => {
            const res = await fetch(`${API(token)}/${method}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal,
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || data.ok === false) {
                const err = new Error(`Telegram ${method} failed: ${data.description || res.status}`);
                err.status = res.status;
                throw err;
            }
            return data.result;
        },
        { retries: 2, baseDelayMs: 500, timeoutMs: 6000, label: `telegram.${method}` }
    );
}

// Fire-and-forget style notification — no reply_markup, no buttons.
// Still retried internally; callers treat this as best-effort and should
// keep wrapping calls in their own try/catch so a Telegram outage never
// blocks the payment flow itself.
async function notifyNewPayment({ screenshotUrl, caption }) {
    const { token, chatId } = getEnv();
    if (screenshotUrl) {
        try {
            return await callApi(token, 'sendPhoto', {
                chat_id: chatId,
                photo: screenshotUrl,
                caption,
                parse_mode: 'HTML',
            });
        } catch (err) {
            // Photo delivery can fail if Telegram hasn't finished fetching the
            // (freshly uploaded) image yet. Fall back to a text-only notification
            // so the team still gets alerted even if the photo itself doesn't land.
            console.error('[telegram] sendPhoto failed, falling back to sendMessage:', err.message);
            return callApi(token, 'sendMessage', {
                chat_id: chatId,
                text: `${caption}\n\n⚠️ (screenshot photo delivery failed, see: ${screenshotUrl})`,
                parse_mode: 'HTML',
            });
        }
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