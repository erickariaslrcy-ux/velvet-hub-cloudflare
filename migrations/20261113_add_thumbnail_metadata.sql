-- =======================================================================
-- VELVET HUB — MIGRACIÓN DE METADATOS DE MINIATURAS (FASE B.2)
-- Propuesta formal de migración para Supabase / PostgreSQL.
-- NO EJECUTAR DIRECTAMENTE — Requiere revisión y aprobación previa del usuario.
-- =======================================================================

-- 1. Añadir columnas para color dominante y miniatura LQIP (base64 / BlurHash)
ALTER TABLE public.items 
ADD COLUMN IF NOT EXISTS thumb_color VARCHAR(9) DEFAULT '#120822',
ADD COLUMN IF NOT EXISTS thumb_lqip TEXT DEFAULT NULL;

COMMENT ON COLUMN public.items.thumb_color IS 'Hex color dominante (#RRGGBB) de la portada para placeholder instantáneo';
COMMENT ON COLUMN public.items.thumb_lqip IS 'Data URI base64 ultra-liviana (16x24 WebP/JPEG) o hash de desenfoque para carga progresiva sin cuadros negros';

-- 2. Índice para consultas rápidas de elementos que aún requieren cálculo de miniatura
CREATE INDEX IF NOT EXISTS idx_items_thumb_pending 
ON public.items (id) 
WHERE thumb_lqip IS NULL;

-- =======================================================================
-- SCRIPT DE INGESTA / CÁLCULO EN LOTES (Ejemplo en Python / Node)
-- =======================================================================
/*
-- Ejemplo de script de procesamiento en segundo plano (workers/batch_thumbs.py):
-- 
-- from PIL import Image
-- import io, requests, base64
-- from colorthief import ColorThief
-- 
-- def process_item_thumbnail(cover_url):
--     res = requests.get(cover_url, timeout=8)
--     img = Image.open(io.BytesIO(res.content))
--     
--     # Color dominante
--     dominant = ColorThief(io.BytesIO(res.content)).get_color(quality=1)
--     hex_color = '#{:02x}{:02x}{:02x}'.format(*dominant)
--     
--     # LQIP (16px de ancho, WebP q20, ~300 bytes)
--     aspect = img.height / img.width
--     thumb = img.resize((16, int(16 * aspect)), Image.Resampling.LANCZOS)
--     buf = io.BytesIO()
--     thumb.save(buf, format='WEBP', quality=20)
--     lqip_base64 = 'data:image/webp;base64,' + base64.b64encode(buf.getvalue()).decode('utf-8')
--     
--     return hex_color, lqip_base64
*/
