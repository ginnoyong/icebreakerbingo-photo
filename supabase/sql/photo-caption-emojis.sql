-- Caption emoji — each saved caption becomes { "text": "...", "emojis": ["🌴", "🚲", ...] }
-- instead of a plain string, so each photo can show 1–3 of that caption's emoji on the
-- left and the same ones mirrored on the right.
--
-- Run once in the Supabase SQL Editor, after photo-captions.sql. Safe to re-run.
-- Captions saved earlier as plain strings stay valid (the app converts them).

create or replace function public.captions_are_valid(c jsonb)
returns boolean
language sql
immutable
as $$
  select jsonb_typeof(c) = 'array'
     and jsonb_array_length(c) <= 20
     and not exists (
       select 1 from jsonb_array_elements(c) e
       where not (
         -- older format: a plain string
         (jsonb_typeof(e) = 'string' and char_length(e #>> '{}') between 1 and 40)
         or
         -- current format: { text, emojis }
         (jsonb_typeof(e) = 'object'
           and jsonb_typeof(e -> 'text') = 'string'
           and char_length(e ->> 'text') between 1 and 40
           and jsonb_typeof(e -> 'emojis') = 'array'
           and jsonb_array_length(e -> 'emojis') <= 6
           and not exists (
             select 1 from jsonb_array_elements(e -> 'emojis') m
             where jsonb_typeof(m) <> 'string' or char_length(m #>> '{}') not between 1 and 16
           ))
       )
     );
$$;

-- Re-attach the check so it uses the new definition.
alter table public.host_photo_settings drop constraint if exists captions_valid;
alter table public.host_photo_settings
  add constraint captions_valid check (public.captions_are_valid(captions));
