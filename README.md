# Viaa — Production Deployment (post-audit)

## What was actually broken (confirmed by inspecting file sizes, not guessed)

| File | Problem | Fix |
|---|---|---|
| `approve-payment.js` | **0 bytes — completely empty** | Rewritten from scratch. This was the entire reason the approval flow was broken: `admin.html` called an endpoint that didn't exist. |
| `brevo.js` | **0 bytes — completely empty** | Rewritten from scratch. No email-sending code existed at all. |
| `vercel.json` | **0 bytes — invalid JSON** | Replaced with a minimal valid config. An empty config file is why deploys were inconsistent — sometimes Vercel silently fell back to zero-config, sometimes it didn't. |
| Backend files flat instead of in `api/` | Vercel didn't auto-detect them as functions at all (only `/api/*` is auto-detected in zero-config) | Moved to `api/submit-payment.js` + `api/approve-payment.js`, with shared helpers in `api/_lib/` (the underscore prefix tells Vercel to exclude that folder from routing, so `storage.js`/`store.js`/`ids.js`/`telegram.js`/`brevo.js` don't each become their own broken endpoint). |
| `.env` | `SUPABASE_SERVICE_ROLE_KEY` and `ADMIN_TOKEN` blank | These must be filled in and pushed to Vercel — see below. Every Supabase write was silently failing without the service-role key; `admin.html` could never authenticate without `ADMIN_TOKEN`. |
| `index.html`, `app.html`, `payment.html`, `payment.js`, `success.html`, `admin.html` | **Nothing wrong** | Verified and left untouched. Button hooks and `/api/*` fetch calls were already correct. |

## Why this fixes the 404s for good
With everything now under `api/` and no `builds`/`routes`/`rewrites` anywhere, Vercel's zero-config detection handles both static HTML at the root and the two serverless functions automatically. There is no routing configuration left to misconfigure — the `vercel.json` that remains only sets a function timeout, nothing else.

## Final structure
```
/
├── index.html, app.html, about.html, demo.html, friendship.html, love.html, update.html
├── payment.html, payment.js, success.html, admin.html
├── package.json
├── vercel.json
├── .env            (fill in 2 values, never commit)
├── .gitignore
└── api/
    ├── submit-payment.js
    ├── approve-payment.js
    └── _lib/
        ├── storage.js      (Supabase service-role client)
        ├── store.js        (payments table domain logic)
        ├── ids.js           (reference id + access code generators)
        ├── telegram.js      (notification-only, no buttons/webhook)
        └── brevo.js         (access-code email)
```

## 1. Supabase — one-time setup (unchanged from before, re-verify it's actually applied)

```sql
create table public.payments (
  id uuid primary key default gen_random_uuid(),
  reference_id text unique not null,
  full_name text not null,
  email text not null,
  phone text not null,
  payment_method text not null,
  payment_number text not null,
  amount text not null,
  screenshot_url text,
  status text not null default 'pending',
  access_code text,
  created_at timestamptz not null default now(),
  approved_at timestamptz
);
create index on public.payments (status);
create index on public.payments (reference_id);
alter table public.payments enable row level security;
```

Storage → New bucket → `payments` → set **public**.

## 2. Environment variables — set these in Vercel, not just `.env`
`.env` is for local reference only; Vercel does not read it from the repo. Go to Vercel → Project → Settings → Environment Variables and add all of these for the **Production** environment:

| Variable | Value |
|---|---|
| `TELEGRAM_BOT_TOKEN` | from `.env` |
| `TELEGRAM_CHAT_ID` | from `.env` |
| `BREVO_API_KEY` | from `.env` |
| `BREVO_SENDER_EMAIL` | from `.env` |
| `BREVO_SENDER_NAME` | from `.env` |
| `SUPABASE_URL` | from `.env` |
| `SUPABASE_SERVICE_ROLE_KEY` | **you must fill this in** — Supabase → Settings → API → `service_role` key |
| `ADMIN_TOKEN` | **you must fill this in** — any long random string, this is your `admin.html` password |

This step alone explains several of your reported symptoms ("environment variables were changed several times," approval flow failing, Telegram sometimes not firing) — if these aren't set in the Vercel dashboard itself, the corresponding features fail at runtime regardless of how correct the code is.

## 3. Deploy
```bash
npm install
vercel deploy --prod
```
No webhook registration, no build step, no output directory setting needed.

## 4. Verify after deploy
- Visit `/` → should load `index.html`, not 404.
- Visit `/admin.html` → should show the admin token gate, not 404 or the landing page.
- Submit a test payment on `/payment.html` → should redirect to `/success.html` and poll.
- Check your Telegram chat for the notification.
- Approve it in `/admin.html` → check email arrives, and `/success.html` reveals the code.

⚠️ The Telegram bot token and Brevo API key have been shared in plain chat text multiple times now. Rotate both (BotFather `/revoke` for a new token, roll the key in Brevo's dashboard) and update the Vercel env vars with the new values — this is unrelated to the deployment bug but is a real exposure.
