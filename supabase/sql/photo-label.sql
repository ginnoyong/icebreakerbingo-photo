-- Photo label — the event title (font + colour) a host has drawn onto every photo
-- saved to their Google Drive.
--
-- Run once in the Supabase SQL Editor, after drive-photos.sql. Safe to re-run.

-- 1. One row per host. Like a host's phrases, the label is "live": editing it applies
--    to every later upload from any of that host's sessions.
create table if not exists public.host_photo_settings (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  title      text not null default '' check (char_length(title) <= 40),
  font       text not null default 'syne'
             check (font in ('syne', 'dmsans', 'bebas', 'playfair', 'pacifico', 'marker', 'caveat')),
  color      text not null default '#FFFFFF' check (color ~ '^#[0-9A-Fa-f]{6}$'),
  updated_at timestamptz not null default now()
);

alter table public.host_photo_settings enable row level security;

drop policy if exists "hosts_select_own_photo_settings" on public.host_photo_settings;
drop policy if exists "hosts_insert_own_photo_settings" on public.host_photo_settings;
drop policy if exists "hosts_update_own_photo_settings" on public.host_photo_settings;

create policy "hosts_select_own_photo_settings"
  on public.host_photo_settings for select to authenticated
  using (user_id = auth.uid());

create policy "hosts_insert_own_photo_settings"
  on public.host_photo_settings for insert to authenticated
  with check (user_id = auth.uid());

create policy "hosts_update_own_photo_settings"
  on public.host_photo_settings for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- 2. Players read the label through the same narrow lookup function as the phrases
--    (see tighten-anonymous-access.sql) — never the table itself. Adds a 'photo_label'
--    key; null when the host hasn't set one.
create or replace function public.get_session_phrases(p_session_id uuid)
returns jsonb
language sql
security definer
set search_path = public
stable
as $$
  select jsonb_build_object(
    'session_found', exists(select 1 from public.sessions where id = p_session_id),
    'phrases', (
      select up.phrases
      from public.sessions s
      join public.user_phrases up on up.user_id = s.host_id
      where s.id = p_session_id
      limit 1
    ),
    'photo_label', (
      select jsonb_build_object('title', ps.title, 'font', ps.font, 'color', ps.color)
      from public.sessions s
      join public.host_photo_settings ps on ps.user_id = s.host_id
      where s.id = p_session_id
      limit 1
    )
  );
$$;

grant execute on function public.get_session_phrases(uuid) to anon, authenticated;
