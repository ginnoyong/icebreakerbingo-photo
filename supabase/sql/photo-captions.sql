-- Random photo captions — replaces the single event title (photo-label.sql).
-- The host saves a list of short captions (AI-suggested from a theme, then reviewed and
-- edited by the host); each photo saved to their Drive gets one of them, in a random
-- font and colour chosen on the player's phone.
--
-- Run once in the Supabase SQL Editor, after photo-label.sql. Safe to re-run.
-- (The old title/font/color columns are left in place but no longer used.)

-- Every element must be a non-empty string of at most 40 characters (the UI limits
-- captions to 30 visible characters; emoji can take several characters each).
create or replace function public.captions_are_valid(c jsonb)
returns boolean
language sql
immutable
as $$
  select jsonb_typeof(c) = 'array'
     and jsonb_array_length(c) <= 20
     and not exists (
       select 1 from jsonb_array_elements(c) e
       where jsonb_typeof(e) <> 'string'
          or char_length(e #>> '{}') not between 1 and 40
     );
$$;

alter table public.host_photo_settings
  add column if not exists caption_theme text not null default '',
  add column if not exists captions jsonb not null default '[]'::jsonb;

alter table public.host_photo_settings drop constraint if exists caption_theme_length;
alter table public.host_photo_settings
  add constraint caption_theme_length check (char_length(caption_theme) <= 100);

alter table public.host_photo_settings drop constraint if exists captions_valid;
alter table public.host_photo_settings
  add constraint captions_valid check (public.captions_are_valid(captions));

-- Players get the caption list through the same narrow lookup function as the phrases.
-- 'photo_captions' is [] when the host has none (= no overlay).
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
    'photo_captions', coalesce((
      select ps.captions
      from public.sessions s
      join public.host_photo_settings ps on ps.user_id = s.host_id
      where s.id = p_session_id
      limit 1
    ), '[]'::jsonb)
  );
$$;

grant execute on function public.get_session_phrases(uuid) to anon, authenticated;
