# 🎨 Documentación de Rediseño de Interfaz de Usuario (UI) — Velvet Hub
**Rama:** `feat/rediseno-ui`  
**Fecha:** 15 de Noviembre de 2026  
**Entorno:** Cloudflare Pages + PWA + Android (360px - 412px) y PC  

---

## 1. Resumen Ejecutivo
Siguiendo las anotaciones de la captura de referencia (marcas rojas = **QUITAR**; círculos amarillos = **MEJORAR / REDISEÑAR**), se aplicó una reingeniería visual y de interacción sobre la vista principal de cómics de **Velvet Hub**. 

El nuevo diseño se enfoca en:
1. **Eliminar el ruido visual y textos decorativos** que saturaban la pantalla sin aportar navegación.
2. **Optimizar la ergonomía móvil para Android** (resoluciones de 360px a 412px de ancho) y mantener una visualización elegante y espaciosa en monitores de PC.
3. **Asegurar la consistencia estética:** paleta oscura premium (`#0a0610`, `#120726`), acentos en rosa neón (`#ff2d95`), bordes sutiles y transparencias con desenfoque de fondo (*glassmorphism*).
4. **Respetar estrictamente las directrices de arquitectura:** 100% delegación con `data-action`, cero JavaScript `onclick`/`onsubmit` inline, soporte estricto de CSP, `100dvh`, `safe-area-inset`, `AbortController` en el catálogo, y actualización del Service Worker a `v12`.

---

## 2. Elementos Eliminados (X Roja en Captura)

| Elemento | Identificador / Selector | Ubicación | Motivo de Eliminación |
| :--- | :--- | :--- | :--- |
| **Badge "24 Cómics Calientes Listos"** | `#results-count` | Barra de categorías superior | Texto estático y decorativo que no aportaba valor al usuario, generaba desbalance visual en la fila de categorías y ocupaba espacio crítico en pantallas móviles. |
| **Título "Últimas Novedades Calientes"** | `#grid-section-title` | Encabezado del grid principal | Título redundante y publicitario. Al eliminarse, las portadas del catálogo suben inmediatamente y quedan visibles en el primer pantallazo (*above the fold*) tanto en PC como en móviles. |
| **Badge "24 historias listas para leer"** | `#grid-status-badge` | Junto al título del grid | Contador decorativo innecesario que agregaba dispersión visual sin funcionalidad interactiva. |
| **Subtítulo "Reanuda donde lo dejaste con 1 toque"** | `#continue-shelf-subtitle` | Fila de Continuar Leyendo | Texto de relleno decorativo. La sección queda limpia con el encabezado "Continuar Leyendo" y su ícono dinámico. |

> [!NOTE]
> Todas las referencias en el código JavaScript a `results-count`, `grid-section-title` y `grid-status-badge` fueron blindadas con guardas de nulidad (`if (resCount)`, `if (titleSec)`, `if (badgeEl)`), garantizando que las funciones de actualización del feed (`renderFeedData`, `setPortalMode`, `fetchLiveFeed`) operen sin lanzar excepciones en la consola.

---

## 3. Elementos Rediseñados y Mejorados (Círculo Amarillo)

### 3.1. Barra de Categorías Horizontal Compacta
- **Estructura y Ergonomía:** Se transformó en una fila única de chips compactos con scroll horizontal táctil nativo (`overflow-x-auto`, `scroll-smooth`, `snap-x`, `snap-mandatory`).
- **Touch Target Móvil:** Cada botón cuenta con una altura táctil estandarizada de **40px a 44px** (`h-10 px-3.5 sm:px-4`), garantizando facilidad de pulsación con el pulgar en pantallas de 360px a 412px.
- **Tipografía y Estilo:** Texto en una sola línea (`whitespace-nowrap`), ícono temático a la izquierda de cada categoría, estado inactivo con fondo translúcido (`bg-white/[0.04] border border-white/10`) y estado activo con degradado neón vibrante (`bg-gradient-to-r from-pink-500 to-purple-600 border-pink-400/50 shadow-md shadow-pink-500/25`).
- **Indicador Visual de Desplazamiento:** Se integró un degradado suave en el extremo derecho (`bg-gradient-to-l from-[#0b0416] to-transparent`) visible únicamente en móviles para indicar intuitivamente que hay más categorías deslizables.
- **Sincronización con URL e Historial:**
  - Al pulsar una categoría, se actualiza el parámetro `?cat=` en la barra de direcciones con `history.pushState`.
  - Se implementó un escucha global para el evento `popstate`, permitiendo que el botón "Atrás" y "Adelante" del navegador o del móvil restaure la categoría previa sin recargar la página.

#### Justificación y Verificación de Categorías en Base de Datos Real:
Antes de fijar las categorías, se auditó el catálogo real en Supabase para verificar si cada una devolvía resultados legítimos:
1. **Todos los Estrenos (`id: 'all'`):** 50,401 obras en catálogo general.
2. **Manhwas +18 (`id: 'manhwa'`):** 168 obras verificadas con lectura vertical estilo webtoon. Se mantuvo como categoría de primer nivel debido a la alta preferencia del usuario por cómic coreano vertical.
3. **3D CGI Novels (`id: '3d'`):** 7,185 obras en 3D/CGI renderizadas.
4. **Doujinshi & Manga (`id: 'doujin'`):** 28,510 obras japonesas sin censura.
5. **Parodias Animadas (`id: 'parody'`):** 8,034 obras.  
   *(**Corrección Crítica:** En la versión anterior el frontend utilizaba el identificador erróneo `id: 'toon'`, lo cual impedía que el backend en `functions/api/[[path]].js:1530` aplicara el filtro `catTerm = 'parodia'`. Al migrar a `id: 'parody'`, el filtro se conecta de forma inmediata con las 8,034 parodias).*
6. **Cómics XXX Clásicos (`id: 'western'`):** 2,202 obras de formato cómic occidental tradicional.

---

### 3.2. Menú de Ordenación / Modo Aleatorio (Sort Menu)
- **Eliminación del Select Blanco Nativo:** Se reemplazó el antiguo `<select id="sort-select">` (cuyas opciones eran texto blanco sobre fondo blanco inaccesible) por un componente de diseño propio 100% accesible.
- **Botón Desplegable (PC y Móvil):**
  - Botón oscuro satinado (`bg-white/[0.05] border border-white/10 hover:border-pink-500/50`) con el ícono del modo actual, etiqueta y flecha chevron animada con rotación suave de 180°.
  - Soporte completo para accesibilidad ARIA: `aria-haspopup="listbox"`, `aria-expanded="false"`, `role="listbox"`, `role="option"`.
- **Comportamiento Adaptativo PC vs Móvil:**
  - **En PC (≥ 768px):** Despliega un menú flotante con fondo violeta profundo (`#120726/95`), desenfoque *backdrop-blur* y sombra profunda.
  - **En Móvil (< 768px):** Abre una **hoja inferior (*bottom sheet*)** táctil desde la parte baja de la pantalla, con barra indicadora de arrastre, título claro y botones grandes diseñados para interacción con una sola mano.
- **Opciones Soportadas por el Backend:**
  Se verificó la lista de ordenamiento permitida en `ALLOWED_SORTS` de Cloudflare Workers:
  1. `random`: **Modo Aleatorio 🎲** — Orden impredecible y dinámico.
  2. `recent`: **Más Recientes 📌** — Últimos estrenos cronológicos agregados.
  3. `popular`: **Más Populares ⭐** — Cómics favoritos guardados por la comunidad.
  4. `views`: **Más Vistos 🔥** — Títulos con mayor tráfico de lectura.
  5. `rating`: **Mejor Valorados 💎** — Obras con mayor calificación y reseñas VIP.
  *(Se eliminó la opción "Más páginas", ya que no estaba soportada por la API y no producía cambios en la consulta).*
- **Navegación por Teclado:** Se incorporaron eventos de teclado para cerrar con `Escape` y navegar entre opciones mediante flechas `ArrowUp` y `ArrowDown`, devolviendo el foco al botón de apertura.
- **Sincronización con URL:** La opción seleccionada se refleja en la URL mediante el parámetro `?sort=`, reiniciando la paginación a la página 1 y solicitando el nuevo feed.

---

### 3.3. Fila "Continuar Leyendo" (Vertical Cards & 5s Undo)
- **Cambio de Formato Horizontal a Vertical:** Las tarjetas horizontales anteriores consumían un ancho excesivo y dejaban poco espacio para la portada. Se reemplazaron por **tarjetas verticales de proporción estándar 2:3 (`aspect-[2/3]`)** con ancho adaptable de **155px a 170px** (`w-[155px] sm:w-[170px] shrink-0 snap-start`).
- **Portada y Animaciones:** Portada completa protegida con proxy stealth, fondo con color dominante de la obra, esqueleto de carga (*skeleton loading*), e ícono de lectura al pasar el cursor o pulsar.
- **Jerarquía de Información:**
  - **Título:** Acotado rigurosamente a un máximo de 2 líneas con puntos suspensivos (`line-clamp-2 min-h-[32px]`).
  - **Progreso:** Barra fina de 4px (`h-1`) con acento rosa `#ff2d95` e indicador numérico claro `"Pág. X de Y"` y porcentaje `"Z%"`.
  - **Botón de Acción:** Botón inferior compacto `"Continuar"` con ícono de libro abierto.
- **Botón Discreto de Descarte (X) con "Deshacer (5s)":**
  - Cada tarjeta incorpora un botón circular discreto `(X)` en la esquina superior derecha (`data-action="dismiss-continue"`).
  - Al pulsarlo, el cómic se retira de la fila de continuar y se despliega un aviso flotante inferior:
    `"Removido de Continuar [Deshacer (5s)]"`.
  - Si el usuario pulsa **Deshacer** dentro de los 5 segundos, la obra vuelve inmediatamente a su posición en la fila; si no se pulsa, la eliminación se consolida permanentemente.
- **Control de Privacidad y Estado Vacío:**
  - Si no hay cómics con progreso en lectura, o si el usuario tiene habilitada la preferencia de privacidad `pauseHistory`, la sección `#continue-section` se oculta por completo (`display: none`), evitando huecos en blanco o espacios vacíos.

---

### 3.4. Favicon e Iconografía PWA
- **Problema previo:** En pestañas oscuras y claras del navegador el icono de Velvet Hub aparecía en blanco o con el favicon genérico del servidor.
- **Solución implementada:** Se procesó el logotipo de alta resolución (`velvet_logo.png`) generando activos nítidos con fondo oscuro optimizado y contraste calibrado:
  - `public/favicon.ico` (resoluciones de 16x16 y 32x32 incrustadas).
  - `public/favicon-16x16.png` y `public/favicon-32x32.png` para navegadores modernos.
  - `public/apple-touch-icon.png` (180x180) para iOS y Safari.
  - `public/icon-192.png` y `public/icon-512.png` para instalación PWA en Android y ChromeOS.
- **Registro en HTML y PWA:** Enlazados en el `<head>` de `public/index.html` y dentro de `public/manifest.json`.
- **Invalidación en Service Worker:** Se actualizó la versión de caché del Service Worker a `v12-velvet-redesign` y se añadieron los nuevos favicons a la lista de `STATIC_ASSETS`, obligando a los navegadores móviles y de escritorio a refrescar la caché y mostrar el nuevo icono.

---

## 4. Maqueta Textual y Comparativa Visual

### 4.1. Vista en PC (Escritorio / Pantallas > 1024px)
```text
+---------------------------------------------------------------------------------------------------+
|  [ VELVET HUB ]    [Cómics] [Videos] [Modelos]    [ Buscar... ]          [🎲 Modo Aleatorio ▾]    |
+---------------------------------------------------------------------------------------------------+
|  [🔥 Todos los Estrenos] [🔞 Manhwas +18] [💎 3D CGI] [🎌 Doujinshi] [✨ Parodias] [💥 Clásicos]    |
+---------------------------------------------------------------------------------------------------+
|                                                                                                   |
|  CONTINUAR LEYENDO                                                                                |
|  +----------------+  +----------------+  +----------------+  +----------------+                   |
|  | [X] Portada    |  | [X] Portada    |  | [X] Portada    |  | [X] Portada    |                   |
|  |     2:3        |  |     2:3        |  |     2:3        |  |     2:3        |                   |
|  |----------------|  |----------------|  |----------------|  |----------------|                   |
|  | Título de Obra |  | Romance Oculto |  | Campus Secret  |  | Sister Tempt   |                   |
|  | en 2 líneas... |  | en 2 líneas... |  | en 2 líneas... |  | en 2 líneas... |                   |
|  | Pág. 14 de 28  |  | Pág. 3 de 15   |  | Pág. 8 de 40   |  | Pág. 12 de 16  |                   |
|  | [======    ]   |  | [==        ]   |  | [===       ]   |  | [=======   ]   |                   |
|  | [▶ Continuar]  |  | [▶ Continuar]  |  | [▶ Continuar]  |  | [▶ Continuar]  |                   |
|  +----------------+  +----------------+  +----------------+  +----------------+                   |
|                                                                                                   |
|  CATÁLOGO DE CÓMICAS (Sin títulos decorativos redundantes)                                        |
|  +--------------------+  +--------------------+  +--------------------+  +--------------------+   |
|  |                    |  |                    |  |                    |  |                    |   |
|  |     CÓMIC 1        |  |     CÓMIC 2        |  |     CÓMIC 3        |  |     CÓMIC 4        |   |
|  |                    |  |                    |  |                    |  |                    |   |
|  +--------------------+  +--------------------+  +--------------------+  +--------------------+   |
+---------------------------------------------------------------------------------------------------+
```

### 4.2. Vista en Android (Pantalla 360px - 412px de Ancho)
```text
+-------------------------------------------+
| [🔥 VELVET HUB]          [🔍] [👤 Cuenta] |
+-------------------------------------------+
| [Cómics|Videos] [🔥 Todos] [🔞 Manh..] >> | (Deslizable con degradado a la derecha)
|                            [🎲 Ordenar ▾] |
+-------------------------------------------+
| CONTINUAR LEYENDO                         |
| +-------------+ +-------------+ +----->   |
| |[X] Portada  | |[X] Portada  | |[X]      | (Tarjetas verticales 155px con scroll táctil)
| |    2:3      | |    2:3      | |         |
| |-------------| |-------------| |         |
| | Secret Class| | Queen Bee   | |         |
| | Cap. 4      | | Cap. 12     | |         |
| | Pág. 12/20  | | Pág. 5/18   | |         |
| | [=====   ]  | | [===     ]  | |         |
| | [Continuar] | | [Continuar] | |         |
| +-------------+ +-------------+ +----->   |
+-------------------------------------------+
|                                           |
| (Catálogo de cómics visible inmediatamente|
|  en 2 columnas ultra limpias sin títulos) |
|                                           |
| +---------------+   +---------------+     |
| | Portada Cómic |   | Portada Cómic |     |
| | 1             |   | 2             |     |
| +---------------+   +---------------+     |
+-------------------------------------------+
```

### 4.3. Hoja Inferior (*Bottom Sheet*) en Android al Tocar "Ordenar"
```text
+-------------------------------------------+
|                 [   ]  (Barra de arrastre)|
|  Ordenar Catálogo                     [X] |
|-------------------------------------------|
|  🎲  Modo Aleatorio                   (✓) |
|      Descubre cómics y novedades al azar  |
|                                           |
|  📌  Más Recientes                        |
|      Últimos estrenos agregados           |
|                                           |
|  ⭐  Más Populares                        |
|      Favoritos guardados por la comunidad |
|                                           |
|  🔥  Más Vistos                           |
|      Los títulos con más lecturas         |
|                                           |
|  💎  Mejor Valorados                      |
|      Mayor puntuación y reseñas VIP       |
+-------------------------------------------+
```

---

## 5. Resumen de Pruebas Automatizadas
Se ejecutaron satisfactoriamente las siguientes suites de pruebas sobre la rama `feat/rediseno-ui`:
1. `test/test_ui_redesign.mjs`: Verifica eliminación de los 4 elementos decorativos, scroll-snap y touch targets de la barra de categorías, soporte de las 5 opciones y bottom sheet en ordenación, proporción 2:3 y descarte con deshacer en Continuar Leyendo, y favicons con Service Worker v12. **(100% PASS)**
2. `npm test`: Suite completa que incluye pruebas de paginación, seguridad HMAC-SHA256 y anti-SSRF, rendimiento en Android (100dvh, safe-area-inset, límites de prefetch), calidad y ARIA, e integración en vivo con PostgREST. **(100% PASS)**
