# DISENO_BOVEDA.md — Rediseño Arquitectónico y Enrutamiento de la Bóveda Velvet Hub

**Fecha:** 15 de Noviembre de 2026  
**Rama:** `feat/datos-personales`  
**Autor:** Senior Full-Stack & Database Engineer  

---

## 1. Causa Raíz de los Problemas Detectados

### 1.1 Filtración de la Paginación del Catálogo ("Página 1 de 1562") sobre la Bóveda
* **Causa Raíz:** En `public/index.html`, el elemento `<main id="main-content">` y el contenedor `#infinite-scroll-container` (que contiene la paginación del catálogo global) carecían de la clase CSS de vista `.velvet-view`. Cuando el enrutador (`router.js`) montaba la ruta `/boveda/*`, `vault.js` ejecutaba:
  ```javascript
  document.querySelectorAll('.velvet-view').forEach(el => el.classList.add('hidden'));
  ```
  Al no tener `.velvet-view`, `#main-content`, `#filter-bar` y `#infinite-scroll-container` permanecían visibles en el DOM, provocando que la barra de paginación global del catálogo se renderizara superpuesta en la parte superior de `/boveda/favoritos`.
* **Solución Implementada:**
  1. En `vault.js` (`mount()`), se ocultan explícitamente y de forma defensiva:
     - `document.getElementById('main-content')?.classList.add('hidden')`
     - `document.getElementById('filter-bar')?.classList.add('hidden')`
     - `document.getElementById('infinite-scroll-container')?.classList.add('hidden')`
  2. En `router.js`, al desmontar rutas de catálogo para pasar a la Bóveda, se asegura el aislamiento estricto de vistas.

### 1.2 Discrepancia de Contadores (Menú mostraba 29, Bóveda mostraba 0)
* **Causa Raíz:** 
  - El menú de usuario en `index.html` leía directamente de la clave legacy en `localStorage` (`velvet_acc_${uid}_favs`) calculando `length = 29`.
  - La Bóveda (`vault.js`) consultaba una clave distinta (`velvet_favorites`), que estaba vacía (`0`).
  - No existía ninguna llamada de red al backend para sincronizar ni consultar la base de datos PostgreSQL como única fuente de verdad.
* **Solución Implementada:**
  - Se unificó toda la gestión de datos en el motor `VelvetPersonalData` (`public/js/personal-data.js`).
  - Tanto el contador del avatar/menú, la barra lateral de la Bóveda y las pestañas móviles consumen la misma fuente reactiva (`VelvetPersonalData.getFavoritesCount()` y evento `velvet:favorites-updated`).
  - Al iniciar sesión, se migran automáticamente los ítems locales pendientes hacia PostgreSQL vía `/api/user/favorites` con respaldo de seguridad de 30 días (`velvet_backup_pre_migration_*`).

---

## 2. Distribución y Contenedores de la Bóveda

La vista `#view-vault` se divide en una estructura limpia, responsiva y semántica:

```
#view-vault (Contenedor Raíz)
├── Barra Superior de Información y Sincronización
│   ├── Título "Mi Bóveda Personal"
│   ├── Indicador de Sincronización (#vault-sync-status-text): "Sincronizado con Supabase hace X min"
│   └── Botón Modo Selección (#vault-select-toggle-btn)
│
├── Layout Principal (Flex / Grid Responsive)
│   ├── Barra Lateral de Navegación (Escritorio)
│   │   ├── Tab Favoritos (#vault-sidebar-tab-favorites + contador reactivo)
│   │   ├── Tab Historial (#vault-sidebar-tab-history + contador reactivo)
│   │   └── Tab Cuenta (#vault-sidebar-tab-account)
│   │
│   ├── Barra de Pestañas Fijas Inferiores (Móvil Android / iOS)
│   │   └── Safe-Area Inset Bottom (≥44px touch targets)
│   │
│   └── Área de Contenido Dinámico
│       ├── Panel Favoritos (#vault-panel-favorites)
│       │   ├── Filtros (Todo / Cómics / Videos / Galerías)
│       │   ├── Buscador en Bóveda
│       │   ├── Selector de Ordenación (Más recientes, A-Z)
│       │   ├── Contenedor de Listado (#vault-favorites-list)
│       │   └── Contenedor de Paginación (#vault-pagination-root)
│       │
│       ├── Panel Historial (#vault-panel-history)
│       │   ├── Barra de Filtros y Búsqueda
│       │   ├── Botón "Vaciar Historial" con modal de confirmación
│       │   ├── Contenedor de Historial (#vault-history-list)
│       │   └── Contenedor de Paginación (#vault-history-pagination-root)
│       │
│       └── Panel Detalles de Cuenta (#vault-panel-account)
│           ├── Tarjeta de Perfil (Usuario, VIP Badge, Llave canjeada)
│           ├── Preferencias de Reproducción y Lectura (Calidad, Ambilight, Ahorro de Datos)
│           └── Botón Cerrar Sesión
│
└── Barra de Acciones Flotante (Modo Selección)
    └── Fija en parte inferior, respetando safe-area-inset-bottom
```

---

## 3. Estados Visuales Diferenciados

Para erradicar el parpadeo de "Tu Bóveda está vacía" mientras se cargan los datos, se establecieron 5 estados visuales puros y mutuamente excluyentes:

| Estado | Elemento Visual | Comportamiento |
| :--- | :--- | :--- |
| **1. Visitante (No Autenticado)** | Tarjeta de bienvenida con candado neón y botón `Iniciar Sesión / Registrarse` | Se muestra inmediatamente sin intentar peticiones de red personales (evita 401s). |
| **2. Cargando (Loading)** | Grilla de 8 tarjetas Skeletons animados (`animate-pulse`) del mismo tamaño exacto de las tarjetas reales | Los skeletons mantienen la geometría exacta del layout para prevenir Cumulative Layout Shift (CLS = 0). Oculta el estado vacío. |
| **3. Con Datos (Populated)** | Grilla responsive (2 cols móvil, 3 tablet, 4 desktop) con tarjetas completas | Muestra miniaturas cargadas mediante token firmado anti-bloqueo, progreso neón, etiquetas de tipo y opciones de selección. |
| **4. Vacío Real (Empty)** | Ilustración sobria con corazón roto + botón "Explorar Videos" y botón "Ver Cómics" | Solo se muestra tras una respuesta HTTP 200 confirmada con `total === 0`. |
| **5. Error de Red (Error)** | Banner de alerta con mensaje descriptivo y botón con icono `Reintentar` | Se muestra si la llamada a `/api/user/favorites` o `/api/user/history` falla por red o servidor. Permite reintento inmediato sin recargar la página. |

---

## 4. Modo "Seleccionar" y Barra de Acciones Fija

* **Activación:** Botón `#vault-select-toggle-btn` alterna entre navegación normal y selección múltiple.
* **Barra Flotante:**
  - Aparece en la parte inferior de la pantalla con efecto `backdrop-blur-md` y borde neón violeta.
  - Diseñada con `padding-bottom: max(16px, env(safe-area-inset-bottom))` para no solaparse con la barra de gestos de Android o iOS.
  - Indicador numérico: `"X seleccionados"`.
  - Botón `"Quitar de Favoritos"`: Desencadena borrado en lote optimista en la UI y sincronización con el backend.
  - **Toast de Deshacer (5 segundos):** Al eliminar, aparece un toast flotante con cuenta regresiva. Si el usuario toca "Deshacer", se restauran los ítems inmediatamente tanto en la interfaz como en el backend.

---

## 5. Integración de Paginación (`window.VelvetPagination`)

Siguiendo estrictamente las directrices de coordinación:
1. **Contenedor Dedicado:** Se preparó `#vault-pagination-root` (para favoritos) y `#vault-history-pagination-root` (para historial).
2. **Delegación Dinámica:**
   ```javascript
   if (window.VelvetPagination && typeof window.VelvetPagination.render === 'function') {
     window.VelvetPagination.render(paginationContainer, {
       currentPage: page,
       totalPages: totalPages,
       onPageChange: (newPage) => {
         VelvetPersonalData.loadFavoritesPage(newPage);
       }
     });
   } else {
     renderFallbackPagination(paginationContainer, page, totalPages, (newPage) => {
       VelvetPersonalData.loadFavoritesPage(newPage);
     });
   }
   ```
3. **Fallback Temporal Mínimo:** Botones "Anterior" y "Siguiente" con indicador "Página X de Y", accesibles por teclado y con objetivos táctiles de 44x44 px.

---

## 6. Pestaña "Detalles de Cuenta"

Una tarjeta ordenada y limpia sin saturación:
* **Identidad:** Avatar generado con iniciales, nombre de usuario y badge de "Miembro VIP".
* **Llave Canjeada:** Indicador de suscripción activa con fecha de vigencia o estado permanente.
* **Preferencias:**
  - Calidad de Video por defecto (1080p / 720p / 480p / Auto).
  - Efecto Ambilight (activado / desactivado).
  - Ahorro de Datos en Conexiones Móviles.
  - Pausar Historial de Navegación (para mayor privacidad).
* Todas las preferencias se guardan de forma atómica en la tabla `public.user_preferences` mediante `PUT /api/user/preferences`.
