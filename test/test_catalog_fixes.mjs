import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { onRequest } from "../functions/api/[[path]].js";

console.log("=== CATÁLOGO, JUEGOS, TOKENS DE MEDIA Y PORTADAS ===");

const apiPath = path.join("functions", "api", "[[path]].js");
const api = fs.readFileSync(apiPath, "utf8");
const indexHtml = fs.readFileSync(path.join("public", "index.html"), "utf8");
const sw = fs.readFileSync(path.join("public", "sw.js"), "utf8");

assert.ok(!api.includes("estimatedTotal - offset"), "El cursor de id no puede restar el conteo estimado");
assert.ok(!api.includes("${SUPABASE_URL_DB2}/rest/v1/items"), "Los juegos no pueden consultar el Supabase DB2 que ya no resuelve");
assert.ok(api.includes("id=lte.${cursorId}"), "Las páginas profundas siguen usando id=lte sobre el id real");
assert.ok(api.includes("degraded: true"), "Un fallo de juegos debe degradar con HTTP 200, no con 500");
assert.ok(api.includes("function quantizedMediaExpiry"), "La expiración del token de media debe estar cuantizada");
assert.ok(indexHtml.includes("function settleCoverImages"), "El cliente debe asentar portadas que ya vienen de caché");
assert.ok(indexHtml.includes('data-media-type="game"'), "Las portadas de juegos pasan por el mismo asentador");
assert.ok(sw.includes("attempt < 2"), "El service worker reintenta una imagen abortada antes del fallback");

const prelude = api.substring(
  api.indexOf("// ============================================================================="),
  api.indexOf("export async function onRequest")
);
const testContext = {};
const loadApi = new Function("exports", prelude + `
  exports.quantizedMediaExpiry = quantizedMediaExpiry;
  exports.catalogIdCursor = catalogIdCursor;
  exports.buildGameCatalogPage = buildGameCatalogPage;
  exports.isDeadUpstreamError = isDeadUpstreamError;
  exports.encodeMediaToken = encodeMediaToken;
  exports.decodeMediaToken = decodeMediaToken;
  exports.MEDIA_TOKEN_QUANTUM_SEC = MEDIA_TOKEN_QUANTUM_SEC;
`);
loadApi(testContext);

const {
  quantizedMediaExpiry,
  catalogIdCursor,
  buildGameCatalogPage,
  isDeadUpstreamError,
  encodeMediaToken,
  decodeMediaToken,
  MEDIA_TOKEN_QUANTUM_SEC
} = testContext;

const quantum = MEDIA_TOKEN_QUANTUM_SEC;
const bucketStart = Math.floor(1796356440 / quantum) * quantum;
assert.equal(quantizedMediaExpiry(bucketStart + 10), quantizedMediaExpiry(bucketStart + quantum - 5));
assert.equal(quantizedMediaExpiry(1796356440), quantizedMediaExpiry(1796356449));
assert.notEqual(quantizedMediaExpiry(bucketStart), quantizedMediaExpiry(bucketStart + quantum));
assert.ok(quantizedMediaExpiry(bucketStart) > bucketStart + 13 * 24 * 60 * 60);

const secret = "test_media_secret_secure_key_2026_subtle_crypto";
const sampleUrl = "https://mitaku.net/wp-content/uploads/2025/12/cover.jpg";
const tokenA = await encodeMediaToken(sampleUrl, "", secret, bucketStart + 20);
const tokenB = await encodeMediaToken(sampleUrl, "", secret, bucketStart + 4000);
const tokenC = await encodeMediaToken(sampleUrl, "", secret, bucketStart + quantum + 20);
assert.equal(tokenA, tokenB, "La misma portada debe producir la misma URL durante toda la semana");
assert.notEqual(tokenA, tokenC, "La URL rota al cambiar de semana");
const decoded = await decodeMediaToken(tokenA, secret);
assert.equal(decoded.u, sampleUrl);
assert.equal(decoded.exp, quantizedMediaExpiry(bucketStart + 20));

function pageFromCursor(ids, cursor, pageSize, maxId) {
  const below = ids.filter((id) => id <= cursor).sort((a, b) => b - a).slice(0, pageSize);
  if (below.length >= pageSize) return below;
  const seen = new Set(below);
  const top = ids.filter((id) => id <= maxId).sort((a, b) => b - a);
  for (const id of top) {
    if (below.length >= pageSize) break;
    if (!seen.has(id)) below.push(id);
  }
  return below;
}

const galleryMin = 380391;
const galleryMax = 398651;
const galleryIds = [];
for (let id = galleryMin; id <= galleryMax; id++) galleryIds.push(id);

const randomCursor = catalogIdCursor({
  minId: galleryMin,
  maxId: galleryMax,
  page: 1,
  pageSize: 24,
  seed: 22424,
  random: true
});
assert.ok(randomCursor >= galleryMin && randomCursor <= galleryMax, "sort=random debe caer dentro de los ids reales de galería");
assert.equal(pageFromCursor(galleryIds, randomCursor, 24, galleryMax).length, 24);
assert.equal(galleryIds.filter((id) => id <= 16052).length, 0, "El cursor viejo (conteo 18260) no toca ninguna galería");

for (const page of [1, 2, 20, 80]) {
  const cursor = catalogIdCursor({
    minId: galleryMin,
    maxId: galleryMax,
    page,
    pageSize: 24,
    seed: 1,
    random: false
  });
  assert.equal(pageFromCursor(galleryIds, cursor, 24, galleryMax).length, 24, `galería página ${page} completa`);
}

const comicCursor = catalogIdCursor({
  minId: 1200,
  maxId: 374460,
  page: 30,
  pageSize: 24,
  seed: 1,
  random: false
});
assert.ok(comicCursor > 300000 && comicCursor <= 374460, "La página 30 de cómics sale del extremo alto, no del conteo 37485");

for (const [minId, maxId] of [[1, 20242], [1, 8032], [370000, 398651]]) {
  for (const page of [1, 12, 40]) {
    const cursor = catalogIdCursor({ minId, maxId, page, pageSize: 24, seed: 99, random: true });
    assert.ok(cursor >= minId && cursor <= maxId, `cursor aleatorio dentro de ${minId}..${maxId} pág ${page}`);
    const spanIds = [minId, minId + 1, maxId - 1, maxId];
    assert.ok(pageFromCursor(spanIds.concat(Array.from({ length: 30 }, (_, i) => minId + i)), cursor, 24, maxId).length > 0);
  }
}

const games = Array.from({ length: 40 }, (_, i) => ({
  id: i + 1,
  title: i === 3 ? "Deep Vault 69" : `Game ${i}`,
  cover_url: "https://gamcore.com/f/w/d/deep_vault_69.webp",
  embed_url: "https://fgn.cdn.serverable.com/common/flashes/nf/deep_vault_69/v_0.7.11/index.html",
  media_type: "game",
  tags: i % 2 ? ["Flash"] : ["Ren'Py", "Adventure"],
  engine: i % 2 ? "Flash" : "Ren'Py",
  game_type: i % 2 ? "flash" : "html5",
  plays: 1000 - i,
  rating: 70 + (i % 10),
  source: "gamcore",
  source_id: `g${i}`
}));
const gamePage = buildGameCatalogPage(games, { page: 1, pageSize: 24, sort: "random", seed: 7 });
const gamePageAgain = buildGameCatalogPage(games, { page: 1, pageSize: 24, sort: "random", seed: 7 });
assert.equal(gamePage.items.length, 24);
assert.equal(gamePage.total, 40);
assert.deepEqual(gamePage.items.map((g) => g.id), gamePageAgain.items.map((g) => g.id));
const deepGames = buildGameCatalogPage(games, { page: 2, pageSize: 24, sort: "popular", seed: 1 });
assert.equal(deepGames.items.length, 16);
assert.ok(deepGames.items[0].plays >= deepGames.items[deepGames.items.length - 1].plays);
assert.equal(isDeadUpstreamError(500, "error code: 1016\n"), true);
assert.equal(isDeadUpstreamError(1016, ""), true);
assert.equal(isDeadUpstreamError(200, "ok"), false);

const gameSecret = "test_media_secret_secure_key_2026_subtle_crypto";
const sampleGames = games.slice(0, 5);
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
  throw new Error("getaddrinfo ENOTFOUND vtyleivfovkolpxjjkjs.supabase.co error code: 1016");
};
try {
  const deadAgain = await onRequest({
    request: new Request("https://morbohub.pages.dev/api/items?media_type=game&sort=random&page=1&page_size=24"),
    env: {
      SUPABASE_URL: "http://127.0.0.1:9",
      SUPABASE_ANON_KEY: "anon",
      SUPABASE_SERVICE_ROLE_KEY: "service",
      MEDIA_SECRET: gameSecret,
      ASSETS: { fetch: async () => new Response("error code: 1016\n", { status: 502 }) }
    },
    waitUntil() {}
  });
  assert.equal(deadAgain.status, 200, "media_type=game no debe responder 500 si el origen DNS falla");
  const deadBody = await deadAgain.json();
  assert.equal(deadBody.degraded, true);
  assert.deepEqual(deadBody.items, []);
} finally {
  globalThis.fetch = originalFetch;
}

const okRes = await onRequest({
  request: new Request("https://morbohub.pages.dev/api/items?media_type=game&sort=popular&page=1&page_size=24"),
  env: {
    SUPABASE_URL: "http://127.0.0.1:9",
    SUPABASE_ANON_KEY: "anon",
    SUPABASE_SERVICE_ROLE_KEY: "service",
    MEDIA_SECRET: gameSecret,
    ASSETS: {
      fetch: async () => new Response(JSON.stringify(sampleGames), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    }
  },
  waitUntil() {}
});
assert.equal(okRes.status, 200);
const okBody = await okRes.json();
assert.equal(okBody.items.length, 5);
assert.ok(okBody.items[0].cover_url.startsWith("/api/media?t="), "La portada del juego sale por /api/media");
assert.ok(okBody.items.every((it) => it.embed_url || it.swf_url), "Cada juego trae URL para jugar");

const coverSrc = fs.readFileSync(path.join("public", "js", "image-loader.js"), "utf8");
const coverSb = { globalThis: {} };
coverSb.globalThis = coverSb;
vm.createContext(coverSb);
vm.runInContext(coverSrc, coverSb);
const { coverLoadDecision, coverWatchdogMs } = coverSb.VelvetCovers;

assert.equal(coverLoadDecision({
  settled: false, complete: true, naturalWidth: 320, elapsedMs: 0, retries: 0, watchdogMs: 8000
}), "reveal", "Una portada ya cacheada se revela aunque no vuelva a disparar onload");
assert.equal(coverLoadDecision({
  settled: false, failed: true, complete: true, naturalWidth: 0, elapsedMs: 8000, retries: 0, watchdogMs: 8000
}), "retry", "Un abort o error se reintenta una vez");
assert.equal(coverLoadDecision({
  settled: false, failed: true, complete: true, naturalWidth: 0, elapsedMs: 8000, retries: 1, watchdogMs: 8000
}), "fallback", "El segundo fallo muestra la portada de reserva");
assert.equal(coverLoadDecision({
  settled: false, complete: false, naturalWidth: 0, elapsedMs: 8000, retries: 0, watchdogMs: 8000
}), "retry", "Un watchdog suelta la cola si la imagen no termina");
assert.equal(coverLoadDecision({
  settled: true, complete: false, naturalWidth: 0, elapsedMs: 9000, retries: 0, watchdogMs: 8000
}), "done");
assert.equal(coverWatchdogMs({ connection: { effectiveType: "2g" } }), 12000);
assert.equal(coverWatchdogMs({ connection: { effectiveType: "4g" } }), 8000);

console.log("✓ Galería aleatoria, juegos sin 500, tokens estables y portadas resilientes.");
