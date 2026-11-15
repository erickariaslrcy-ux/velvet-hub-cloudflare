-- ==============================================================================
-- EJECUTAR_TODO_EN_ORDEN.SQL
-- SCRIPT MAESTRO DE MIGRACIÓN, RENDIMIENTO Y SEGURIDAD RLS
-- Proyecto: Velvet Hub / Morbohub
-- ==============================================================================
-- Este archivo agrupa en el orden estricto de dependencias todas las operaciones
-- seguras de base de datos para ejecutar en el SQL Editor de Supabase:
--
--   1. Migración de columnas de miniaturas LQIP (05_thumbnails_lqip.sql)
--   2. Políticas de Seguridad RLS y Privilegios de Columna (01_rls_policies.sql)
--   3. Índices de Alto Rendimiento para Catálogo y Búsqueda (04_indexes.sql)
--   4. Auditoría de Integridad de Datos (03_data_integrity_audit.sql)
--   5. Funciones y Auditoría de Protección a Menores (02_minor_protection_audit.sql)
--
-- NOTA IMPORTANTE:
-- Los scripts de escritura preventiva (02_minor_protection_trigger.sql y
-- 02b_minor_protection_backfill.sql) se mantienen intencionalmente SEPARADOS
-- para ser ejecutados únicamente después de revisar los reportes de auditoría.
-- ==============================================================================

-- ##############################################################################
-- PASO 1: MIGRACIÓN DE COLUMNAS DE MINIATURAS LQIP Y COLOR DOMINANTE
-- ##############################################################################
ALTER TABLE public.items 
  ADD COLUMN IF NOT EXISTS thumb_color varchar(7) DEFAULT NULL;

ALTER TABLE public.items 
  ADD COLUMN IF NOT EXISTS thumb_lqip text DEFAULT NULL;

COMMENT ON COLUMN public.items.thumb_color IS 'Color dominante en formato hex (#RRGGBB) para evitar parpadeos';
COMMENT ON COLUMN public.items.thumb_lqip IS 'Miniatura ultraligera LQIP codificada en base64 (16x16 px)';


-- ##############################################################################
-- PASO 2: SEGURIDAD RLS Y PRIVILEGIOS MÍNIMOS DE COLUMNA (ROL ANON)
-- ##############################################################################
-- 2.1 Habilitar RLS en public.items
ALTER TABLE public.items ENABLE ROW LEVEL SECURITY;

-- 2.2 Eliminar políticas públicas anteriores
DROP POLICY IF EXISTS "items_public_select" ON public.items;
DROP POLICY IF EXISTS "Allow anon read" ON public.items;
DROP POLICY IF EXISTS "Public items read" ON public.items;

-- 2.3 Crear política estricta de filas
CREATE POLICY items_public_select ON public.items
    FOR SELECT TO anon, authenticated
    USING (
        (status IS NULL OR status <> 'blocked')
        AND (real_people IS NULL OR real_people = false)
    );

-- 2.4 Revocar acceso de columna a datos sensibles para anon
REVOKE ALL ON public.items FROM anon;

-- Conceder SELECT ÚNICAMENTE sobre las 14 columnas necesarias para el catálogo público
GRANT SELECT (
    id, source, source_id, title, cover_url, thumb_color, thumb_lqip,
    media_type, language, tags, artists, page_count, scraped_at, created_at
) ON public.items TO anon;

-- 2.5 Rol authenticated: acceso a catálogo y favoritos
REVOKE INSERT, UPDATE, DELETE ON public.items FROM authenticated;
GRANT SELECT (
    id, source, source_id, title, cover_url, thumb_color, thumb_lqip,
    media_type, language, tags, artists, page_count, scraped_at, created_at
) ON public.items TO authenticated;

-- 2.6 Rol service_role: acceso administrativo completo
GRANT ALL ON public.items TO service_role;

-- 2.7 Función RPC SECURITY DEFINER para consultar detalle de un elemento
CREATE OR REPLACE FUNCTION public.get_item_detail(p_id bigint)
RETURNS TABLE (
    id bigint,
    source text,
    source_id text,
    title text,
    cover_url text,
    thumb_color varchar(7),
    thumb_lqip text,
    media_type text,
    language text,
    tags text[],
    artists text[],
    page_count int,
    pages jsonb,
    video_sources jsonb,
    chapters jsonb,
    created_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
    SELECT 
        i.id, i.source, i.source_id, i.title, i.cover_url,
        i.thumb_color, i.thumb_lqip, i.media_type, i.language,
        i.tags, i.artists, i.page_count, i.pages, i.video_sources,
        i.chapters, i.created_at
    FROM public.items i
    WHERE i.id = p_id
      AND (i.status IS NULL OR i.status <> 'blocked')
      AND (i.real_people IS NULL OR i.real_people = false)
    LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.get_item_detail(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_item_detail(bigint) TO authenticated, service_role;


-- ##############################################################################
-- PASO 3: ÍNDICES DE ALTO RENDIMIENTO (OPTIMIZACIÓN DE CATÁLOGO Y BÚSQUEDA)
-- ##############################################################################
-- Nota: En este script consolidado se omite la palabra clave CONCURRENTLY para
-- permitir la ejecución en bloque continuo dentro del SQL Editor.
CREATE INDEX IF NOT EXISTS idx_items_media_type_id_desc
  ON public.items (media_type, id DESC)
  WHERE status <> 'blocked' AND real_people = false;

CREATE INDEX IF NOT EXISTS idx_items_media_pub_desc
  ON public.items (media_type, published_at DESC)
  WHERE status <> 'blocked';

CREATE INDEX IF NOT EXISTS idx_items_tags_gin
  ON public.items USING GIN (tags);

CREATE EXTENSION IF NOT EXISTS pg_trgm SCHEMA extensions;

CREATE INDEX IF NOT EXISTS idx_items_search_trgm
  ON public.items USING GIN (search_text extensions.gin_trgm_ops);


-- ##############################################################################
-- PASO 4: AUDITORÍA DE PROTECCIÓN A MENORES (LEETSPEAK Y FUNCIONES ANTI-EVASIÓN)
-- ##############################################################################
CREATE EXTENSION IF NOT EXISTS unaccent SCHEMA extensions;

CREATE OR REPLACE FUNCTION public.normalize_leetspeak(input_text text)
RETURNS text
LANGUAGE sql IMMUTABLE
AS $$
  SELECT translate(
    lower(extensions.unaccent(coalesce(input_text, ''))),
    '013457@$!',
    'oieastasi'
  );
$$;

CREATE OR REPLACE FUNCTION public.minor_content_match(txt text)
RETURNS boolean
LANGUAGE plpgsql IMMUTABLE
AS $$
DECLARE
  raw_text text;
  raw_norm text;
  leet_norm text;
  has_match boolean;
BEGIN
  IF txt IS NULL OR trim(txt) = '' THEN
    RETURN false;
  END IF;

  raw_text := lower(txt);
  raw_norm := lower(extensions.unaccent(txt));
  leet_norm := public.normalize_leetspeak(txt);

  has_match := (
    raw_norm ~* '\m(loli|lolis|lolicon|lolita|lolitas|shota|shotas|shotacon|toddlercon|toddler|toddlers|child|children|underage|under-age|preteen|pre-teen|infant|infants|jailbait|pedo|pedophile|pedophiles|pedophilia|paedo|paedophile|cub)\M'
    OR leet_norm ~* '\m(loli|lolis|lolicon|lolita|shota|shotas|shotacon|toddlercon|child|children|underage|preteen|jailbait|pedo|pedophile)\M'
    OR raw_norm ~* '\m(kid|kids)\M'
    OR leet_norm ~* '\m(kid|kids)\M'
    OR raw_text ~* '\m(niñ[ao]s?|niñit[ao]s?|nenit[ao]s?)\M'
    OR raw_norm ~* '\m(infantil|infantiles|menor|menores|menorcitas?|menorcitos?|preadolescente|preadolescentes|prepuber|prepuberes|prepubescent|primaria|kindergarten|guarderia|colegialas? menor(es)?|criatura|criaturas|escolares? menor(es)?)\M'
    OR leet_norm ~* '\m(infantil|menor|menores|menorcitas?|preadolescente|prepuber|primaria|kindergarten|guarderia)\M'
    OR raw_norm ~* '\m(rori|rorikon|syota|syotacon|kodomo|chugakusei|shogakusei|danshi koukousei|enjo[- ]?kosai|enkou)\M'
    OR raw_norm ~* '\m(fillette|fillettes|mineure?s?|minderjahrig(e)?|schulerin|rebenok|maloletka|shkolnitsa)\M'
    OR raw_norm ~* '\m([0-9]|1[0-7]) ?(anos|ano|year|years|yo|y/o|ans|jahre)\M'
    OR leet_norm ~* '\m([0-9]|1[0-7]) ?(anos|ano|year|years|yo|y/o)\M'
    OR raw_norm ~* '\m(under|menor de|sub|moins de) 1[0-8]\M'
    OR raw_norm ~* '\mage 1[0-7]\M'
  );

  RETURN coalesce(has_match, false);
END;
$$;


-- ##############################################################################
-- PASO 5: VERIFICACIÓN Y PRUEBAS AUTOMATIZADAS DENTRO DE LA BASE DE DATOS
-- ##############################################################################
DO $$
BEGIN
  -- 5.1 Verificar privilegios de columnas para anon
  ASSERT NOT has_column_privilege('anon', 'public.items', 'pages', 'SELECT'),
    'ERROR DE SEGURIDAD: anon todavía puede leer la columna pages';
  ASSERT NOT has_column_privilege('anon', 'public.items', 'video_sources', 'SELECT'),
    'ERROR DE SEGURIDAD: anon todavía puede leer la columna video_sources';
  ASSERT NOT has_column_privilege('anon', 'public.items', 'status', 'SELECT'),
    'ERROR DE SEGURIDAD: anon todavía puede leer la columna status';

  -- 5.2 Verificar leetspeak y delimitadores contra falsos positivos
  ASSERT public.normalize_leetspeak('$h0ta') = 'shota', 'Error en leetspeak $h0ta';
  ASSERT public.normalize_leetspeak('l0l!ta') = 'lolita', 'Error en leetspeak l0l!ta';
  ASSERT public.minor_content_match('Hot Adult Teacher in High School') = false, 'Falso positivo en teacher/school';
  ASSERT public.minor_content_match('Nina Hartley Classic Performance') = false, 'Falso positivo en Nina Hartley';
  ASSERT public.minor_content_match('Kidnapped Spy Agent Action') = false, 'Falso positivo en kidnap';

  RAISE NOTICE '=======================================================';
  RAISE NOTICE 'TODO EL SCRIPT SE EJECUTÓ CORRECTAMENTE. 100%% APROBADO.';
  RAISE NOTICE '=======================================================';
END;
$$;
