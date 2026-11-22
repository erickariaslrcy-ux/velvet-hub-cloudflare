import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { onRequest } from "../functions/api/[[path]].js";

console.log("=== AL AZAR: SEMILLA NUEVA, CATÁLOGO COMPLETO Y ROTACIÓN DE 3 H ===");

const apiPath = path.join("functions", "api", "[[path]].js");
const api = fs.readFileSync(apiPath, "utf8");
const indexHtml = fs.readFileSync(path.join("public", "index.html"), "utf8");
const pagination = fs.readFileSync(path.join("public", "js", "pagination.js"), "utf8");

const prelude = api.substring(
  api.indexOf("// ============================================================================="),
  api.indexOf("export async function onRequest")
);
const testContext = {};
const loadApi = new Function("exports", prelude + `
  exports.planShuffleWindows = planShuffleWindows;
  exports.assembleShufflePage = assembleShufflePage;
  exports.pmvPageNumbers = pmvPageNumbers;
  exports.readShuffleSeed = readShuffleSeed;
  exports.rotationSlot = rotationSlot;
  exports.catalogResponseCacheHeaders = catalogResponseCacheHeaders;
  exports.SHUFFLE_NO_STORE = SHUFFLE_NO_STORE;
  exports.ROTATION_WINDOW_MS = ROTATION_WINDOW_MS;
`);
loadApi(testContext);

const {
  planShuffleWindows,
  assembleShufflePage,
  pmvPageNumbers,
  readShuffleSeed,
  rotationSlot,
  catalogResponseCacheHeaders,
  SHUFFLE_NO_STORE,
  ROTATION_WINDOW_MS
} = testContext;

assert.equal(ROTATION_WINDOW_MS, 3 * 3600 * 1000);
assert.equal(rotationSlot(1_700_000_000_000), rotationSlot(1_700_000_000_000 + 1000));
assert.notEqual(rotationSlot(1_700_000_000_000), rotationSlot(1_700_000_000_000 + ROTATION_WINDOW_MS));
assert.equal(readShuffleSeed("0"), 0);
assert.equal(readShuffleSeed("11"), 11);
assert.equal(readShuffleSeed("1000001"), 1000001, "Un nonce mayor que 1e6 no puede aplastarse al mismo tope");
assert.ok(SHUFFLE_NO_STORE.includes("no-store"));
assert.equal(catalogResponseCacheHeaders(false, "public, max-age=60, s-maxage=120")["Cache-Control"].includes("public"), true);
assert.equal(catalogResponseCacheHeaders(false, "public, max-age=60, s-maxage=120")["Cache-Control"].includes("no-store"), false);
assert.equal(catalogResponseCacheHeaders(true, "public, max-age=60")["CDN-Cache-Control"], "no-store");

function rowsBelow(idsDesc, anchor, take) {
  const rows = [];
  for (const id of idsDesc) {
    if (id <= anchor) rows.push({ id, title: `Item ${id}` });
    if (rows.length >= take) break;
  }
  return rows;
}

function pageFromPlan(ids, seed, page, pageSize) {
  const minId = ids[0];
  const maxId = ids[ids.length - 1];
  const plan = planShuffleWindows({
    total: ids.length,
    minId,
    maxId,
    page,
    pageSize,
    seed,
    bands: 4
  });
  const desc = ids.slice().reverse();
  const bands = plan.windows.map((w) => rowsBelow(desc, w.anchorId, w.take));
  return { plan, items: assembleShufflePage(bands, pageSize, seed + page * 997) };
}

function assertSpread(items, minId, maxId, label) {
  const ids = items.map((it) => it.id);
  assert.equal(ids.length, 24, `${label} debe llenar la página`);
  assert.equal(new Set(ids).size, ids.length, `${label} no repite ids dentro de la página`);
  assert.ok(Math.min(...ids) >= minId && Math.max(...ids) <= maxId, `${label} se sale del rango real`);
  const span = maxId - minId;
  assert.ok(Math.max(...ids) - Math.min(...ids) > span * 0.5, `${label} no cruza el catálogo`);
  assert.ok(Math.min(...ids) < minId + span * 0.34, `${label} no toca la zona baja`);
  assert.ok(Math.max(...ids) > minId + span * 0.66, `${label} no toca la zona alta`);
}

const galleryIds = [];
for (let id = 380391; id <= 398650; id++) galleryIds.push(id);
const gappedComicIds = [];
for (let id = 1200; id <= 374000; id += 17) gappedComicIds.push(id);

for (const [label, ids] of [["gallery", galleryIds], ["comic", gappedComicIds]]) {
  const minId = ids[0];
  const maxId = ids[ids.length - 1];
  const a = pageFromPlan(ids, 11, 1, 24);
  const aAgain = pageFromPlan(ids, 11, 1, 24);
  const b = pageFromPlan(ids, 90210, 1, 24);
  const page2 = pageFromPlan(ids, 11, 2, 24);
  assertSpread(a.items, minId, maxId, label);
  assertSpread(b.items, minId, maxId, label);
  assert.deepEqual(a.items.map((it) => it.id), aAgain.items.map((it) => it.id), `${label} es estable con la misma semilla`);
  assert.notDeepEqual(a.items.map((it) => it.id), b.items.map((it) => it.id), `${label} cambia con otra semilla de Al Azar`);
  assert.notDeepEqual(a.items.map((it) => it.id), page2.items.map((it) => it.id), `${label} página 2 no repite la página 1`);
  assert.equal(page2.items.length, 24, `${label} página 2 no queda vacía por huecos`);
  const low = Math.min(...a.plan.windows.map((w) => w.anchorId));
  const high = Math.max(...a.plan.windows.map((w) => w.anchorId));
  assert.ok(low < minId + (maxId - minId) * 0.34, `${label} ancla baja`);
  assert.ok(high > minId + (maxId - minId) * 0.66, `${label} ancla alta`);
  assert.ok(a.items.every((it) => it.id >= minId), `${label} no puede devolver ids por debajo del mínimo real`);
}

const pagesA = pmvPageNumbers(11, 1, 24, 2500);
const pagesB = pmvPageNumbers(90210, 1, 24, 2500);
assert.notDeepEqual(pagesA, pagesB, "Dos clics de Al Azar piden páginas distintas de video");
assert.ok(Math.min(...pagesA) < 800 && Math.max(...pagesA) > 1700, "El muestreo de video cubre páginas bajas y altas");
assert.ok(pagesA.length >= 4 && pagesB.length >= 4);

const shuffleFn = indexHtml.slice(
  indexHtml.indexOf("function shuffleCurrentFeed"),
  indexHtml.indexOf("function shuffleVideoFeed")
);
assert.ok(shuffleFn.includes("nextShuffleSeed()"), "Cada clic genera un nonce nuevo");
assert.ok(shuffleFn.includes("state.freshShuffle = true"));
assert.ok(!shuffleFn.includes("state.freshShuffle = false"), "El clic no puede apagar la mezcla antes de paginar");
assert.ok(shuffleFn.includes("fetchLiveFeed(true)"));
assert.ok(shuffleFn.includes("renderSkeletons()"));
assert.ok(indexHtml.includes("function nextShuffleSeed"));
assert.ok(indexHtml.includes("recentShuffleIds"));
assert.ok(indexHtml.includes("params.append('fresh', '1')"));
assert.ok(indexHtml.includes("params.append('shuffle', String(state.feedSeed))"));
assert.ok(indexHtml.includes("cache: manualShuffle ? 'no-store' : 'default'"));
assert.ok(indexHtml.includes("Math.floor(Date.now() / (3 * 3600 * 1000))"));
assert.ok(!indexHtml.includes("params.append('seed'"), "La navegación normal no manda una semilla por usuario");
assert.ok(indexHtml.includes('id="random-btn"'));
assert.ok(indexHtml.includes('id="filter-random-btn"'));
assert.ok(indexHtml.includes("function rememberActiveShuffle"));
assert.ok(indexHtml.includes("function restoreActiveShuffle"));
assert.ok(indexHtml.includes("searchParams.set('shuffle'"));
assert.ok(indexHtml.includes("sessionStorage.setItem(activeShuffleKey()"));
assert.ok(indexHtml.includes('data-action="drawer-random"'));
assert.ok(pagination.includes("params.append('fresh', '1')"));
assert.ok(pagination.includes("params.append('shuffle', String(curState.feedSeed))"));
assert.ok(api.includes("const catalogSlot = Math.floor(Date.now() / (3 * 3600 * 1000));"));
assert.ok(api.includes('const isRandomMode = (sort === "random" || seedParam > 0) && !q && !tag && (!category || category === "all");'));
assert.ok(api.includes("fetchPmvPage = ((randomBasePage + (page - 1) * 3) % 2500) + 1;"));

function buildIds(count, start, step) {
  const ids = new Array(count);
  for (let i = 0; i < count; i++) ids[i] = start + i * step;
  return ids;
}

const catalogs = {
  comic: buildIds(40000, 1000, 9),
  gallery: buildIds(18260, 380391, 1),
  video: buildIds(21000, 50, 3)
};

const games = Array.from({ length: 120 }, (_, i) => ({
  id: 1000 + i * 17,
  title: `Game ${i}`,
  cover_url: "https://gamcore.com/f/cover.webp",
  embed_url: "https://fgn.cdn.example/game/index.html",
  media_type: "game",
  tags: i % 2 ? ["Flash"] : ["Ren'Py"],
  engine: i % 2 ? "Flash" : "Ren'Py",
  game_type: i % 2 ? "flash" : "html5",
  plays: 5000 - i,
  rating: 70 + (i % 20),
  source: "gamcore",
  source_id: `g${i}`
}));

const pmvPagesHit = [];
const pmvSorts = [];
const lteHits = [];
const originalFetch = globalThis.fetch;

function mediaKind(url) {
  const mt = url.searchParams.get("media_type") || "";
  if (mt.includes("gallery")) return "gallery";
  if (mt.includes("video")) return "video";
  return "comic";
}

globalThis.fetch = async (input) => {
  const raw = typeof input === "string" ? input : input.url;
  const url = new URL(raw);
  if (url.hostname.includes("pmvhaven.com")) {
    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
    const limit = Math.max(1, parseInt(url.searchParams.get("limit") || "24", 10));
    pmvPagesHit.push(page);
    pmvSorts.push(url.searchParams.get("sort") || "");
    const videos = [];
    for (let i = 0; i < limit; i++) {
      const id = `pmv_${page}_${i}`;
      videos.push({
        _id: id,
        title: `Video ${id}`,
        thumbnailUrl: `https://cdn.example/${id}.jpg`,
        videoUrl: `https://cdn.example/${id}.mp4`,
        tags: ["pmv"],
        uploaderUsername: "studio"
      });
    }
    return new Response(JSON.stringify({
      videos,
      pagination: { total: 70704, totalPages: 2500 }
    }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (url.pathname.includes("games.json")) {
    return new Response(JSON.stringify(games), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }
  if (url.pathname.includes("/rest/v1/items")) {
    const ids = catalogs[mediaKind(url)];
    const limit = Math.max(1, parseInt(url.searchParams.get("limit") || "24", 10));
    const offset = Math.max(0, parseInt(url.searchParams.get("offset") || "0", 10));
    const order = url.searchParams.get("order") || "id.desc";
    const idFilter = url.searchParams.get("id") || "";
    let list = ids;
    if (idFilter.startsWith("lte.")) {
      const n = Number(idFilter.slice(4));
      lteHits.push(n);
      list = ids.filter((id) => id <= n);
    } else if (idFilter.startsWith("lt.")) {
      const n = Number(idFilter.slice(3));
      list = ids.filter((id) => id < n);
    } else if (idFilter.startsWith("in.")) {
      const body = idFilter.replace(/^in\.\(?/, "").replace(/\)?$/, "");
      const wanted = new Set(body.split(",").map((s) => Number(s.trim())).filter((n) => n > 0));
      list = ids.filter((id) => wanted.has(id));
    }
    const ordered = order.includes(".asc") || order.endsWith("asc")
      ? list.slice().sort((a, b) => a - b)
      : list.slice().sort((a, b) => b - a);
    if (offset > 0 && offset >= ordered.length) {
      return new Response("[]", {
        status: 416,
        headers: { "content-type": "application/json", "content-range": `*/${ids.length}` }
      });
    }
    const slice = ordered.slice(offset, offset + limit);
    const end = slice.length ? offset + slice.length - 1 : offset;
    const kind = mediaKind(url);
    const rows = slice.map((id) => ({
      id,
      source: "velvet",
      source_id: String(id),
      title: `${kind} ${id}`,
      cover_url: `https://cdn.example/${kind}/${id}.jpg`,
      media_type: kind,
      tags: [],
      page_count: 8,
      artists: [],
      video_sources: []
    }));
    return new Response(JSON.stringify(rows), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "content-range": `${offset}-${end}/${ids.length}`
      }
    });
  }
  return new Response("[]", { status: 404, headers: { "content-type": "application/json" } });
};

function handlerEnv(extra = {}) {
  return {
    SUPABASE_URL: "http://catalog.test",
    SUPABASE_ANON_KEY: "anon-test",
    SUPABASE_SERVICE_ROLE_KEY: "service-test",
    MEDIA_SECRET: "shuffle-test-media-secret-32chars-min",
    ASSETS: {
      fetch: async () => new Response(JSON.stringify(games), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    },
    ...extra
  };
}

async function callItems(query, extraEnv) {
  const res = await onRequest({
    request: new Request(`https://www.morbohub.com/api/items?${query}`),
    env: handlerEnv(extraEnv),
    params: {},
    waitUntil() {}
  });
  const body = await res.json();
  return { res, body };
}

function idsOf(body) {
  return (body.items || []).map((it) => it.id);
}

function assertZones(ids, minId, maxId, label) {
  assert.equal(ids.length, 24, `${label} vacío o incompleto: ${ids.length}`);
  assert.ok(ids.every((id) => id >= minId && id <= maxId), `${label} fuera de rango`);
  const span = maxId - minId;
  assert.ok(Math.max(...ids) - Math.min(...ids) > span * 0.5, `${label} no cubre zonas distintas`);
}

try {
  const slot = String(rotationSlot(Date.now()));
  const normalA = await callItems("media_type=comic&sort=random&page=1&page_size=24");
  const normalB = await callItems("media_type=comic&sort=random&page=1&page_size=24");
  const normalCache = normalA.res.headers.get("Cache-Control") || "";
  assert.ok(normalCache.includes("public"), `La rotación de 3 h debe ser pública: ${normalCache}`);
  assert.ok(normalCache.includes("s-maxage="), `La rotación de 3 h debe poder cachearse en el borde: ${normalCache}`);
  assert.ok(!normalCache.includes("no-store"), "La navegación normal no lleva no-store");
  assert.equal(normalA.res.headers.get("X-Velvet-Rotation"), slot);
  assert.equal(normalA.res.headers.get("X-Velvet-Shuffle"), null);
  assert.deepEqual(idsOf(normalA.body), idsOf(normalB.body), "Sin semilla manual la página no cambia dentro de la ventana");
  assert.deepEqual(idsOf(normalA.body).slice(0, 5), idsOf(normalB.body).slice(0, 5), "El hero de cómics no cambia al recargar");
  assert.equal(idsOf(normalA.body).length, 24);

  lteHits.length = 0;
  const galleryA = await callItems("media_type=gallery&sort=random&page=1&page_size=24&fresh=1&shuffle=11");
  const galleryB = await callItems("media_type=gallery&sort=random&page=1&page_size=24&fresh=1&shuffle=90210");
  const galleryAgain = await callItems("media_type=gallery&sort=random&page=1&page_size=24&fresh=1&shuffle=11");
  const galleryCache = galleryA.res.headers.get("Cache-Control") || "";
  assert.ok(galleryCache.includes("no-store"), `Al Azar no se cachea: ${galleryCache}`);
  assert.equal(galleryA.res.headers.get("CDN-Cache-Control"), "no-store");
  assert.equal(galleryA.res.headers.get("X-Velvet-Shuffle"), "11");
  assertZones(idsOf(galleryA.body), 380391, 398650, "gallery");
  assertZones(idsOf(galleryB.body), 380391, 398650, "gallery semilla 2");
  assert.notDeepEqual(idsOf(galleryA.body), idsOf(galleryB.body));
  assert.deepEqual(idsOf(galleryA.body), idsOf(galleryAgain.body));
  assert.ok(lteHits.length >= 4, "La galería se muestrea con varias anclas");
  assert.ok(lteHits.length <= 24, `La galería no puede abrir una consulta por ficha: ${lteHits.length}`);
  assert.ok(lteHits.every((id) => id >= 380391), `Un ancla cayó en el hueco bajo de galería: ${Math.min(...lteHits)}`);

  const galleryPlain = await callItems("media_type=gallery&sort=random&page=1&page_size=24");
  const galleryPlainAgain = await callItems("media_type=gallery&sort=random&page=1&page_size=24");
  assert.equal(idsOf(galleryPlain.body).length, 24, "La rotación normal de galería no queda vacía por huecos de id");
  assert.deepEqual(idsOf(galleryPlain.body), idsOf(galleryPlainAgain.body), "La galería sin shuffle no cambia al recargar");
  assert.deepEqual(idsOf(galleryPlain.body).slice(0, 5), idsOf(galleryPlainAgain.body).slice(0, 5), "El hero de Modelos no cambia al recargar");
  assert.ok(idsOf(galleryPlain.body).every((id) => id >= 380391));
  assert.ok((galleryPlain.res.headers.get("Cache-Control") || "").includes("public"));

  const comicA = await callItems("media_type=comic&sort=random&page=1&page_size=24&fresh=1&shuffle=11");
  const comicB = await callItems("media_type=comic&sort=random&page=1&page_size=24&fresh=1&shuffle=90210");
  const comicPage2 = await callItems("media_type=comic&sort=random&page=2&page_size=24&fresh=1&shuffle=11");
  assertZones(idsOf(comicA.body), 1000, 1000 + 39999 * 9, "comic");
  assertZones(idsOf(comicB.body), 1000, 1000 + 39999 * 9, "comic semilla 2");
  assert.notDeepEqual(idsOf(comicA.body), idsOf(comicB.body));
  assert.notDeepEqual(idsOf(comicA.body), idsOf(comicPage2.body));
  assert.equal(idsOf(comicPage2.body).length, 24);
  assert.ok((comicA.res.headers.get("Cache-Control") || "").includes("no-store"));

  const videoDbA = await callItems("media_type=video&source=supabase&sort=random&page=1&page_size=24&fresh=1&shuffle=11");
  const videoDbB = await callItems("media_type=video&source=supabase&sort=random&page=1&page_size=24&fresh=1&shuffle=90210");
  assertZones(idsOf(videoDbA.body), 50, 50 + 20999 * 3, "video supabase");
  assert.notDeepEqual(idsOf(videoDbA.body), idsOf(videoDbB.body));
  assert.ok((videoDbA.res.headers.get("Cache-Control") || "").includes("no-store"));

  pmvPagesHit.length = 0;
  const videoA = await callItems("media_type=video&sort=random&page=1&page_size=24&fresh=1&shuffle=11");
  const hitA = pmvPagesHit.slice();
  pmvPagesHit.length = 0;
  const videoB = await callItems("media_type=video&sort=random&page=1&page_size=24&fresh=1&shuffle=90210");
  const hitB = pmvPagesHit.slice();
  assert.equal(idsOf(videoA.body).length, 24, "video PMV no puede volver vacío");
  assert.notDeepEqual(idsOf(videoA.body), idsOf(videoB.body));
  assert.ok(Math.min(...hitA) < 800 && Math.max(...hitA) > 1700, `PMV no cubrió el catálogo: ${hitA.join(",")}`);
  assert.notDeepEqual(hitA, hitB);
  assert.ok((videoA.res.headers.get("Cache-Control") || "").includes("no-store"));
  assert.equal(videoA.body.live, true);

  const videoNormalA = await callItems("media_type=video&sort=random&page=1&page_size=24");
  const videoNormalB = await callItems("media_type=video&sort=random&page=1&page_size=24");
  assert.ok((videoNormalA.res.headers.get("Cache-Control") || "").includes("public"));
  assert.ok(!(videoNormalA.res.headers.get("Cache-Control") || "").includes("no-store"));
  assert.deepEqual(idsOf(videoNormalA.body), idsOf(videoNormalB.body));
  assert.deepEqual(idsOf(videoNormalA.body).slice(0, 5), idsOf(videoNormalB.body).slice(0, 5), "El hero de videos no cambia al recargar");
  assert.equal(idsOf(videoNormalA.body).length, 24);
  assert.ok(pmvSorts.length > 0 && pmvSorts.every((s) => s !== "random"), `PMV sort=random cambia en cada F5: ${pmvSorts.join(",")}`);

  const gameA = await callItems("media_type=game&sort=random&page=1&page_size=24&fresh=1&shuffle=11");
  const gameB = await callItems("media_type=game&sort=random&page=1&page_size=24&fresh=1&shuffle=90210");
  const gameAgain = await callItems("media_type=game&sort=random&page=1&page_size=24&fresh=1&shuffle=11");
  const gamePage2 = await callItems("media_type=game&sort=random&page=2&page_size=24&fresh=1&shuffle=11");
  assert.equal(idsOf(gameA.body).length, 24);
  assert.equal(idsOf(gamePage2.body).length, 24);
  assert.notDeepEqual(idsOf(gameA.body), idsOf(gameB.body), "Juegos debe cambiar con cada semilla");
  assert.deepEqual(idsOf(gameA.body), idsOf(gameAgain.body));
  assert.notDeepEqual(idsOf(gameA.body), idsOf(gamePage2.body));
  const gameIds = new Set(games.map((g) => g.id));
  assert.ok(idsOf(gameA.body).every((id) => gameIds.has(id)));
  const overlap = idsOf(gameA.body).filter((id) => idsOf(gameB.body).includes(id)).length;
  assert.ok(overlap < 12, `Dos clics de juegos comparten demasiados ids (${overlap})`);
  assert.ok((gameA.res.headers.get("Cache-Control") || "").includes("no-store"));

  const gameNormalA = await callItems("media_type=game&sort=random&page=1&page_size=24");
  const gameNormalB = await callItems("media_type=game&sort=random&page=1&page_size=24");
  assert.ok((gameNormalA.res.headers.get("Cache-Control") || "").includes("public"));
  assert.deepEqual(idsOf(gameNormalA.body), idsOf(gameNormalB.body));
  assert.equal(idsOf(gameNormalA.body).length, 24);
} finally {
  globalThis.fetch = originalFetch;
}

console.log("✓ Al Azar cambia con cada semilla, cubre el catálogo y la rotación de 3 h sigue cacheable.");
