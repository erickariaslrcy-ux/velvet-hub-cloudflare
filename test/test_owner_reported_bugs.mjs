import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { onRequest } from "../functions/api/[[path]].js";

console.log("=== BUGS DEL DUEÑO: ROTACIÓN, PÁGINAS PROFUNDAS, BÓVEDA, MENÚ Y MÓVIL ===");

const apiPath = path.join("functions", "api", "[[path]].js");
const api = fs.readFileSync(apiPath, "utf8");
const indexHtml = fs.readFileSync(path.join("public", "index.html"), "utf8");
const personal = fs.readFileSync(path.join("public", "js", "personal-data.js"), "utf8");
const vault = fs.readFileSync(path.join("public", "js", "vault.js"), "utf8");
const router = fs.readFileSync(path.join("public", "js", "router.js"), "utf8");
const inputCss = fs.readFileSync(path.join("src", "input.css"), "utf8");

const prelude = api.substring(
  api.indexOf("// ============================================================================="),
  api.indexOf("export async function onRequest")
);
const testContext = {};
const loadApi = new Function("exports", prelude + `
  exports.rotationSlot = rotationSlot;
  exports.orderCatalogForSlot = orderCatalogForSlot;
  exports.sliceCatalogIds = sliceCatalogIds;
  exports.catalogPageOffset = catalogPageOffset;
  exports.permutePageIndex = permutePageIndex;
  exports.ROTATION_WINDOW_MS = ROTATION_WINDOW_MS;
`);
loadApi(testContext);

const {
  rotationSlot,
  orderCatalogForSlot,
  sliceCatalogIds,
  catalogPageOffset,
  permutePageIndex,
  ROTATION_WINDOW_MS
} = testContext;

assert.equal(ROTATION_WINDOW_MS, 3 * 3600 * 1000);
const slotA = rotationSlot(1_700_000_000_000);
const slotB = rotationSlot(1_700_000_000_000 + ROTATION_WINDOW_MS);
assert.notEqual(slotA, slotB);
assert.equal(rotationSlot(1_700_000_000_000 + 1000), slotA);
assert.equal(slotA, Math.floor(1_700_000_000_000 / (3 * 3600 * 1000)));

const mediaTypes = ["comic", "video", "gallery", "game"];
for (const mediaType of mediaTypes) {
  const items = Array.from({ length: 48 }, (_, i) => ({
    id: mediaType === "video" ? `vid_${i}_${mediaType}` : (1000 + i * 3),
    title: `${mediaType} ${i}`
  }));
  const first = orderCatalogForSlot(items, slotA, mediaType).map((it) => it.id);
  const again = orderCatalogForSlot(items, slotA, mediaType).map((it) => it.id);
  const other = orderCatalogForSlot(items, slotB, mediaType).map((it) => it.id);
  assert.deepEqual(first, again, `${mediaType} debe ser estable dentro de la misma ventana`);
  assert.notDeepEqual(first, other, `${mediaType} debe cambiar de orden al cambiar la ventana de 3 horas`);
  assert.equal(first.length, items.length);
}

const gapped = [];
for (let n = 0; n < 20000; n++) gapped.push(500000 - n * 17);
const page494 = sliceCatalogIds(gapped, 494, 24, slotA, true);
const page495 = sliceCatalogIds(gapped, 495, 24, slotA, true);
const page496 = sliceCatalogIds(gapped, 496, 24, slotA, true);
assert.equal(page494.ids.length, 24);
assert.equal(page495.ids.length, 24);
assert.equal(page496.ids.length, 24);
assert.notDeepEqual(page494.ids, page495.ids);
assert.notDeepEqual(page495.ids, page496.ids);
assert.equal(page494.ids.filter((id) => page495.ids.includes(id)).length, 0);
assert.equal(page495.ids.filter((id) => page496.ids.includes(id)).length, 0);
const plan494 = catalogPageOffset(494, 24, gapped.length, slotA, true);
const plan495 = catalogPageOffset(495, 24, gapped.length, slotA, true);
assert.notEqual(plan494.offset, plan495.offset);
assert.notEqual(permutePageIndex(493, plan494.totalPages, slotA), permutePageIndex(494, plan495.totalPages, slotA));
const page1 = sliceCatalogIds(gapped, 1, 24, slotA, true);
const page2 = sliceCatalogIds(gapped, 2, 24, slotA, true);
assert.notDeepEqual(page1.ids, page2.ids);
const rotatedHome = sliceCatalogIds(gapped, 1, 24, slotB, true);
assert.notDeepEqual(page1.ids, rotatedHome.ids);

assert.ok(api.includes('searchParams.set("rot"'), "La caché de borde debe variar con la ventana de 3 horas");
assert.ok(api.includes("const catalogSlot = Math.floor(Date.now() / (3 * 3600 * 1000));"));
assert.ok(api.includes("id=lte.${cursorId}"));
assert.ok(api.includes("postgrestUrl.replace(/offset=\\d+/, 'offset=0')"));
assert.ok(api.includes("fetchPmvPage = ((randomBasePage + (page - 1) * 3) % 2500) + 1;"));
assert.ok(api.includes('const isRandomMode = (sort === "random" || seedParam > 0) && !q && !tag && (!category || category === "all");'));
assert.ok(!indexHtml.includes("velvet_user_rot_salt"), "La rotación no puede depender de una sal por usuario");
assert.ok(indexHtml.includes("Math.floor(Date.now() / (3 * 3600 * 1000))"));

assert.ok(!indexHtml.includes('onclick="handleUserButtonClick()"'), "El botón de perfil no debe dispararse dos veces");
assert.ok(indexHtml.includes('data-action="user-button"'));
assert.ok(indexHtml.includes("window.handleUserButtonClick = handleUserButtonClick"));
assert.ok(indexHtml.includes("Mi Bóveda / Favoritos"));
assert.ok(indexHtml.includes("Mi Historial"));
assert.ok(indexHtml.includes("Detalles de Cuenta / Configuración"));
assert.ok(indexHtml.includes("Cerrar Sesión"));
assert.ok(indexHtml.includes('aria-controls="user-dropdown-menu"'));

assert.ok(personal.includes("hydrateCanonicalCache"));
assert.ok(personal.includes("vault-stats-favs"));
assert.ok(personal.includes("vault-stats-hist"));
assert.ok(vault.includes("favState.total"));
assert.ok(vault.includes("gap-2"));
assert.ok(api.includes("degraded: true"));
assert.ok(api.includes("decodeJwtPayload"));

assert.ok(indexHtml.includes('id="mob-mode-switch"'));
assert.ok(/id="mob-mode-switch"[^>]*hidden/.test(indexHtml));
assert.ok(indexHtml.includes('data-nav="account"'));
assert.ok(indexHtml.includes('data-nav="vault"'));
assert.ok(indexHtml.includes('data-nav="comics"'));
assert.ok(router.includes("syncMobileNav"));
assert.ok(router.includes("tab-btn-account"));
assert.ok(router.includes("mob-tab-active"));
assert.ok(inputCss.includes(".mob-tab-active"));
assert.ok(inputCss.includes("#brand-wordmark"));
assert.ok(indexHtml.includes("whitespace-nowrap"));
assert.ok(indexHtml.includes("catalog-tight"));
assert.ok(!/id="home-view"[^>]*\bflex-1\b/.test(indexHtml));

assert.ok(!indexHtml.includes("v11-velvet-turbo"));
assert.ok(!indexHtml.includes("Cloudflare Pages Native"));
assert.ok(indexHtml.includes("Descargo de responsabilidad"));
assert.ok(indexHtml.includes("DMCA / Retiro de contenido"));
assert.ok(indexHtml.includes("Términos de uso"));
assert.ok(indexHtml.includes("Privacidad"));
assert.ok(indexHtml.includes("Solo +18"));
assert.ok(indexHtml.includes('id="legal-modal"'));
assert.ok(indexHtml.includes("no se alojan ni se guardan"));

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

const liveToken = `${b64url({ alg: "none", typ: "JWT" })}.${b64url({
  sub: "user-fav-1",
  exp: Math.floor(Date.now() / 1000) + 3600,
  email: "erick@velvet.test",
  user_metadata: { username: "erickariasmpnv" }
})}.sig`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname === "/auth/v1/user") {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "auth down" }));
    return;
  }
  if (url.pathname === "/rest/v1/favorites") {
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Content-Range": "0-1/2"
    });
    res.end(JSON.stringify([
      { item_id: 11, created_at: "2026-11-01T00:00:00Z", items: { id: 11, title: "Uno", media_type: "comic", status: "ok" } },
      { item_id: 22, created_at: "2026-11-02T00:00:00Z", items: { id: 22, title: "Dos", media_type: "video", status: "ok" } }
    ]));
    return;
  }
  if (url.pathname === "/rest/v1/user_history") {
    res.writeHead(200, { "Content-Type": "application/json", "Content-Range": "0-0/0" });
    res.end("[]");
    return;
  }
  if (url.pathname === "/rest/v1/user_preferences") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("[]");
    return;
  }
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end("{}");
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const env = {
  SUPABASE_URL: `http://127.0.0.1:${port}`,
  SUPABASE_ANON_KEY: "anon-test",
  SUPABASE_SERVICE_ROLE_KEY: "service-test",
  MEDIA_SECRET: "media-secret-for-owner-bugs-32chars"
};

const fav = await onRequest({
  request: new Request("https://www.morbohub.com/api/user/favorites", {
    headers: { Authorization: `Bearer ${liveToken}` }
  }),
  env,
  params: {},
  waitUntil: () => {}
});
assert.equal(fav.status, 200, "Un GoTrue caído no debe convertir un JWT vigente en 503");
const favBody = await fav.json();
assert.equal(favBody.total, 2);
assert.equal(favBody.items.length, 2);
assert.equal(favBody.items[0].id, 11);

const hist = await onRequest({
  request: new Request("https://www.morbohub.com/api/user/history", {
    headers: { Authorization: `Bearer ${liveToken}` }
  }),
  env,
  params: {},
  waitUntil: () => {}
});
assert.equal(hist.status, 200);

const prefs = await onRequest({
  request: new Request("https://www.morbohub.com/api/user/preferences", {
    headers: { Authorization: `Bearer ${liveToken}` }
  }),
  env,
  params: {},
  waitUntil: () => {}
});
assert.equal(prefs.status, 200);

const broken = await onRequest({
  request: new Request("https://www.morbohub.com/api/favorites", {
    headers: { Authorization: "Bearer not-a-jwt" }
  }),
  env,
  params: {},
  waitUntil: () => {}
});
assert.equal(broken.status, 503);

server.close();
console.log("✓ Rotación de 3 h, páginas 494/495, bóveda sin 503 falso, menú y layout móvil quedan cubiertos.");
