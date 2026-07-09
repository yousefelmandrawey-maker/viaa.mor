-- ═════════════════════════════════════════════════════════════════════════
-- Viaa — Pages / Photos / Trailer pipeline schema
--
-- STATUS BEFORE THIS FILE: none of this existed anywhere in the repo.
-- Every route in api/trailer/*.js, lib/trailerStorage.js, lib/trailerRetry.js,
-- and every db.from('pages') / db.from('photos') call in app.html, love.html,
-- friendship.html, success.html, update.html assumes these tables, columns,
-- buckets, and function already exist in Supabase. They do not, until this
-- file (or the equivalent) is run once against the project's Postgres
-- instance via the Supabase SQL editor.
--
-- Run this AFTER the `payments` table from README.md has already been
-- created (this file's ALTER TABLE on `payments` depends on it existing).
-- ═════════════════════════════════════════════════════════════════════════

-- ── 1. pages ─────────────────────────────────────────────────────────────
-- Every column here is read or written by app.html (create), update.html
-- (edit), love.html / friendship.html (render), and api/trailer/*.js
-- (trailer state machine).
create table if not exists public.pages (
  id uuid primary key default gen_random_uuid(),
  owner_code text not null,                 -- access code of the creator (users.access_code)
  user_id uuid,                             -- references public.users(id) if that table uses uuid ids
  edition text not null default 'love',     -- 'love' | 'friendship'
  boy_name text,
  girl_name text,
  message text,
  start_date date,
  music_url text,
  audio_type text,                          -- 'music' | 'voice'
  theme text,                               -- theme id, e.g. 'classic', 'midnight', 'golden_days'
  message_style text,                       -- 'typewriter' | 'fade' | 'letter' | 'envelope' | 'instant'
  secret_date date,
  secret_code text,
  timeline jsonb,                           -- [{date,title,desc}, ...]
  gift_mode boolean,
  surprise_mode boolean,
  discover_mode boolean,

  -- Trailer state machine — read/written by app.html (free trailer),
  -- api/trailer/queue.js, api/trailer/webhook.js, api/trailer/poll.js,
  -- lib/trailerRetry.js, and rendered by love.html/friendship.html.
  trailer_type text,                        -- null | 'free' | 'premium'
  trailer_status text default 'none',       -- 'none' | 'pending' | 'ready' | 'failed'
  trailer_url text,
  trailer_job_id text,                      -- provider's generation id (Luma etc.), used to match webhook/poll back to this row
  trailer_retry_count int default 0,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists pages_owner_code_idx on public.pages (owner_code);
create index if not exists pages_trailer_status_idx on public.pages (trailer_status);
create index if not exists pages_trailer_job_id_idx on public.pages (trailer_job_id);

alter table public.pages enable row level security;

-- Anonymous/public read: love.html and friendship.html load a page by id
-- with the anon key and no login. Write access (insert/update) is also
-- performed with the anon key directly from app.html/update.html today —
-- there is no server-side page-write route. This means anyone with the
-- anon key can currently write any page id; access control for "is this
-- your page" is enforced only by possession of owner_code, not by RLS.
-- These two policies preserve that existing (weak) trust model rather than
-- silently changing app behavior; tightening this is a separate, real
-- security improvement outside the scope of the trailer audit.
create policy "pages_public_read" on public.pages
  for select using (true);
create policy "pages_public_write" on public.pages
  for insert with check (true);
create policy "pages_public_update" on public.pages
  for update using (true);

-- ── 2. photos ────────────────────────────────────────────────────────────
create table if not exists public.photos (
  id uuid primary key default gen_random_uuid(),
  page_id uuid not null references public.pages(id) on delete cascade,
  photo_url text not null,
  created_at timestamptz not null default now()
);

create index if not exists photos_page_id_idx on public.photos (page_id);

alter table public.photos enable row level security;
create policy "photos_public_read" on public.photos
  for select using (true);
create policy "photos_public_write" on public.photos
  for insert with check (true);

-- ── 3. payments.page_id ─────────────────────────────────────────────────
-- Links a Premium Trailer purchase back to the page it's for. Without this
-- column, api/_lib/store.js's createPayment() silently drops page_id on
-- insert (see its 42703 fallback), and api/trailer/queue.js's payment
-- verification falls back to a weaker trailer_type-only check. Both
-- degrade gracefully today, but the automatic "approve payment → queue
-- trailer" flow in success.html never actually fires without this column.
alter table public.payments
  add column if not exists page_id uuid references public.pages(id);

create index if not exists payments_page_id_idx on public.payments (page_id);

-- ── 4. check_rate_limit RPC ──────────────────────────────────────────────
-- Backing function for api/_lib/rateLimit.js's checkRateLimit(), used by
-- api/trailer/queue.js (5/hour/page) and api/trailer/poll.js (10/min
-- global), and also by api/submit-payment.js. Sliding-window limiter
-- backed by a table so counts are shared across all serverless instances.
create table if not exists public.rate_limit_hits (
  id bigserial primary key,
  key text not null,
  hit_at timestamptz not null default now()
);

create index if not exists rate_limit_hits_key_time_idx on public.rate_limit_hits (key, hit_at);

create or replace function public.check_rate_limit(
  p_key text,
  p_limit int,
  p_window_seconds int
) returns boolean
language plpgsql
security definer
as $$
declare
  v_count int;
begin
  delete from public.rate_limit_hits
    where key = p_key and hit_at < now() - make_interval(secs => p_window_seconds);

  select count(*) into v_count from public.rate_limit_hits where key = p_key;

  if v_count >= p_limit then
    return false;
  end if;

  insert into public.rate_limit_hits (key) values (p_key);
  return true;
end;
$$;

-- Housekeeping: without this, rate_limit_hits grows forever. Not
-- scheduled automatically here (Supabase pg_cron availability varies by
-- plan) — run manually or wire to pg_cron if available:
--   select cron.schedule('rate_limit_cleanup', '0 * * * *',
--     $$delete from public.rate_limit_hits where hit_at < now() - interval '1 day'$$);

-- ── 5. Storage buckets ───────────────────────────────────────────────────
-- Run these from the Supabase Dashboard → Storage (bucket creation isn't
-- reliably scriptable via plain SQL across all Supabase versions), or via
-- the storage API. Required buckets, referenced by exact name in code:
--
--   'photos'   — public  — app.html uploadXHR('photos', ...)      (page images)
--   'music'    — public  — app.html uploadXHR('music', ...)       (page audio)
--   'trailers' — public  — lib/trailerStorage.js persistTrailerVideo()
--                           (Premium, server-side) AND app.html
--                           generateAndUploadFreeTrailer() (Free, client-side)
--   'payments' — PRIVATE — already documented in README.md; screenshots
--                           are served via signed URLs (api/_lib/storage.js
--                           getSignedUrl), never public.
--
-- 'trailers' must additionally allow INSERT from the anon role, because
-- the Free Trailer is uploaded directly from the browser with the anon
-- key (app.html generateAndUploadFreeTrailer) — the Premium path uploads
-- with the service-role key from api/trailer/*.js and bypasses RLS
-- automatically, but Free does not. Example policy (Storage → Policies):
--
--   create policy "trailers_public_read" on storage.objects
--     for select using (bucket_id = 'trailers');
--   create policy "trailers_anon_upload" on storage.objects
--     for insert with check (bucket_id = 'trailers');
