-- ==============================================================================
-- 02_MINOR_PROTECTION_TRIGGER.SQL
-- INSTALACIÓN DEL TRIGGER DE PROTECCIÓN A MENORES (ZERO-TOLERANCE EN ESCRITURA)
-- Proyecto: Velvet Hub / Morbohub
-- Estado: Ejecutar ÚNICAMENTE tras revisar los resultados de 02_minor_protection_audit.sql.
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. FUNCIÓN DE NORMALIZACIÓN LEETSPEAK Y DEPURACIÓN DE CARACTERES
-- Convierte sustituciones numéricas y símbolos en letras normales antes del chequeo.
-- Mapeo estricto: '013457@$!' -> 'oieastasi'
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
-- 3. TRIGGER INFALIBLE EN ESCRITURA (INSERT / UPDATE)
-- Asegura que search_text esté poblado y bloquea permanentemente cualquier
-- coincidencia con los términos prohibidos.
-- ------------------------------------------------------------------------------
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

  -- Si coincide con cualquier término prohibido, se fuerza status = 'blocked'
  if public.minor_content_match(new.search_text) or public.minor_content_match(new.title) then
    new.status := 'blocked';
  end if;

  -- REGLA DE SEGURIDAD ESTRICTA: Un elemento bloqueado NUNCA puede ser desbloqueado por update
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

-- ------------------------------------------------------------------------------
-- 4. BLOQUEO PREVENTIVO INMEDIATO DE ELEMENTOS HISTÓRICOS IDENTIFICADOS
-- Actualiza los elementos existentes que hayan coincidido en la auditoría.
-- ------------------------------------------------------------------------------
update public.items
set status = 'blocked'
where status <> 'blocked'
  and (
    public.minor_content_match(coalesce(search_text, ''))
    or public.minor_content_match(coalesce(title, ''))
  );
