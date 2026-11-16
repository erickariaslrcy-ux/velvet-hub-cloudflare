import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

console.log("=== INICIANDO PRUEBAS UNITARIAS DE REDISEÑO UI (FEAT/REDISENO-UI) ===\n");

const root = process.cwd();
const indexPath = path.join(root, "public", "index.html");
const swPath = path.join(root, "public", "sw.js");
const manifestPath = path.join(root, "public", "manifest.json");
const backendPath = path.join(root, "functions", "api", "[[path]].js");

const indexHtml = fs.readFileSync(indexPath, "utf8");
const swJs = fs.readFileSync(swPath, "utf8");
const manifestJson = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const backendJs = fs.readFileSync(backendPath, "utf8");

// ============================================================================
// 1. VERIFICACIÓN DE ELEMENTOS ELIMINADOS (X ROJA)
// ============================================================================
console.log("[1] Verificando eliminación de elementos decorativos obsoletos (X Roja)...");

// Badge "24 Cómics Calientes Listos" junto a la barra de categorías
assert.ok(
  !indexHtml.includes('id="results-count"'),
  "id='results-count' debe haber sido eliminado del HTML para quitar el badge decorativo '24 Cómics Calientes Listos'"
);

// Título "Últimas Novedades Calientes"
assert.ok(
  !indexHtml.includes('id="grid-section-title"'),
  "id='grid-section-title' debe haber sido eliminado del HTML para evitar títulos decorativos redundantes"
);

// Badge "24 historias listas para leer"
assert.ok(
  !indexHtml.includes('id="grid-status-badge"'),
  "id='grid-status-badge' debe haber sido eliminado del HTML"
);

// Subtítulo en Continuar Leyendo ("Reanuda donde lo dejaste con 1 toque")
assert.ok(
  !indexHtml.includes('id="continue-shelf-subtitle"'),
  "id='continue-shelf-subtitle' debe haber sido eliminado del HTML"
);

// Asegurar que las funciones JS tengan protecciones null-safe para elementos eliminados
assert.ok(
  indexHtml.includes("if (resCount) resCount.textContent"),
  "El código JS debe proteger con null check a resCount"
);
assert.ok(
  indexHtml.includes("if (titleSec)"),
  "El código JS debe proteger con null check a titleSec"
);

console.log("✓ Todos los elementos decorativos obsoletos fueron eliminados limpiamente del DOM sin errores.");

// ============================================================================
// 2. VERIFICACIÓN DE BARRA DE CATEGORÍAS REDISEÑADA (CHIPS COMPACTOS)
// ============================================================================
console.log("\n[2] Verificando barra de categorías horizontal compacta con scroll-snap y URL sync...");

// Scroll horizontal suave y scroll snap
assert.ok(
  indexHtml.includes("scroll-smooth snap-x snap-mandatory"),
  "La barra de categorías debe implementar scroll-smooth snap-x snap-mandatory"
);

// Máscara de desvanecimiento para móvil
assert.ok(
  indexHtml.includes("pointer-events-none md:hidden absolute right-0 top-0 bottom-0") &&
  indexHtml.includes("bg-gradient-to-l"),
  "Debe existir una máscara de degradado en el borde derecho para indicar scroll en móvil"
);

// Delegación por data-action
assert.ok(
  indexHtml.includes('data-action="filter-category"'),
  "Los botones de categoría deben usar delegación con data-action='filter-category'"
);

// Altura táctil mínima de 40-44px y whitespace-nowrap
assert.ok(
  indexHtml.includes("cat-chip h-10 px-3.5 sm:px-4") && indexHtml.includes("whitespace-nowrap"),
  "Los chips deben tener altura mínima h-10 (40px) y no permitir saltos de línea (whitespace-nowrap)"
);

// Mapeo de categoría parody para el backend
assert.ok(
  indexHtml.includes("id: 'parody'") && indexHtml.includes("Parodias Animadas"),
  "La categoría de parodias animadas debe tener id 'parody' para alinearse con el backend"
);
assert.ok(
  backendJs.includes('category === "parody"') && backendJs.includes('catTerm = "parodia"'),
  "El backend debe mapear category === 'parody' a catTerm = 'parodia'"
);

// Sincronización de URL con ?cat= y history pushState
assert.ok(
  indexHtml.includes("url.searchParams.set('cat', cat)") && indexHtml.includes("window.history.pushState"),
  "setCategory debe sincronizar el parámetro ?cat= en la URL mediante pushState"
);

// Soporte para popstate
assert.ok(
  indexHtml.includes("window.addEventListener('popstate'"),
  "Debe existir un listener de popstate para soportar navegación Atrás/Adelante con ?cat="
);

console.log("✓ Barra de categorías optimizada, accesible, responsive y sincronizada con la URL.");

// ============================================================================
// 3. VERIFICACIÓN DE MENÚ DESPLEGABLE Y BOTTOM SHEET DE ORDENACIÓN (SORT)
// ============================================================================
console.log("\n[3] Verificando menú personalizado accesible de ordenación (Dropdown PC + Bottom Sheet Móvil)...");

// Reemplazo del select nativo blanco
assert.ok(
  !indexHtml.includes('<select id="sort-select"'),
  "El <select id='sort-select'> nativo blanco debe haber sido reemplazado"
);

// Botón de activación accesible
assert.ok(
  indexHtml.includes('id="sort-menu-btn"') &&
  indexHtml.includes('aria-haspopup="listbox"') &&
  indexHtml.includes('aria-expanded="false"'),
  "Debe existir un botón sort-menu-btn accesible con ARIA para activar el menú"
);

// Dropdown para PC
assert.ok(
  indexHtml.includes('id="sort-dropdown-menu"') &&
  indexHtml.includes('role="listbox"'),
  "Debe existir un dropdown flotante id='sort-dropdown-menu' con role='listbox' para PC"
);

// Bottom Sheet para Móvil
assert.ok(
  indexHtml.includes('id="sort-bottom-sheet"') &&
  indexHtml.includes('id="sort-bottom-sheet-backdrop"'),
  "Debe existir una hoja inferior id='sort-bottom-sheet' y su fondo backdrop para móvil"
);

// Whitelist de opciones soportadas por el backend (random, recent, popular, views, rating)
assert.ok(
  indexHtml.includes("id: 'random'") &&
  indexHtml.includes("id: 'recent'") &&
  indexHtml.includes("id: 'popular'") &&
  indexHtml.includes("id: 'views'") &&
  indexHtml.includes("id: 'rating'"),
  "El menú de orden debe soportar las 5 opciones reales del backend"
);

// Eliminación de opción no funcional "pages"
assert.ok(
  !indexHtml.includes("id: 'pages'") && !indexHtml.includes("value=\"pages\""),
  "La opción no soportada 'pages' ('Más páginas') debe haber sido eliminada"
);

// Navegación accesible por teclado (Escape, ArrowDown, ArrowUp)
assert.ok(
  indexHtml.includes("e.key === 'Escape'") &&
  indexHtml.includes("e.key === 'ArrowDown'") &&
  indexHtml.includes("e.key === 'ArrowUp'"),
  "Debe soportar navegación por teclado con Escape, Flecha Abajo y Flecha Arriba"
);

// Sincronización con ?sort=
assert.ok(
  indexHtml.includes("url.searchParams.set('sort', sortId)"),
  "selectSortOption debe sincronizar el parámetro ?sort= en la URL"
);

console.log("✓ Menú de ordenación accesible, responsivo y sincronizado verificado.");

// ============================================================================
// 4. VERIFICACIÓN DE FILA 'CONTINUAR LEYENDO' VERTICAL CON DESHACER
// ============================================================================
console.log("\n[4] Verificando tarjetas verticales compactas 2:3 y toast de Deshacer (5s)...");

// Tarjetas verticales con proporción 2:3 y ancho 155-170px
assert.ok(
  indexHtml.includes("w-[155px] sm:w-[170px] shrink-0 snap-start") &&
  indexHtml.includes("aspect-[2/3]"),
  "Las tarjetas deben ser verticales con ancho ~155-170px y portada con proporción aspect-[2/3]"
);

// Título de 2 líneas con puntos suspensivos
assert.ok(
  indexHtml.includes("line-clamp-2"),
  "El título de la tarjeta debe estar acotado a máximo 2 líneas con line-clamp-2"
);

// Barra fina de progreso con acento rosa (#ff2d95)
assert.ok(
  indexHtml.includes("bg-[#ff2d95]") && indexHtml.includes("h-1"),
  "Debe tener una barra fina de progreso h-1 con el acento #ff2d95"
);

// Botón Continuar
assert.ok(
  indexHtml.includes("<span>Continuar</span>"),
  "Cada tarjeta debe incluir un botón pequeño de acción 'Continuar'"
);

// Botón discreto (X) con delegación data-action="dismiss-continue"
assert.ok(
  indexHtml.includes('data-action="dismiss-continue"'),
  "Cada tarjeta debe tener un botón discreto (X) con data-action='dismiss-continue'"
);

// Toast de Deshacer con 5 segundos
assert.ok(
  indexHtml.includes('data-action="undo-dismiss-continue"') &&
  indexHtml.includes("Deshacer (5s)"),
  "Debe existir la acción de Deshacer con toast de 5 segundos"
);

// Ocultamiento total si está vacío o si pauseHistory está activo
assert.ok(
  indexHtml.includes("pauseHistory") &&
  indexHtml.includes("section.classList.add('hidden')"),
  "La sección debe ocultarse totalmente si pauseHistory está activo o no hay elementos"
);

console.log("✓ Fila Continuar Leyendo vertical compacta con soporte de Deshacer y privacidad verificada.");

// ============================================================================
// 5. VERIFICACIÓN DE FAVICONS, ICONOS PWA Y SERVICE WORKER
// ============================================================================
console.log("\n[5] Verificando generación e integración de Favicons, PWA y Service Worker v12...");

const requiredIcons = [
  "favicon.ico",
  "favicon-16x16.png",
  "favicon-32x32.png",
  "apple-touch-icon.png",
  "icon-192.png",
  "icon-512.png"
];

for (const icon of requiredIcons) {
  const iconFile = path.join(root, "public", icon);
  assert.ok(fs.existsSync(iconFile), `El archivo ${icon} debe existir en public/`);
  const stat = fs.statSync(iconFile);
  assert.ok(stat.size > 200, `El archivo ${icon} debe tener contenido binario válido (> 200 bytes)`);
}

// Enlaces en <head>
assert.ok(
  indexHtml.includes('href="/favicon.ico"') &&
  indexHtml.includes('href="/favicon-32x32.png"') &&
  indexHtml.includes('href="/favicon-16x16.png"') &&
  indexHtml.includes('href="/apple-touch-icon.png"'),
  "El <head> debe incluir las etiquetas <link rel='icon'> y apple-touch-icon"
);

// Manifest PWA
assert.ok(
  manifestJson.icons.some(i => i.src === "/icon-192.png" && i.sizes === "192x192"),
  "manifest.json debe contener icon-192.png"
);
assert.ok(
  manifestJson.icons.some(i => i.src === "/icon-512.png" && i.sizes === "512x512"),
  "manifest.json debe contener icon-512.png"
);

// Service Worker v12
assert.ok(
  swJs.includes("v12-velvet-turbo") || swJs.includes("v12-velvet-redesign"),
  "sw.js debe tener la versión de caché actualizada a v12"
);
assert.ok(
  swJs.includes("/favicon.ico") && swJs.includes("/icon-192.png"),
  "sw.js debe pre-cachear los nuevos iconos en STATIC_ASSETS"
);

console.log("✓ Favicons multi-resolución, PWA manifest e invalidación del Service Worker v12 verificados.");

console.log("\n====================================================");
console.log("✅ TODAS LAS PRUEBAS DE REDISEÑO UI PASARON EXITOSAMENTE (100%)");
console.log("====================================================");
