-- ============================================================================
-- 15_security_audit_hardening.sql
-- Cierre integral de RLS, vistas invoker, permisos de tablas y RPCs en Supabase
-- ============================================================================

-- 1. PROTECCIÓN DE public.items (incluye items bloqueados y URLs crudas)
ALTER TABLE public.items ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.items FROM anon, authenticated, PUBLIC;
GRANT ALL ON TABLE public.items TO service_role;
-- Permitimos solo SELECT de columnas públicas no sensibles a authenticated para joins
-- (RLS policy 'items solo admin' filtra filas no autorizadas y excluye blocked / real_people)
GRANT SELECT (id, source, source_id, title, cover_url, media_type, page_count, status) ON TABLE public.items TO authenticated;

-- 2. PROTECCIÓN DE LA VISTA public.catalog (SECURITY INVOKER + solo service_role)
ALTER VIEW public.catalog SET (security_invoker = true);
REVOKE ALL ON TABLE public.catalog FROM anon, authenticated, PUBLIC;
GRANT SELECT ON TABLE public.catalog TO service_role;

-- 3. PROTECCIÓN DE public.profiles Y COLUMNA-POR-COLUMNA + TRIGGER ANTI-ESCALADA
REVOKE ALL ON TABLE public.profiles FROM anon, PUBLIC;
REVOKE ALL ON TABLE public.profiles FROM authenticated;
GRANT SELECT ON TABLE public.profiles TO authenticated;
GRANT UPDATE (username, avatar, avatar_bg, updated_at) ON TABLE public.profiles TO authenticated;
GRANT ALL ON TABLE public.profiles TO service_role;

CREATE OR REPLACE FUNCTION public.protect_profile_sensitive_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_jwt_role text := '';
BEGIN
  BEGIN
    v_jwt_role := COALESCE(
      NULLIF(current_setting('request.jwt.claim.role', true), ''),
      NULLIF((current_setting('request.jwt.claims', true)::jsonb ->> 'role'), ''),
      ''
    );
  EXCEPTION WHEN OTHERS THEN
    v_jwt_role := '';
  END;

  IF current_user IN ('authenticated', 'anon')
     OR v_jwt_role IN ('authenticated', 'anon')
     OR COALESCE(auth.role(), '') IN ('authenticated', 'anon') THEN
    NEW.id := OLD.id;
    NEW.email := OLD.email;
    NEW.is_admin := OLD.is_admin;
    NEW.subscription_tier := OLD.subscription_tier;
    NEW.subscription_status := OLD.subscription_status;
    NEW.subscription_expires_at := OLD.subscription_expires_at;
    NEW.is_lifetime := OLD.is_lifetime;
    NEW.registered_with_key := OLD.registered_with_key;
    NEW.last_redeemed_at := OLD.last_redeemed_at;
    NEW.patreon_id := OLD.patreon_id;
    NEW.patron_status := OLD.patron_status;
    NEW.is_suspended := OLD.is_suspended;
    NEW.created_at := OLD.created_at;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$function$;

-- 4. TABLAS INTERNAS DE SUSCRIPCIONES Y METADATOS (invite_keys, source_aliases, redemptions)
REVOKE ALL ON TABLE public.invite_keys FROM anon, authenticated, PUBLIC;
GRANT ALL ON TABLE public.invite_keys TO service_role;

REVOKE ALL ON TABLE public.source_aliases FROM anon, authenticated, PUBLIC;
GRANT ALL ON TABLE public.source_aliases TO service_role;

REVOKE ALL ON TABLE public.subscription_redemptions FROM anon, PUBLIC;
REVOKE ALL ON TABLE public.subscription_redemptions FROM authenticated;
GRANT SELECT ON TABLE public.subscription_redemptions TO authenticated;
GRANT ALL ON TABLE public.subscription_redemptions TO service_role;

-- 5. TABLAS DE DATOS PERSONALES DEL USUARIO (solo authenticated + RLS propio + service_role)
REVOKE ALL ON TABLE
  public.favorites,
  public.user_history,
  public.user_preferences,
  public.user_custom_favorites,
  public.user_custom_history
FROM anon, PUBLIC;

REVOKE TRUNCATE, TRIGGER, REFERENCES ON TABLE
  public.favorites,
  public.user_history,
  public.user_preferences,
  public.user_custom_favorites,
  public.user_custom_history
FROM authenticated;

GRANT ALL ON TABLE
  public.favorites,
  public.user_history,
  public.user_preferences,
  public.user_custom_favorites,
  public.user_custom_history
TO service_role;

-- 6. BLOQUEO DE FUNCIONES / RPCs SENSIBLES Y SEARCH_PATH INMUTABLE
ALTER FUNCTION public.items_before_write() SET search_path = public, extensions;

REVOKE ALL ON FUNCTION public.get_item_detail(bigint) FROM anon, authenticated, PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_item_detail(bigint) TO service_role;

REVOKE ALL ON FUNCTION public.redeem_subscription_key(text, uuid, text) FROM anon, authenticated, PUBLIC;
GRANT EXECUTE ON FUNCTION public.redeem_subscription_key(text, uuid, text) TO service_role;

REVOKE ALL ON FUNCTION public.claim_invite_key(text, text) FROM anon, authenticated, PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_invite_key(text, text) TO service_role;

REVOKE ALL ON FUNCTION public.handle_new_user() FROM anon, authenticated, PUBLIC;
REVOKE ALL ON FUNCTION public.ensure_source_alias() FROM anon, authenticated, PUBLIC;
REVOKE ALL ON FUNCTION public.items_before_write() FROM anon, authenticated, PUBLIC;

REVOKE ALL ON FUNCTION public.catalog_sources() FROM anon, authenticated, PUBLIC;
GRANT EXECUTE ON FUNCTION public.catalog_sources() TO service_role;

REVOKE ALL ON FUNCTION public.admin_stats() FROM anon, authenticated, PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_stats() TO service_role;

REVOKE ALL ON FUNCTION public.admin_source_aliases() FROM anon, authenticated, PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_source_aliases() TO service_role;

REVOKE ALL ON FUNCTION public.is_admin() FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.has_active_subscription(uuid) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.has_active_subscription(uuid) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.prune_user_history(integer) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.prune_user_history(integer) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.upsert_history(bigint, text, integer, integer, boolean, bigint) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.upsert_history(bigint, text, integer, integer, boolean, bigint) TO authenticated, service_role;
