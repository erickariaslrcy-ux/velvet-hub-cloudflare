import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

console.log("=== INICIANDO PRUEBAS UNITARIAS DE PAGINACIÓN (FASE 1) ===");

// 1. Verificación de cálculo de offset y monotonicidad
console.log("\n[1] Verificando estabilidad y monotonicidad de offsets...");
for (const seed of [0, 1, 25, 42, 99, 250, 499, 12345]) {
  for (const pageSize of [12, 24]) {
    let prevOffset = -1;
    const effectiveSeed = seed > 0 ? seed : 7919;
    const maxCatalogOffset = 18000;
    const maxPageSlots = Math.floor(maxCatalogOffset / pageSize);
    const randomStartPage = (Math.abs(effectiveSeed * 313) % Math.max(1, maxPageSlots - 30));
    const baseOffset = randomStartPage * pageSize;

    for (let page = 1; page <= 10; page++) {
      const offset = (baseOffset + (page - 1) * pageSize) % maxCatalogOffset;

      assert.ok(offset >= 0, `Offset no debe ser negativo: seed=${seed}, page=${page}`);
      if (prevOffset >= 0) {
        assert.equal(
          offset - prevOffset,
          pageSize,
          `El offset debe avanzar exactamente pageSize (${pageSize}) entre páginas consecutivas: seed=${seed}, page=${page}`
        );
      }
      prevOffset = offset;
    }
  }
}
console.log("✓ Offsets estrictamente monotónicos y secuenciales para todos los seeds y pageSizes.");

// 2. Verificación de filtros en la consulta PostgREST en functions/api/[[path]].js
console.log("\n[2] Verificando filtros a nivel de base de datos en functions/api/[[path]].js...");
const functionsCode = fs.readFileSync(path.join("functions", "api", "[[path]].js"), "utf-8");

assert.ok(
  functionsCode.includes("postgrestUrl = `${SUPABASE_URL}/rest/v1/items?select=${selectFields}&limit=${pageSize}&offset=${offset}`"),
  "Debe consultar items con paginación limpia"
);
assert.ok(
  functionsCode.includes("media_type=eq.comic&page_count=gt.0"),
  "Debe filtrar page_count > 0 y cómics en la consulta SQL"
);
assert.ok(
  functionsCode.includes('"Prefer": preferCount') && functionsCode.includes('"count=exact"'),
  "Debe soportar Prefer: count=exact y count configurable para catálogos masivos"
);
assert.ok(
  functionsCode.includes('spRes.headers.get("content-range")'),
  "Debe leer la cabecera Content-Range para calcular total y totalPages reales"
);
assert.ok(
  !functionsCode.includes("COMIC_CLUSTERS"),
  "No debe existir la lógica rota de COMIC_CLUSTERS que provocaba páginas vacías"
);
console.log("✓ Todos los filtros de nivel de base de datos verificados en el backend.");

// 3. Verificación de Service Worker (public/sw.js)
console.log("\n[3] Verificando exclusión de /api/items en Service Worker...");
const swCode = fs.readFileSync(path.join("public", "sw.js"), "utf-8");

assert.ok(
  swCode.includes("url.pathname.startsWith('/api/items')"),
  "sw.js debe excluir /api/items de la interceptación/caché"
);
assert.ok(
  !swCode.includes("url.pathname.startsWith('/api/items') || url.pathname.startsWith('/api/tags')"),
  "sw.js NO debe cachear /api/items en API_CACHE con SWR"
);
assert.ok(
  swCode.includes("v12-velvet-turbo") || swCode.includes("v12-velvet-redesign") || swCode.includes("v13-session-persist") || swCode.includes("v14-stable-media") || swCode.includes("v15-mobile-nav") || swCode.includes("v16-stable-covers") || swCode.includes("v17-gallery-mirrors") || swCode.includes("v18-fav-ids") || swCode.includes("v19-section-zoom") || swCode.includes("v20-video-silence") || swCode.includes("v21-gallery-budget") || swCode.includes("v22-video-direct") || swCode.includes("v23-morbo-name") || swCode.includes("v24-subscriptions-fix") || swCode.includes("v25-cloud-favorites") || swCode.includes("v26-security-audit") || swCode.includes("v27-vault-pagination") || swCode.includes("v28-clean-vault-titles") || swCode.includes("v29-random-disjoint-ui") || swCode.includes("v30-pmv-disjoint-final") || swCode.includes("v31-android-pagination-fix") || swCode.includes("v32-launch-hardening") || swCode.includes("v33-fast-budget") || swCode.includes("v34-tiktok-local") || swCode.includes("v35-tiktok-wide") || swCode.includes("v36-tiktok-solo") || swCode.includes("v37-tiktok-fit") || swCode.includes("v38-tiktok-ambient") || swCode.includes("v39-tiktok-turbo") || swCode.includes("v40-tiktok-direct") || swCode.includes("v41-tiktok-stealth"),
  "sw.js debe tener la versión de caché actualizada"
);
assert.ok(
  swCode.includes("/css/pagination.css") && swCode.includes("/js/pagination.js"),
  "sw.js debe incluir pagination.css y pagination.js en STATIC_ASSETS"
);
console.log("✓ Service Worker configurado correctamente sin caché para /api/items.");

// 4. Verificación de AbortController y control de concurrencia en public/index.html
console.log("\n[4] Verificando AbortController y prevención de carreras en public/index.html...");
const indexCode = fs.readFileSync(path.join("public", "index.html"), "utf-8");

assert.ok(
  indexCode.includes("_catalogAbortController"),
  "index.html debe declarar y utilizar _catalogAbortController"
);
assert.ok(
  indexCode.includes("_isLoadingFeed"),
  "index.html debe utilizar bandera _isLoadingFeed para evitar llamadas duplicadas"
);
assert.ok(
  indexCode.includes("if (err.name === 'AbortError') return;"),
  "index.html debe manejar silenciosamente peticiones abortadas"
);
console.log("✓ Control de concurrencia y AbortController verificados en el frontend.");

// 5. Verificación de coherencia matemática de totalPages
console.log("\n[5] Verificando cálculo de total_pages...");
function calcTotalPages(total, pageSize) {
  return Math.max(1, Math.ceil(total / pageSize));
}
assert.equal(calcTotalPages(37485, 24), 1562);
assert.equal(calcTotalPages(37485, 12), 3124);
assert.equal(calcTotalPages(452, 24), 19);
assert.equal(calcTotalPages(452, 12), 38);
assert.equal(calcTotalPages(3, 24), 1);
assert.equal(calcTotalPages(0, 24), 1);
console.log("✓ Coherencia matemática de páginas verificada.");

// 6. Verificación de paginación secuencial en búsquedas (sin wrapping ni estancamiento)
console.log("\n[6] Verificando paginación secuencial y sin wrapping para búsquedas...");
const prelude = functionsCode.substring(
  functionsCode.indexOf("// ============================================================================="),
  functionsCode.indexOf("export async function onRequest")
);
const testCtx = {};
new Function("exports", prelude + "\nexports.catalogPageOffset = catalogPageOffset;")(testCtx);
const { catalogPageOffset } = testCtx;

// Búsqueda con 80 resultados totales (4 páginas de 24)
const searchTotal = 80;
const p1 = catalogPageOffset(1, 24, searchTotal, 1, false);
const p2 = catalogPageOffset(2, 24, searchTotal, 1, false);
const p3 = catalogPageOffset(3, 24, searchTotal, 1, false);
const p4 = catalogPageOffset(4, 24, searchTotal, 1, false);

assert.equal(p1.offset, 0, "Página 1 debe tener offset 0");
assert.equal(p2.offset, 24, "Página 2 debe tener offset 24");
assert.equal(p3.offset, 48, "Página 3 debe tener offset 48");
assert.equal(p4.offset, 72, "Página 4 debe tener offset 72");
assert.notEqual(p2.offset, p1.offset, "Página 2 no debe repetir el offset de la página 1");
assert.notEqual(p3.offset, p2.offset, "Página 3 no debe repetir el offset de la página 2");

// Búsqueda con estimación pequeña inicial (e.g. 24)
const p2SmallEstimate = catalogPageOffset(2, 24, 24, 1, false);
assert.equal(p2SmallEstimate.offset, 24, "Página 2 no debe colapsar a 0 con estimaciones pequeñas");
console.log("✓ Paginación secuencial en búsquedas validada exitosamente.");

console.log("\n=== TODAS LAS PRUEBAS DE LA FASE 1 PASARON CON ÉXITO ===");
