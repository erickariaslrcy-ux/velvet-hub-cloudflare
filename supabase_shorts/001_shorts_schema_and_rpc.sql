-- ==============================================================================
-- SHORTS DB (SEGUNDA BASE DE DATOS INDEPENDIENTE: laberi4n / gfzmxupwzbsdmjjiagnl)
-- Arquitectura separada de lrcy-central (cómics, videos largos, modelos, usuarios).
-- Uso actual con 95,802 clips + índices: ~77 MB / 500 MB (Plan Gratis Supabase).
-- ==============================================================================

CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;

CREATE TABLE IF NOT EXISTS public.shorts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_code text NOT NULL,
  source_id text NOT NULL,
  title text NOT NULL,
  cover_url text NOT NULL DEFAULT '',
  video_url text NOT NULL,
  referer text NOT NULL DEFAULT '',
  tags text[] NOT NULL DEFAULT '{}',
  artists text[] NOT NULL DEFAULT '{}',
  duration integer,
  likes integer NOT NULL DEFAULT 0,
  direct_play boolean NOT NULL DEFAULT true,
  is_active boolean NOT NULL DEFAULT true,
  rand_key double precision NOT NULL DEFAULT random(),
  search_text text NOT NULL DEFAULT '',
  CONSTRAINT shorts_source_unique UNIQUE (source_code, source_id)
);

ALTER TABLE public.shorts ENABLE ROW LEVEL SECURITY;

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT SELECT ON TABLE public.shorts TO anon, authenticated;
GRANT ALL ON TABLE public.shorts TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.shorts_id_seq TO service_role;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'shorts'
      AND policyname = 'shorts_public_read'
  ) THEN
    CREATE POLICY shorts_public_read ON public.shorts
      FOR SELECT
      TO anon, authenticated
      USING (true);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_shorts_tags_gin
  ON public.shorts USING GIN (tags);

CREATE INDEX IF NOT EXISTS idx_shorts_search_trgm
  ON public.shorts USING GIN (search_text extensions.gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_shorts_active_id
  ON public.shorts (id)
  WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_shorts_active_rand
  ON public.shorts (rand_key)
  WHERE is_active = true;

CREATE OR REPLACE FUNCTION public.get_random_shorts(
  p_limit integer DEFAULT 12,
  p_q text DEFAULT '',
  p_exclude bigint[] DEFAULT '{}'::bigint[]
)
RETURNS TABLE (
  id bigint,
  title text,
  cover_url text,
  video_url text,
  tags text[],
  artists text[],
  duration integer,
  likes integer,
  direct_play boolean
)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_limit integer := least(greatest(coalesce(p_limit, 12), 1), 30);
  v_q text := btrim(coalesce(p_q, ''));
  v_excl bigint[] := coalesce(p_exclude, '{}'::bigint[]);
  v_slice integer := greatest(4, ceil(v_limit / 3.0)::integer + 3);
  v_r1 double precision := random();
  v_r2 double precision := random();
  v_r3 double precision := random();
  v_r4 double precision := random();
  v_r5 double precision := random();
  v_r6 double precision := random();
BEGIN
  IF v_q = '' THEN
    RETURN QUERY
    WITH pool AS (
      (SELECT sh.id, sh.title, sh.cover_url, sh.video_url, sh.tags, sh.artists, sh.duration, sh.likes, sh.direct_play
       FROM public.shorts sh
       WHERE sh.is_active = true AND sh.rand_key >= v_r1
         AND (cardinality(v_excl) = 0 OR NOT (sh.id = ANY(v_excl)))
       ORDER BY sh.rand_key ASC
       LIMIT v_slice)
      UNION ALL
      (SELECT sh.id, sh.title, sh.cover_url, sh.video_url, sh.tags, sh.artists, sh.duration, sh.likes, sh.direct_play
       FROM public.shorts sh
       WHERE sh.is_active = true AND sh.rand_key >= v_r2
         AND (cardinality(v_excl) = 0 OR NOT (sh.id = ANY(v_excl)))
       ORDER BY sh.rand_key ASC
       LIMIT v_slice)
      UNION ALL
      (SELECT sh.id, sh.title, sh.cover_url, sh.video_url, sh.tags, sh.artists, sh.duration, sh.likes, sh.direct_play
       FROM public.shorts sh
       WHERE sh.is_active = true AND sh.rand_key >= v_r3
         AND (cardinality(v_excl) = 0 OR NOT (sh.id = ANY(v_excl)))
       ORDER BY sh.rand_key ASC
       LIMIT v_slice)
      UNION ALL
      (SELECT sh.id, sh.title, sh.cover_url, sh.video_url, sh.tags, sh.artists, sh.duration, sh.likes, sh.direct_play
       FROM public.shorts sh
       WHERE sh.is_active = true AND sh.rand_key >= v_r4
         AND (cardinality(v_excl) = 0 OR NOT (sh.id = ANY(v_excl)))
       ORDER BY sh.rand_key ASC
       LIMIT v_slice)
      UNION ALL
      (SELECT sh.id, sh.title, sh.cover_url, sh.video_url, sh.tags, sh.artists, sh.duration, sh.likes, sh.direct_play
       FROM public.shorts sh
       WHERE sh.is_active = true AND sh.rand_key >= v_r5
         AND (cardinality(v_excl) = 0 OR NOT (sh.id = ANY(v_excl)))
       ORDER BY sh.rand_key ASC
       LIMIT v_slice)
      UNION ALL
      (SELECT sh.id, sh.title, sh.cover_url, sh.video_url, sh.tags, sh.artists, sh.duration, sh.likes, sh.direct_play
       FROM public.shorts sh
       WHERE sh.is_active = true AND sh.rand_key >= v_r6
         AND (cardinality(v_excl) = 0 OR NOT (sh.id = ANY(v_excl)))
       ORDER BY sh.rand_key ASC
       LIMIT v_slice)
      UNION ALL
      (SELECT sh.id, sh.title, sh.cover_url, sh.video_url, sh.tags, sh.artists, sh.duration, sh.likes, sh.direct_play
       FROM public.shorts sh
       WHERE sh.is_active = true AND sh.rand_key >= 0.0
         AND (cardinality(v_excl) = 0 OR NOT (sh.id = ANY(v_excl)))
       ORDER BY sh.rand_key ASC
       LIMIT v_limit)
    ),
    dedup AS (
      SELECT DISTINCT ON (p.id)
        p.id, p.title, p.cover_url, p.video_url, p.tags, p.artists, p.duration, p.likes, p.direct_play
      FROM pool p
    )
    SELECT d.id, d.title, d.cover_url, d.video_url, d.tags, d.artists, d.duration, d.likes, d.direct_play
    FROM dedup d
    ORDER BY random()
    LIMIT v_limit;
    RETURN;
  END IF;

  RETURN QUERY
  SELECT s.id, s.title, s.cover_url, s.video_url, s.tags, s.artists, s.duration, s.likes, s.direct_play
  FROM (
    SELECT sh.*
    FROM public.shorts sh
    WHERE sh.is_active = true
      AND (sh.tags @> ARRAY[lower(v_q)]::text[] OR sh.search_text ILIKE ('%' || v_q || '%'))
      AND (cardinality(v_excl) = 0 OR NOT (sh.id = ANY(v_excl)))
    LIMIT 1500
  ) s
  ORDER BY random()
  LIMIT v_limit;
END;
$$;

REVOKE ALL ON FUNCTION public.get_random_shorts(integer, text, bigint[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_random_shorts(integer, text, bigint[]) TO anon, authenticated, service_role;
