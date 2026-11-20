import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

console.log("=== PRESUPUESTO DE PETICIONES Y CACHÉ ===");

const indexHtml = fs.readFileSync(path.join("public", "index.html"), "utf8");
const sw = fs.readFileSync(path.join("public", "sw.js"), "utf8");
const api = fs.readFileSync(path.join("functions", "api", "[[path]].js"), "utf8");
const pagination = fs.readFileSync(path.join("public", "js", "pagination.js"), "utf8");
const router = fs.readFileSync(path.join("public", "js", "router.js"), "utf8");

assert.ok(
  indexHtml.includes("function getResponsiveSrcSet()"),
  "Las tarjetas no deben armar un srcset de varios anchos"
);
assert.ok(
  !indexHtml.includes("live: 'true'"),
  "El catálogo no debe mandar live=true (no lo lee el API y rompe la caché)"
);
assert.ok(
  !indexHtml.includes("params.append('seed'"),
  "El cliente no debe mandar un seed por usuario: impedía compartir la caché de borde"
);
assert.ok(
  indexHtml.includes("_feedLockKey"),
  "fetchLiveFeed debe ignorar una segunda petición idéntica en vuelo"
);
const imageBlock = sw.slice(sw.indexOf("isImageReq"), sw.indexOf("Catálogo de Etiquetas"));
assert.ok(
  imageBlock.includes("if (cached) return cached;"),
  "El service worker debe servir imágenes ya vistas sin revalidarlas"
);
assert.ok(
  !imageBlock.includes("event.waitUntil(fetchPromise)"),
  "Una imagen cacheada no debe disparar otra descarga"
);
assert.ok(
  api.includes("id=lte.${cursorId}"),
  "Las páginas profundas deben usar id=lte en lugar de un OFFSET enorme"
);
assert.ok(
  api.includes("MASTER_INVITE_KEYS"),
  "Las llaves maestras deben salir de la variable de entorno MASTER_INVITE_KEYS"
);
assert.ok(
  !api.includes('const MASTER_KEYS = ["VELVET-VIP-2026"'),
  "Las llaves maestras no deben quedar escritas en el código"
);
assert.ok(
  api.includes("async function updateUserMetadata()"),
  "Los favoritos no deben reescribirse en user_metadata"
);
assert.ok(
  !pagination.includes("live: 'true'"),
  "El prefetch de la página siguiente no debe llevar live=true"
);
assert.ok(
  !router.includes("addEventListener('touchstart'"),
  "El router no debe precargar un detalle en cada toque del móvil"
);

console.log("✓ El catálogo, las portadas y el service worker dejan de multiplicar peticiones.");
