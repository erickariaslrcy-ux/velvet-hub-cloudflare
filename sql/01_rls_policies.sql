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

-- Lectura pública con filtrado estricto RLS
create policy "items_public_select" on public.items
  for select to anon, authenticated
  using (
    status <> 'blocked' 
    and real_people = false
    and (cover_url <> '' or jsonb_array_length(pages) > 0 or jsonb_array_length(video_sources) > 0)
  );

-- Control total para administradores autenticados
create policy "items_admin_all" on public.items
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- Permisos PostgREST
grant select on public.items to anon, authenticated;
grant all on public.items to service_role;

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
