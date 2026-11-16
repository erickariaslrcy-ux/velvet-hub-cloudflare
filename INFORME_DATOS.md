# INFORME_DATOS.md — Sincronización de Datos Personales, Paginación PostgreSQL y Aislamiento Multi-Cuenta

**Fecha:** 15 de Noviembre de 2026  
**Rama:** `feat/datos-personales` (en carpeta de trabajo aislada `WORKTREE_DATOS_PERSONALES`)  
**Autor:** Senior Full-Stack & Database Engineer  

---

## 1. Resumen Ejecutivo de la Intervención

Se rediseñó e implementó la persistencia y sincronización multi-dispositivo de **Favoritos, Historial, Progreso de Lectura/Video y Preferencias de Usuario**, transformando a PostgreSQL/Supabase en la **única fuente de verdad**.

### Problemas Raíz Erradicados:
1. **Discrepancia 29 vs 0 en la Bóveda:** Resuelto. El menú de usuario leía claves legacy de `localStorage` mientras que `vault.js` leía otra clave vacía y nunca hacía peticiones a la base de datos. Se unificaron contadores y listados a través de `VelvetPersonalData`.
2. **Paginación del Catálogo superpuesta sobre la Bóveda:** Resuelto. Se aislaron de forma defensiva `#main-content`, `#filter-bar` e `#infinite-scroll-container` al montar `/boveda/*`.
3. **Pérdida de progreso e inconsistencia entre dispositivos:** Resuelto. Se implementó la tabla `user_history` con la función RPC concurrente `upsert_history` (`SECURITY INVOKER`), que descarta marcas de tiempo obsoletas.
4. **Fuga o mezcla entre cuentas:** Resuelto. La identidad se resuelve exclusivamente mediante el JWT firmado del usuario (`auth.uid()`), ignorando cualquier `user_id` enviado por el cliente. Las políticas RLS garantizan aislamiento total entre usuarios A y B, y deniegan todo acceso a usuarios anónimos.

---

## 2. Clasificación de Estado por Problema

| Componente / Requerimiento | Estado | Evidencia de Verificación |
| :--- | :--- | :--- |
| **Persistencia de Favoritos en PostgreSQL** | **RESUELTO Y VERIFICADO** | Suite automatizada `test_personal_data.mjs` (bloque 2) verifica inserción, eliminación y recuperación. |
| **Idempotencia de Favoritos (sin duplicados)** | **RESUELTO Y VERIFICADO** | Verificado con inserciones repetidas con `resolution=ignore-duplicates` (0 duplicados). |
| **Tabla de Historial y Progreso (`user_history`)** | **RESUELTO Y VERIFICADO** | Esquema SQL idempotente en `10_personal_data_schema.sql` y pruebas de inserción/actualización en suite. |
| **Concurrencia en Historial (`upsert_history`)** | **RESUELTO Y VERIFICADO** | Verificado en prueba [3]: peticiones lentas con timestamp 500 no pisan el progreso de timestamp 2000. |
| **Paginación Real desde BD (24 por página)** | **RESUELTO Y VERIFICADO** | Prueba [4] con 160 registros: Pág 1 pide `Range: 0-23` (24 items), Pág 2 `Range: 24-47` (24 items), Pág 7 `Range: 144-167` (16 items). NUNCA se piden los 160. |
| **Aislamiento Multi-Cuenta (Usuario A vs B)** | **RESUELTO Y VERIFICADO** | Verificado en pruebas [1], [2], [3] y [5]: Usuario B no puede ver ni modificar favoritos, historial ni preferencias de A. |
| **Protección contra Spoofing de `user_id`** | **RESUELTO Y VERIFICADO** | Validado: el backend descarta cualquier parámetro `user_id` en query o body y usa `auth.uid()`. |
| **Tabla de Preferencias (`user_preferences`)** | **RESUELTO Y VERIFICADO** | Almacenamiento versionado de JSONB verificado, con límite estricto de 16KB (rechazo 413). |
| **Aislamiento Visual de Rutas de Bóveda** | **RESUELTO Y VERIFICADO** | Verificado en prueba [7] y en `vault.js`: `#main-content` e `#infinite-scroll-container` se ocultan. |
| **Exclusiones en Service Worker (`sw.js`)** | **RESUELTO Y VERIFICADO** | Sin tocar `CACHE_VERSION` ('v11-velvet-turbo'), se añadieron exclusiones para `/api/user/*`, `/api/history*`, `/api/preferences*` y `/api/sync*`. |
| **Sincronización en Producción / Supabase Real** | **CORREGIDO PERO PENDIENTE DE VERIFICACIÓN** | Código y scripts SQL listos y verificados en entorno aislado con mocks. Requiere ejecutar SQL en proyecto Supabase real. |
| **Comportamiento Táctil en Dispositivo Físico** | **REQUIERE ACCIÓN MANUAL** | Seguir pasos descritos en `CHECKLIST_BOVEDA.md` y `CHECKLIST_DATOS.md` en dispositivo Android físico. |

---

## 3. Arquitectura y Mecanismo de Sincronización

```
┌────────────────────────────────────────────────────────────────────────┐
│                        FRONTEND (Navegador)                            │
│  - VelvetPersonalData (public/js/personal-data.js)                     │
│  - Adapters transparentes en VelvetStore (public/js/store.js)          │
│  - Interfaz de Bóveda y Contadores (public/js/vault.js)                │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ Peticiones HTTPS autenticadas (JWT)
                                    │ Cache-Control: private, no-store
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                BACKEND CLOUDFLARE PAGES FUNCTIONS                      │
│  - Endpoint Router: functions/api/[[path]].js                          │
│  - Extracción de identidad: resolveAuthUser(request) -> auth.uid()     │
│  - Paginación determinista: Range: offset-to, Prefer: count=exact       │
│  - Rate Limiter Isolate en memoria (60 escrituras/min por usuario)     │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ PostgREST / RPC HTTPS
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                      POSTGRESQL / SUPABASE                             │
│  - public.favorites (PK: user_id, item_id; Índice: user_id, created_at)│
│  - public.user_history (PK: id; UQ: user_id, item_id; Índice compuesto)│
│  - public.user_preferences (PK: user_id; check length < 16KB)         │
│  - RPC upsert_history (SECURITY INVOKER, resolución de concurrencia)   │
│  - Políticas RLS: auth.uid() = user_id (SELECT, INSERT, UPDATE, DELETE)│
└────────────────────────────────────────────────────────────────────────┘
```

### Reglas Clave del Flujo de Sincronización:
1. **Primera Sesión / Migración Local:** Al iniciar sesión por primera vez con datos locales preexistentes, `VelvetPersonalData` realiza un respaldo completo de 30 días en `localStorage` (`velvet_backup_pre_migration_*`) y envía una sincronización masiva idempotente mediante `POST /api/user/favorites` y `POST /api/user/history`.
2. **Actualización Optimista con Rollback:** Al añadir o quitar un favorito, la UI actualiza instantáneamente los contadores y tarjetas. Si la llamada de red falla, se revierte el estado y se notifica al usuario.
3. **Throttling Inteligente de Progreso:** Durante la lectura de cómics o reproducción de video, el progreso se envía al servidor cada **20 segundos** para no saturar la red ni la base de datos.
4. **Envío Inmediato en Eventos Críticos:** En los eventos `pause`, `pagechange`, cambio de capítulo o descarga de la página (`visibilitychange`, `beforeunload`), el progreso se descarga inmediatamente usando `navigator.sendBeacon` o `fetch` con `{ keepalive: true }`.

---

## 4. Archivos Creados y Modificados (Detalle de Líneas)

### 4.1 Archivos Creados (Nuevos)
1. **`sql/10_personal_data_schema.sql` (229 líneas):**
   - Creación de índices optimizados para favoritos.
   - Definición de la tabla `public.user_history` y su constraint `uq_user_history_user_item`.
   - Función RPC `public.upsert_history` con `SECURITY INVOKER` y resolución de concurrencia por timestamp.
   - Función `public.prune_user_history(p_keep_limit INT)` para poda automática de historiales extensos.
   - Definición de la tabla `public.user_preferences` con constraint de tamaño `< 16384` bytes.
   - Políticas RLS completas para el rol `authenticated` y revocación total para el rol `anon`.
   - Revocación de permisos de actualización en la columna `is_admin` de `profiles`.
2. **`sql/11_test_personal_data_isolation.sql` (149 líneas):**
   - Transacción de prueba (`BEGIN ... ROLLBACK`) con `SET LOCAL ROLE authenticated` para simular aislamiento estricto entre Usuario A y Usuario B.
3. **`sql/README.md` (40 líneas):**
   - Orden de ejecución no destructivo e instrucciones de respaldo previo.
4. **`public/js/personal-data.js` (815 líneas):**
   - Motor unificado `VelvetPersonalData` para favoritos, historial, continuar leyendo y preferencias.
   - Paginación de 24 en 24, gestión de concurrencia con `AbortController`, respaldo de migraciones.
5. **`test/test_personal_data.mjs` (545 líneas):**
   - Suite completa de 7 pruebas unitarias y de integración que valida auth, aislamiento A/B, concurrencia, paginación de 160 registros y límites de payload.
6. **`DISENO_BOVEDA.md`:** Documento de diseño arquitectónico y de interfaz.
7. **`CHECKLIST_BOVEDA.md`:** Guía de verificación manual de la Bóveda en PC y Android.
8. **`CHECKLIST_DATOS.md`:** Guía de prueba de sincronización multi-dispositivo.
9. **`DIAGNOSTICO_DATOS.md`:** Análisis de causas raíz y comprobación de las 7 hipótesis.

### 4.2 Archivos Compartidos Modificados (Líneas Exactas)
1. **`functions/api/[[path]].js`:**
   - Líneas 68–74: Definición de variables de módulo `_activeSupabaseUrl`, `_activeSupabaseKey` y constante global `PERSONAL_PAGE_SIZE = 24`.
   - Líneas 302–326: Implementación de `checkPersonalWriteRateLimit(userId, maxPerMin)` con mapa en memoria isolate y poda LRU.
   - Líneas 328–385: Actualización de `resolveAuthUser(request, sbUrl, sbKey)` para resolver `token`, `newToken` y `user` usando `activeUrl` y `activeKey`, eliminando el `ReferenceError`.
   - Líneas 440–445: Inyección de `_activeSupabaseUrl` y `_activeSupabaseKey` al inicio del ciclo de vida de `onRequest`.
   - Líneas 2010–2215: Implementación de rutas `/api/user/favorites` y `/api/favorites` con paginación determinista (24 por página, headers `Range`, `Prefer: count=exact`, cálculo de `total` y `totalPages` independiente de items bloqueados, inserción idempotente con `resolution=ignore-duplicates`, y borrado atómico).
   - Líneas 2216–2475: Implementación de rutas `/api/user/history` y `/api/history` con soporte de RPC `upsert_history`, fallback a `user_history`, borrado individual y acción `clear=all`.
   - Líneas 2476–2595: Implementación de `/api/user/preferences` con validación de payload máximo de 16KB (`413 Payload Too Large`) y lectura con fallback seguro.
   - Líneas 2596–2635: Implementación de `/api/user/sync-status` con conteos atómicos de favoritos e historial.
2. **`public/js/store.js`:**
   - Líneas 80–92: Adaptador en `getPreferences()` delegando en `VelvetPersonalData.getPreferences()`.
   - Líneas 98–110: Adaptador en `setPreferences()` delegando en `VelvetPersonalData.setPreferences()`.
   - Líneas 210–225: Adaptador en `setCurrentUser()` para notificar cambio de identidad a `VelvetPersonalData.handleUserChanged(user)`.
   - Líneas 360–378: Adaptador en `getFavorites()` y `getFavoritesCount()` sincronizado con `VelvetPersonalData`.
   - Líneas 420–445: Adaptador en `addFavorite()` y `removeFavorite()` delegando en `VelvetPersonalData`.
   - Líneas 485–510: Adaptador en `recordProgress()` y `getHistory()` delegando en `VelvetPersonalData`.
3. **`public/js/vault.js`:**
   - Líneas 145–185: Ocultamiento defensivo explícito de `#main-content`, `#filter-bar` e `#infinite-scroll-container` en `mount()`.
   - Líneas 190–240: Invocación de `renderFallbackPagination(container, page, totalPages, onPageChange)` delegando a `window.VelvetPagination.render` si existe.
   - Líneas 245–320: Implementación de los 5 estados visuales en `renderFavorites()` (Visitante, Skeletons de carga, Populado, Vacío real con botones a cómics/videos, Error de red con reintento).
   - Líneas 330–395: Modo Selección con barra flotante inferior fija (`safe-area-inset-bottom`) y toast de deshacer por 5 segundos.
   - Líneas 400–470: Renderizado de historial con paginación real de 24 registros y agrupación inteligente.
4. **`public/index.html`:**
   - Línea 48: Carga del script `<script defer src="/js/personal-data.js"></script>` antes de `store.js`.
   - Líneas 1690–1705: Adición del contenedor `#vault-pagination-root` para favoritos e indicador dinámico `#vault-sync-status-text`.
   - Líneas 1735–1745: Adición del contenedor `#vault-history-pagination-root` para historial.
5. **`public/sw.js`:**
   - Líneas 66–75: Se conservó intacta la versión `CACHE_VERSION = 'v11-velvet-turbo'` y se añadieron exclusiones de caché para `/api/user/*`, `/api/favorites*`, `/api/history*`, `/api/preferences*` y `/api/sync*`.
6. **`package.json`:**
   - Líneas 11 y 12: Inclusión de `node test/test_personal_data.mjs` en los scripts `test` y `check`.

---

## 5. Conflictos de Merge Previsibles con Otras Ramas

Dado que otras dos IAs trabajan simultáneamente en `feat/rediseno-ui` y `feat/rediseno-paginacion`, se identifican los siguientes puntos de convergencia para una integración limpia:

| Archivo | Conflicto Previsible | Líneas Afectadas | Estrategia de Resolución al Juntar |
| :--- | :--- | :--- | :--- |
| **`public/index.html`** | `feat/rediseno-ui` rediseñó la grilla del Home y la fila "Continuar Leyendo", mientras que nosotros añadimos `<script src="/js/personal-data.js">` y los contenedores `#vault-pagination-root`. | `<head>` (Línea ~48) y contenedor `#view-vault` (Líneas ~1690–1745). | **Conservar ambos:** Mantener el nuevo diseño de Home de `feat/rediseno-ui` y asegurar que la etiqueta `<script defer src="/js/personal-data.js">` y los contenedores `#vault-pagination-root` permanezcan presentes. |
| **`public/sw.js`** | `feat/rediseno-paginacion` incrementó la versión a `v12-velvet-turbo` y añadió `pagination.js`/`pagination.css` en `STATIC_ASSETS`, mientras que nosotros añadimos las exclusiones de API personal. | Cabecera (`CACHE_VERSION`) y evento `fetch` (Líneas 65–75). | **Aceptar el bump de versión a `v12`** del Service Worker y mantener la lista extendida de exclusiones personales (`/api/user/*`, `/api/favorites*`, `/api/history*`, etc.). |
| **`public/js/vault.js`** | `feat/rediseno-paginacion` puede haber modificado cómo se instancia la paginación global. | Líneas 190–240 en `renderFavorites()`. | Nuestro código ya utiliza el contrato oficial `if (window.VelvetPagination?.render)` con fallback transparente, por lo que se integrará de forma natural sin conflicto. |
| **`public/js/store.js`** | Cualquier modificación menor en firmas. | Bloques de adaptadores delegados. | Las firmas públicas de `VelvetStore` se preservaron 100% idénticas, por lo que no romperán ningún consumidor externo. |

---

## 6. Resultados de la Suite Automatizada (`npm test`)

Todas las 7 suites del proyecto fueron ejecutadas y pasaron al 100%:
1. `test/test_pagination.mjs`: Monotonicidad de offsets, filtros en base de datos, exclusión en Service Worker y AbortController (5/5).
2. `test/test_security.mjs`: Auditoría de secretos, Web Crypto HMAC-SHA256, Anti-SSRF, sanitización PostgREST y cabeceras CORS (6/6).
3. `test/test_database.mjs`: Estructura de scripts SQL, auditoría de integridad solo lectura, índices concurrentes y migración LQIP (5/5).
4. `test/test_performance.mjs`: Optimización responsive, viewports 100dvh, safe-area-insets, hardware acceleration y carga inteligente con Save-Data (17/17).
5. `test/test_quality_suite.mjs`: Navegación por teclado en Reader y Player, atributos de accesibilidad ARIA y ordenación estable determinista (21/21).
6. `test/test_integration_pages.mjs`: Catálogo paginado por tipo de medio (cómics, videos, galerías) con PostgREST mock y verificación de tokens de medios (100% éxito).
7. `test/test_personal_data.mjs` **(NUEVA)**: Autenticación estricta, rechazo anónimo (401), bloqueo de spoofing de user_id, favoritos idempotentes, aislamiento A/B, concurrencia de timestamps en historial, paginación real de 160 registros (24 por página sin pedir los 160), preferencias con límite de 16KB (413), cabeceras privadas de caché y aislamiento DOM de vistas (7/7).

**Total de Pruebas: 68/68 pruebas pasadas exitosamente (100% PASS).**
