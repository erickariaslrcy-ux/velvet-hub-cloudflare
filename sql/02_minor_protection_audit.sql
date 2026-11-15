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

    -- 3. Español: Términos con 'ñ' evaluados sobre el texto crudo para bloqueo incondicional
    or raw_text ~* '\m(niñ[ao]s?|niñit[ao]s?|nenit[ao]s?)\M'

    -- 4. REGLA CONTEXTUAL FINA: Variantes sin tilde (nina, nino, ninas, ninos).
    -- JUSTIFICACIÓN: "Nina" y "Nino" son nombres propios muy comunes en actrices adultas
    -- (Nina Hartley, Nina Elle, etc.) o personajes (Nino Nakano). No deben bloquearse de
    -- forma aislada. Se bloquean SÓLO si coexisten con términos de riesgo escolar o minoría:
    or (
      raw_norm ~* '\m(nina|ninas|nino|ninos)\M'
      and (
        raw_norm ~* '\m(colegiala|colegialas|escolar|escolares|estudiante|estudiantes|escuela|escuelas|primaria|pequena|pequeno|pequenas|pequenos|uniforme|uniformes|underage|menor|menores|young|teen|little|child|virgen|primeriza)\M'
        or leet_norm ~* '\m(colegiala|escolar|estudiante|primaria|pequena|pequeno|uniforme|menor)\M'
      )
    )

    -- 5. Español: términos descriptivos de minoría de edad y contexto escolar infantil
    or raw_norm ~* '\m(infantil|infantiles|menor|menores|menorcitas?|menorcitos?|preadolescente|preadolescentes|prepuber|prepuberes|prepubescent|primaria|kindergarten|guarderia|colegialas? menor(es)?|criatura|criaturas|escolares? menor(es)?)\M'
    or leet_norm ~* '\m(infantil|menor|menores|menorcitas?|preadolescente|prepuber|primaria|kindergarten|guarderia)\M'

    -- 6. Japonés romaji: términos específicos de doujinshi y anime
    or raw_norm ~* '\m(rori|rorikon|syota|syotacon|kodomo|chugakusei|shogakusei|danshi koukousei|enjo[- ]?kosai|enkou)\M'

    -- 7. Francés, Alemán y Ruso
    or raw_norm ~* '\m(fillette|fillettes|mineure?s?|minderjahrig(e)?|schulerin|rebenok|maloletka|shkolnitsa)\M'

    -- 8. Patrones numéricos de edades menores de 18 años (1 a 17 años)
    or raw_norm ~* '\m([0-9]|1[0-7]) ?(anos|ano|year|years|yo|y/o|ans|jahre)\M'
    or leet_norm ~* '\m([0-9]|1[0-7]) ?(anos|ano|year|years|yo|y/o)\M'
    or raw_norm ~* '\m(under|menor de|sub|moins de) 1[0-8]\M'
    or raw_norm ~* '\mage 1[0-7]\M'
  );

  return coalesce(has_match, false);
end;
$$;

-- ------------------------------------------------------------------------------
-- 3. PRUEBAS UNITARIAS DE LEETSPEAK, LÍMITES Y DETECCIÓN ANTI-EVASIÓN
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

  -- Validación 5: minor_content_match detecta variantes ofuscadas y términos reales
  assert public.minor_content_match('$h0ta') = true,
    'Error en test minor_content_match: fallo al detectar $h0ta';

  assert public.minor_content_match('l0l!ta') = true,
    'Error en test minor_content_match: fallo al detectar l0l!ta';

  assert public.minor_content_match('niña bonita') = true,
    'Error en test minor_content_match: fallo al detectar niña con tilde incondicional';

  assert public.minor_content_match('niño travieso') = true,
    'Error en test minor_content_match: fallo al detectar niño con tilde incondicional';

  assert public.minor_content_match('underage student') = true,
    'Error en test minor_content_match: fallo al detectar underage';

  assert public.minor_content_match('chica menor de 15 anos') = true,
    'Error en test minor_content_match: fallo al detectar edad menor de 18';

  -- Validación 6: REGLA FINA: Nombres propios sin términos de riesgo NO se bloquean
  assert public.minor_content_match('Nina Hartley Classic Performance') = false,
    'Error: Falso positivo en nombre propio Nina Hartley';

  assert public.minor_content_match('Nino Nakano Cosplay Manga') = false,
    'Error: Falso positivo en nombre de personaje Nino Nakano';

  assert public.minor_content_match('Nina Kayy Solo Scene') = false,
    'Error: Falso positivo en Nina Kayy';

  -- Validación 7: REGLA FINA: Variantes sin tilde CON términos de riesgo SÍ se bloquean
  assert public.minor_content_match('nina colegiala en uniforme') = true,
    'Error: Fallo al detectar nina con contexto colegiala/uniforme';

  assert public.minor_content_match('nino escolar en primaria') = true,
    'Error: Fallo al detectar nino con contexto escolar';

  assert public.minor_content_match('nina menor de edad') = true,
    'Error: Fallo al detectar nina con contexto menor';

  -- Validación 8: Palabras compuestas y términos adultos legítimos
  assert public.minor_content_match('Hot Adult Teacher in High School') = false,
    'Error: Falso positivo en "teacher" / "school"';

  assert public.minor_content_match('College Campus Student Reunion') = false,
    'Error: Falso positivo en contexto universitario';

  assert public.minor_content_match('Kidnapped Spy Agent Action') = false,
    'Error: Falso positivo en palabra compuesta "kidnap"';

  assert public.minor_content_match('Skid Row Action Video') = false,
    'Error: Falso positivo en palabra compuesta "skid"';

  assert public.minor_content_match('Black Orchid Fantasy Comic') = false,
    'Error: Falso positivo en palabra compuesta "orchid"';

  assert public.minor_content_match('Jason Kidd Basketball Player') = false,
    'Error: Falso positivo en apellido "Kidd"';

  assert public.minor_content_match('chica normal de 20 anos') = false,
    'Error en test minor_content_match: falso positivo en adulto';

  raise notice '=======================================================';
  raise notice 'PRUEBAS UNITARIAS LEETSPEAK Y LÍMITES: 100%% APROBADAS.';
  raise notice '=======================================================';
end;
$$;

-- ------------------------------------------------------------------------------
-- 4. CONSULTA DE AUDITORÍA CON CONTEO POR TÉRMINO (SIN MOSTRAR TÍTULOS NI CONTENIDOS)
-- Proporciona un desglose cuantitativo por categoría de riesgo de forma 100% segura.
-- ------------------------------------------------------------------------------
select
  matched_category,
  count(*) as total_items_detectados
from (
  select
    id,
    case
      when lower(coalesce(search_text, '') || ' ' || coalesce(title, '')) ~* '\m(loli|lolis|lolicon|lolita|shota|shotacon|toddlercon)\M'
        then '1. Jerga internacional (loli / shota / toddlercon)'
      when lower(coalesce(search_text, '') || ' ' || coalesce(title, '')) ~* '\m(niñ[ao]s?|niñit[ao]s?|nenit[ao]s?)\M'
        then '2. Español explícito con tilde (niña / niño / nenita)'
      when lower(coalesce(search_text, '') || ' ' || coalesce(title, '')) ~* '\m(nina|nino|ninas|ninos)\M'
           and lower(coalesce(search_text, '') || ' ' || coalesce(title, '')) ~* '\m(colegiala|escolar|estudiante|pequena|pequeno|uniforme|menor)\M'
        then '3. Variante sin tilde (nina/nino) con contexto de riesgo'
      when lower(coalesce(search_text, '') || ' ' || coalesce(title, '')) ~* '\m(infantil|preadolescente|prepuber|primaria|kindergarten|guarderia)\M'
        then '4. Ámbito escolar infantil / preadolescente'
      when lower(coalesce(search_text, '') || ' ' || coalesce(title, '')) ~* '\m([0-9]|1[0-7]) ?(anos|ano|year|years|yo)\M'
        then '5. Patrón numérico de edad menor de 18'
      else '6. Otras coincidencias prohibidas'
    end as matched_category
  from public.items
  where status <> 'blocked'
    and public.minor_content_match(coalesce(search_text, '') || ' ' || coalesce(title, ''))
) categorized
group by matched_category
order by total_items_detectados desc;
