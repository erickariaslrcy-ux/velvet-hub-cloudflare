-- ==============================================================================
-- 11_TEST_PERSONAL_DATA_ISOLATION.SQL
-- SCRIPT DE PRUEBAS DE SEGURIDAD, AISLAMIENTO Y CONCURRENCIA
-- Proyecto: Velvet Hub
-- Rama: feat/datos-personales
--
-- INSTRUCCIONES DE USO EN PROYECTO DE PRUEBA:
-- Ejecutar en una base de datos PostgreSQL/Supabase de staging/pruebas.
-- Todo el script se ejecuta dentro de un bloque de transacción que hace ROLLBACK
-- al final, de modo que NO modifica ningún dato permanente.
-- ==============================================================================

BEGIN;

-- 1. PREPARACIÓN DE USUARIOS DE PRUEBA Y DATOS FICTICIOS
-- ------------------------------------------------------------------------------
DO $$
DECLARE
  v_user_a uuid := '11111111-1111-1111-1111-111111111111';
  v_user_b uuid := '22222222-2222-2222-2222-222222222222';
  v_item_1 bigint;
  v_item_2 bigint;
BEGIN
  -- Insertar usuarios ficticios en auth.users si no existen
  INSERT INTO auth.users (id, email)
  VALUES 
    (v_user_a, 'usuario_a@velvethub.test'),
    (v_user_b, 'usuario_b@velvethub.test')
  ON CONFLICT (id) DO NOTHING;

  -- Insertar items ficticios para pruebas de favoritos e historial
  INSERT INTO public.items (source, source_id, title, media_type, status, real_people)
  VALUES 
    ('test_source', 'item_101', 'Test Comic 101', 'comic', 'verified', false),
    ('test_source', 'item_102', 'Test Video 102', 'video', 'verified', false)
  ON CONFLICT (source, source_id) DO UPDATE SET title = EXCLUDED.title
  RETURNING id INTO v_item_1;

  SELECT id INTO v_item_1 FROM public.items WHERE source = 'test_source' AND source_id = 'item_101';
  SELECT id INTO v_item_2 FROM public.items WHERE source = 'test_source' AND source_id = 'item_102';

  -- Asignar datos iniciales como servicio
  INSERT INTO public.favorites (user_id, item_id)
  VALUES (v_user_a, v_item_1)
  ON CONFLICT DO NOTHING;

  INSERT INTO public.user_preferences (user_id, data, version)
  VALUES (v_user_a, '{"defaultQuality":"1080p","pauseHistory":false}'::jsonb, 2)
  ON CONFLICT (user_id) DO NOTHING;
END $$;

-- ------------------------------------------------------------------------------
-- 2. PRUEBA: AISLAMIENTO COMO USUARIO B (SET LOCAL ROLE authenticated, claims User B)
-- ------------------------------------------------------------------------------
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '22222222-2222-2222-2222-222222222222';

-- Comprobación 2.1: Usuario B NO debe ver favoritos de Usuario A
DO $$
DECLARE
  v_count integer;
BEGIN
  SELECT count(*) INTO v_count FROM public.favorites;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'FALLO DE SEGURIDAD: Usuario B pudo ver % favoritos ajenos', v_count;
  END IF;
  RAISE NOTICE '✓ Aislamiento de Favoritos validado: Usuario B ve 0 registros ajenos.';
END $$;

-- Comprobación 2.2: Usuario B NO debe ver preferencias de Usuario A
DO $$
DECLARE
  v_count integer;
BEGIN
  SELECT count(*) INTO v_count FROM public.user_preferences;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'FALLO DE SEGURIDAD: Usuario B pudo ver preferencias de Usuario A';
  END IF;
  RAISE NOTICE '✓ Aislamiento de Preferencias validado: Usuario B ve 0 registros ajenos.';
END $$;

-- Comprobación 2.3: Usuario B registra historial mediante RPC upsert_history
DO $$
DECLARE
  v_item_1 bigint;
  v_hist public.user_history;
BEGIN
  SELECT id INTO v_item_1 FROM public.items WHERE source = 'test_source' AND source_id = 'item_101';

  -- Inserción inicial: timestamp 1000, página 5
  v_hist := public.upsert_history(v_item_1, 'comic', 5, 20, false, 1000);
  IF v_hist.position <> 5 THEN
    RAISE EXCEPTION 'FALLO RPC: posición esperada 5, obtenida %', v_hist.position;
  END IF;

  -- Actualización posterior: timestamp 2000, página 12 (debe actualizar)
  v_hist := public.upsert_history(v_item_1, 'comic', 12, 20, false, 2000);
  IF v_hist.position <> 12 THEN
    RAISE EXCEPTION 'FALLO RPC: actualización legítima no se aplicó';
  END IF;

  -- Intento de sobreescritura con dato obsoleto: timestamp 1500 (menor que 2000), página 3
  -- DEBE ignorarse la sobreescritura y mantenerse en página 12
  v_hist := public.upsert_history(v_item_1, 'comic', 3, 20, false, 1500);
  IF v_hist.position <> 12 THEN
    RAISE EXCEPTION 'FALLO CONCURRENCIA: dato obsoleto sobreescribió un progreso más nuevo!';
  END IF;

  RAISE NOTICE '✓ Resolución de Concurrencia validada: progreso antiguo no sobreescribe el nuevo.';
END $$;

-- ------------------------------------------------------------------------------
-- 3. PRUEBA: AISLAMIENTO COMO USUARIO ANÓNIMO (anon)
-- ------------------------------------------------------------------------------
SET LOCAL ROLE anon;
SET LOCAL "request.jwt.claim.sub" = '';

DO $$
BEGIN
  -- Anon no debe poder leer user_history
  BEGIN
    PERFORM count(*) FROM public.user_history;
    RAISE EXCEPTION 'FALLO: Anon pudo consultar public.user_history';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE '✓ Anon bloqueado correctamente para user_history (permission denied).';
  END;

  -- Anon no debe poder leer user_preferences
  BEGIN
    PERFORM count(*) FROM public.user_preferences;
    RAISE EXCEPTION 'FALLO: Anon pudo consultar public.user_preferences';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE '✓ Anon bloqueado correctamente para user_preferences (permission denied).';
  END;

  -- Anon no debe poder leer favorites
  BEGIN
    PERFORM count(*) FROM public.favorites;
    RAISE EXCEPTION 'FALLO: Anon pudo consultar public.favorites';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE '✓ Anon bloqueado correctamente para favorites (permission denied).';
  END;
END $$;

-- ------------------------------------------------------------------------------
-- 4. CONCLUSIÓN Y ROLLBACK
-- ------------------------------------------------------------------------------
ROLLBACK;
RAISE NOTICE '=== TODAS LAS PRUEBAS DE AISLAMIENTO Y CONCURRENCIA PASARON EXITOSAMENTE (ROLLBACK REALIZADO) ===';
