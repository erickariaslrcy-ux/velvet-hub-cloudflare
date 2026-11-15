-- ==============================================================================
-- 05_THUMBNAILS_LQIP.SQL
-- MIGRACIÓN DE MINIATURAS LQIP (LOW QUALITY IMAGE PLACEHOLDER) Y COLOR DOMINANTE
-- Proyecto: Velvet Hub / Morbohub
-- Estado: Listo para aplicar de forma segura en producción.
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- INSTRUCCIONES DE SEGURIDAD Y CERO CAÍDAS (ZERO-DOWNTIME):
-- 1. Se añade con valor por defecto NULL. En PostgreSQL >= 11, añadir una columna
--    con default NULL es una operación instantánea O(1) de solo metadatos,
--    lo que significa que NO bloquea lecturas ni escrituras en la tabla items.
-- 2. El relleno de datos (backfill) se debe ejecutar progresivamente en segundo plano
--    mediante lotes pequeños (chunks de 100 elementos) para evitar picos de CPU en la BD.
-- ------------------------------------------------------------------------------

-- 1. Añadir columna para código Hexadecimal de color dominante (#RRGGBB)
ALTER TABLE public.items 
  ADD COLUMN IF NOT EXISTS thumb_color varchar(7) DEFAULT NULL;

-- 2. Añadir columna para LQIP (Low Quality Image Placeholder):
--    Cadena data:image/webp;base64,... de 16x16 px (< 200 bytes) o Blurhash compacto
ALTER TABLE public.items 
  ADD COLUMN IF NOT EXISTS thumb_lqip text DEFAULT NULL;

-- 3. Comentarios explicativos en el catálogo de PostgreSQL
COMMENT ON COLUMN public.items.thumb_color IS 'Color dominante en formato hex (#RRGGBB) para evitar fondo negro mientras carga la portada';
COMMENT ON COLUMN public.items.thumb_lqip IS 'Miniatura ultraligera LQIP codificada en base64 (16x16 px) para renderizado instantáneo';

-- 4. Verificación de creación de columnas
SELECT column_name, data_type, is_nullable, column_default 
FROM information_schema.columns 
WHERE table_name = 'items' AND column_name IN ('thumb_color', 'thumb_lqip');

-- ------------------------------------------------------------------------------
-- GUÍA DE BACKFILL (POBLACIÓN DE DATOS EN SEGUNDO PLANO):
-- Un script Python o worker puede procesar los registros pendientes con:
-- 
-- SELECT id, cover_url FROM public.items 
-- WHERE thumb_color IS NULL AND cover_url <> '' 
-- ORDER BY id DESC 
-- LIMIT 100;
--
-- Y actualizar cada registro con:
-- UPDATE public.items 
-- SET thumb_color = '#1f0d2c', thumb_lqip = 'data:image/webp;base64,...' 
-- WHERE id = $id;
-- ------------------------------------------------------------------------------
