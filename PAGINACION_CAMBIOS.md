# Rediseño Completo de la Paginación del Catálogo Velvet Pro

**Rama de trabajo:** `feat/rediseno-paginacion`  
**Ubicación:** `VERSION_CLOUDFLARE/`  
**Fecha:** 15 de Noviembre de 2026  

---

## 1. Resumen Ejecutivo de la Intervención

Se rediseñó integralmente el sistema de paginación del catálogo para transformar los enlaces de texto fragmentados y asimétricos (`‹ Ant 1 2 3 … 1562 Sig ›` con caja separada `Página 1 de 1562 | Ir a: [1] [Ir]`) en un **componente unificado, profesional y responsivo de alta gama**:
- **En Escritorio (≥ 768px):** Un componente central único tipo píldora flotante con fondo translúcido (`rgba(13, 6, 30, 0.88)`), desenfoque de fondo (`backdrop-filter: blur(16px)`), borde violeta sutil, botones circulares de 40px con degradado institucional rosa-violeta (`linear-gradient(135deg, #ec4899 0%, #8b5cf6 100%)`) y campo de salto directo numérico integrado con validación reactiva en tiempo real.
- **En Android / Móvil (< 768px):** Barra compacta de una sola fila con botones de anterior/siguiente táctiles (≥ 44px, exactamente 46px), botón central *"Página X de Y"* que despliega una **Hoja Inferior (Bottom Sheet)** animada con atajos rápidos (`Primera`, `-10`, `+10`, `Última`) y respeto estricto de `safe-area-inset-bottom`.
- **Arquitectura Modular CSP / Anti-Colisiones:** Para proteger el trabajo concurrente de la otra IA en `public/index.html`, **todo el código nuevo reside en módulos dedicados e independientes**:
  - `public/css/pagination.css` (estilos encapsulados con prefijo `.v-page-` y variables institucionales).
  - `public/js/pagination.js` (lógica matemática, ventana inteligente, URL sync, eventos declarativos por `data-action` y prefetch predictivo).
  - Solo se realizaron **5 intervenciones quirúrgicas mínimas indispensables** en `public/index.html`.

---

## 2. ¿Qué se Quitó?

1. **Componente Antiguo Dividido en Dos Contenedores Desacoplados:**
   - Se removió la estructura partida conformada por `#pagination-numbers-row` (enlaces de texto simples) y la caja separada de salto rápido (`#pagination-current-label`, `#pagination-total-label`, `#direct-page-input-quick`).
2. **Atributos Inline Prohibidos (`onclick` y `onkeydown`):**
   - Se erradicaron handlers inline como `onclick="executeQuickJump()"` y `onkeydown="if(event.key==='Enter') executeQuickJump()"`, sustituyéndolos por **delegación de eventos declarativa** con atributos `data-action` (`data-action="page-prev"`, `data-action="page-next"`, `data-action="page-number"`, `data-action="focus-jump"`, `data-action="confirm-jump"`, `data-action="open-sheet"`, `data-action="quick-shortcut"`), blindando la aplicación contra inyecciones y cumpliendo con CSP estricto.
3. **Texto Plano y Botones Asimétricos:**
   - Se eliminaron los textos redundantes `"Ant"` y `"Sig"`, sustituidos por íconos SVG vectoriales de alta precisión (`fa-chevron-left`, `fa-chevron-right`) dentro de objetivos táctiles perfectamente centrados.
4. **Lógica Monolítica en `index.html`:**
   - Se retiraron más de 100 líneas de código procedural disperso en `index.html` (`createPageNumBtn`, bucles de cálculo de elipsis sin debounce, listeners no normalizados), delegando la responsabilidad a `window.VelvetPagination`.

---

## 3. ¿Qué se Diseñó e Implementó?

### A. Componente Desktop (≥ 768px)
- **Cuerpo Tipo Píldora Centrada:** Contenedor estilizado con `border-radius: 9999px`, fondo oscuro profundo semitransparente, sombras volumétricas violeta/rosa y desenfoque por hardware.
- **Botones Numéricos Circulares (40px × 40px):**
  - **Página Activa:** Degradado Velvet Rosa-Violeta, texto blanco brillante, anillo y resplandor sutil (`box-shadow: 0 0 16px rgba(236, 72, 153, 0.45)`).
  - **Páginas Inactivas:** Fondo translúcido `rgba(255, 255, 255, 0.05)`, estados `:hover` y `:focus-visible` claramente delineados.
  - **Botones Anterior / Siguiente:** Deshabilitados semánticamente (`disabled`, `opacity: 0.35`, `pointer-events: none`) en la primera y última página.
- **Ventana de Páginas Inteligente:**
  - Si `total_pages <= 7`: Muestra la secuencia completa `[1, 2, 3, 4, 5, 6, 7]`.
  - Si `total_pages > 7`: Siempre incluye la primera (1) y la última (`total_pages`), con 2 páginas a cada lado de la página activa y puntos suspensivos (`…`).
  - *Ejemplo exacto del requerimiento:* Página actual 7 de 1562 genera `[1, '...', 5, 6, 7, 8, 9, '...', 1562]`.
  - **Puntos Suspensivos Interactivos:** Los botones de `…` son clicables (`data-action="focus-jump"`) y enfocan directamente el campo numérico "Ir a".
- **Campo "Ir a Página" Integrado:**
  - Input numérico con botón de confirmación integrado, prefijo `"Ir a:"` y sufijo `"de 1,562"`.
  - Validación matemática estricta: solo enteros entre 1 y `total_pages`.
  - En caso de valor inválido (vacío, texto, 0, negativo, decimal o > total): borde carmesí suave, animación shake (`@keyframes v-shake`) y tooltip breve con mensaje claro (`"Escribe un número entre 1 y 1562"`).
  - Tecla `Enter` confirma la acción; si el usuario ingresa la página actual, la petición se cancela sin recargar.

### B. Versión Compacta en Android / Pantallas Móviles (< 768px)
- **Barra Compacta de Una Sola Fila:** 
  - Botón anterior grande (46px ≥ 44px).
  - Botón central de activación con texto `"Página 7 de 1562"` con ícono sutil de apertura.
  - Botón siguiente grande (46px ≥ 44px).
  - Sin desbordamiento horizontal ni texto recortado (`text-overflow: ellipsis`, `max-width: 100%`).
- **Hoja Inferior (Bottom Sheet Modal):**
  - Se despliega al pulsar el botón central con animación suave desde el fondo de pantalla.
  - Fondo backdrop oscurecido con desenfoque (`backdrop-filter: blur(8px)`).
  - Manija superior redondeada para arrastre visual y botón de cierre accesible (`fa-xmark`).
  - Campo numérico grande con botón de confirmación directo y validación de errores.
  - **Atajos Rápidos de Un Solo Toque:** Cuadrícula con botones táctiles para `"Primera (1)"`, `"-10 pág"`, `"+10 pág"` y `"Última (1562)"`.
  - Cierre automático al tocar fuera del contenedor, presionar `Escape`, pulsar el botón de cerrar o al confirmar el salto.
  - Respeto estricto del notch inferior mediante `padding-bottom: max(1.25rem, env(safe-area-inset-bottom, 1.25rem))`.

### C. Comportamiento y Concurrencia
- **Control de AbortController:** Cada cambio de página invoca `_catalogAbortController.abort()`, cancelando inmediatamente peticiones de red previas antes de disparar la nueva.
- **Prevención de Doble Clic:** Bloqueo reactivo con flags `isPaginating` y `_isLoadingFeed`, deshabilitando temporalmente los botones y aplicando clase `.is-loading` en la barra.
- **Scroll Suave Contextual:** Al paginar, la vista se desplaza con animación suave hacia `#comics-grid` (con offset superior para respetar la barra de navegación fija), en lugar de reiniciar toda la página desde el hero.
- **Sincronización Bidireccional con URL (?page=X):** La URL refleja inmediatamente la página activa (`history.pushState`), permitiendo recarga, compartir enlaces y navegación nativa con los botones atrás/adelante del navegador (`popstate`). Si la URL contiene un número inválido o fuera de rango, se autocorrige matemáticamente al límite más cercano.
- **Respeto a Filtros Activos:** Cambiar de categoría, orden o búsqueda restablece `page = 1`; al paginar, se preservan intactos todos los filtros activos.
- **Prefetch Predictivo Inteligente:** Precarga en segundo plano la página siguiente (`page + 1`) usando `fetch(..., { priority: 'low' })` únicamente si la conexión es rápida (no `2g`/`slow-2g`) y el usuario no tiene activado el modo ahorro de datos (`navigator.connection.saveData` ni `.velvet-data-saver`).
- **Accesibilidad Completa (A11y):** Estructura semántica `<nav aria-label="Paginación">`, `aria-current="page"` en la activa, `aria-label` descriptivo en cada botón ("Página 7", "Ir a la página anterior"), foco visible con anillos de contraste y soporte para `prefers-reduced-motion`.

---

## 4. Archivos Creados y Modificados en el Repositorio

| Archivo | Tipo de Cambio | Líneas / Tamaño | Propósito |
| :--- | :---: | :---: | :--- |
| `public/css/pagination.css` | **Nuevo** | 674 líneas | Estilos visuales de la píldora, botones 40px, bottom sheet móvil, safe area, animaciones y reduced-motion. |
| `public/js/pagination.js` | **Nuevo** | 820 líneas | Motor de cálculo de ventana, validación, renderizado seguro por `data-action`, sincronización de URL y prefetch. |
| `test/test_pagination_redesign.mjs` | **Nuevo** | 308 líneas | Suite de 6 bloques de pruebas automáticas para ventana matemática, saltos, URL y accesibilidad. |
| `package.json` | Modificado | +2 líneas | Inclusión de `test_pagination_redesign.mjs` en scripts `test` y `check`. |
| `public/sw.js` | Modificado | +3 líneas | Bump de versión a `v12-velvet-turbo` e inclusión de `pagination.css` y `pagination.js` en `STATIC_ASSETS`. |
| `test/test_pagination.mjs` | Modificado | +4 líneas | Aserciones actualizadas para validar Service Worker v12 y los nuevos assets de paginación. |
| `public/js/router.js` | Modificado | +1 línea | Normalización del parámetro `page` en la ruta `/` (`home`). |
| `public/index.html` | Modificado | +21 / -100 líneas | Inserción mínima de enlaces, root de montaje y delegación de controladores (ver detalle abajo). |

---

## 5. Líneas Exactas Tocadas en `public/index.html`

Para garantizar un merge 100% limpio y sin conflictos con la otra IA que trabaja en `public/index.html`, **las modificaciones en este archivo se limitaron a 5 zonas quirúrgicas**:

```diff
===================================================================
ZONA 1: <head> - Carga de estilos y script modular
Líneas originales: 53-56
===================================================================
-    <!-- Modular Architecture: Store, Router & Vault -->
+    <!-- Modular Architecture: Store, Router, Vault & Pagination -->
+  <link rel="stylesheet" href="/css/pagination.css">
   <script defer src="/js/store.js"></script>
   <script defer src="/js/router.js"></script>
   <script defer src="/js/vault.js"></script>
+  <script defer src="/js/pagination.js"></script>

===================================================================
ZONA 2: <body> - Contenedor raíz de montaje de la paginación
Líneas originales: 1638-1659 (reemplazo del bloque viejo por contenedor único)
===================================================================
-      <!-- Barra de Paginación Clásica Velvet Pro -->
-      <nav id="velvet-pagination-container" aria-label="Navegación del Catálogo" class="w-full max-w-2xl mx-auto flex flex-col items-center justify-center gap-3 py-6 my-4 select-none">
-        <!-- Fila de Botones Numerados (1, 2, 3...) -->
-        <div id="pagination-numbers-row" class="flex flex-wrap items-center justify-center gap-1.5 sm:gap-2 w-full px-2"></div>
-
-        <!-- Fila de Salto Rápido y Total de Páginas -->
-        <div class="flex flex-wrap items-center justify-center gap-3 text-xs text-lav/80 bg-[#0d061e]/90 border border-purple-500/25 px-4 py-2 rounded-2xl backdrop-blur-md shadow-lg">
-          <span>
-            Página <strong id="pagination-current-label" class="text-pink-400 font-extrabold text-sm">1</strong> de <span id="pagination-total-label" class="text-purple-300 font-mono font-bold">1,562</span>
-          </span>
-          <span class="text-purple-500/40">|</span>
-          <div class="flex items-center gap-1.5">
-            <span class="text-[11px] text-lav/60">Ir a:</span>
-            <input id="direct-page-input-quick" type="number" min="1" class="w-16 h-8 text-center text-xs font-black text-white bg-black/80 border border-purple-500/30 rounded-xl focus:outline-none focus:border-pink-500" placeholder="1" onkeydown="if(event.key==='Enter') executeQuickJump()" />
-            <button type="button" onclick="executeQuickJump()" class="px-3 h-8 rounded-xl bg-gradient-to-r from-pink-500 to-purple-600 hover:opacity-90 text-white text-xs font-black shadow-md cursor-pointer transition-all">
-              Ir
-            </button>
-          </div>
-        </div>
-      </nav>
+      <!-- Barra de Paginación Rediseñada Velvet Pro -->
+      <div id="velvet-pagination-root" class="w-full select-none"></div>

===================================================================
ZONA 3: Sincronización inicial y arranque en bootstrap
Líneas: 4342-4346 y 4404
===================================================================
       setPortalMode(state.mode);
+      const initialPageInfo = window.VelvetPagination?.parseUrlPage(window.location.search);
+      if (initialPageInfo && initialPageInfo.page > 1) {
+        state.page = initialPageInfo.page;
+      }
       renderContinueShelf();
...
       window.VelvetRouter?.init();
+      window.VelvetPagination?.init();

===================================================================
ZONA 4: renderFeedData - Ocultar en vacío y pasar totalItems
Líneas: 5287-5291 y 5381
===================================================================
         if (!append) {
           grid.classList.add('hidden');
           empty.classList.remove('hidden');
+          window.VelvetPagination?.render(1, 0, 0);
           resCount.textContent = '0 resultados';
...
       const totalPages = parseInt(data.total_pages, 10) || state.totalPages || 1;
       const currentPage = parseInt(data.page, 10) || state.page || 1;
-      renderPaginationControls(currentPage, totalPages);
+      renderPaginationControls(currentPage, totalPages, totalItemsCount);

===================================================================
ZONA 5: Delegación limpia de controladores obsoletos
Líneas originales: 12065-12199
===================================================================
-    function renderPaginationControls(currentPage, totalPages) { ... (135 líneas de código legado) ... }
+    function renderPaginationControls(currentPage, totalPages, totalItems) {
+      if (window.VelvetPagination && typeof window.VelvetPagination.render === 'function') {
+        window.VelvetPagination.render(currentPage, totalPages, totalItems);
+        return;
+      }
+    }
+
+    function jumpToPage(targetPage, opts = {}) {
+      if (window.VelvetPagination && typeof window.VelvetPagination.jumpToPage === 'function') {
+        return window.VelvetPagination.jumpToPage(targetPage, opts);
+      }
+      targetPage = parseInt(targetPage, 10) || 1;
+      if (state.totalPages && targetPage > state.totalPages) targetPage = state.totalPages;
+      if (targetPage === state.page) return;
+      state.page = targetPage;
+      fetchLiveFeed();
+    }
+
+    function executeQuickJump() {
+      const input = document.getElementById('direct-page-input-quick');
+      if (!input || !input.value) return;
+      jumpToPage(input.value);
+    }
+
+    function changePage(delta) {
+      jumpToPage(state.page + delta);
+    }
+
+    function jumpToLastPage() {
+      if (state.totalPages) jumpToPage(state.totalPages);
+    }
```
