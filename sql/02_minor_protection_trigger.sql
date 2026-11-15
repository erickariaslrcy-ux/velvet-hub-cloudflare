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
  raw_text text;
  raw_norm text;
  leet_norm text;
  has_match boolean;
begin
  if txt is null or trim(txt) = '' then
    return false;
  end if;

  raw_text := lower(txt);
  raw_norm := lower(extensions.unaccent(txt));
  leet_norm := public.normalize_leetspeak(txt);

  -- Regla multilingüe exhaustiva con delimitadores estrictos de palabra (\m...\M)
  -- para evitar falsos positivos en palabras compuestas y nombres propios legítimos.
  has_match := (
    -- 1. Jerga explícita internacional y términos universales de protección infantil
    raw_norm ~* '\m(loli|lolis|lolicon|lolita|lolitas|shota|shotas|shotacon|toddlercon|toddler|toddlers|child|children|underage|under-age|preteen|pre-teen|infant|infants|jailbait|pedo|pedophile|pedophiles|pedophilia|paedo|paedophile|cub)\M'
    or leet_norm ~* '\m(loli|lolis|lolicon|lolita|shota|shotas|shotacon|toddlercon|child|children|underage|preteen|jailbait|pedo|pedophile)\M'

    -- 2. "kid" y "kids" con límites estrictos de palabra completa (no coincide con kidnap, skid, orchid, etc.)
    or raw_norm ~* '\m(kid|kids)\M'
    or leet_norm ~* '\m(kid|kids)\M'

    -- 3. Español: Términos con 'ñ' evaluados sobre el texto crudo para NO bloquear nombres propios sin ñ (ej. Nina, Nino)
    or raw_text ~* '\m(niñ[ao]s?|niñit[ao]s?|nenit[ao]s?)\M'

    -- 4. Español: términos descriptivos de minoría de edad y contexto escolar infantil
    or raw_norm ~* '\m(infantil|infantiles|menor|menores|menorcitas?|menorcitos?|preadolescente|preadolescentes|prepuber|prepuberes|prepubescent|primaria|kindergarten|guarderia|colegialas? menor(es)?|criatura|criaturas|escolares? menor(es)?)\M'
    or leet_norm ~* '\m(infantil|menor|menores|menorcitas?|preadolescente|prepuber|primaria|kindergarten|guarderia)\M'

    -- 5. Japonés romaji: términos específicos de doujinshi y anime
    or raw_norm ~* '\m(rori|rorikon|syota|syotacon|kodomo|chugakusei|shogakusei|danshi koukousei|enjo[- ]?kosai|enkou)\M'

    -- 6. Francés, Alemán y Ruso
    or raw_norm ~* '\m(fillette|fillettes|mineure?s?|minderjahrig(e)?|schulerin|rebenok|maloletka|shkolnitsa)\M'

    -- 7. Patrones numéricos de edades menores de 18 años (1 a 17 años)
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

-- NOTA: Este script ÚNICAMENTE instala el trigger defensivo para operaciones futuras (INSERT / UPDATE).
-- NO modifica registros históricos existentes. Para auditar y aplicar el saneamiento histórico con respaldo,
-- ejecute posteriormente el script 02b_minor_protection_backfill.sql.
