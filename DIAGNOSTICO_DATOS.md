# Diagnóstico Integral de Datos Personales, Bóveda y Sincronización Multi-Dispositivo
**Proyecto:** Velvet Hub (Cloudflare Pages + Supabase)  
**Rama de trabajo:** `feat/datos-personales` (basada en `fix/auditoria-completa`)  
**Fecha:** 15 de Noviembre de 2026  
**Autor:** Senior Full-Stack & Database Architect  

---

## 1. Recorrido Completo del Flujo de Datos

A continuación se traza el ciclo de vida de los datos personales (Favoritos, Historial, Progreso y Preferencias):

```
[Acción de Usuario] (Click en Corazón / Pausa de Video / Cambio de Página)
        │
        ▼
[Frontend: index.html / store.js / vault.js]
  • Problema: Existen DOS motores de persistencia paralelos e incompatibles:
    - Motor A (`index.html`): Guarda en `localStorage` con prefijo dinámico `velvet_acc_${uid}_favs`, `...history`, `...progress`.
    - Motor B (`store.js`): Guarda en `localStorage` con claves estáticas sin usuario `velvet_favorites`, `velvet_history`, `velvet_progress`.
    - Motor C (`vault.js`): Solo lee del Motor B (`VelvetStore.getFavorites()`), ignorando por completo el Motor A y la red.
        │
        ▼
[Función de Guardado]
  • Favoritos: `store.js` (L465) envía `POST /api/user/favorites`.
  • Historial: `store.js` (L332) envía `POST /api/user/history`.
        │
        ▼
[API Backend: functions/api/[[path]].js]
  • Favoritos (L2006-2170): Guarda en `user.user_metadata.favorites` de Supabase Auth (máximo 300 ítems en un JSON dentro de auth.users). De forma secundaria intenta insertar en la tabla SQL `favorites`.
  • Historial (L2219-2308): Guarda **únicamente** en `user.user_metadata.history` y `user.user_metadata.progress` (máximo 50 ítems). **NO existe tabla SQL de historial**.
  • Preferencias: **NO existe endpoint** de preferencias en el backend; se quedan atrapadas en el navegador local (`velvet_preferences_v2`).
        │
        ▼
[Supabase: Base de Datos PostgreSQL]
  • `favorites`: Solo tiene `(user_id, item_id, created_at)`. La API no paginea en SQL y si el join con `items` devuelve null (por ejemplo si un ítem está marcado como bloqueado o borrado), se descarta silenciosamente.
  • `items`: `status <> 'blocked' and real_people = false`. `favorites` tiene `ON DELETE CASCADE` con `items(id)`.
  • Historial / Progreso / Preferencias: **Inexistentes en el esquema SQL**.
        │
        ▼
[Respuesta HTTP al Navegador]
  • Envía el array JSON completo de una sola vez (hasta 300 favoritos o 50 registros de historial). Sin paginación real de PostgreSQL (`range` / `Prefer: count=exact`).
        │
        ▼
[Estado de la Interfaz y Carga en Otro Dispositivo]
  • Dispositivo 1: Inicia sesión, `index.html` llama `loadCloudFavorites()` y pone 29 en `state.favorites` -> el dropdown de usuario muestra "29".
  • Pero al abrir `/boveda/favoritos`: `vault.js` lee `VelvetStore.getFavorites()` (`localStorage.getItem('velvet_favorites')`), que está vacío (`0`) -> Muestra "Tu Bóveda está vacía".
  • Dispositivo 2: Inicia sesión con la misma cuenta. Si no tenía datos en `localStorage`, la bóveda muestra 0. Si el usuario guardó algo como invitado en el Dispositivo 2, ese historial local queda aislado porque no se fusiona bidireccionalmente con la base de datos SQL.

---

## 2. Comprobación Rigurosa de las 7 Hipótesis

### Hipótesis 1: El historial se guarda por X-Device-Token (por dispositivo) y no por user_id.
* **Veredicto:** **PARCIALMENTE CIERTA / AGRAVADA**.
* **Evidencia de Código:**
  - `functions/api/[[path]].js` (L271): `X-Device-Token` está listado en `Access-Control-Allow-Headers`, pero el backend **no lo procesa ni almacena en base de datos**.
  - `public/js/store.js` (L23, L194, L222): Define `DEVICE_KEY = 'velvet_device_token'`, pero solo lo guarda en `localStorage`.
  - `public/index.html` (L4914-4915): Cuando no hay usuario autenticado, guarda en `velvet_guest_history` y `velvet_guest_progress`.
  - **Consecuencia:** Para usuarios anónimos, el historial solo vive en el navegador. Al autenticarse, no existe un mecanismo seguro de fusión (*merge*) que traslade los datos del dispositivo a la cuenta en PostgreSQL. Para usuarios con sesión, se guardaba en el blob `user_metadata` de Supabase Auth en vez de una tabla SQL de historial normalizada.

### Hipótesis 2: store.js/localStorage actúa como fuente de verdad y pisa o ignora al servidor.
* **Veredicto:** **CIERTA AL 100% (Causa principal de la discrepancia visual)**.
* **Evidencia de Código:**
  - `public/js/vault.js` (L157-164):
    ```javascript
    const favs = window.VelvetStore?.getFavorites() || [];
    const hist = window.VelvetStore?.getHistory() || [];
    favCountEls.forEach((el) => { el.textContent = String(favs.length); });
    histCountEls.forEach((el) => { el.textContent = String(hist.length); });
    ```
  - `public/js/vault.js` (L175, L198-202):
    ```javascript
    let favs = window.VelvetStore?.getFavorites() || [];
    if (favs.length === 0) {
      container.innerHTML = '';
      container.classList.add('hidden');
      if (emptyEl) emptyEl.classList.remove('hidden');
      return;
    }
    ```
  - `public/js/store.js` (L408):
    ```javascript
    const raw = localStorage.getItem(FAVORITES_KEY) || localStorage.getItem('velvet_guest_favs') || localStorage.getItem('velvet_favs');
    ```
  - `public/index.html` (L4908): Almacena bajo `velvet_acc_${user.id}_favs`.
  - **Consecuencia:** `vault.js` nunca consulta a la API al abrir `/boveda/favoritos` ni escucha a `state.favorites` de `index.html`. Confía a ciegas en `VelvetStore.getFavorites()`, el cual lee una clave no prefijada (`velvet_favorites`). Como esa clave está vacía, la pantalla muestra "Tu Bóveda está vacía" y contador 0, a pesar de que el servidor y el navbar reportan 29 favoritos.

### Hipótesis 3: El Service Worker (sw.js), Cloudflare o la caché de isolate cachean /api/favorites, /api/user/* o respuestas con la sesión de otro usuario.
* **Veredicto:** **PARCIALMENTE CIERTA / RIESGO LATENTE**.
* **Evidencia de Código:**
  - `public/sw.js` (L68-76): Excluye explícitamente `url.pathname.startsWith('/api/user')` y `url.pathname.startsWith('/api/favorites')` de la caché del Service Worker.
  - Sin embargo, endpoints complementarios como `/api/user/sync-status`, `/api/preferences` o consultas de sincronización por lote no estaban específicamente blindados.
  - En Cloudflare Pages, si la cabecera `Cache-Control: private, no-store, no-cache, must-revalidate` no se envía de forma uniforme en todas las rutas y respuestas de error (por ejemplo 401 o 500), proxies intermedios o navegadores móviles pueden reutilizar respuestas entre sesiones.

### Hipótesis 4: La sesión aún no está lista cuando se piden los datos (condición de carrera) o se usa un user_id distinto al del JWT.
* **Veredicto:** **CIERTA**.
* **Evidencia de Código:**
  - `public/js/vault.js` (L83-88, L101-124): Al cargar la página en `/boveda/favoritos`, el router dispara de inmediato el evento `velvet:route-render`. `VelvetVault.mount()` se ejecuta de forma síncrona en el ciclo inicial de renderizado.
  - `public/index.html` (L10375-10400): La verificación de sesión (`checkAuth()`) y la descarga de favoritos de la nube (`loadCloudFavorites()`) son llamadas asíncronas con promesas de red.
  - **Consecuencia:** Cuando `vault.js` se monta, la sesión aún no ha terminado de validarse y la petición de red no ha vuelto. Como `vault.js` no cuenta con estado de carga (*skeleton*) ni espera a la sesión, pinta de inmediato el estado vacío ("Tu Bóveda está vacía") antes de que los datos existan en memoria.

### Hipótesis 5: Existe o no existe una tabla de historial/progreso en el esquema real (0001_init.sql).
* **Veredicto:** **CIERTA: NO EXISTE LA TABLA**.
* **Evidencia de Código:**
  - `supabase/migrations/0001_init.sql` (L1-321): Define `profiles`, `items`, `source_aliases`, `favorites`, `invite_keys`.
  - `sql/01_rls_policies.sql` (L1-303): Solo audita y aplica políticas a las mismas 5 tablas.
  - `functions/api/[[path]].js` (L2230-2294): Todo el historial y progreso se serializa en el campo JSON `user_metadata` de Supabase Auth (`updateSupabaseUserMetadata`).
  - **Consecuencia:** Supabase Auth no es una base de datos para historial de reproducciones. Provoca límites de tamaño de token, falta de paginación SQL, imposibilidad de indexación por fecha/usuario, y pérdida de datos ante actualizaciones concurrentes entre pestañas o dispositivos. **Es mandatorio crear la tabla `user_history` y `user_preferences` en PostgreSQL con RLS estricto**.

### Hipótesis 6: El join con items oculta ítems bloqueados o cuyo id cambió, y el total no coincide con lo mostrado.
* **Veredicto:** **CIERTA**.
* **Evidencia de Código:**
  - `functions/api/[[path]].js` (L2030-2040):
    ```javascript
    fetch(`${SUPABASE_URL}/rest/v1/favorites?user_id=eq.${user.id}&select=item_id,created_at,items(id,title,cover_url,media_type,source,source_id,url)&order=created_at.desc&limit=300`)
    ...
    (sqlData || []).forEach((r) => {
      if (!r || !r.items) return; // Descarta ítems donde items es null
    ```
  - `supabase/migrations/0001_init.sql` (L213):
    `item_id bigint not null references public.items(id) on delete cascade`
  - Si un ítem en `items` cambia de estado a `blocked` o `real_people = true`, la política RLS `items_public_select` hace que la relación `items` devuelva `null`. El bucle en el backend omite el registro (`if (!r.items) return`). El conteo en `favorites` sigue teniendo la fila, pero la lista resultante no la devuelve, descuadrando el total de páginas y registros.

### Hipótesis 7: Políticas RLS y GRANT del rol authenticated tras los cambios de seguridad.
* **Veredicto:** **COMPROBADA Y REQUIERE EXPANSION**.
* **Evidencia de Código:**
  - `sql/01_rls_policies.sql` (L128-151):
    `public.favorites` cuenta con RLS habilitada para `user_id = auth.uid()`, y tiene `grant select, insert, delete on public.favorites to authenticated;`.
    Sin embargo, al no existir tablas para historial ni preferencias, el rol `authenticated` no tiene permisos para esas operaciones relacionales en SQL.
    Para `items`, el rol `authenticated` tiene `grant select on public.items to authenticated;` pero está filtrado por `items_public_select` (`status <> 'blocked' and real_people = false`).

---

## 3. Desglose de la Discrepancia Observada en Pantalla

| Elemento UI | Valor Observado | Origen del Dato | Causa de la Inconsistencia |
| :--- | :---: | :--- | :--- |
| **Menú de Usuario** (Dropdown) | **29** | `state.favorites.length` (`index.html` L10485) | `loadCloudFavorites()` cargó los 29 ítems desde `user_metadata.favorites` de la API. |
| **Contador Lateral Bóveda** (`.vault-fav-counter`) | **0** | `VelvetStore.getFavorites().length` (`vault.js` L157) | Lee `localStorage.getItem('velvet_favorites')`, que nunca fue sincronizado con `state.favorites` ni con la cuenta actual. |
| **Lista de Bóveda** (`/boveda/favoritos`) | **0 (Vacía)** | `VelvetStore.getFavorites()` (`vault.js` L175) | Al encontrar el array local vacío, inyecta el HTML de "Tu Bóveda está vacía" sin realizar petición de red. |
| **Contador "Mi Historial"** (`.vault-hist-counter`) | **0** | `VelvetStore.getHistory().length` (`vault.js` L158) | Lee `localStorage.getItem('velvet_history')` (vacío en ese almacén estático). |
| **Fila "Continuar Leyendo"** (Home) | **5 cómics** | `state.history` (`index.html` L8643) | Almacenado en `velvet_acc_${uid}_history` mediante el motor legacy de `index.html`. |
| **Paginación Fantasma** | **Página 1 de 1,562** | `#infinite-scroll-container` (`index.html` L1634) | El contenedor de paginación del catálogo general no se ocultaba al navegar a la Bóveda, apareciendo montado encima de la vista de la Bóveda. |

---

## 4. Inventario de Datos Personales

| Característica | Tabla PostgreSQL | Identificación Usuario | Guardado | Lectura | Sincronización | Paginación | Caché | Problema Actual |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Favoritos** | `public.favorites` | `user_id = auth.uid()` | `POST /api/user/favorites` + `user_metadata` | `GET /api/user/favorites` (limit 300) | Bidireccional desfasada (metadata vs SQL vs localStorage) | No existe (todo en memoria) | `localStorage` sin prefijo | Discrepancia entre menú (29) y lista (0). Descuadre en join con items. |
| **Historial** | **Inexistente** (se creará `user_history`) | `user_metadata` (se usará `auth.uid()`) | `POST /api/user/history` a `user_metadata` | `GET /api/user/history` | Solo últimos 50 en metadata | No existe | `localStorage` | Sin persistencia SQL real; no se sincroniza entre dispositivos de forma segura. |
| **Continuar Viendo / Leyendo** | **Inexistente** (se integrará en `user_history`) | `auth.uid()` | Se calcula en frontend sobre `state.history` | Memoria local | No existe a nivel SQL | No aplica (carrusel) | `localStorage` | Desconectado de `vault.js`; solo funciona en home. |
| **Progreso Video** | **Inexistente** (campo `position_seconds`, `duration_seconds`) | `auth.uid()` | Cabecera `X-Velvet-Progress` en `metadata` | Cabecera de respuesta | Sobrescritura sin control de versiones | No existe | Memoria local | Escrituras continuas; si se usa otro dispositivo se puede perder el progreso más nuevo. |
| **Progreso Lectura** | **Inexistente** (campo `page_number`, `total_pages`) | `auth.uid()` | `user_metadata.progress` | Cabecera de respuesta | Sobrescritura sin control de versiones | No existe | Memoria local | Carreras de guardado al avanzar de página rápidamente. |
| **Preferencias** | **Inexistente** (se creará `user_preferences`) | Nula (solo `localStorage`) | Solo en navegador del cliente | `VelvetStore.getPreferences()` | **Ninguna** | No aplica | `velvet_preferences_v2` | No viajan entre dispositivos (PC vs Android tienen configuraciones distintas). |

---

## 5. Plan de Acción y Solución Arquitectónica

1. **Fase 1 (Base de Datos):**
   - Crear script `sql/10_personal_data_schema.sql` con:
     - Tabla `public.user_history` con PK `(user_id, item_id)` o `(user_id, content_id)`, `position`, `total`, `completed`, `last_activity`, `client_timestamp`, e índices compuestos `(user_id, last_activity desc, id desc)`.
     - Función RPC `upsert_history` con `SECURITY INVOKER`, resolución atómica de conflictos condicionada a que `client_timestamp` entrante sea más reciente (`WHERE EXCLUDED.client_timestamp >= user_history.client_timestamp`).
     - Función de poda `prune_user_history(p_user_id, p_keep_limit)`.
     - Tabla `public.user_preferences` con `user_id PK`, `data jsonb` (con restricción `check (octet_length(data::text) < 16384)`), `version int`, `updated_at timestamptz`, y RLS estricta por `auth.uid()`.
     - Optimización de índices de `public.favorites`.
   - Crear script de verificación `sql/11_test_personal_data_isolation.sql` para validar aislamiento entre usuarios y bloqueo a rol anónimo.

2. **Fase 2 (Backend):**
   - Endpoints en `functions/api/[[path]].js`:
     - `/api/user/favorites` (GET con paginación real `range` + `Prefer: count=exact`, POST idempotente, DELETE por id).
     - `/api/user/history` (GET paginado, POST vía `upsert_history`, DELETE individual o vaciado completo).
     - `/api/user/preferences` (GET, PUT con validación de esquema).
     - `/api/user/sync-status` (resumen atómico de marcas de tiempo y contadores).
   - Constante `PERSONAL_PAGE_SIZE = 24`.
   - Consulta eficiente con un solo join/IN seleccionando solo columnas visuales de tarjetas.
   - Headers: `Cache-Control: private, no-store, no-cache, must-revalidate`.

3. **Fase 3 (Frontend):**
   - Nuevo módulo `public/js/personal-data.js` que sea la **única fuente de verdad** unificada.
   - `VelvetStore` y `vault.js` delegan en `VelvetPersonalData`.
   - Migración transparente y no destructiva de `localStorage` existente hacia Supabase con respaldo local por 30 días.
   - Paginación real integrada con fallback e invocación reactiva a `window.VelvetPagination`.
   - Modo "Seleccionar" con barra fija y toast de deshacer (5s).
   - Estados: Cargando (skeletons), Resultados, Vacío y Error con botón Reintentar. Estado especial para no autenticados.
   - Corrección en SPA router para asegurar que solo una vista esté visible (ocultando `#infinite-scroll-container` al entrar a la Bóveda).

4. **Fase 4 (Service Worker):**
   - Exclusión explícita de `/api/user/*`, `/api/favorites*`, `/api/preferences*` en `public/sw.js` manteniendo intacta la versión y el resto de optimizaciones de medios.

5. **Fase 5 (Pruebas Automatizadas):**
   - Suite de pruebas de aislamiento, concurrencia, paginación con 160 ítems y consistencia de vistas.
