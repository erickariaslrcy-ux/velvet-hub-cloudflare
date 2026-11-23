-- ==============================================================================
-- 10_PERSONAL_DATA_SCHEMA.SQL
-- ESQUEMA DE DATOS PERSONALES: HISTORIAL, PROGRESO, PREFERENCIAS Y FAVORITOS
-- Proyecto: Velvet Hub
-- Rama: feat/datos-personales
-- Características: 100% IDEMPOTENTE, NO DESTRUCTIVO, CON RLS ESTRICTA POR auth.uid()
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- NOTA DE RESPALDO PREVIO (EN CASO DE APLICAR EN PRODUCCIÓN):
-- En un entorno real, ejecutar previamente en la consola SQL de Supabase:
--   CREATE TABLE IF NOT EXISTS _backup_favorites_20261115 AS SELECT * FROM public.favorites;
-- ------------------------------------------------------------------------------

-- 1. TABLA: public.favorites (Optimización de índices y deterministic sorting)
-- ------------------------------------------------------------------------------
-- La tabla ya existe en 0001_init.sql con PK (user_id, item_id).
-- Añadimos índice compuesto determinista para paginación eficiente de 24 en 24.
CREATE INDEX IF NOT EXISTS idx_favorites_user_created_item
  ON public.favorites (user_id, created_at DESC, item_id DESC);

-- 2. TABLA: public.user_history (Historial y Progreso Unificado)
-- ------------------------------------------------------------------------------
-- Cada cuenta tiene exactamente una fila por (user_id, item_id) que refleja
-- su última actividad y su posición exacta (página en cómics, segundos en video).
CREATE TABLE IF NOT EXISTS public.user_history (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  item_id bigint not null references public.items(id) on delete cascade,
  media_type text not null default 'comic' check (media_type in ('comic', 'video', 'gallery')),
  position integer not null default 0 check (position >= 0),
  duration integer not null default 0 check (duration >= 0),
  completed boolean not null default false,
  last_activity timestamptz not null default now(),
  client_timestamp bigint not null default 0,
  constraint user_history_user_item_unique unique (user_id, item_id)
);

-- Índices de alto rendimiento para orden cronológico determinista y paginación
CREATE INDEX IF NOT EXISTS idx_user_history_user_activity
  ON public.user_history (user_id, last_activity DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_user_history_user_item
  ON public.user_history (user_id, item_id);

-- 3. TABLA: public.user_preferences (Configuración Multi-Dispositivo)
-- ------------------------------------------------------------------------------
-- Almacena las preferencias del usuario (calidad, tema, ambilight, pauseHistory, etc.)
-- Aislada de public.profiles para prevenir cualquier escalada de privilegios a is_admin.
CREATE TABLE IF NOT EXISTS public.user_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  version integer not null default 2,
  updated_at timestamptz not null default now(),
  constraint user_preferences_size_check check (octet_length(data::text) <= 16384)
);

-- 4. FUNCIÓN RPC: upsert_history (Resolución Concurrente Anti-Carreras)
-- ------------------------------------------------------------------------------
-- Regla de Oro: SECURITY INVOKER (opera bajo los permisos del usuario invocador).
-- Utiliza estrictamente auth.uid(), ignorando cualquier user_id enviado por cliente.
-- Condición ON CONFLICT: Solo actualiza si client_timestamp entrante es mayor o igual
-- que el existente, evitando que un dispositivo desactualizado sobreescriba un progreso más nuevo.
CREATE OR REPLACE FUNCTION public.upsert_history(
  p_item_id bigint,
  p_media_type text default 'comic',
  p_position integer default 0,
  p_duration integer default 0,
  p_completed boolean default false,
  p_client_timestamp bigint default 0
)
RETURNS public.user_history
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_res public.user_history;
  v_client_ts bigint := coalesce(p_client_timestamp, round(extract(epoch from now()) * 1000)::bigint);
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No autenticado: auth.uid() es nulo' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.user_history (
    user_id,
    item_id,
    media_type,
    position,
    duration,
    completed,
    last_activity,
    client_timestamp
  )
  VALUES (
    v_uid,
    p_item_id,
    coalesce(p_media_type, 'comic'),
    greatest(0, coalesce(p_position, 0)),
    greatest(0, coalesce(p_duration, 0)),
    coalesce(p_completed, false),
    now(),
    v_client_ts
  )
  ON CONFLICT (user_id, item_id) DO UPDATE SET
    media_type = coalesce(excluded.media_type, user_history.media_type),
    position = excluded.position,
    duration = excluded.duration,
    completed = (user_history.completed OR excluded.completed),
    last_activity = now(),
    client_timestamp = excluded.client_timestamp
  WHERE excluded.client_timestamp >= user_history.client_timestamp
  RETURNING * INTO v_res;

  -- Si el dato entrante era más antiguo, la cláusula WHERE descartó el UPDATE.
  -- En ese caso devolvemos la fila existente para que el cliente sincronice el estado más reciente.
  IF v_res IS NULL THEN
    SELECT * INTO v_res FROM public.user_history WHERE user_id = v_uid AND item_id = p_item_id;
  END IF;

  RETURN v_res;
END;
$$;

-- 5. FUNCIÓN DE PODA: prune_user_history (Mantenimiento Opcional de Historial)
-- ------------------------------------------------------------------------------
-- Conserva únicamente los N registros más recientes por usuario (por defecto 2000).
CREATE OR REPLACE FUNCTION public.prune_user_history(
  p_keep_limit integer default 2000
)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_deleted integer := 0;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No autenticado: auth.uid() es nulo' USING ERRCODE = '42501';
  END IF;

  DELETE FROM public.user_history
  WHERE id IN (
    SELECT id
    FROM public.user_history
    WHERE user_id = v_uid
    ORDER BY last_activity DESC, id DESC
    OFFSET greatest(100, p_keep_limit)
  );

  GET DIAGNOSTICS v_deleted = row_count;
  RETURN v_deleted;
END;
$$;

-- 6. POLÍTICAS ROW LEVEL SECURITY (RLS)
-- ------------------------------------------------------------------------------

-- RLS en user_history
ALTER TABLE public.user_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_history_select_own" ON public.user_history;
CREATE POLICY "user_history_select_own" ON public.user_history
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "user_history_insert_own" ON public.user_history;
CREATE POLICY "user_history_insert_own" ON public.user_history
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "user_history_update_own" ON public.user_history;
CREATE POLICY "user_history_update_own" ON public.user_history
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "user_history_delete_own" ON public.user_history;
CREATE POLICY "user_history_delete_own" ON public.user_history
  FOR DELETE TO authenticated
  USING (user_id = auth.uid());

-- RLS en user_preferences
ALTER TABLE public.user_preferences ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_preferences_select_own" ON public.user_preferences;
CREATE POLICY "user_preferences_select_own" ON public.user_preferences
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "user_preferences_insert_own" ON public.user_preferences;
CREATE POLICY "user_preferences_insert_own" ON public.user_preferences
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "user_preferences_update_own" ON public.user_preferences;
CREATE POLICY "user_preferences_update_own" ON public.user_preferences
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "user_preferences_delete_own" ON public.user_preferences;
CREATE POLICY "user_preferences_delete_own" ON public.user_preferences
  FOR DELETE TO authenticated
  USING (user_id = auth.uid());

-- 7. CONCESIÓN SEGURA DE PERMISOS (GRANTS)
-- ------------------------------------------------------------------------------
-- Conceder al rol authenticated acceso exclusivo a sus tablas personales
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_history TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_preferences TO authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_history(bigint, text, integer, integer, boolean, bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prune_user_history(integer) TO authenticated;

-- Service role mantiene control administrativo
GRANT ALL ON public.user_history TO service_role;
GRANT ALL ON public.user_preferences TO service_role;

-- Revocación total para usuarios anónimos (anon no ve ni escribe nada)
REVOKE ALL ON public.user_history FROM anon;
REVOKE ALL ON public.user_preferences FROM anon;
REVOKE EXECUTE ON FUNCTION public.upsert_history(bigint, text, integer, integer, boolean, bigint) FROM anon;
REVOKE EXECUTE ON FUNCTION public.prune_user_history(integer) FROM anon;

-- Blindaje de public.profiles: prohibir actualización de is_admin
REVOKE UPDATE (is_admin) ON public.profiles FROM authenticated;

-- ==============================================================================
-- 8. COMPATIBILIDAD CON CONTENIDO EXTERNO / JUEGOS / PMV (ARQUITECTURA HÍBRIDA)
-- ==============================================================================
-- Los ítems nativos alojados en PostgreSQL se relacionan vía clave foránea
-- a public.items(id).
-- Para ítems externos (juegos WebGL, PMVs embebidos o contenidos sin ID en items),
-- la API Worker de Cloudflare utiliza automáticamente el almacenamiento seguro
-- en auth.users(raw_user_meta_data -> 'custom_favorites' y 'history'), evitando
-- fallos por Foreign Key Violation (409/400) y garantizando persistencia
-- 100% agnóstica entre dispositivos y sesiones.
-- ==============================================================================

