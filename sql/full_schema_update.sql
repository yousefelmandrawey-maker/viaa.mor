-- ═════════════════════════════════════════════════════════════════════════
-- Viaa — FULL SCHEMA UPDATE (production-ready, idempotent)
--
-- Safe to run multiple times and safe to run whether or not
-- sql/trailer_and_pages_schema.sql was already applied — every statement
-- uses IF NOT EXISTS / ON CONFLICT DO NOTHING / a guarded DO block, so
-- re-running this never errors and never duplicates data.
--
-- Covers, end to end: pages, photos, payments.page_id, rate limiting,
-- and the three Storage buckets (photos, music, trailers) with their
-- required policies — including the Free Trailer's anon-key upload into
-- 'trailers', which the Premium (service-role) path does not need but
-- Free does.
--
-- Run this in the Supabase SQL editor. Requires the `payments` and
-- `users` tables (from README.md's initial setup) to already exist —
-- this file only ALTERs `payments`, it does not create it.
-- ═════════════════════════════════════════════════════════════════════════

-- ── 1. pages ─────────────────────────────────────────────────────────────
create table if not exists public.pages (
  id uuid primary key default gen_random_uuid(),
  owner_code text not null,
  user_id uuid,
  edition text not null default 'love',
  boy_name text,
  girl_name text,
  message text,
  start_date date,
  music_url text,
  audio_type text,
  theme text,
  message_style text,
  secret_date date,
  secret_code text,
  timeline jsonb,
  gift_mode boolean,
  surprise_mode boolean,
  discover_mode boolean,

  trailer_type text,                        -- null | 'free' | 'premium'
  trailer_status text default 'none',       -- 'none' | 'pending' | 'ready' | 'failed'
  trailer_url text,
  trailer_job_id text,
  trailer_retry_count int default 0,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Backfill columns individually in case an older version of `pages` exists
-- without the trailer state machine (e.g. deployed before this feature).
alter table public.pages add column if not exists owner_code text;
alter table public.pages add column if not exists user_id uuid;
alter table public.pages add column if not exists edition text default 'love';
alter table public.pages add column if not exists boy_name text;
alter table public.pages add column if not exists girl_name text;
alter table public.pages add column if not exists message text;
alter table public.pages add column if not exists start_date date;
alter table public.pages add column if not exists music_url text;
alter table public.pages add column if not exists audio_type text;
alter table public.pages add column if not exists theme text;
alter table public.pages add column if not exists message_style text;
alter table public.pages add column if not exists secret_date date;
alter table public.pages add column if not exists secret_code text;
alter table public.pages add column if not exists timeline jsonb;
alter table public.pages add column if not exists gift_mode boolean;
alter table public.pages add column if not exists surprise_mode boolean;
alter table public.pages add column if not exists discover_mode boolean;
alter table public.pages add column if not exists trailer_type text;
alter table public.pages add column if not exists trailer_status text default 'none';
alter table public.pages add column if not exists trailer_url text;
alter table public.pages add column if not exists trailer_job_id text;
alter table public.pages add column if not exists trailer_retry_count int default 0;
alter table public.pages add column if not exists created_at timestamptz not null default now();
alter table public.pages add column if not exists updated_at timestamptz not null default now();

create index if not exists pages_owner_code_idx on public.pages (owner_code);
create index if not exists pages_trailer_status_idx on public.pages (trailer_status);
create index if not exists pages_trailer_job_id_idx on public.pages (trailer_job_id);

alter table public.pages enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'pages' and policyname = 'pages_public_read') then
    create policy "pages_public_read" on public.pages for select using (true);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'pages' and policyname = 'pages_public_write') then
    create policy "pages_public_write" on public.pages for insert with check (true);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'pages' and policyname = 'pages_public_update') then
    create policy "pages_public_update" on public.pages for update using (true);
  end if;
end $$;

-- ── 2. photos ────────────────────────────────────────────────────────────
create table if not exists public.photos (
  id uuid primary key default gen_random_uuid(),
  page_id uuid not null references public.pages(id) on delete cascade,
  photo_url text not null,
  created_at timestamptz not null default now()
);

create index if not exists photos_page_id_idx on public.photos (page_id);

alter table public.photos enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'photos' and policyname = 'photos_public_read') then
    create policy "photos_public_read" on public.photos for select using (true);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'photos' and policyname = 'photos_public_write') then
    create policy "photos_public_write" on public.photos for insert with check (true);
  end if;
end $$;

-- ── 3. payments.page_id ─────────────────────────────────────────────────
-- Requires the `payments` table to already exist (README.md initial setup).
alter table public.payments
  add column if not exists page_id uuid references public.pages(id);

create index if not exists payments_page_id_idx on public.payments (page_id);

-- ── 4. check_rate_limit RPC ──────────────────────────────────────────────
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

-- ── 5. Storage buckets ───────────────────────────────────────────────────
-- Scriptable directly via the storage.buckets table (no dashboard clicking
-- required). 'payments' stays private; the other three are public-read.
insert into storage.buckets (id, name, public)
  values ('photos', 'photos', true)
  on conflict (id) do update set public = true;

insert into storage.buckets (id, name, public)
  values ('music', 'music', true)
  on conflict (id) do update set public = true;

insert into storage.buckets (id, name, public)
  values ('trailers', 'trailers', true)
  on conflict (id) do update set public = true;

insert into storage.buckets (id, name, public)
  values ('payments', 'payments', false)
  on conflict (id) do nothing;

-- ── 6. Storage policies ──────────────────────────────────────────────────
-- 'photos' and 'music': public read + anon upload — app.html already
-- uploads directly to these with the anon key (uploadXHR), so these
-- policies formalize what production already requires.
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'photos_public_read') then
    create policy "photos_public_read" on storage.objects for select using (bucket_id = 'photos');
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'photos_anon_upload') then
    create policy "photos_anon_upload" on storage.objects for insert with check (bucket_id = 'photos');
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'music_public_read') then
    create policy "music_public_read" on storage.objects for select using (bucket_id = 'music');
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'music_anon_upload') then
    create policy "music_anon_upload" on storage.objects for insert with check (bucket_id = 'music');
  end if;
end $$;

-- 'trailers': public read for everyone (Premium AND Free trailer playback
-- on love.html/friendship.html) + anon upload (Free Trailer only — uploaded
-- directly from the browser in app.html with the anon key). The Premium
-- path uploads with the service-role key from api/trailer/*.js, which
-- bypasses RLS automatically and does not need this insert policy, but it
-- does not hurt that path either.
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'trailers_public_read') then
    create policy "trailers_public_read" on storage.objects for select using (bucket_id = 'trailers');
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'trailers_anon_upload') then
    create policy "trailers_anon_upload" on storage.objects for insert with check (bucket_id = 'trailers');
  end if;
end $$;

-- 'payments': private. Screenshots are served only via signed URLs
-- (api/_lib/storage.js getSignedUrl, using the service-role key, which
-- bypasses RLS) — no public/anon policy is created for this bucket.

-- ── Done ─────────────────────────────────────────────────────────────────
-- After running this file:
--   1. Set TRAILER_PROVIDER=luma and LUMA_API_KEY in your environment.
--   2. Set TRAILER_WEBHOOK_SECRET (required even though Luma is poll-only —
--      api/trailer/webhook.js requires it configured before it will accept
--      any future webhook-capable provider).
--   3. Confirm the Vercel Cron entry in vercel.json is deployed so
--      api/trailer/poll.js actually runs on a schedule for Premium jobs.
