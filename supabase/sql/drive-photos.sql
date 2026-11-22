-- Google Drive photo uploads — schema for the store-drive-token and upload-photo
-- Edge Functions.
--
-- Run once in the Supabase SQL Editor (Project → SQL Editor → New query), after
-- tighten-anonymous-access.sql. Safe to re-run.

-- 1. Each host's Google refresh token (drive.file scope) + their cached app folder.
--    RLS is ON with NO policies, and table privileges are revoked from the public
--    roles, so nothing reachable with the anon key or a host's own session can read
--    it — only the Edge Functions, which use the service role key.
create table if not exists public.host_drive_tokens (
  user_id        uuid primary key references auth.users(id) on delete cascade,
  refresh_token  text not null,
  root_folder_id text,
  updated_at     timestamptz not null default now()
);

alter table public.host_drive_tokens enable row level security;
revoke all on public.host_drive_tokens from anon, authenticated;

-- 2. Each session's Drive subfolder (created lazily on the first upload).
alter table public.sessions add column if not exists drive_folder_id text;

-- 3. One row per photo uploaded to Drive. Used to:
--    - rate-limit uploads per session,
--    - check a retake's file_id really belongs to that session (so a player can't
--      overwrite some other session's photo by guessing/reusing a file id).
create table if not exists public.photo_uploads (
  id          bigint generated always as identity primary key,
  session_id  uuid not null references public.sessions(id) on delete cascade,
  file_id     text not null,
  cell_index  int  not null,
  created_at  timestamptz not null default now()
);

create index if not exists photo_uploads_session_created_idx
  on public.photo_uploads (session_id, created_at desc);
create index if not exists photo_uploads_file_idx
  on public.photo_uploads (file_id);

alter table public.photo_uploads enable row level security;
revoke all on public.photo_uploads from anon, authenticated;
