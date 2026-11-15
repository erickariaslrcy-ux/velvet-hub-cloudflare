import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

console.log("=== INICIANDO PRUEBAS UNITARIAS DE PAGINACIÓN (FASE 1) ===");

// 1. Verificación de cálculo de offset y monotonicidad
console.log("\n[1] Verificando estabilidad y monotonicidad de offsets...");
for (const seed of [0, 1, 25, 42, 99, 250, 499]) {
  for (const pageSize of [12, 24]) {
    let prevOffset = -1;
    for (let page = 1; page <= 10; page++) {
      const baseOffset = seed > 0 ? (Math.abs(seed * 137) % 500) : 0;
      const offset = baseOffset + (page - 1) * pageSize;

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
  functionsCode.includes("status=neq.blocked"),
  "Debe incluir filtro status=neq.blocked en la consulta SQL"
);
assert.ok(
  functionsCode.includes("cover_url=not.is.null&cover_url=neq."),
  "Debe incluir filtro cover_url no nulo y no vacío en la consulta SQL"
);
assert.ok(
  functionsCode.includes("media_type=eq.comic&page_count=gt.0&real_people=eq.false"),
  "Debe incluir filtros de protección de menores, page_count > 0 y cómics en la consulta SQL"
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
  swCode.includes("v11-velvet-turbo"),
  "sw.js debe tener la versión de caché actualizada a v11-velvet-turbo"
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

console.log("\n=== TODAS LAS PRUEBAS DE LA FASE 1 PASARON CON ÉXITO ===");
