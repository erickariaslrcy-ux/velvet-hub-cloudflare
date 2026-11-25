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
  exports.normalizeUpstreamUrl = normalizeUpstreamUrl;
  exports.inferUpstreamReferer = inferUpstreamReferer;
  exports.hostRejectsImageResize = hostRejectsImageResize;
  exports.alternateCoverUrls = alternateCoverUrls;
  exports.maskCoverFields = maskCoverFields;
  exports.galleryFetchPlan = galleryFetchPlan;
  exports.xasiatAlbumPreview = xasiatAlbumPreview;
  exports.xasiatPhotoThumbnail = xasiatPhotoThumbnail;
  exports.unwrapBuonduaEmbed = unwrapBuonduaEmbed;
  exports.isFollowableMediaRedirect = isFollowableMediaRedirect;
  exports.isGalleryFallbackUrl = isGalleryFallbackUrl;
`);
loadApi(testContext);

const {
  quantizedMediaExpiry,
  catalogIdCursor,
  buildGameCatalogPage,
  isDeadUpstreamError,
  encodeMediaToken,
  decodeMediaToken,
  MEDIA_TOKEN_QUANTUM_SEC,
  normalizeUpstreamUrl,
  inferUpstreamReferer,
  hostRejectsImageResize,
  alternateCoverUrls,
  maskCoverFields,
  galleryFetchPlan,
  xasiatAlbumPreview,
  xasiatPhotoThumbnail,
  unwrapBuonduaEmbed,
  isFollowableMediaRedirect,
  isGalleryFallbackUrl
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

assert.equal(normalizeUpstreamUrl("//i2.buondua.com/a-001.gif"), "https://i2.buondua.com/a-001.gif");
assert.equal(inferUpstreamReferer("https://i2.buondua.com/a-001.gif", ""), "https://buondua.com/");
assert.equal(inferUpstreamReferer("https://cdni.xascdn.li/p.jpg", ""), "https://xasiat.com/");
assert.equal(hostRejectsImageResize("https://i2.buondua.com/a.jpeg"), true);
assert.equal(hostRejectsImageResize("https://mitaku.net/cover.jpg"), false);
const buonAlts = alternateCoverUrls("https://i2.buondua.com/set-001.gif");
assert.ok(buonAlts.some((u) => u.endsWith(".jpeg")), "Un poster gif de buondua tiene foto jpeg de reserva");
assert.ok(!buonAlts.includes("https://i2.buondua.com/set-001.gif"));
const thumbAlts = alternateCoverUrls("https://cdn.example/gallery/thumb.jpg");
assert.ok(thumbAlts.some((u) => u.endsWith("/1.jpg")), "thumb.jpg cae a la primera foto");
const masked = await maskCoverFields("https://i2.buondua.com/set-001.gif", secret);
assert.ok(masked.cover_url.startsWith("/api/media?t="));
assert.ok(masked.cover_fallback.startsWith("/api/media?t="));
assert.notEqual(masked.cover_url, masked.cover_fallback);

const mediaSecret = secret;
async function callMedia(token, query, fetchImpl) {
  const prev = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    return await onRequest({
      request: new Request(`https://www.morbohub.com/api/media?t=${encodeURIComponent(token)}${query || ""}`),
      env: {
        SUPABASE_URL: "http://127.0.0.1:9",
        SUPABASE_ANON_KEY: "anon",
        SUPABASE_SERVICE_ROLE_KEY: "service",
        MEDIA_SECRET: mediaSecret
      },
      waitUntil() {}
    });
  } finally {
    globalThis.fetch = prev;
  }
}

const buonToken = await encodeMediaToken("https://i2.buondua.com/set-001.gif", "", mediaSecret, bucketStart + 20);
const resizeCalls = [];
const buonRes = await callMedia(buonToken, "&w=360&q=70", async (input, init) => {
  resizeCalls.push({
    url: typeof input === "string" ? input : input.url,
    image: !!(init && init.cf && init.cf.image),
    referer: init && init.headers && init.headers.Referer,
    redirect: init && init.redirect
  });
  if (init && init.cf && init.cf.image) {
    return new Response("blocked", { status: 403, headers: { "content-type": "text/plain" } });
  }
  return new Response(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]), {
    status: 200,
    headers: { "content-type": "image/jpeg" }
  });
});
assert.equal(buonRes.status, 200, "La portada de galería no puede redirigir al CDN");
assert.equal((buonRes.headers.get("content-type") || "").includes("image/jpeg"), true);
assert.ok(resizeCalls.every((c) => !c.image), "buondua no pasa por Image Resizing, que tira el Referer");
assert.equal(resizeCalls[0].referer, "https://buondua.com/");
assert.equal(resizeCalls[0].redirect, "manual");
assert.ok(String(resizeCalls[0].url).includes("i0.wp.com/i2.buondua.com/"), "i2.buondua sale por Photon: el CDN responde 403 al worker");

const mitakuToken = await encodeMediaToken("https://mitaku.net/wp-content/uploads/cover.jpg", "", mediaSecret, bucketStart + 20);
const mitakuCalls = [];
const mitakuRes = await callMedia(mitakuToken, "&w=360", async (input, init) => {
  mitakuCalls.push(!!(init && init.cf && init.cf.image));
  if (init && init.cf && init.cf.image) {
    return new Response("<html>hotlink</html>", { status: 403, headers: { "content-type": "text/html" } });
  }
  return new Response(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]), {
    status: 200,
    headers: { "content-type": "image/jpeg" }
  });
});
assert.equal(mitakuRes.status, 200);
assert.deepEqual(mitakuCalls, [true, false], "Si el resize falla se reintenta la imagen original");

const deadToken = await encodeMediaToken("https://i2.buondua.com/missing.jpeg", "", mediaSecret, bucketStart + 20);
const deadRes = await callMedia(deadToken, "&w=360", async () => {
  return new Response("no", { status: 403, headers: { "content-type": "text/html" } });
});
assert.equal(deadRes.status, 502, "Una portada caída no se redirige con 307 al origen");
assert.notEqual(deadRes.status, 307);

const ovhUrl = "https://pmvhavencloud.s3.eu-west-par.io.cloud.ovh.net/video.mp4";
const ovhToken = await encodeMediaToken(ovhUrl, "https://pmvhaven.com/", mediaSecret, bucketStart + 22);
let ovhFetched = false;
const ovhRes = await callMedia(ovhToken, "", async () => {
  ovhFetched = true;
  return new Response("no-stream", { status: 200, headers: { "content-type": "video/mp4" } });
});
assert.equal(ovhFetched, false, "Un mp4 de OVH no se descarga por el Worker");
assert.equal(ovhRes.status, 302);
assert.equal(ovhRes.headers.get("location"), ovhUrl);
assert.equal(ovhRes.headers.get("x-velvet-media"), "direct");

const ovhPlaylist = "https://pmvhavencloud.s3.eu-west-par.io.cloud.ovh.net/master.m3u8";
const ovhPlaylistToken = await encodeMediaToken(ovhPlaylist, "https://pmvhaven.com/", mediaSecret, bucketStart + 22);
const playlistRes = await callMedia(ovhPlaylistToken, "", async () => {
  return new Response("#EXTM3U\nseg.ts\n", {
    status: 200,
    headers: { "content-type": "application/vnd.apple.mpegurl" }
  });
});
assert.equal(playlistRes.status, 200, "Una lista HLS sigue reescribiéndose en el Worker");
assert.equal((playlistRes.headers.get("content-type") || "").includes("mpegurl"), true);

const tubeUrl = "https://pornone.com/clip.mp4";
const tubeToken = await encodeMediaToken(tubeUrl, "", mediaSecret, bucketStart + 22);
const tubeCalls = [];
const tubeRes = await callMedia(tubeToken, "", async (input, init) => {
  tubeCalls.push(init && init.cf && init.cf.cacheTtl);
  return new Response("abcd", {
    status: 206,
    headers: {
      "content-type": "video/mp4",
      "content-range": "bytes 0-3/9",
      "content-length": "4"
    }
  });
});
assert.equal(tubeRes.status, 206, "Un mp4 que exige Referer sigue saliendo por el proxy");
assert.equal(tubeCalls[0], 0, "El proxy de video no cachea el archivo entero");
assert.equal(tubeRes.headers.get("content-range"), "bytes 0-3/9");

const gallerySvg = indexHtml.slice(indexHtml.indexOf("const GALLERY_FALLBACK_SVG"), indexHtml.indexOf("const VIDEO_FALLBACK_SVG"));
const comicSvg = indexHtml.slice(indexHtml.indexOf("const COMIC_FALLBACK_SVG"), indexHtml.indexOf("const GALLERY_FALLBACK_SVG"));
assert.ok(gallerySvg.includes("GALLERY_FALLBACK_SVG"));
assert.equal(gallerySvg.includes("polygon"), false, "El fallback de galería no lleva botón de Play");
assert.equal(comicSvg.includes("polygon"), false, "El fallback de cómic no lleva botón de Play");
assert.ok(indexHtml.includes("Ver Galería"));
assert.ok(indexHtml.includes("Fotos"));
assert.ok(indexHtml.includes("fa-arrow-down-wide-short"));
assert.ok(indexHtml.includes('class="hidden md:flex h-10 px-3 rounded-xl bg-gradient-to-r from-[#ff2d95] to-[#8b3dff]'));

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
assert.equal(coverWatchdogMs({ connection: { effectiveType: "2g" } }), 20000);
assert.equal(coverWatchdogMs({ connection: { effectiveType: "4g" } }), 20000);

const xasiatBlocked = "https://www.xasiat.com/get_image/2/abc/sources/36000/36203/2534993.jpg/?i-acctoken=abc";
assert.equal(
  xasiatAlbumPreview(xasiatBlocked),
  "https://pic.xascdn.li/contents/albums/preview/380x507/36000/36203/preview.jpg"
);
assert.equal(
  unwrapBuonduaEmbed("https://cdn.buondua.com/pok.misskon.com/images/2025/12/30/a.webp?hash?other"),
  "https://pok.misskon.com/images/2025/12/30/a.webp"
);
const buonPlan = galleryFetchPlan("https://i2.buondua.com/2025/51077/XIUREN-No.10975.jpeg?e068?c3e9");
assert.ok(buonPlan[0].startsWith("https://i0.wp.com/i2.buondua.com/2025/51077/XIUREN-No.10975.jpeg?"));
assert.ok(buonPlan.includes("https://i2.buondua.com/2025/51077/XIUREN-No.10975.jpeg?e068?c3e9"));
const xasiatPlan = galleryFetchPlan(xasiatBlocked);
assert.equal(xasiatPlan[0], "https://pic.xascdn.li/contents/albums/preview/380x507/36000/36203/preview.jpg");
assert.equal(isGalleryFallbackUrl("https://evil.example/secret"), false);
assert.equal(isFollowableMediaRedirect("https://169.254.169.254/latest", "https://pic.4khd.com/a.webp"), false);
assert.equal(
  isFollowableMediaRedirect(
    "https://yt4.googleusercontent.com/a.webp",
    "https://pic.4khd.com/a.webp"
  ),
  true
);

const jpeg = () => new Response(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]), {
  status: 200,
  headers: { "content-type": "image/jpeg" }
});
const blockedHtml = () => new Response("<html>Attention Required</html>", {
  status: 403,
  headers: { "content-type": "text/html" }
});

const xasiatToken = await encodeMediaToken(xasiatBlocked, "", mediaSecret, bucketStart + 20);
const xasiatCalls = [];
const xasiatRes = await callMedia(xasiatToken, "&w=360", async (input) => {
  const url = typeof input === "string" ? input : input.url;
  xasiatCalls.push(url);
  if (url.includes("pic.xascdn.li")) return jpeg();
  return blockedHtml();
});
assert.equal(xasiatRes.status, 200, "La portada xasiat sale de la preview de xascdn");
assert.equal(xasiatRes.headers.get("X-Velvet-Media"), "mirror");
assert.ok(xasiatCalls[0].includes("/380x507/36000/36203/preview.jpg"));
assert.equal(xasiatCalls.some((u) => u.includes("xasiat.com/get_image")), false);

// [VERIFICACIÓN DEL LECTOR DE GALERÍAS (w=0)]
const xasiatReaderPlan = galleryFetchPlan(xasiatBlocked, 0);
assert.equal(xasiatReaderPlan[0], xasiatBlocked, "En el visor/lector (w=0) la primera opción es la foto original");
assert.equal(
  xasiatReaderPlan[1],
  "https://pic.xascdn.li/contents/albums/main/200x150/36000/36203/2534993.jpg",
  "Segunda opción en el visor es la miniatura individual de la foto en xascdn (no repite la portada)"
);
assert.equal(
  xasiatReaderPlan[2],
  "https://pic.xascdn.li/contents/albums/preview/380x507/36000/36203/preview.jpg",
  "Última opción en el visor es la portada como fallback"
);

const xasiatReaderCalls = [];
const xasiatReaderRes = await callMedia(xasiatToken, "", async (input) => {
  const url = typeof input === "string" ? input : input.url;
  xasiatReaderCalls.push(url);
  // Simular que xasiat original responde 403 y se recurre al CDN individual
  if (url.includes("/main/200x150/36000/36203/2534993.jpg")) return jpeg();
  return blockedHtml();
});
assert.equal(xasiatReaderRes.status, 200, "La foto de página sale del CDN individual");
assert.equal(xasiatReaderCalls[0], xasiatBlocked, "El visor intenta la foto original primero");
assert.ok(
  xasiatReaderCalls[1].includes("/main/200x150/36000/36203/2534993.jpg"),
  "Si falla la original, el visor usa la foto individual y no la portada repetida"
);

const hdUrl = "https://pic.4khd.com/album/w1090-h1500-p-k-no-rw/4KHD-beautifulGirls.webp";
const hdToken = await encodeMediaToken(hdUrl, "", mediaSecret, bucketStart + 20);
const hdCalls = [];
const hdRes = await callMedia(hdToken, "", async (input) => {
  const url = typeof input === "string" ? input : input.url;
  hdCalls.push(url);
  if (url.startsWith("https://pic.4khd.com/")) {
    return new Response(null, {
      status: 301,
      headers: { location: "https://yt4.googleusercontent.com/album/4KHD-beautifulGirls.webp", "content-type": "text/html" }
    });
  }
  if (url.includes("googleusercontent.com")) return jpeg();
  return blockedHtml();
});
assert.equal(hdRes.status, 200, "pic.4khd.com se sigue hasta googleusercontent");
assert.ok(hdCalls.some((u) => u.includes("yt4.googleusercontent.com")));
assert.equal(hdCalls.some((u) => u.includes("169.254.169.254")), false);

const evilToken = await encodeMediaToken(hdUrl, "", mediaSecret, bucketStart + 21);
const evilCalls = [];
const evilRes = await callMedia(evilToken, "", async (input) => {
  const url = typeof input === "string" ? input : input.url;
  evilCalls.push(url);
  if (url.startsWith("https://pic.4khd.com/")) {
    return new Response("no", {
      status: 301,
      headers: { location: "https://169.254.169.254/latest/meta-data", "content-type": "text/html" }
    });
  }
  return blockedHtml();
});
assert.equal(evilRes.status, 502, "Un redirect de 4khd a metadata no se sigue");
assert.equal(evilCalls.some((u) => u.includes("169.254.169.254")), false);

const embedUrl = "https://cdn.buondua.com/pok.misskon.com/images/2025/12/30/cover.webp?aaaa?bbbb";
const embedToken = await encodeMediaToken(embedUrl, "", mediaSecret, bucketStart + 20);
const embedCalls = [];
const embedRes = await callMedia(embedToken, "", async (input) => {
  const url = typeof input === "string" ? input : input.url;
  embedCalls.push(url);
  if (url.startsWith("https://pok.misskon.com/images/")) return jpeg();
  return blockedHtml();
});
assert.equal(embedRes.status, 200, "cdn.buondua.com se abre en pok.misskon.com");
assert.equal(embedCalls[0], "https://pok.misskon.com/images/2025/12/30/cover.webp");

assert.ok(sw.includes("v23-morbo-name") || sw.includes("v24-subscriptions-fix") || sw.includes("v25-cloud-favorites") || sw.includes("v26-security-audit") || sw.includes("v27-vault-pagination") || sw.includes("v28-clean-vault-titles") || sw.includes("v29-random-disjoint-ui"), "El service worker purga la caché vieja de portadas");
assert.ok(sw.includes("req.destination === 'video'"), "El service worker no intercepta la reproducción");
assert.ok(sw.includes("function isUsableCoverResponse"), "El service worker descarta SVG y 403 cacheados");

console.log("✓ Galería aleatoria, juegos sin 500, tokens estables y portadas resilientes.");
