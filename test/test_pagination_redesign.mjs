import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const paginationCode = fs.readFileSync(path.join("public", "js", "pagination.js"), "utf-8");
// Mock mínimo para entorno Node
globalThis.document = {
  getElementById: () => null,
  addEventListener: () => {},
  createElement: () => ({ classList: { add() {}, remove() {} } })
};
globalThis.window = {
  addEventListener: () => {},
  location: { search: "" },
  history: {}
};
globalThis.window.document = globalThis.document;

vm.runInThisContext(paginationCode);
const VelvetPagination = globalThis.VelvetPagination;

console.log("=== INICIANDO PRUEBAS UNITARIAS DE REDISEÑO DE PAGINACIÓN ===");

const { calculatePaginationWindow, validateJumpPage, parseUrlPage, shouldPrefetchNextPage } = VelvetPagination;

// ----------------------------------------------------------------------------
// 1. VERIFICACIÓN DE LA VENTANA INTELIGENTE DE PÁGINAS
// ----------------------------------------------------------------------------
console.log("\n[1] Verificando ventana inteligente de páginas (calculatePaginationWindow)...");

// Caso total = 1: se oculta (array vacío)
assert.deepEqual(
  calculatePaginationWindow(1, 1),
  [],
  "Para total = 1 debe retornar array vacío (ocultar componente)"
);
assert.deepEqual(
  calculatePaginationWindow(0, 0),
  [],
  "Para total = 0 debe retornar array vacío"
);

// Caso total = 5 (<= 7): muestra todas las páginas
assert.deepEqual(
  calculatePaginationWindow(1, 5),
  [1, 2, 3, 4, 5],
  "Para total = 5 con actual = 1 debe mostrar todas [1, 2, 3, 4, 5]"
);
assert.deepEqual(
  calculatePaginationWindow(3, 5),
  [1, 2, 3, 4, 5],
  "Para total = 5 con actual = 3 debe mostrar todas [1, 2, 3, 4, 5]"
);
assert.deepEqual(
  calculatePaginationWindow(5, 5),
  [1, 2, 3, 4, 5],
  "Para total = 5 con actual = 5 debe mostrar todas [1, 2, 3, 4, 5]"
);

// Caso total = 7 (<= 7): muestra todas las páginas
assert.deepEqual(
  calculatePaginationWindow(1, 7),
  [1, 2, 3, 4, 5, 6, 7],
  "Para total = 7 con actual = 1 debe mostrar todas [1..7]"
);
assert.deepEqual(
  calculatePaginationWindow(4, 7),
  [1, 2, 3, 4, 5, 6, 7],
  "Para total = 7 con actual = 4 debe mostrar todas [1..7]"
);
assert.deepEqual(
  calculatePaginationWindow(7, 7),
  [1, 2, 3, 4, 5, 6, 7],
  "Para total = 7 con actual = 7 debe mostrar todas [1..7]"
);

// Caso total = 8 (> 7): primera, última, 2 a cada lado y puntos suspensivos
assert.deepEqual(
  calculatePaginationWindow(1, 8),
  [1, 2, 3, '...', 8],
  "Para total = 8 con actual = 1 debe mostrar [1, 2, 3, '...', 8]"
);
assert.deepEqual(
  calculatePaginationWindow(4, 8),
  [1, 2, 3, 4, 5, 6, '...', 8],
  "Para total = 8 con actual = 4 debe mostrar [1, 2, 3, 4, 5, 6, '...', 8]"
);
assert.deepEqual(
  calculatePaginationWindow(5, 8),
  [1, '...', 3, 4, 5, 6, 7, 8],
  "Para total = 8 con actual = 5 debe mostrar [1, '...', 3, 4, 5, 6, 7, 8]"
);
assert.deepEqual(
  calculatePaginationWindow(8, 8),
  [1, '...', 6, 7, 8],
  "Para total = 8 con actual = 8 debe mostrar [1, '...', 6, 7, 8]"
);

// Caso total = 100
assert.deepEqual(
  calculatePaginationWindow(1, 100),
  [1, 2, 3, '...', 100],
  "Para total = 100 con actual = 1 debe mostrar [1, 2, 3, '...', 100]"
);
assert.deepEqual(
  calculatePaginationWindow(50, 100),
  [1, '...', 48, 49, 50, 51, 52, '...', 100],
  "Para total = 100 con actual = 50 debe mostrar [1, '...', 48, 49, 50, 51, 52, '...', 100]"
);
assert.deepEqual(
  calculatePaginationWindow(100, 100),
  [1, '...', 98, 99, 100],
  "Para total = 100 con actual = 100 debe mostrar [1, '...', 98, 99, 100]"
);

// Caso total = 1562 (Catálogo completo de cómics)
assert.deepEqual(
  calculatePaginationWindow(1, 1562),
  [1, 2, 3, '...', 1562],
  "Para total = 1562 con actual = 1 debe mostrar [1, 2, 3, '...', 1562]"
);
// CASO DE EJEMPLO DEL USUARIO: "1 … 5 6 [7] 8 9 … 1562"
assert.deepEqual(
  calculatePaginationWindow(7, 1562),
  [1, '...', 5, 6, 7, 8, 9, '...', 1562],
  "Para total = 1562 con actual = 7 debe coincidir exactamente con el ejemplo del requerimiento"
);
assert.deepEqual(
  calculatePaginationWindow(781, 1562),
  [1, '...', 779, 780, 781, 782, 783, '...', 1562],
  "Para total = 1562 en el medio exacto debe mostrar 2 a cada lado y elipsis en ambos extremos"
);
assert.deepEqual(
  calculatePaginationWindow(1562, 1562),
  [1, '...', 1560, 1561, 1562],
  "Para total = 1562 con actual = última debe mostrar [1, '...', 1560, 1561, 1562]"
);

console.log("✓ Casos de ventana inteligente (1, 5, 7, 8, 100, 1562 en inicio, medio y fin) verificados exitosamente.");

// ----------------------------------------------------------------------------
// 2. VALIDACIÓN DEL CAMPO "IR A PÁGINA"
// ----------------------------------------------------------------------------
console.log("\n[2] Verificando validación del campo 'Ir a página' (validateJumpPage)...");

const totalPages1562 = 1562;

// Valores válidos
assert.deepEqual(
  validateJumpPage("1", totalPages1562),
  { isValid: true, page: 1, error: null }
);
assert.deepEqual(
  validateJumpPage(7, totalPages1562),
  { isValid: true, page: 7, error: null }
);
assert.deepEqual(
  validateJumpPage("1562", totalPages1562),
  { isValid: true, page: 1562, error: null }
);
assert.deepEqual(
  validateJumpPage("  42  ", totalPages1562),
  { isValid: true, page: 42, error: null }
);

// Valores inválidos: vacíos o nulos
assert.equal(validateJumpPage("", totalPages1562).isValid, false);
assert.equal(validateJumpPage("   ", totalPages1562).isValid, false);
assert.equal(validateJumpPage(null, totalPages1562).isValid, false);
assert.equal(validateJumpPage(undefined, totalPages1562).isValid, false);
assert.equal(validateJumpPage("", totalPages1562).error, "Escribe un número entre 1 y 1562");

// Valores inválidos: fuera de rango (< 1 o > totalPages)
assert.equal(validateJumpPage("0", totalPages1562).isValid, false);
assert.equal(validateJumpPage("-5", totalPages1562).isValid, false);
assert.equal(validateJumpPage("1563", totalPages1562).isValid, false);
assert.equal(validateJumpPage("99999", totalPages1562).isValid, false);
assert.equal(validateJumpPage("1563", totalPages1562).error, "Escribe un número entre 1 y 1562");

// Valores inválidos: no numéricos o decimales
assert.equal(validateJumpPage("abc", totalPages1562).isValid, false);
assert.equal(validateJumpPage("12a", totalPages1562).isValid, false);
assert.equal(validateJumpPage("7.5", totalPages1562).isValid, false);
assert.equal(validateJumpPage("3,14", totalPages1562).isValid, false);

console.log("✓ Validación de campo 'Ir a' (enteros válidos, nulos, ceros, negativos, fuera de rango) verificada exitosamente.");

// ----------------------------------------------------------------------------
// 3. SINCRONIZACIÓN CON LA URL (parseUrlPage)
// ----------------------------------------------------------------------------
console.log("\n[3] Verificando sincronización y lectura de la URL (parseUrlPage)...");

// Sin parámetro page -> devuelve 1
assert.deepEqual(
  parseUrlPage("?cat=all&q=milf", 1562),
  { page: 1, wasCorrected: false, raw: null }
);
assert.deepEqual(
  parseUrlPage("https://morbohub.pages.dev/comics", 1562),
  { page: 1, wasCorrected: false, raw: null }
);

// Con parámetro page válido
assert.deepEqual(
  parseUrlPage("?page=7", 1562),
  { page: 7, wasCorrected: false, raw: "7" }
);
assert.deepEqual(
  parseUrlPage("https://morbohub.pages.dev/comics?q=naruto&cat=all&page=14#seccion", 1562),
  { page: 14, wasCorrected: false, raw: "14" }
);

// Con parámetro page fuera de rango (< 1) -> corregido a 1
assert.deepEqual(
  parseUrlPage("?page=0", 1562),
  { page: 1, wasCorrected: true, raw: "0" }
);
assert.deepEqual(
  parseUrlPage("?page=-10", 1562),
  { page: 1, wasCorrected: true, raw: "-10" }
);
assert.deepEqual(
  parseUrlPage("?page=invalido", 1562),
  { page: 1, wasCorrected: true, raw: "invalido" }
);

// Con parámetro page fuera de rango (> totalPages) -> corregido a totalPages
assert.deepEqual(
  parseUrlPage("?page=2000", 1562),
  { page: 1562, wasCorrected: true, raw: "2000" }
);
assert.deepEqual(
  parseUrlPage("?page=999999", 50),
  { page: 50, wasCorrected: true, raw: "999999" }
);

console.log("✓ Sincronización con URL y auto-corrección de valores fuera de rango verificadas exitosamente.");

// ----------------------------------------------------------------------------
// 4. PREFETCH CONDICIONAL (shouldPrefetchNextPage)
// ----------------------------------------------------------------------------
console.log("\n[4] Verificando prefetch condicional...");
assert.equal(typeof shouldPrefetchNextPage, "function");
// En entorno Node (sin navigator.connection), retorna true por defecto
assert.equal(shouldPrefetchNextPage(), true);
console.log("✓ Verificación de prefetch condicional completada.");

// ----------------------------------------------------------------------------
// 5. VERIFICACIÓN DE REGLAS CSS Y OBJETIVOS TÁCTILES MÓVILES (>= 44px)
// ----------------------------------------------------------------------------
console.log("\n[5] Verificando reglas CSS de diseño, responsive y touch targets (pagination.css)...");
const cssContent = fs.readFileSync(path.join("public", "css", "pagination.css"), "utf-8");

assert.ok(cssContent.includes("safe-area-inset-bottom"), "pagination.css debe respetar safe-area-inset-bottom");
assert.ok(cssContent.includes("min-height: 44px") || cssContent.includes("min-height: 46px") || cssContent.includes("min-height: 48px"), "Los botones móviles deben tener touch targets >= 44px");
assert.ok(cssContent.includes("prefers-reduced-motion"), "pagination.css debe respetar prefers-reduced-motion");
assert.ok(cssContent.includes("linear-gradient(135deg, #ec4899"), "pagination.css debe utilizar el degradado rosa-violeta institucional");
assert.ok(cssContent.includes("is-invalid"), "pagination.css debe incluir estilos de error para campo inválido");
assert.ok(cssContent.includes("@media (max-width: 767px)"), "pagination.css debe definir breakpoint móvil para < 768px");
assert.ok(cssContent.includes("@media (min-width: 768px)"), "pagination.css debe definir breakpoint desktop para >= 768px");

console.log("✓ Reglas CSS (touch targets >= 44px, safe area, degradado rosa-violeta, responsive) verificadas exitosamente.");

// ----------------------------------------------------------------------------
// 6. ESTRUCTURA Y ACCESIBILIDAD DEL COMPONENTE RENDERIZADO
// ----------------------------------------------------------------------------
console.log("\n[6] Verificando renderizado semántico y accesibilidad...");

// Mock de DOM para probar render()
let innerHtmlStored = "";
let classListRoot = new Set();
globalThis.document.getElementById = (id) => {
  if (id === 'velvet-pagination-root') {
    return {
      classList: {
        add: (c) => classListRoot.add(c),
        remove: (c) => classListRoot.delete(c),
        contains: (c) => classListRoot.has(c)
      },
      set innerHTML(val) { innerHtmlStored = val; },
      get innerHTML() { return innerHtmlStored; },
      querySelector: () => null
    };
  }
  return null;
};

// Si totalPages <= 1: debe ocultarse y no renderizar
VelvetPagination.render(1, 1, 10);
assert.ok(classListRoot.has("v-hidden"), "Para totalPages <= 1 el componente debe tener clase v-hidden");
assert.equal(innerHtmlStored, "", "Para totalPages <= 1 el contenedor debe quedar vacío");

// Si totalPages = 1562 y currentPage = 7
VelvetPagination.render(7, 1562, 37485);
assert.ok(!classListRoot.has("v-hidden"), "Para totalPages > 1 debe estar visible");
assert.ok(innerHtmlStored.includes('<nav class="v-pagination-bar" aria-label="Paginación">'), "Debe contener nav con aria-label='Paginación'");
assert.ok(innerHtmlStored.includes('aria-current="page"'), "La página activa debe tener aria-current='page'");
assert.ok(innerHtmlStored.includes('data-action="page-prev"'), "Debe incluir botón Anterior con data-action");
assert.ok(innerHtmlStored.includes('data-action="page-next"'), "Debe incluir botón Siguiente con data-action");
assert.ok(innerHtmlStored.includes('data-action="focus-jump"'), "Los puntos suspensivos deben tener data-action focus-jump");
assert.ok(innerHtmlStored.includes('v-bottom-sheet'), "Debe incluir la hoja inferior (bottom sheet) para Android/móvil");
assert.ok(innerHtmlStored.includes('data-action="quick-shortcut"'), "Debe incluir atajos rápidos en la bottom sheet");
assert.ok(innerHtmlStored.includes('de 1,562'), "Debe mostrar el texto con el total de páginas formateado");

console.log("✓ Estructura DOM semántica y accesibilidad ARIA verificadas exitosamente.");

console.log("\n=== TODAS LAS PRUEBAS DE REDISEÑO DE PAGINACIÓN PASARON EXITOSAMENTE ===");
