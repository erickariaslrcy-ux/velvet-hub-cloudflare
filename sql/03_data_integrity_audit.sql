-- ==============================================================================
-- 03_DATA_INTEGRITY_AUDIT.SQL
-- AUDITORÍA DE INTEGRIDAD DE DATOS (CONSULTAS SELECT DE SOLO LECTURA)
-- Proyecto: Velvet Hub / Morbohub
-- Estado: Listo para ejecución en el SQL Editor de Supabase.
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. CÓMICS Y GALERÍAS CON CERO PÁGINAS O ARRAY "PAGES" VACÍO
-- Identifica publicaciones incompletas o corruptas que rompen el visor en frontend.
-- ------------------------------------------------------------------------------
SELECT 
  id,
  source,
  source_id,
  media_type,
  title,
  page_count,
  jsonb_array_length(pages) as real_pages_count,
  status
FROM public.items
WHERE media_type IN ('comic', 'gallery')
  AND (
    page_count = 0 
    OR pages IS NULL 
    OR pages = '[]'::jsonb 
    OR jsonb_array_length(pages) = 0
  )
ORDER BY id DESC
LIMIT 100;

-- ------------------------------------------------------------------------------
-- 2. ÍTEMS CON PORTADA FALTANTE, NULA O CADENA VACÍA
-- Estos ítems provocan tarjetas vacías o cuadros negros si no hay fallback visual.
-- ------------------------------------------------------------------------------
SELECT 
  id,
  source,
  source_id,
  media_type,
  title,
  cover_url,
  status
FROM public.items
WHERE cover_url IS NULL 
   OR trim(cover_url) = '' 
   OR cover_url = 'null'
ORDER BY id DESC
LIMIT 100;

-- ------------------------------------------------------------------------------
-- 3. INCONSISTENCIA EN CONTEO DE PÁGINAS (page_count vs jsonb_array_length(pages))
-- Ocurre cuando el scraper registra un número reportado distinto a las páginas reales bajadas.
-- ------------------------------------------------------------------------------
SELECT 
  id,
  source,
  source_id,
  media_type,
  title,
  page_count as reported_page_count,
  jsonb_array_length(pages) as actual_pages_in_json,
  abs(page_count - jsonb_array_length(pages)) as discrepancy
FROM public.items
WHERE media_type IN ('comic', 'gallery')
  AND pages IS NOT NULL 
  AND jsonb_typeof(pages) = 'array'
  AND jsonb_array_length(pages) > 0
  AND page_count <> jsonb_array_length(pages)
ORDER BY discrepancy DESC
LIMIT 100;

-- ------------------------------------------------------------------------------
-- 4. DUPLICADOS EXACTOS POR (source, source_id)
-- Verifica si la restricción UNIQUE está fallando o existen registros huérfanos.
-- ------------------------------------------------------------------------------
SELECT 
  source,
  source_id,
  count(*) as duplicate_count,
  array_agg(id) as item_ids,
  array_agg(status) as statuses
FROM public.items
GROUP BY source, source_id
HAVING count(*) > 1;

-- ------------------------------------------------------------------------------
-- 5. DUPLICADOS POTENCIALES POR TÍTULO NORMALIZADO
-- Identifica obras subidas desde múltiples fuentes con títulos casi idénticos.
-- ------------------------------------------------------------------------------
SELECT 
  lower(trim(extensions.unaccent(title))) as normalized_title,
  media_type,
  count(*) as copies_count,
  array_agg(source) as sources,
  array_agg(id) as ids
FROM public.items
WHERE media_type = 'comic' 
  AND length(title) > 5
GROUP BY lower(trim(extensions.unaccent(title))), media_type
HAVING count(*) > 1
ORDER BY copies_count DESC
LIMIT 50;

-- ------------------------------------------------------------------------------
-- 6. ÍTEMS BLOQUEADOS O CON PERSONAS REALES QUE PODRÍAN ESTAR EXPUESTOS
-- Comprueba que las restricciones de status y real_people se cumplan estrictamente.
-- ------------------------------------------------------------------------------
SELECT 
  id,
  source,
  source_id,
  media_type,
  title,
  real_people,
  status,
  scraped_at
FROM public.items
WHERE status = 'blocked' 
   OR real_people = true
ORDER BY scraped_at DESC
LIMIT 50;

-- ------------------------------------------------------------------------------
-- 7. VIDEOS SIN FUENTES DE REPRODUCCIÓN (video_sources VACÍO)
-- Videos que no se pueden reproducir en el reproductor HLS/MP4.
-- ------------------------------------------------------------------------------
SELECT 
  id,
  source,
  source_id,
  title,
  video_sources,
  status
FROM public.items
WHERE media_type = 'video'
  AND (
    video_sources IS NULL 
    OR video_sources = '[]'::jsonb 
    OR jsonb_array_length(video_sources) = 0
  )
ORDER BY id DESC
LIMIT 50;
