# Viaa — Sprint 10: Semi-Automatic Payment System

Supabase only. No Paymob, no Stripe, no Vercel KV, no Vercel Blob.
No inline Telegram buttons — Telegram is notification-only, all approval
happens in `admin.html`.

## Flow
1. Buyer taps **Buy Access Code** (index.html) or **Upgrade to Premium
   Trailer** (app.html) → redirected to `payment.html`.
2. `payment.html` shows Vodafone Cash / InstaPay, payment number
   **01060577088**, and a form: Full Name, Email, Phone, Payment Method,
   Transaction Number, Screenshot.
3. On submit, `submit-payment.js`:
   - uploads the screenshot to the Supabase Storage bucket `payments`
   - inserts a row into the Supabase table `payments`
   - sends a plain Telegram message (name, email, phone, method, transaction
     number, screenshot) — no buttons
   - redirects the buyer to `success.html`, which polls for status
4. You open `admin.html`, see all pending payments, tap **Approve** or
   **Reject**.
5. On Approve, `approve-payment.js`:
   - generates a one-time access code
   - inserts it into the existing Supabase `users` table with the exact same
     schema/shape the Builder already uses (`access_code`,
     `remaining_generations: 1`, `active: true`) — schema untouched
   - emails the code via Brevo
   - marks the payment row `approved`
6. `success.html` (still polling) detects `approved` and reveals the code.

## 1. Supabase — one-time setup

Run in the Supabase SQL editor:

```sql
create table public.payments (
  id uuid primary key default gen_random_uuid(),
  reference_id text unique not null,
  full_name text not null,
  email text not null,
  phone text not null,
  payment_method text not null,        -- 'vodafone_cash' | 'instapay'
  payment_number text not null,        -- transaction / sender number
  amount text not null,
  screenshot_url text,
  status text not null default 'pending',  -- pending | approved | rejected
  access_code text,
  created_at timestamptz not null default now(),
  approved_at timestamptz
);

create index on public.payments (status);
create index on public.payments (reference_id);

alter table public.payments enable row level security;
-- No public policies needed — the backend uses the service-role key, which
-- bypasses RLS. The existing `users` table and its schema are untouched.
```

Then: Dashboard → Storage → New bucket → name it **`payments`** → set it
**public** (so screenshot links work directly in admin.html / Telegram).

## 2. Environment variables
A ready `.env` file is included with your Telegram + Brevo credentials
already filled in. Two values only you have — fill them in before deploying:

- `SUPABASE_SERVICE_ROLE_KEY` — Supabase → Settings → API → `service_role` key
- `ADMIN_TOKEN` — any long random string; this is the password for `admin.html`

Then push them to Vercel:
```bash
vercel env add SUPABASE_SERVICE_ROLE_KEY production
vercel env add ADMIN_TOKEN production
vercel env add TELEGRAM_BOT_TOKEN production
vercel env add TELEGRAM_CHAT_ID production
vercel env add BREVO_API_KEY production
vercel env add BREVO_SENDER_EMAIL production
vercel env add BREVO_SENDER_NAME production
```
(or paste `.env` directly into Vercel → Project → Settings → Environment Variables)

⚠️ The Telegram bot token and Brevo API key were shared in plain chat text —
rotate both after setup (BotFather `/revoke` for a new token, roll the key in
Brevo's dashboard), then update the env vars with the new values.

## 3. Deploy
```bash
npm install
vercel deploy --prod
```
No webhook registration needed — Telegram is notification-only.

## Files
- `index.html`, `app.html`, `update.html` — your existing site/Builder, untouched except for two button hooks (`payBtn` in index.html, `uc_btn` in app.html) now redirecting to `payment.html`. Design, animations, Builder logic, Generation, Themes, and Supabase auth are all unmodified.
- `payment.html` / `payment.js` — payment form + screenshot upload
- `success.html` — polls `/api/submit-payment?id=...` until approved
- `admin.html` — password-gated, lists pending payments, Approve/Reject (the only place approval happens)
- `vercel/functions/submit-payment.js` — create payment (Supabase Storage + table), status polling, admin list
- `vercel/functions/approve-payment.js` — admin-only approve/reject, issues code, writes to `users`, sends email
- `vercel/functions/telegram.js` — notification-only (no buttons, no webhook)
- `vercel/functions/brevo.js` — access-code email
- `vercel/functions/store.js` — `payments` table domain logic
- `vercel/functions/storage.js` — Supabase service-role client
- `vercel/functions/ids.js` — reference id + access code generators
- `.env` — your credentials, two fields left for you to fill in
- `package.json`, `vercel.json`
