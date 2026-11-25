-- =============================================================================
-- Migración 13: Suscripciones por Tiempo, Usuarios, Canje Atómico y RLS Seguro
-- Proyecto: Morbo Hub / Velvet Hub (VERSION_CLOUDFLARE)
-- =============================================================================

-- 1. Ampliar public.profiles con campos de perfil y suscripción por tiempo
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS username text,
  ADD COLUMN IF NOT EXISTS avatar text NOT NULL DEFAULT 'crown',
  ADD COLUMN IF NOT EXISTS avatar_bg text NOT NULL DEFAULT 'from-pink-600 to-purple-600',
  ADD COLUMN IF NOT EXISTS subscription_tier text NOT NULL DEFAULT 'free',
  ADD COLUMN IF NOT EXISTS subscription_status text NOT NULL DEFAULT 'inactive',
  ADD COLUMN IF NOT EXISTS subscription_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS is_lifetime boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS registered_with_key text,
  ADD COLUMN IF NOT EXISTS last_redeemed_at timestamptz,
  ADD COLUMN IF NOT EXISTS patreon_id text,
  ADD COLUMN IF NOT EXISTS patron_status text,
  ADD COLUMN IF NOT EXISTS is_suspended boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'profiles_subscription_tier_check'
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_subscription_tier_check
      CHECK (subscription_tier IN ('free', 'vip', 'patreon', 'admin'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'profiles_subscription_status_check'
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_subscription_status_check
      CHECK (subscription_status IN ('inactive', 'active', 'expired', 'suspended', 'admin'));
  END IF;
END $$;

-- Backfill de perfiles existentes con auth.users e invite_keys
UPDATE public.profiles p
SET
  username = COALESCE(
    NULLIF(btrim(p.username), ''),
    CASE
      WHEN p.is_admin THEN 'erick'
      ELSE NULLIF(btrim(u.raw_user_meta_data->>'username'), '')
    END,
    split_part(COALESCE(p.email, u.email, ''), '@', 1)
  ),
  subscription_tier = CASE
    WHEN p.is_admin THEN 'admin'
    WHEN u.raw_user_meta_data->>'patron_status' = 'active_patron' THEN 'patreon'
    WHEN k.code IS NOT NULL THEN 'vip'
    ELSE COALESCE(NULLIF(p.subscription_tier, ''), 'free')
  END,
  subscription_status = CASE
    WHEN p.is_suspended THEN 'suspended'
    WHEN p.is_admin THEN 'admin'
    WHEN k.used_at IS NOT NULL THEN
      CASE WHEN (k.used_at + interval '30 days') > now() THEN 'active' ELSE 'expired' END
    WHEN u.raw_user_meta_data->>'patron_status' = 'active_patron' THEN 'active'
    ELSE 'inactive'
  END,
  is_lifetime = CASE WHEN p.is_admin THEN true ELSE COALESCE(p.is_lifetime, false) END,
  subscription_expires_at = CASE
    WHEN p.is_admin THEN NULL
    WHEN p.subscription_expires_at IS NOT NULL THEN p.subscription_expires_at
    WHEN k.used_at IS NOT NULL THEN k.used_at + interval '30 days'
    ELSE NULL
  END,
  registered_with_key = COALESCE(p.registered_with_key, k.code),
  last_redeemed_at = COALESCE(p.last_redeemed_at, k.used_at),
  patreon_id = COALESCE(p.patreon_id, u.raw_user_meta_data->>'patreon_id'),
  patron_status = COALESCE(p.patron_status, u.raw_user_meta_data->>'patron_status'),
  updated_at = now()
FROM auth.users u
LEFT JOIN LATERAL (
  SELECT ik.code, ik.used_at
  FROM public.invite_keys ik
  WHERE ik.used_by = u.id
  ORDER BY ik.used_at DESC NULLS LAST
  LIMIT 1
) k ON true
WHERE p.id = u.id;

-- Deduplicar usernames en caso de colisión previa antes de crear el índice único
WITH ranked AS (
  SELECT id, username,
         row_number() OVER (PARTITION BY lower(btrim(username)) ORDER BY created_at ASC, id ASC) AS rn
  FROM public.profiles
  WHERE username IS NOT NULL AND btrim(username) <> ''
)
UPDATE public.profiles p
SET username = p.username || '_' || substr(replace(p.id::text, '-', ''), 1, 4)
FROM ranked r
WHERE p.id = r.id AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_username_lower
  ON public.profiles (lower(btrim(username)))
  WHERE username IS NOT NULL AND btrim(username) <> '';

CREATE INDEX IF NOT EXISTS idx_profiles_patreon_id
  ON public.profiles (patreon_id)
  WHERE patreon_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_profiles_subscription_expires
  ON public.profiles (subscription_expires_at)
  WHERE subscription_expires_at IS NOT NULL;

-- 2. Ampliar public.invite_keys con duración en días (0 = permanente) y etiqueta de plan
ALTER TABLE public.invite_keys
  ADD COLUMN IF NOT EXISTS duration_days integer NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS plan_label text NOT NULL DEFAULT 'Morbo VIP 1 Mes';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'invite_keys_duration_days_check'
  ) THEN
    ALTER TABLE public.invite_keys
      ADD CONSTRAINT invite_keys_duration_days_check
      CHECK (duration_days >= 0 AND duration_days <= 3650);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_invite_keys_available
  ON public.invite_keys (created_at DESC)
  WHERE used_at IS NULL AND revoked = false;

-- 3. Bitácora / historial de canjes de suscripción
CREATE TABLE IF NOT EXISTS public.subscription_redemptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  key_code text NOT NULL REFERENCES public.invite_keys(code) ON DELETE RESTRICT,
  duration_days integer NOT NULL,
  previous_expires_at timestamptz,
  new_expires_at timestamptz,
  redeemed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_subscription_redemptions_user
  ON public.subscription_redemptions (user_id, redeemed_at DESC);

CREATE INDEX IF NOT EXISTS idx_subscription_redemptions_key
  ON public.subscription_redemptions (key_code);

ALTER TABLE public.subscription_redemptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "subscription_redemptions_select_own" ON public.subscription_redemptions;
CREATE POLICY "subscription_redemptions_select_own"
  ON public.subscription_redemptions
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()) OR public.is_admin());

INSERT INTO public.subscription_redemptions (user_id, key_code, duration_days, previous_expires_at, new_expires_at, redeemed_at)
SELECT
  ik.used_by,
  ik.code,
  COALESCE(ik.duration_days, 30),
  NULL,
  ik.used_at + make_interval(days => COALESCE(ik.duration_days, 30)),
  ik.used_at
FROM public.invite_keys ik
JOIN auth.users u ON u.id = ik.used_by
WHERE ik.used_by IS NOT NULL
  AND ik.used_at IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.subscription_redemptions sr WHERE sr.key_code = ik.code
  );

-- 4. Funciones y triggers endurecidos
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE((SELECT is_admin FROM public.profiles WHERE id = (SELECT auth.uid())), false);
$$;

CREATE OR REPLACE FUNCTION public.has_active_subscription(p_user_id uuid DEFAULT NULL)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE((
    SELECT
      NOT COALESCE(p.is_suspended, false)
      AND (
        COALESCE(p.is_admin, false)
        OR COALESCE(p.is_lifetime, false)
        OR (p.subscription_expires_at IS NOT NULL AND p.subscription_expires_at > now())
        OR (p.patron_status = 'active_patron' AND p.subscription_status = 'active')
      )
    FROM public.profiles p
    WHERE p.id = COALESCE(p_user_id, (SELECT auth.uid()))
  ), false);
$$;

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_raw_username text;
  v_clean_username text;
  v_candidate text;
BEGIN
  v_raw_username := NULLIF(btrim(COALESCE(new.raw_user_meta_data->>'username', new.raw_user_meta_data->>'display_name', '')), '');
  IF v_raw_username IS NULL THEN
    v_raw_username := NULLIF(split_part(COALESCE(new.email, ''), '@', 1), '');
  END IF;

  v_clean_username := NULLIF(regexp_replace(COALESCE(v_raw_username, ''), '[^a-zA-Z0-9_.-]+', '', 'g'), '');

  IF v_clean_username IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM public.profiles
      WHERE lower(btrim(username)) = lower(v_clean_username)
        AND id <> new.id
    ) THEN
      v_candidate := left(v_clean_username, 24) || '_' || substr(replace(new.id::text, '-', ''), 1, 4);
    ELSE
      v_candidate := left(v_clean_username, 32);
    END IF;
  END IF;

  INSERT INTO public.profiles (id, email, username, avatar, avatar_bg)
  VALUES (
    new.id,
    lower(COALESCE(new.email, '')),
    v_candidate,
    COALESCE(NULLIF(new.raw_user_meta_data->>'avatar', ''), 'crown'),
    COALESCE(NULLIF(new.raw_user_meta_data->>'avatarBg', ''), 'from-pink-600 to-purple-600')
  )
  ON CONFLICT (id) DO UPDATE SET
    email = COALESCE(NULLIF(public.profiles.email, ''), EXCLUDED.email),
    username = COALESCE(NULLIF(public.profiles.username, ''), EXCLUDED.username),
    updated_at = now();

  RETURN new;
END;
$$;

CREATE OR REPLACE FUNCTION public.protect_profile_sensitive_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF COALESCE(current_setting('request.jwt.claim.role', true), '') = 'authenticated' THEN
    new.email := old.email;
    new.is_admin := old.is_admin;
    new.subscription_tier := old.subscription_tier;
    new.subscription_status := old.subscription_status;
    new.subscription_expires_at := old.subscription_expires_at;
    new.is_lifetime := old.is_lifetime;
    new.registered_with_key := old.registered_with_key;
    new.last_redeemed_at := old.last_redeemed_at;
    new.patreon_id := old.patreon_id;
    new.patron_status := old.patron_status;
    new.is_suspended := old.is_suspended;
  END IF;
  new.updated_at := now();
  RETURN new;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_profile_sensitive_columns ON public.profiles;
CREATE TRIGGER trg_protect_profile_sensitive_columns
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.protect_profile_sensitive_columns();

-- Función transaccional atómica de canje de llave (solo ejecutable con service_role)
CREATE OR REPLACE FUNCTION public.redeem_subscription_key(
  p_code text,
  p_user_id uuid,
  p_email text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_code text := upper(btrim(COALESCE(p_code, '')));
  v_key public.invite_keys%rowtype;
  v_profile public.profiles%rowtype;
  v_days integer;
  v_base timestamptz;
  v_new_exp timestamptz;
  v_is_lifetime boolean;
  v_email text := lower(NULLIF(btrim(COALESCE(p_email, '')), ''));
  v_new_status text;
BEGIN
  IF v_code = '' OR p_user_id IS NULL THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'invalid_input',
      'message', 'Código de llave o usuario inválido.'
    );
  END IF;

  SELECT * INTO v_key
  FROM public.invite_keys
  WHERE code = v_code
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'not_found',
      'message', 'La llave de acceso no existe.'
    );
  END IF;

  IF COALESCE(v_key.revoked, false) THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'revoked',
      'message', 'Esta llave fue revocada por el administrador.'
    );
  END IF;

  IF v_key.used_at IS NOT NULL THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'already_used',
      'message', 'Esta llave de acceso ya fue utilizada anteriormente.'
    );
  END IF;

  IF v_key.expires_at IS NOT NULL AND v_key.expires_at <= now() THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'key_expired',
      'message', 'Esta llave caducó antes de ser canjeada.'
    );
  END IF;

  SELECT * INTO v_profile
  FROM public.profiles
  WHERE id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    IF v_email IS NULL THEN
      SELECT lower(u.email) INTO v_email FROM auth.users u WHERE u.id = p_user_id;
    END IF;
    INSERT INTO public.profiles (id, email)
    VALUES (p_user_id, COALESCE(v_email, ''))
    ON CONFLICT (id) DO NOTHING;

    SELECT * INTO v_profile
    FROM public.profiles
    WHERE id = p_user_id
    FOR UPDATE;
  END IF;

  IF COALESCE(v_profile.is_suspended, false) THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'suspended',
      'message', 'Tu cuenta está suspendida. Contacta al administrador.'
    );
  END IF;

  v_days := COALESCE(v_key.duration_days, 30);

  IF v_days = 0 THEN
    v_is_lifetime := true;
    v_new_exp := NULL;
  ELSE
    v_is_lifetime := COALESCE(v_profile.is_lifetime, false);
    IF v_is_lifetime THEN
      v_new_exp := NULL;
    ELSE
      v_base := CASE
        WHEN v_profile.subscription_expires_at IS NOT NULL AND v_profile.subscription_expires_at > now()
          THEN v_profile.subscription_expires_at
        ELSE now()
      END;
      v_new_exp := v_base + make_interval(days => v_days);
    END IF;
  END IF;

  v_new_status := CASE WHEN COALESCE(v_profile.is_admin, false) THEN 'admin' ELSE 'active' END;

  UPDATE public.invite_keys
  SET
    used_by = p_user_id,
    used_email = COALESCE(v_email, NULLIF(btrim(v_profile.email), '')),
    used_at = now()
  WHERE code = v_code;

  UPDATE public.profiles
  SET
    subscription_tier = CASE WHEN COALESCE(v_profile.is_admin, false) THEN 'admin' ELSE 'vip' END,
    subscription_status = v_new_status,
    subscription_expires_at = v_new_exp,
    is_lifetime = v_is_lifetime,
    registered_with_key = v_code,
    last_redeemed_at = now(),
    updated_at = now()
  WHERE id = p_user_id;

  INSERT INTO public.subscription_redemptions (
    user_id,
    key_code,
    duration_days,
    previous_expires_at,
    new_expires_at,
    redeemed_at
  )
  VALUES (
    p_user_id,
    v_code,
    v_days,
    v_profile.subscription_expires_at,
    v_new_exp,
    now()
  );

  RETURN jsonb_build_object(
    'ok', true,
    'code', v_code,
    'duration_days', v_days,
    'plan_label', COALESCE(NULLIF(v_key.plan_label, ''), CASE WHEN v_days = 0 THEN 'VIP Permanente' ELSE 'Morbo VIP ' || v_days || ' días' END),
    'previous_expires_at', v_profile.subscription_expires_at,
    'subscription_expires_at', v_new_exp,
    'is_lifetime', v_is_lifetime,
    'subscription_status', v_new_status
  );
END;
$$;

-- Restringir ejecución de RPCs administrativas/transaccionales solo a service_role
REVOKE ALL ON FUNCTION public.redeem_subscription_key(text, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.redeem_subscription_key(text, uuid, text) TO service_role;

REVOKE ALL ON FUNCTION public.claim_invite_key(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_invite_key(text, text) TO service_role;

REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.protect_profile_sensitive_columns() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.has_active_subscription(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.has_active_subscription(uuid) TO authenticated, service_role;

-- 5. Políticas RLS seguras y optimizadas (initplan) en tablas de usuario
DROP POLICY IF EXISTS "perfil propio" ON public.profiles;
CREATE POLICY "perfil propio"
  ON public.profiles
  FOR SELECT TO authenticated
  USING (id = (SELECT auth.uid()) OR public.is_admin());

DROP POLICY IF EXISTS "profiles_update_own" ON public.profiles;
CREATE POLICY "profiles_update_own"
  ON public.profiles
  FOR UPDATE TO authenticated
  USING (id = (SELECT auth.uid()))
  WITH CHECK (id = (SELECT auth.uid()));

-- Seguridad a nivel de columnas: el usuario solo puede editar avatar/username/updated_at si toca PostgREST
REVOKE UPDATE ON public.profiles FROM anon, authenticated;
GRANT UPDATE (username, avatar, avatar_bg, updated_at) ON public.profiles TO authenticated;

-- Optimización initplan para favorites, user_history, user_preferences
DROP POLICY IF EXISTS "favoritos propios leer" ON public.favorites;
CREATE POLICY "favoritos propios leer" ON public.favorites
  FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "favoritos propios crear" ON public.favorites;
CREATE POLICY "favoritos propios crear" ON public.favorites
  FOR INSERT TO authenticated WITH CHECK (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "favoritos propios borrar" ON public.favorites;
CREATE POLICY "favoritos propios borrar" ON public.favorites
  FOR DELETE TO authenticated USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "user_history_select_own" ON public.user_history;
CREATE POLICY "user_history_select_own" ON public.user_history
  FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "user_history_insert_own" ON public.user_history;
CREATE POLICY "user_history_insert_own" ON public.user_history
  FOR INSERT TO authenticated WITH CHECK (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "user_history_update_own" ON public.user_history;
CREATE POLICY "user_history_update_own" ON public.user_history
  FOR UPDATE TO authenticated
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "user_history_delete_own" ON public.user_history;
CREATE POLICY "user_history_delete_own" ON public.user_history
  FOR DELETE TO authenticated USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "user_preferences_select_own" ON public.user_preferences;
CREATE POLICY "user_preferences_select_own" ON public.user_preferences
  FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "user_preferences_insert_own" ON public.user_preferences;
CREATE POLICY "user_preferences_insert_own" ON public.user_preferences
  FOR INSERT TO authenticated WITH CHECK (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "user_preferences_update_own" ON public.user_preferences;
CREATE POLICY "user_preferences_update_own" ON public.user_preferences
  FOR UPDATE TO authenticated
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "user_preferences_delete_own" ON public.user_preferences;
CREATE POLICY "user_preferences_delete_own" ON public.user_preferences
  FOR DELETE TO authenticated USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "llaves solo admin" ON public.invite_keys;
CREATE POLICY "llaves solo admin" ON public.invite_keys
  FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());
