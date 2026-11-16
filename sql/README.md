# Guía de Migraciones SQL: Datos Personales y Bóveda Multi-Dispositivo
**Rama:** `feat/datos-personales`  
**Objetivo:** Persistencia atómica y unificada en PostgreSQL para Favoritos, Historial, Progreso y Preferencias.

---

## 1. Reglas de Seguridad y Respaldo Previo
- **NO DESTRUCTIVO & IDEMPOTENTE:** Todas las sentencias usan `IF NOT EXISTS`, `OR REPLACE` y cláusulas seguras.
- **RESPALDO SUGERIDO EN PRODUCCIÓN:**
  Antes de ejecutar en la consola SQL del dashboard de Supabase (o mediante migración CLI), ejecute un snapshot de respaldo de seguridad:
  ```sql
  CREATE TABLE IF NOT EXISTS _backup_favorites_20261115 AS SELECT * FROM public.favorites;
  ```

---

## 2. Orden de Ejecución de Scripts

1. **`10_personal_data_schema.sql`**  
   - Crea la tabla `public.user_history` con restricción única `(user_id, item_id)`.
   - Crea la tabla `public.user_preferences` con restricción de tamaño y aislamiento de `profiles`.
   - Crea la función RPC concurrente `public.upsert_history` con `SECURITY INVOKER`.
   - Crea la función de mantenimiento `public.prune_user_history`.
   - Aplica políticas RLS estrictas (`auth.uid() = user_id`) y revoca permisos a `anon`.
   - Añade el índice determinista `(user_id, created_at DESC, item_id DESC)` a `public.favorites`.

2. **`11_test_personal_data_isolation.sql`** (Solo para entornos de prueba / Staging)  
   - Realiza una simulación transaccional (`BEGIN ... ROLLBACK`) con dos usuarios ficticios (Usuario A y Usuario B).
   - Valida que Usuario B no pueda leer ni escribir sobre datos de Usuario A.
   - Valida que el rol `anon` no pueda acceder a las tablas personales.
   - Valida que `upsert_history` ignore escrituras obsoletas con timestamp anterior al actual.

---

## 3. Verificación Posterior a la Ejecución
En el editor SQL de Supabase, verifique que las tablas y RLS estén activas:
```sql
SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('user_history', 'user_preferences', 'favorites');
```
Ambas deben mostrar `rowsecurity = true`.
