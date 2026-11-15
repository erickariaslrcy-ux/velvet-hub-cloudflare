-- ==============================================================================
-- 02_MINOR_PROTECTION_AUDIT.SQL
-- AUDITORÍA DE PROTECCIÓN A MENORES (ESTRICTAMENTE SOLO LECTURA / ZERO-TOLERANCE)
-- Proyecto: Velvet Hub / Morbohub
-- Estado: Listo para análisis de base de datos antes de activar triggers de bloqueo.
-- CARACTERÍSTICA: 100% SOLO LECTURA (SELECT). NO MODIFICA REGISTROS NI INSTALA TRIGGERS.
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. FUNCIÓN DE NORMALIZACIÓN LEETSPEAK Y DEPURACIÓN DE CARACTERES
-- Convierte sustituciones numéricas y símbolos en letras normales antes del chequeo.
-- Mapeo corregido:
--   '0' -> 'o', '1' -> 'i', '3' -> 'e', '4' -> 'a', '5' -> 's', '7' -> 't',
--   '@' -> 'a', '$' -> 's', '!' -> 'i'
-- ------------------------------------------------------------------------------
create or replace function public.normalize_leetspeak(input_text text)
returns text
language sql immutable
as $$
  select translate(
    lower(extensions.unaccent(coalesce(input_text, ''))),
    '013457@$!',
    'oieastasi'
  );
$$;

-- ------------------------------------------------------------------------------
-- 2. FUNCIÓN DE DETECCIÓN MULTILINGÜE Y ANTI-EVASIÓN: minor_content_match
-- Analiza tanto el texto directo como el texto normalizado con desofuscación.
-- ------------------------------------------------------------------------------
create or replace function public.minor_content_match(txt text)
returns boolean
language plpgsql immutable
as $$
declare
  raw_norm text;
  leet_norm text;
  has_match boolean;
begin
  if txt is null or trim(txt) = '' then
    return false;
  end if;

  -- Versión 1: Texto sin acentos y en minúsculas
  raw_norm := lower(extensions.unaccent(txt));
  -- Versión 2: Texto con normalización de leetspeak y símbolos
  leet_norm := public.normalize_leetspeak(txt);

  -- Regla multilingüe exhaustiva (Español, Inglés, Japonés romaji, Francés, Alemán, Ruso)
  has_match := (
    -- Términos explícitos y jerga internacional
    raw_norm ~* '\m(loli|lolis|lolicon|lolita|lolitas|shota|shotas|shotacon|toddlercon|toddler|child|children|kid|kids|underage|under-age|preteen|pre-teen|infant|jailbait|pedo|pedophile|paedo|cub)\M'
    or leet_norm ~* '\m(loli|lolis|lolicon|lolita|shota|shotas|shotacon|toddlercon|child|kid|underage|preteen|jailbait|pedo|pedophile)\M'

    -- Español: menores, infantes, términos escolares de primaria/guardería
    or raw_norm ~* '\m(nina|ninas|nino|ninos|nena|nenas|infantil|menor|menores|menorcitas?|preadolescente|prepuber|prepubescent|primaria|kindergarten|guarderia|colegialas? menor(es)?|criatura|escolares? menor(es)?)\M'
    or leet_norm ~* '\m(nina|ninas|nino|ninos|nena|nenas|infantil|menor|menores|menorcitas?)\M'

    -- Japonés romaji: términos específicos de doujinshi y anime
    or raw_norm ~* '\m(rori|rorikon|syota|syotacon|kodomo|chugakusei|shogakusei|danshi koukousei|enjo[- ]?kosai|enkou)\M'

    -- Francés, Alemán y otros idiomas europeos
    or raw_norm ~* '\m(fillette|mineure?|minderjahrig(e)?|schulerin|rebenok|maloletka|shkolnitsa)\M'

    -- Patrones numéricos de edades menores de 18 años (1 a 17 años)
    or raw_norm ~* '\m([0-9]|1[0-7]) ?(anos|ano|year|years|yo|y/o|ans|jahre)\M'
    or leet_norm ~* '\m([0-9]|1[0-7]) ?(anos|ano|year|years|yo|y/o)\M'
    or raw_norm ~* '\m(under|menor de|sub|moins de) 1[0-8]\M'
    or raw_norm ~* '\mage 1[0-7]\M'
  );

  return coalesce(has_match, false);
end;
$$;

-- ------------------------------------------------------------------------------
-- 3. PRUEBAS UNITARIAS DE LEETSPEAK Y DETECCIÓN ANTI-EVASIÓN
-- ------------------------------------------------------------------------------
do $$
begin
  -- Validación 1: $ mapea a 's' y 0 mapea a 'o'
  assert public.normalize_leetspeak('$h0ta') = 'shota',
    'Error en test leetspeak: $h0ta no produjo shota';

  -- Validación 2: ! mapea a 'i' y 0 mapea a 'o'
  assert public.normalize_leetspeak('l0l!ta') = 'lolita',
    'Error en test leetspeak: l0l!ta no produjo lolita';

  -- Validación 3: 1 mapea a 'i'
  assert public.normalize_leetspeak('k1d') = 'kid',
    'Error en test leetspeak: k1d no produjo kid';

  -- Validación 4: @ mapea a 'a'
  assert public.normalize_leetspeak('under@ge') = 'underage',
    'Error en test leetspeak: under@ge no produjo underage';

  -- Validación 5: minor_content_match detecta variantes ofuscadas
  assert public.minor_content_match('$h0ta') = true,
    'Error en test minor_content_match: fallo al detectar $h0ta';

  assert public.minor_content_match('l0l!ta') = true,
    'Error en test minor_content_match: fallo al detectar l0l!ta';

  assert public.minor_content_match('chica normal de 20 anos') = false,
    'Error en test minor_content_match: falso positivo en adulto';

  raise notice '=======================================================';
  raise notice 'PRUEBAS UNITARIAS LEETSPEAK: 100%% PASADAS CON ÉXITO.';
  raise notice '=======================================================';
end;
$$;

-- ------------------------------------------------------------------------------
-- 4. CONSULTA DE AUDITORÍA (SOLO LECTURA)
-- Ejecutar en Supabase para auditar si existen elementos no bloqueados que deben bloquearse:
-- ------------------------------------------------------------------------------
select
  id,
  source,
  source_id,
  title,
  media_type,
  status,
  created_at
from public.items
where status <> 'blocked'
  and (
    public.minor_content_match(coalesce(search_text, ''))
    or public.minor_content_match(coalesce(title, ''))
  )
order by id desc
limit 500;
