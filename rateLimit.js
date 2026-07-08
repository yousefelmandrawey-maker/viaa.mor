// ids.js — id + access code generation helpers
'use strict';

const crypto = require('crypto');

// Short, URL-safe payment id, e.g. "p_9f3a2c7b1e4d"
function newPaymentId() {
  return 'p_' + crypto.randomBytes(8).toString('hex');
}

// Access code generator — kept in the SAME shape as the existing client-side
// CodeGenerationService in index.html ('V' + 10 chars, unambiguous charset)
// so codes issued here work with the existing Supabase `users` table / builder login.
function newAccessCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let out = 'V';
  for (let i = 0; i < 10; i++) {
    out += chars[crypto.randomInt(0, chars.length)];
  }
  return out;
}

module.exports = { newPaymentId, newAccessCode };
