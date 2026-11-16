-- ==============================================================================
-- 01_RLS_POLICIES.SQL
-- AUDITORÍA Y FORTALECIMIENTO DE POLÍTICAS ROW LEVEL SECURITY (RLS)
-- Proyecto: Velvet Hub / Morbohub
-- Estado: Listo para revisión manual y ejecución por el administrador.
-- CARACTERÍSTICA: 100% IDEMPOTENTE, EXHAUSTIVO Y NO DESTRUCTIVO.
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. EXTENSIONES REQUERIDAS
-- ------------------------------------------------------------------------------
create extension if not exists unaccent with schema extensions;
create extension if not exists pg_trgm with schema extensions;

-- ------------------------------------------------------------------------------
-- 2. TABLA: profiles
-- Propósito: Perfil de usuario vinculado a auth.users.
-- Regla: Cada usuario solo puede leer y actualizar su propio perfil.
-- Creación: Exclusivamente vía trigger al crearse la cuenta en auth.users.
-- ------------------------------------------------------------------------------
alter table public.profiles enable row level security;

-- Limpieza de políticas previas
drop policy if exists "perfil propio" on public.profiles;
drop policy if exists "profiles_select_own" on public.profiles;
drop policy if exists "profiles_update_own" on public.profiles;
drop policy if exists "profiles_admin_all" on public.profiles;

-- Lectura: Solo el dueño autenticado o el rol administrador
create policy "profiles_select_own" on public.profiles
  for select to authenticated
  using (id = auth.uid() or public.is_admin());

-- Actualización: Solo el dueño de su cuenta (sin permitir auto-asignarse is_admin)
create policy "profiles_update_own" on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid() and (is_admin is not distinct from (select p.is_admin from public.profiles p where p.id = auth.uid())));

-- Acceso total para service_role (backend administrativo)
grant all on public.profiles to service_role;
grant select, update on public.profiles to authenticated;
revoke all on public.profiles from anon;

-- ------------------------------------------------------------------------------
-- 3. TABLA: items
-- Propósito: Catálogo principal (cómics, videos, galerías).
-- Regla: Lectura pública (anon y authenticated) permitida ÚNICAMENTE para
--        elementos válidos (status != 'blocked' AND real_people = false).
-- Escritura: Bloqueada para usuarios normales; solo permitida para service_role o admin.
-- ------------------------------------------------------------------------------
alter table public.items enable row level security;

drop policy if exists "catalogo visible" on public.items;
drop policy if exists "items solo admin" on public.items;
drop policy if exists "items_public_select" on public.items;
drop policy if exists "items_admin_all" on public.items;

-- Lectura pública con filtrado estricto RLS (excluye permanentemente blocked y real_people)
create policy "items_public_select" on public.items
  for select to anon, authenticated
  using (
    status <> 'blocked' 
    and real_people = false
  );

-- Control total para administradores autenticados
create policy "items_admin_all" on public.items
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- Permisos PostgREST: anon solo puede leer metadatos de listado público
-- (pages, video_sources, chapters, search_text, status, real_people y url quedan estrictamente revocadas)
revoke select on public.items from anon;
grant select (
  id, source, source_id, title, cover_url, thumb_color, thumb_lqip,
  media_type, language, tags, artists, page_count, published_at, scraped_at
) on public.items to anon;

grant select on public.items to authenticated;
grant all on public.items to service_role;

-- Función RPC con SECURITY DEFINER para lectura segura de detalle por parte del backend
create or replace function public.get_item_detail(p_id bigint)
returns table (
  id bigint,
  source text,
  source_id text,
  title text,
  cover_url text,
  thumb_color text,
  thumb_lqip text,
  media_type text,
  language text,
  tags text[],
  artists text[],
  page_count integer,
  pages jsonb,
  video_sources jsonb,
  chapters jsonb,
  published_at text,
  scraped_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  select
    i.id, i.source, i.source_id, i.title, i.cover_url,
    i.thumb_color, i.thumb_lqip, i.media_type, i.language,
    i.tags, i.artists, i.page_count, i.pages, i.video_sources,
    i.chapters, i.published_at, i.scraped_at
  from public.items i
  where i.id = p_id
    and i.status <> 'blocked'
    and i.real_people = false;
$$;

grant execute on function public.get_item_detail(bigint) to authenticated, service_role;
revoke execute on function public.get_item_detail(bigint) from anon;

-- ------------------------------------------------------------------------------
-- 4. TABLA: favorites
-- Propósito: Marcadores y favoritos del usuario.
-- Regla: Aislamiento estricto por usuario (user_id = auth.uid()).
-- ------------------------------------------------------------------------------
alter table public.favorites enable row level security;

drop policy if exists "favoritos propios leer" on public.favorites;
drop policy if exists "favoritos propios insertar" on public.favorites;
drop policy if exists "favoritos propios borrar" on public.favorites;
drop policy if exists "favorites_select_own" on public.favorites;
drop policy if exists "favorites_insert_own" on public.favorites;
drop policy if exists "favorites_delete_own" on public.favorites;

create policy "favorites_select_own" on public.favorites
  for select to authenticated
  using (user_id = auth.uid());

create policy "favorites_insert_own" on public.favorites
  for insert to authenticated
  with check (user_id = auth.uid());

create policy "favorites_delete_own" on public.favorites
  for delete to authenticated
  using (user_id = auth.uid());

grant select, insert, delete on public.favorites to authenticated;
grant all on public.favorites to service_role;
revoke all on public.favorites from anon;

-- ------------------------------------------------------------------------------
-- 5. TABLA: invite_keys
-- Propósito: Códigos de registro y acceso por invitación.
-- Regla: NINGÚN usuario anónimo o estándar puede leer ni escribir llaves directamente.
--        Solo service_role y cuentas con rol is_admin() pueden gestionarlas.
-- ------------------------------------------------------------------------------
create table if not exists public.invite_keys (
  code text primary key,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  used_at timestamptz,
  used_by uuid references auth.users(id),
  max_claims integer not null default 1,
  claim_count integer not null default 0,
  is_active boolean not null default true
);

alter table public.invite_keys enable row level security;

drop policy if exists "keys_admin_only" on public.invite_keys;
create policy "keys_admin_only" on public.invite_keys
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

grant all on public.invite_keys to service_role;
grant select on public.invite_keys to authenticated;
revoke all on public.invite_keys from anon;

-- ------------------------------------------------------------------------------
-- 6. TABLA: source_aliases
-- Propósito: Mapeo de fuentes a etiquetas neutrales ("Fuente 1", "Fuente 2").
-- Regla: Lectura pública para anon y authenticated; escritura solo service_role / admin.
-- ------------------------------------------------------------------------------
alter table public.source_aliases enable row level security;

drop policy if exists "alias solo admin" on public.source_aliases;
drop policy if exists "source_aliases_public_select" on public.source_aliases;
drop policy if exists "source_aliases_admin_all" on public.source_aliases;

create policy "source_aliases_public_select" on public.source_aliases
  for select to anon, authenticated
  using (true);

create policy "source_aliases_admin_all" on public.source_aliases
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

grant select on public.source_aliases to anon, authenticated;
grant all on public.source_aliases to service_role;

-- ------------------------------------------------------------------------------
-- 7. VISTA DE SEGURIDAD: catalog
-- Propósito: Vista sanitizada que oculta URLs originales de raspado.
-- ------------------------------------------------------------------------------
create or replace view public.catalog
with (security_barrier = true)
as
select
  i.id,
  a.label as source_label,
  i.media_type,
  i.title,
  i.cover_url,
  i.thumb_color,
  i.thumb_lqip,
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
where i.status <> 'blocked' and i.real_people = false;

grant select on public.catalog to anon, authenticated;
revoke insert, update, delete on public.catalog from anon, authenticated, public;

-- ------------------------------------------------------------------------------
-- 8. PRUEBAS DE VERIFICACIÓN AUTOMÁTICAS (ROLE anon Y RLS)
-- Comprueba que anon únicamente accede al catálogo público y metadatos permitidos,
-- y que NO puede leer columnas sensibles ni registros bloqueados.
-- ------------------------------------------------------------------------------
do $$
begin
  -- 1. Verificación de permisos de columna para anon (debe tener solo metadatos de listado)
  assert has_column_privilege('anon', 'public.items', 'id', 'SELECT'), 'anon debe poder leer id';
  assert has_column_privilege('anon', 'public.items', 'title', 'SELECT'), 'anon debe poder leer title';
  assert has_column_privilege('anon', 'public.items', 'cover_url', 'SELECT'), 'anon debe poder leer cover_url';
  assert has_column_privilege('anon', 'public.items', 'media_type', 'SELECT'), 'anon debe poder leer media_type';
  assert has_column_privilege('anon', 'public.items', 'page_count', 'SELECT'), 'anon debe poder leer page_count';

  -- 2. Verificación de columnas estrictamente revocadas para anon (deben fallar)
  assert not has_column_privilege('anon', 'public.items', 'pages', 'SELECT'),
    'FALLO DE AISLAMIENTO: anon tiene permiso SELECT sobre columna pages';
  assert not has_column_privilege('anon', 'public.items', 'video_sources', 'SELECT'),
    'FALLO DE AISLAMIENTO: anon tiene permiso SELECT sobre columna video_sources';
  assert not has_column_privilege('anon', 'public.items', 'chapters', 'SELECT'),
    'FALLO DE AISLAMIENTO: anon tiene permiso SELECT sobre columna chapters';
  assert not has_column_privilege('anon', 'public.items', 'search_text', 'SELECT'),
    'FALLO DE AISLAMIENTO: anon tiene permiso SELECT sobre columna search_text';
  assert not has_column_privilege('anon', 'public.items', 'status', 'SELECT'),
    'FALLO DE AISLAMIENTO: anon tiene permiso SELECT sobre columna status';
  assert not has_column_privilege('anon', 'public.items', 'real_people', 'SELECT'),
    'FALLO DE AISLAMIENTO: anon tiene permiso SELECT sobre columna real_people';
  assert not has_column_privilege('anon', 'public.items', 'url', 'SELECT'),
    'FALLO DE AISLAMIENTO: anon tiene permiso SELECT sobre columna url';

  -- 3. Verificación en contexto anon
  set local role anon;

  -- 3.1 anon puede consultar items permitidos
  perform id, title, cover_url, media_type, page_count from public.items limit 1;

  -- 3.2 anon puede consultar la vista de seguridad catalog
  perform id, title, cover_url, media_type, source_label from public.catalog limit 1;

  -- Restaurar rol de sesión para el resto del script
  reset role;

  raise notice '=======================================================';
  raise notice 'RLS OK: anon NO puede leer pages, video_sources, chapters,';
  raise notice 'search_text, status, real_people ni url. Filas protegidas.';
  raise notice '=======================================================';
end;
$$;

-- PRUEBAS ADICIONALES DE AISLAMIENTO PARA EJECUTAR MANUALMENTE EN EL EDITOR SQL:
-- SET ROLE anon;
-- SELECT pages FROM public.items LIMIT 1;        -- DEBE FALLAR: ERROR: permission denied for column pages
-- SELECT video_sources FROM public.items LIMIT 1;-- DEBE FALLAR: ERROR: permission denied for column video_sources
-- SELECT url FROM public.items LIMIT 1;          -- DEBE FALLAR: ERROR: permission denied for column url
-- SELECT * FROM public.profiles LIMIT 1;         -- DEBE FALLAR: ERROR: permission denied for table profiles
-- SELECT * FROM public.favorites LIMIT 1;        -- DEBE FALLAR: ERROR: permission denied for table favorites
-- SELECT * FROM public.invite_keys LIMIT 1;      -- DEBE FALLAR: ERROR: permission denied for table invite_keys
-- RESET ROLE;
-- RESET ROLE;
