-- =============================================================================
-- 14_cloud_favorites_and_jwt_slim.sql
-- Tablas persistentes para favoritos/historial externos (videos PMVHaven, juegos,
-- ítems no indexados en SQL), migración de datos existentes y limpieza de JWTs.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.user_custom_favorites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  item_key text NOT NULL,
  item_id text NOT NULL DEFAULT '',
  source text NOT NULL DEFAULT '',
  source_id text NOT NULL DEFAULT '',
  media_type text NOT NULL DEFAULT 'video',
  title text NOT NULL DEFAULT 'Contenido guardado',
  cover_url text NOT NULL DEFAULT '',
  url text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_custom_favorites_user_key_unique UNIQUE (user_id, item_key)
);

CREATE INDEX IF NOT EXISTS idx_user_custom_favorites_user_created
  ON public.user_custom_favorites (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_custom_favorites_user_media_created
  ON public.user_custom_favorites (user_id, media_type, created_at DESC);

ALTER TABLE public.user_custom_favorites ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.user_custom_favorites FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_custom_favorites TO authenticated;
GRANT ALL ON public.user_custom_favorites TO service_role;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'user_custom_favorites'
      AND policyname = 'Users can manage own custom favorites'
  ) THEN
    CREATE POLICY "Users can manage own custom favorites"
      ON public.user_custom_favorites
      FOR ALL
      TO authenticated
      USING ((select auth.uid()) = user_id)
      WITH CHECK ((select auth.uid()) = user_id);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.user_custom_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  item_key text NOT NULL,
  item_id text NOT NULL DEFAULT '',
  source text NOT NULL DEFAULT '',
  source_id text NOT NULL DEFAULT '',
  media_type text NOT NULL DEFAULT 'video',
  title text NOT NULL DEFAULT '',
  cover_url text NOT NULL DEFAULT '',
  url text NOT NULL DEFAULT '',
  position integer NOT NULL DEFAULT 0 CHECK (position >= 0),
  duration integer NOT NULL DEFAULT 0 CHECK (duration >= 0),
  completed boolean NOT NULL DEFAULT false,
  client_timestamp bigint NOT NULL DEFAULT 0,
  last_activity timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_custom_history_user_key_unique UNIQUE (user_id, item_key)
);

CREATE INDEX IF NOT EXISTS idx_user_custom_history_user_activity
  ON public.user_custom_history (user_id, last_activity DESC);

ALTER TABLE public.user_custom_history ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.user_custom_history FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_custom_history TO authenticated;
GRANT ALL ON public.user_custom_history TO service_role;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'user_custom_history'
      AND policyname = 'Users can manage own custom history'
  ) THEN
    CREATE POLICY "Users can manage own custom history"
      ON public.user_custom_history
      FOR ALL
      TO authenticated
      USING ((select auth.uid()) = user_id)
      WITH CHECK ((select auth.uid()) = user_id);
  END IF;
END $$;

-- Backfill de favoritos desde auth.users.raw_user_meta_data
DO $$
DECLARE
  rec RECORD;
  v_raw_id text;
  v_src text;
  v_src_id text;
  v_sql_id bigint;
  v_item_key text;
  v_media_type text;
  v_created_at timestamptz;
BEGIN
  FOR rec IN
    SELECT u.id AS user_id, elem
    FROM auth.users u,
         jsonb_array_elements(coalesce(u.raw_user_meta_data->'favorites', '[]'::jsonb)) elem
    WHERE jsonb_typeof(u.raw_user_meta_data->'favorites') = 'array'
    UNION ALL
    SELECT u.id AS user_id, elem
    FROM auth.users u,
         jsonb_array_elements(coalesce(u.raw_user_meta_data->'custom_favorites', '[]'::jsonb)) elem
    WHERE jsonb_typeof(u.raw_user_meta_data->'custom_favorites') = 'array'
  LOOP
    v_raw_id := nullif(btrim(coalesce(rec.elem->>'id', rec.elem->>'item_id', '')), '');
    v_src := lower(btrim(coalesce(rec.elem->>'source', '')));
    v_src_id := btrim(coalesce(rec.elem->>'source_id', ''));
    v_media_type := lower(btrim(coalesce(rec.elem->>'media_type', '')));
    IF v_media_type NOT IN ('comic', 'video', 'gallery', 'game') THEN
      IF v_src IN ('pmvhaven', 'spankbang', 'xvideos', 'eporner') THEN
        v_media_type := 'video';
      ELSIF v_src IN ('buondua', 'mitaku') THEN
        v_media_type := 'gallery';
      ELSE
        v_media_type := 'comic';
      END IF;
    END IF;

    IF coalesce(rec.elem->>'created_at', '') ~ '^\d{4}-\d{2}-\d{2}' THEN
      BEGIN
        v_created_at := (rec.elem->>'created_at')::timestamptz;
      EXCEPTION WHEN OTHERS THEN
        v_created_at := now();
      END;
    ELSE
      v_created_at := now();
    END IF;

    v_sql_id := NULL;
    IF v_raw_id IS NOT NULL AND v_raw_id ~ '^\d{1,18}$' THEN
      SELECT i.id INTO v_sql_id FROM public.items i WHERE i.id = v_raw_id::bigint LIMIT 1;
    END IF;
    IF v_sql_id IS NULL AND v_src <> '' AND v_src_id <> '' THEN
      SELECT i.id INTO v_sql_id FROM public.items i WHERE i.source = v_src AND i.source_id = v_src_id LIMIT 1;
    END IF;

    IF v_sql_id IS NOT NULL THEN
      INSERT INTO public.favorites (user_id, item_id, created_at)
      VALUES (rec.user_id, v_sql_id, v_created_at)
      ON CONFLICT (user_id, item_id) DO NOTHING;
    ELSE
      v_item_key := CASE
        WHEN v_src <> '' AND v_src_id <> '' THEN v_src || ':' || v_src_id
        WHEN v_raw_id IS NOT NULL THEN v_raw_id
        ELSE md5(rec.elem::text)
      END;
      INSERT INTO public.user_custom_favorites (
        user_id, item_key, item_id, source, source_id, media_type, title, cover_url, url, created_at
      ) VALUES (
        rec.user_id,
        v_item_key,
        coalesce(v_raw_id, v_src_id, v_item_key),
        v_src,
        v_src_id,
        v_media_type,
        left(coalesce(nullif(rec.elem->>'title', ''), 'Contenido guardado'), 300),
        coalesce(rec.elem->>'cover_url', ''),
        coalesce(rec.elem->>'url', ''),
        v_created_at
      )
      ON CONFLICT (user_id, item_key) DO NOTHING;
    END IF;
  END LOOP;
END $$;

-- Backfill de historial desde auth.users.raw_user_meta_data
DO $$
DECLARE
  rec RECORD;
  v_raw_id text;
  v_src text;
  v_src_id text;
  v_sql_id bigint;
  v_item_key text;
  v_media_type text;
  v_sql_media text;
  v_pos integer;
  v_dur integer;
  v_comp boolean;
  v_cts bigint;
  v_act timestamptz;
  v_pos_raw text;
  v_dur_raw text;
  v_cts_raw text;
BEGIN
  FOR rec IN
    SELECT u.id AS user_id, elem
    FROM auth.users u,
         jsonb_array_elements(coalesce(u.raw_user_meta_data->'history', '[]'::jsonb)) elem
    WHERE jsonb_typeof(u.raw_user_meta_data->'history') = 'array'
  LOOP
    v_raw_id := nullif(btrim(coalesce(rec.elem->>'item_id', rec.elem->>'id', '')), '');
    v_src := lower(btrim(coalesce(rec.elem->>'source', '')));
    v_src_id := btrim(coalesce(rec.elem->>'source_id', ''));
    v_media_type := lower(btrim(coalesce(rec.elem->>'media_type', '')));
    IF v_media_type NOT IN ('comic', 'video', 'gallery', 'game') THEN
      v_media_type := CASE
        WHEN v_src IN ('pmvhaven', 'spankbang', 'xvideos', 'eporner') THEN 'video'
        WHEN v_src IN ('buondua', 'mitaku') THEN 'gallery'
        ELSE 'comic'
      END;
    END IF;
    v_sql_media := CASE WHEN v_media_type IN ('comic', 'video', 'gallery') THEN v_media_type ELSE 'comic' END;

    v_pos_raw := nullif(btrim(coalesce(rec.elem->>'position', rec.elem->>'page', rec.elem->>'currentTime', '')), '');
    v_pos := CASE WHEN v_pos_raw ~ '^\d{1,9}(\.\d+)?$' THEN greatest(0, least(2147483647, floor(v_pos_raw::numeric)::integer)) ELSE 0 END;

    v_dur_raw := nullif(btrim(coalesce(rec.elem->>'duration', rec.elem->>'total', '')), '');
    v_dur := CASE WHEN v_dur_raw ~ '^\d{1,9}(\.\d+)?$' THEN greatest(0, least(2147483647, floor(v_dur_raw::numeric)::integer)) ELSE 0 END;

    v_comp := lower(coalesce(rec.elem->>'completed', '')) IN ('true', 't', '1');

    v_cts_raw := nullif(btrim(coalesce(rec.elem->>'client_timestamp', rec.elem->>'at', '')), '');
    v_cts := CASE WHEN v_cts_raw ~ '^\d{1,18}$' THEN v_cts_raw::bigint ELSE 0 END;

    IF coalesce(rec.elem->>'last_activity', '') ~ '^\d{4}-\d{2}-\d{2}' THEN
      BEGIN
        v_act := (rec.elem->>'last_activity')::timestamptz;
      EXCEPTION WHEN OTHERS THEN
        v_act := now();
      END;
    ELSE
      v_act := now();
    END IF;

    v_sql_id := NULL;
    IF v_raw_id IS NOT NULL AND v_raw_id ~ '^\d{1,18}$' THEN
      SELECT i.id INTO v_sql_id FROM public.items i WHERE i.id = v_raw_id::bigint LIMIT 1;
    END IF;
    IF v_sql_id IS NULL AND v_src <> '' AND v_src_id <> '' THEN
      SELECT i.id INTO v_sql_id FROM public.items i WHERE i.source = v_src AND i.source_id = v_src_id LIMIT 1;
    END IF;

    IF v_sql_id IS NOT NULL THEN
      INSERT INTO public.user_history (
        user_id, item_id, media_type, position, duration, completed, last_activity, client_timestamp
      ) VALUES (
        rec.user_id, v_sql_id, v_sql_media, v_pos, v_dur, v_comp, v_act, v_cts
      )
      ON CONFLICT (user_id, item_id) DO UPDATE SET
        position = GREATEST(EXCLUDED.position, public.user_history.position),
        duration = GREATEST(EXCLUDED.duration, public.user_history.duration),
        completed = EXCLUDED.completed OR public.user_history.completed,
        last_activity = GREATEST(EXCLUDED.last_activity, public.user_history.last_activity),
        client_timestamp = GREATEST(EXCLUDED.client_timestamp, public.user_history.client_timestamp);
    ELSIF v_raw_id IS NOT NULL OR (v_src <> '' AND v_src_id <> '') THEN
      v_item_key := CASE
        WHEN v_src <> '' AND v_src_id <> '' THEN v_src || ':' || v_src_id
        ELSE coalesce(v_raw_id, md5(rec.elem::text))
      END;
      INSERT INTO public.user_custom_history (
        user_id, item_key, item_id, source, source_id, media_type, title, cover_url, url, position, duration, completed, client_timestamp, last_activity
      ) VALUES (
        rec.user_id,
        v_item_key,
        coalesce(v_raw_id, v_src_id, v_item_key),
        v_src,
        v_src_id,
        v_media_type,
        left(coalesce(rec.elem->>'title', ''), 300),
        coalesce(rec.elem->>'cover_url', ''),
        coalesce(rec.elem->>'url', ''),
        v_pos,
        v_dur,
        v_comp,
        v_cts,
        v_act
      )
      ON CONFLICT (user_id, item_key) DO NOTHING;
    END IF;
  END LOOP;
END $$;

-- Purgar claves pesadas de auth.users.raw_user_meta_data para reducir el JWT a <1KB
UPDATE auth.users
SET raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb)
  - 'favorites'
  - 'custom_favorites'
  - 'history'
  - 'progress'
WHERE raw_user_meta_data ?| array['favorites', 'custom_favorites', 'history', 'progress'];
