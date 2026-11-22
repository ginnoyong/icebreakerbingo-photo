-- Base schema for a fresh Supabase project.
--
-- Run order in the SQL Editor (Project → SQL Editor → New query), one script per run:
--   1. base-schema.sql               (this file — tables, RLS on)
--   2. tighten-anonymous-access.sql  (RLS policies + get_session_phrases function)
--   3. drive-photos.sql              (photo edition: Drive tokens, upload log)
-- Safe to re-run.

create table if not exists public.user_phrases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) unique,
  phrases jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.sessions (
  id uuid primary key default gen_random_uuid(),
  host_id uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

-- RLS on with no policies = no access; tighten-anonymous-access.sql adds the
-- host-only policies.
alter table public.user_phrases enable row level security;
alter table public.sessions enable row level security;
