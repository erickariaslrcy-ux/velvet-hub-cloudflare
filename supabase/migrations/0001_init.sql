-- Esquema inicial: catálogo, favoritos, llaves de invitación y filtro fijo de protección de menores.

create extension if not exists unaccent with schema extensions;
create extension if not exists pg_trgm with schema extensions;

-- ---------------------------------------------------------------------------
-- Perfiles
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "perfil propio" on public.profiles;
create policy "perfil propio" on public.profiles
  for select to authenticated using (id = auth.uid());

create or replace function public.is_admin()
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false);
$$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email) values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Filtro fijo de protección de menores.
-- Vive en la base de datos: ningún script, archivo de configuración ni la web
-- puede desactivarlo. Cualquier ítem que coincida queda 'blocked' y la RLS
-- impide que un usuario lo vea.
-- ---------------------------------------------------------------------------
create or replace function public.minor_content_match(txt text)
returns boolean
language sql immutable
as $$
  select coalesce(
    lower(extensions.unaccent(txt)) ~* (
      '\m(' ||
        'loli|lolis|lolicon|lolita|lolitas|shota|shotas|shotacon|toddlercon|toddler|' ||
        'child|children|kid|kids|underage|under-age|preteen|pre-teen|infant|' ||
        'jailbait|pedo|pedophile|paedo|cub|' ||
        'nina|ninas|nino|ninos|nena|nenas|infantil|menor|menores|menor de edad|' ||
        'preadolescente|prepuber|prepubescent|primaria|kindergarten|guarderia' ||
      ')\M'
      || '|\m([0-9]|1[0-7]) ?(anos|ano|year|years|yo|y/o)\M'
    ),
    false
  );
$$;

-- ---------------------------------------------------------------------------
-- Catálogo
-- ---------------------------------------------------------------------------
create table if not exists public.items (
  id bigint generated always as identity primary key,
  source text not null,
  source_id text not null,
  url text not null default '',
  media_type text not null default 'comic',
  title text not null,
  cover_url text not null default '',
  language text not null default 'es',
  tags text[] not null default '{}',
  artists text[] not null default '{}',
  page_count integer not null default 0,
  pages jsonb not null default '[]',
  chapters jsonb not null default '[]',
  video_sources jsonb not null default '[]',
  published_at text,
  real_people boolean not null default false,
  status text not null default 'pending' check (status in ('pending', 'verified', 'blocked')),
  scraped_at timestamptz not null default now(),
  search_text text not null default '',
  unique (source, source_id)
);

create index if not exists items_search_trgm on public.items using gin (search_text extensions.gin_trgm_ops);
create index if not exists items_tags on public.items using gin (tags);
create index if not exists items_pages on public.items using gin (pages jsonb_path_ops);
create index if not exists items_source on public.items (source);
create index if not exists items_status on public.items (status);

create or replace function public.items_before_write()
returns trigger
language plpgsql
as $$
begin
  new.search_text := lower(extensions.unaccent(
    coalesce(new.title, '') || ' ' ||
    array_to_string(coalesce(new.tags, '{}'), ' ') || ' ' ||
    array_to_string(coalesce(new.artists, '{}'), ' ')
  ));
  if public.minor_content_match(new.search_text) then
    new.status := 'blocked';
  end if;
  -- Un ítem bloqueado nunca vuelve a desbloquearse por una actualización.
  if tg_op = 'UPDATE' and old.status = 'blocked' then
    new.status := 'blocked';
  end if;
  return new;
end;
$$;

drop trigger if exists items_before_write on public.items;
create trigger items_before_write
  before insert or update on public.items
  for each row execute function public.items_before_write();

alter table public.items enable row level security;

-- La tabla completa (con nombre de la fuente y URLs) solo la ve la cuenta admin.
-- Nadie ve ítems bloqueados ni con personas reales (requieren verificación 2257 aparte).
drop policy if exists "catalogo visible" on public.items;
drop policy if exists "items solo admin" on public.items;
create policy "items solo admin" on public.items
  for select to authenticated
  using (public.is_admin() and status <> 'blocked' and real_people = false);

revoke all on public.items from anon;

-- Alias de las fuentes: los usuarios normales solo ven "Fuente N".
create table if not exists public.source_aliases (
  source text primary key,
  label text not null unique
);

alter table public.source_aliases enable row level security;

drop policy if exists "alias solo admin" on public.source_aliases;
create policy "alias solo admin" on public.source_aliases
  for select to authenticated using (public.is_admin());

create sequence if not exists public.source_alias_seq;

create or replace function public.ensure_source_alias()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if not exists (select 1 from public.source_aliases where source = new.source) then
    insert into public.source_aliases (source, label)
    values (new.source, 'Fuente ' || nextval('public.source_alias_seq'))
    on conflict (source) do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists items_ensure_alias on public.items;
create trigger items_ensure_alias
  after insert on public.items
  for each row execute function public.ensure_source_alias();

-- Vista para usuarios normales: sin nombre de fuente, sin URL de origen y sin
-- URLs de imágenes (las imágenes se sirven por /api/img con el id del ítem).
create or replace view public.catalog
with (security_barrier = true)
as
select
  i.id,
  a.label as source_label,
  i.media_type,
  i.title,
  i.language,
  i.tags,
  i.artists,
  greatest(i.page_count, jsonb_array_length(i.pages)) as page_count,
  jsonb_array_length(i.pages) as page_total,
  coalesce(
    (select jsonb_agg(jsonb_build_object(
        'number', c->>'number',
        'title', coalesce(c->>'title', ''),
        'pages', jsonb_array_length(coalesce(c->'pages', '[]'::jsonb))
      ) order by ord)
     from jsonb_array_elements(i.chapters) with ordinality as t(c, ord)),
    '[]'::jsonb
  ) as chapters,
  i.video_sources,
  (i.cover_url <> '' or jsonb_array_length(i.pages) > 0 or jsonb_array_length(i.video_sources) > 0) as has_cover,
  i.search_text,
  i.scraped_at
from public.items i
left join public.source_aliases a on a.source = i.source
where i.status <> 'blocked' and i.real_people = false and auth.uid() is not null;

revoke all on public.catalog from anon, public;
grant select on public.catalog to authenticated;

-- ---------------------------------------------------------------------------
-- Favoritos
-- ---------------------------------------------------------------------------
create table if not exists public.favorites (
  user_id uuid not null references auth.users(id) on delete cascade,
  item_id bigint not null references public.items(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, item_id)
);

alter table public.favorites enable row level security;

drop policy if exists "favoritos propios leer" on public.favorites;
create policy "favoritos propios leer" on public.favorites
  for select to authenticated using (user_id = auth.uid());

drop policy if exists "favoritos propios crear" on public.favorites;
create policy "favoritos propios crear" on public.favorites
  for insert to authenticated with check (user_id = auth.uid());

drop policy if exists "favoritos propios borrar" on public.favorites;
create policy "favoritos propios borrar" on public.favorites
  for delete to authenticated using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Llaves de invitación (solo la cuenta maestra las crea y ve)
-- ---------------------------------------------------------------------------
create table if not exists public.invite_keys (
  code text primary key,
  note text not null default '',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  used_by uuid references auth.users(id) on delete set null,
  used_email text,
  used_at timestamptz,
  revoked boolean not null default false
);

alter table public.invite_keys enable row level security;

drop policy if exists "llaves solo admin" on public.invite_keys;
create policy "llaves solo admin" on public.invite_keys
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- Reservar una llave de forma atómica (la usa el servidor con la service role).
create or replace function public.claim_invite_key(p_code text, p_email text)
returns boolean
language plpgsql security definer set search_path = public
as $$
declare
  n integer;
begin
  update public.invite_keys
     set used_at = now(), used_email = p_email
   where code = p_code
     and used_at is null
     and revoked = false
     and (expires_at is null or expires_at > now());
  get diagnostics n = row_count;
  return n = 1;
end;
$$;

revoke all on function public.claim_invite_key(text, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Funciones auxiliares para la web
-- ---------------------------------------------------------------------------

-- Etiquetas "Fuente N" disponibles (sin revelar el sitio).
create or replace function public.catalog_sources()
returns table (label text)
language sql stable security definer set search_path = public
as $$
  select a.label
  from public.source_aliases a
  where auth.uid() is not null
    and exists (select 1 from public.items i where i.source = a.source and i.status <> 'blocked' and i.real_people = false)
  order by nullif(regexp_replace(a.label, '\D', '', 'g'), '')::int nulls last, a.label;
$$;

revoke all on function public.catalog_sources() from public, anon;
grant execute on function public.catalog_sources() to authenticated;

-- Resumen por fuente para el panel admin (incluye cuántos bloqueó el filtro).
create or replace function public.admin_stats()
returns table (source text, label text, total bigint, visibles bigint, bloqueados bigint, personas_reales bigint)
language sql stable security definer set search_path = public
as $$
  select i.source, a.label,
         count(*),
         count(*) filter (where i.status <> 'blocked' and not i.real_people),
         count(*) filter (where i.status = 'blocked'),
         count(*) filter (where i.real_people)
  from public.items i
  left join public.source_aliases a on a.source = i.source
  where public.is_admin()
  group by i.source, a.label
  order by i.source;
$$;

revoke all on function public.admin_stats() from public, anon;
grant execute on function public.admin_stats() to authenticated;

create or replace function public.admin_source_aliases()
returns table (source text, label text)
language sql stable security definer set search_path = public
as $$
  select source, label from public.source_aliases where public.is_admin();
$$;

revoke all on function public.admin_source_aliases() from public, anon;
grant execute on function public.admin_source_aliases() to authenticated;
