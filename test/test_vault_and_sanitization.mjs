import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { onRequest } from "../functions/api/[[path]].js";

console.log("=== AUDITORÍA DE PAGINACIÓN (18 PC / 12 ANDROID), SANITIZACIÓN Y RANDOM REAL ===");

const indexHtml = fs.readFileSync(path.join("public", "index.html"), "utf8");
const routerJs = fs.readFileSync(path.join("public", "js", "router.js"), "utf8");
const personalJs = fs.readFileSync(path.join("public", "js", "personal-data.js"), "utf8");
const vaultJs = fs.readFileSync(path.join("public", "js", "vault.js"), "utf8");
const apiJs = fs.readFileSync(path.join("functions", "api", "[[path]].js"), "utf8");

// ---------------------------------------------------------------------------
// 1. Verificar reglas HTML/CSS/Copy estáticas
// ---------------------------------------------------------------------------
assert.ok(indexHtml.includes('id="hero-title"') && indexHtml.includes("line-clamp-2 sm:line-clamp-3"), "Hero title debe tener line-clamp para títulos largos");
assert.ok(indexHtml.includes('id="vault-history-pagination-root"'), "El historial en Bóveda debe tener contenedor de paginación");
assert.ok(indexHtml.includes('id="vault-favs-pro-pagination"') && indexHtml.includes('id="vault-hist-pro-pagination"'), "El modal Bóveda Pro debe tener controles de paginación");
assert.ok(!indexHtml.includes("desde el sitio original"), "No revelar que las imágenes vienen de otro sitio");
assert.ok(!indexHtml.includes("servidor externo"), "No exponer menciones a servidores externos en sinopsis");
assert.ok(!vaultJs.includes("HISTORY_CHUNK_SIZE = 48"), "vault.js no debe acumular 48 nodos sin paginar");
assert.ok(indexHtml.includes('/js/vault.js?v=3.10.0') && (indexHtml.includes('/css/tailwind.css?v=3.10.0') || indexHtml.includes('/css/tailwind.css?v=3.11.0') || indexHtml.includes('/css/tailwind.css?v=3.12.0') || indexHtml.includes('/css/tailwind.css?v=3.13.0') || indexHtml.includes('/css/tailwind.css?v=3.14.0') || indexHtml.includes('/css/tailwind.css?v=3.15.0') || indexHtml.includes('/css/tailwind.css?v=3.16.0') || indexHtml.includes('/css/tailwind.css?v=3.17.0') || indexHtml.includes('/css/tailwind.css?v=3.18.0') || indexHtml.includes('/css/tailwind.css?v=3.19.0')), "index.html debe romper caché inmutable antigua en Android/PC");
assert.ok(!indexHtml.includes('id="vault-pagination-root" class="w-full flex'), "Contenedor de paginación en Bóveda no debe mezclar flex con hidden");

// ---------------------------------------------------------------------------
// 2. Verificar VelvetRouter: cero pesos/sitios en URLs y alias opacos
// ---------------------------------------------------------------------------
{
  const routerSandbox = {
    window: {
      location: { origin: "https://www.morbohub.com", pathname: "/", search: "", hash: "" },
      addEventListener() {},
      dispatchEvent() {}
    },
    document: { addEventListener() {}, querySelectorAll: () => [] },
    URL,
    URLSearchParams,
    encodeURIComponent,
    decodeURIComponent,
    console
  };
  routerSandbox.window.window = routerSandbox.window;
  vm.runInNewContext(routerJs, routerSandbox);
  const Router = routerSandbox.window.VelvetRouter;

  const urlGallery = Router.getItemUrl({ id: 390123, media_type: "gallery", title: "[AIGirl] 猫猫er 0909]270MB [xasiat.com] (40P)" });
  assert.ok(!urlGallery.includes("270mb"), `URL de galería filtró peso: ${urlGallery}`);
  assert.ok(!urlGallery.includes("xasiat"), `URL de galería filtró sitio fuente: ${urlGallery}`);
  assert.ok(!urlGallery.includes("40p"), `URL de galería filtró conteo en slug: ${urlGallery}`);

  const urlExtVideo = Router.getItemUrl({ source: "pmvhaven", source_id: "abc123def456", media_type: "video", title: "PMV 1.4GB buondua edit" });
  assert.ok(!urlExtVideo.includes("pmvhaven"), `URL de video expuso fuente: ${urlExtVideo}`);
  assert.ok(!urlExtVideo.includes("1-4gb") && !urlExtVideo.includes("buondua"), `Slug de video filtró peso/sitio: ${urlExtVideo}`);
  const parsedToken = Router.parseItemToken(urlExtVideo.replace(/^\/v\//, ""));
  assert.equal(parsedToken.source, "pmvhaven", "parseItemToken debe decodificar el alias interno mv -> pmvhaven");
  assert.equal(parsedToken.sourceId, "abc123def456");

  const urlExtGal = Router.getItemUrl({ source: "xasiat", source_id: "36203", media_type: "gallery", title: "Cosplay Set [xasiat] 310MB" });
  assert.ok(!urlExtGal.includes("xasiat"), `URL de galería alias expuso xasiat: ${urlExtGal}`);
  assert.ok(urlExtGal.startsWith("/g/mx--36203"), `Se esperaba alias mx: ${urlExtGal}`);
  assert.equal(Router.parseItemToken(urlExtGal.replace(/^\/g\//, "")).source, "xasiat");
  console.log("✓ Router URLs limpian pesos, nombres de sitios externos y resuelven alias opacos.");
}

// ---------------------------------------------------------------------------
// 3. Verificar limpiador de títulos, badges, tags y hero (PC / Frontend)
// ---------------------------------------------------------------------------
{
  const start = indexHtml.indexOf("const EXTERNAL_SOURCE_LEAK_RE =");
  const end = indexHtml.indexOf("function getReliableBadge(", start);
  assert.ok(start !== -1 && end !== -1, "Deben existir los helpers de sanitización en index.html");
  const cleanPrelude = indexHtml.slice(start, end);
  const ctx = {};
  new Function("exports", cleanPrelude + `
    exports.parseComicTitle = parseComicTitle;
    exports.cleanGallerySetTitle = cleanGallerySetTitle;
    exports.getCleanGalleryCategoryBadge = getCleanGalleryCategoryBadge;
    exports.sanitizeDisplayTags = sanitizeDisplayTags;
    exports.sanitizeCreatorName = sanitizeCreatorName;
  `)(ctx);

  const aiTitle = ctx.cleanGallerySetTitle("[AIGirl] 猫猫er 0909]270MB");
  assert.ok(!/270\s*mb/i.test(aiTitle), `Título conservó peso: ${aiTitle}`);
  assert.ok(!/aigirl|\]/i.test(aiTitle), `Título conservó corchete roto o AIGirl: ${aiTitle}`);
  assert.equal(ctx.getCleanGalleryCategoryBadge({ title: "[AIGirl] 猫猫er 0909]270MB", tags: ["xasiat"] }, aiTitle), "ARTE IA 4K");

  const xasiatBadge = ctx.getCleanGalleryCategoryBadge({ title: "[Cosplay] Sakura", artists: ["XASIAT"], tags: ["xasiat", "cosplay"] }, "Sakura");
  assert.notEqual(xasiatBadge.toLowerCase(), "xasiat");
  assert.equal(xasiatBadge, "COSPLAY VIP");

  const realPersonBadge = ctx.getCleanGalleryCategoryBadge({ title: "nookkizzcos - Aglaea", artists: ["NOOKKIZZCOS"], tags: ["nookkizzcos", "bikini"] }, "Aglaea");
  assert.ok(!/nookkizzcos|npczoey|xasiat|270mb/i.test(realPersonBadge), `Badge expuso nombre o sitio: ${realPersonBadge}`);

  const doujin = "Seiso Kanojo no Noumiso ga Nietagiru Futanari... | Los Testículos de una Futanari le Están Friendo el Cerebro {Spanish} {EbisuTraslade - ACATLLL} {Digital}";
  const parsedHero = ctx.parseComicTitle(doujin, { preferConcise: true });
  assert.ok(!parsedHero.title.includes("{Spanish}") && !parsedHero.title.includes("EbisuTraslade") && !parsedHero.title.includes("{Digital}"), `Hero conservó llaves de scan: ${parsedHero.title}`);
  assert.ok(parsedHero.title.startsWith("Los Testículos"), `Hero bilingüe debe priorizar título en español: ${parsedHero.title}`);

  const cleanTags = ctx.sanitizeDisplayTags(["xasiat", "buondua.com", "270MB", "40P", "Cosplay", "Lingerie"]);
  assert.deepEqual(cleanTags, ["Cosplay", "Lingerie"]);
  assert.equal(ctx.cleanGallerySetTitle("[ROSI写真] No.5066 - 5070 (477 photos)"), "[ROSI写真] No.5066 - 5070");
  assert.equal(ctx.cleanGallerySetTitle("Coser@一小小央泽: 小绵羊 (63 photos + 1 video)"), "Coser@一小小央泽: 小绵羊");
  assert.equal(ctx.cleanGallerySetTitle("Coser@布丁大法 (Pudding Dafa): 2026年05月 居家姐姐 (25 photo..."), "Coser@布丁大法 (Pudding Dafa): 2026年05月 居家姐姐");
  assert.equal(ctx.cleanGallerySetTitle("[Cosplay] 纸祝Etsu_ko 円山小姐 [23P-..."), "[Cosplay] 纸祝Etsu_ko 円山小姐");
  assert.equal(ctx.cleanGallerySetTitle("Comiendo Semen en la Playa [(Dokiyuri) Spanish] Ai translated"), "Comiendo Semen en la Playa");
  assert.equal(ctx.parseComicTitle("Comiendo carne con semen [(Dokiyuri) Spanish] Ai translated").title, "Comiendo carne con semen");
  assert.equal(ctx.sanitizeCreatorName("xasiat.com", "comic"), "Morbo VIP");
  assert.equal(ctx.sanitizeCreatorName("NOOKKIZZCOS", "gallery"), "");
  console.log("✓ Limpiadores de títulos, hero bilingüe, pills de galerías y tags verificados.");
}

// ---------------------------------------------------------------------------
// 4. Verificar paginación adaptativa: máx 18 en PC y máx 12 en Android/móvil
// ---------------------------------------------------------------------------
{
  function makeStorage() {
    const m = {};
    return {
      getItem: (k) => (k in m ? m[k] : null),
      setItem: (k, v) => { m[k] = String(v); },
      removeItem: (k) => { delete m[k]; },
      get length() { return Object.keys(m).length; },
      key: (i) => Object.keys(m)[i] || null
    };
  }

  async function runVaultPaginationScenario({ width, ua, expectedMax }) {
    const makeDomNode = (parentNode = null) => {
      let _html = "";
      const node = {
        className: "",
        href: "",
        id: "",
        onclick: null,
        children: [],
        parentNode,
        classList: { add() {}, remove() {} },
        appendChild(n) { this.children.push(n); },
        querySelector: () => null,
        querySelectorAll: () => []
      };
      Object.defineProperty(node, "innerHTML", {
        get() { return _html; },
        set(v) {
          _html = String(v);
          this.children = [];
        }
      });
      return node;
    };

    const favContainer = makeDomNode();
    const favEmpty = makeDomNode();
    const favPg = makeDomNode();
    const histContainer = makeDomNode({ appendChild() {} });
    const histEmpty = makeDomNode();
    const histPg = makeDomNode();

    const allFavs = Array.from({ length: 40 }, (_, i) => ({
      id: 1000 + i,
      item_id: 1000 + i,
      title: i % 5 === 0
        ? `[AIGirl] Set ${i + 1}]270MB xasiat (477 photos)`
        : (i % 5 === 1
          ? `Coser Set ${i + 1} (63 photos + 1 video)`
          : (i % 5 === 2
            ? `Coser Pack ${i + 1} (25 photo...`
            : (i % 5 === 3
              ? `Cosplay ${i + 1} [23P-...`
              : `Comiendo Semen ${i + 1} [(Dokiyuri) Spanish] Ai translated`))),
      media_type: "gallery",
      source: "xasiat",
      source_id: String(1000 + i)
    }));
    const allHist = Array.from({ length: 40 }, (_, i) => ({
      id: 2000 + i,
      item_id: 2000 + i,
      title: `Hist ${i + 1} [1.2GB] buondua`,
      media_type: i % 2 === 0 ? "video" : "comic",
      source: "velvet",
      source_id: String(2000 + i),
      at: Date.now() - i * 1000,
      position: 3,
      duration: 10
    }));

    const fetchedUrls = [];
    const storage = makeStorage();
    const listeners = {};
    const makeEl = () => makeDomNode();

    const sandbox = {
      navigator: { userAgent: ua },
      document: {
        cookie: "",
        documentElement: { classList: { add() {}, remove() {} } },
        querySelector: () => null,
        querySelectorAll: () => [],
        createElement: makeEl,
        getElementById(id) {
          if (id === "vault-favorites-list") return favContainer;
          if (id === "vault-favorites-empty") return favEmpty;
          if (id === "vault-pagination-root") return favPg;
          if (id === "vault-history-list") return histContainer;
          if (id === "vault-history-empty") return histEmpty;
          if (id === "vault-history-pagination-root") return histPg;
          return null;
        }
      },
      localStorage: storage,
      window: {
        innerWidth: width,
        location: { origin: "https://www.morbohub.com", pathname: "/boveda/favoritos" },
        addEventListener(n, fn) { (listeners[n] ||= []).push(fn); },
        dispatchEvent(ev) { (listeners[ev.type] || []).forEach((fn) => fn(ev)); },
        VelvetRouter: { getItemUrl: (it) => `/g/${it.id}-clean` }
      },
      fetch: async (url) => {
        const u = new URL(String(url), "https://www.morbohub.com");
        fetchedUrls.push(u.pathname + u.search);
        const page = Number(u.searchParams.get("page") || "1");
        const pageSize = Number(u.searchParams.get("pageSize") || String(expectedMax));
        if (u.pathname === "/api/user/favorites" && u.searchParams.get("ids") === "1") {
          return { ok: true, status: 200, json: async () => ({ ids: allFavs.map((f) => f.id), refs: [], total: allFavs.length }) };
        }
        if (u.pathname === "/api/user/favorites") {
          const slice = allFavs.slice((page - 1) * pageSize, page * pageSize);
          return { ok: true, status: 200, json: async () => ({ items: slice, total: allFavs.length, page, pageSize, totalPages: Math.ceil(allFavs.length / pageSize) }) };
        }
        if (u.pathname === "/api/user/history") {
          const slice = allHist.slice((page - 1) * pageSize, page * pageSize);
          return { ok: true, status: 200, json: async () => ({ items: slice, total: allHist.length, page, pageSize, totalPages: Math.ceil(allHist.length / pageSize) }) };
        }
        return { ok: true, status: 200, json: async () => ({ data: {} }) };
      },
      CustomEvent: function CustomEvent(n, d) { this.type = n; this.detail = d?.detail; },
      AbortController: globalThis.AbortController,
      URLSearchParams,
      setTimeout,
      clearTimeout,
      console
    };
    sandbox.window.document = sandbox.document;
    sandbox.window.localStorage = sandbox.localStorage;
    sandbox.window.navigator = sandbox.navigator;

    vm.runInNewContext(personalJs, sandbox);
    vm.runInNewContext(vaultJs, sandbox);

    const PD = sandbox.window.VelvetPersonalData;
    const Vault = sandbox.window.VelvetVault;
    assert.equal(PD.getPersonalPageSize(), expectedMax, `pageSize debe ser ${expectedMax}`);
    assert.equal(Vault.getPageSize(), expectedMax, `Vault pageSize debe ser ${expectedMax}`);

    PD.setSession({ id: "u_test_1", email: "test@example.com" }, "tok-test-123", "ref-1", Math.floor(Date.now() / 1000) + 3600);
    await new Promise((r) => setTimeout(r, 30));

    await PD.fetchFavorites(1);
    Vault.renderFavorites();
    assert.equal(favContainer.children.length, expectedMax, `Favoritos pág 1 debe renderizar máx ${expectedMax} elementos`);
    assert.ok(favContainer.className.includes("lg:grid-cols-3") && !favContainer.className.includes("lg:grid-cols-4"), `La grilla de favoritos debe ser simétrica para 18/12 (3 cols en desktop): ${favContainer.className}`);
    const renderedFavHtml = favContainer.children.map((c) => c.innerHTML).join(" ");
    const favTitlesOnly = [...renderedFavHtml.matchAll(/<h4[^>]*>([\s\S]*?)<\/h4>/g)].map((m) => m[1]).join(" ");
    assert.ok(!/270MB|477 photos|63 photos|1 video|25 photo|23P|Dokiyuri|Ai translated/i.test(renderedFavHtml), `Favoritos renderizó peso, fotos o traductor: ${renderedFavHtml.slice(0, 300)}`);
    assert.ok(!/270MB|477 photos|63 photos|1 video|25 photo|23P|xasiat|Dokiyuri|Ai translated/i.test(favTitlesOnly), `Título en Favoritos conservó ruido o sitio: ${favTitlesOnly}`);
    assert.ok(fetchedUrls.some((u) => u.includes(`/api/user/favorites?page=1&pageSize=${expectedMax}`)));
    assert.ok(favPg.innerHTML.includes(`(${expectedMax}/pág.)`));

    await PD.fetchHistory(1);
    Vault.renderHistory();
    const histRenderedCount = histContainer.children.reduce((acc, el) => acc + (Array.isArray(el.children) ? el.children.length : 0), 0);
    assert.equal(histRenderedCount, expectedMax, `Historial pág 1 debe renderizar máx ${expectedMax} elementos`);
    assert.ok(fetchedUrls.some((u) => u.includes(`/api/user/history?page=1&pageSize=${expectedMax}`)));
    assert.ok(histPg.innerHTML.includes(`(${expectedMax}/pág.)`));
  }

  await runVaultPaginationScenario({ width: 1280, ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", expectedMax: 18 });
  await runVaultPaginationScenario({ width: 390, ua: "Mozilla/5.0 (Linux; Android 14)", expectedMax: 12 });
  await runVaultPaginationScenario({ width: 1024, ua: "Mozilla/5.0 (Linux; Android 14; Tablet)", expectedMax: 12 });
  console.log("✓ Favoritos e Historial paginan estrictamente máx 18 en PC y máx 12 en Android/móvil.");
}

// ---------------------------------------------------------------------------
// 5. Verificar Backend: historial mixto pág 2, alias opaco, sanitización y random DB completo
// ---------------------------------------------------------------------------
{
  const originalFetch = globalThis.fetch;
  const sqlHistoryRows = Array.from({ length: 20 }, (_, i) => ({
    id: 100 + i,
    item_id: 500 + i,
    media_type: "comic",
    position: 4,
    duration: 20,
    completed: false,
    last_activity: new Date(1_700_000_000_000 + i * 10000).toISOString(),
    client_timestamp: 1_700_000_000_000 + i * 10000,
    items: { id: 500 + i, title: `[AIGirl] Comic ${i + 1}]270MB {Spanish}`, cover_url: "https://cdn.example/c.jpg", media_type: "comic", source: "3hentai", source_id: String(500 + i), page_count: 20, status: "ok", real_people: false }
  }));
  const customHistoryRows = Array.from({ length: 10 }, (_, i) => ({
    item_key: `xasiat:g${i}`,
    item_id: null,
    source: "xasiat",
    source_id: `g${i}`,
    media_type: "gallery",
    title: `Gallery ${i + 1} [xasiat.com] [310MB]`,
    cover_url: "https://cdn.example/g.jpg",
    url: "",
    position: 2,
    duration: 12,
    completed: false,
    client_timestamp: 1_700_000_005_000 + i * 20000,
    last_activity: new Date(1_700_000_005_000 + i * 20000).toISOString()
  }));

  const randomOffsetsSeen = [];
  const allCatalogRows = Array.from({ length: 20000 }, (_, i) => ({
    id: 1000 + i * 19,
    source: "xasiat",
    source_id: String(1000 + i * 19),
    title: `[AIGirl] Model ${i}]270MB xasiat.com {Digital}`,
    cover_url: `https://cdn.example/g${i}.jpg`,
    media_type: "gallery",
    tags: ["xasiat", "270MB", "Cosplay", "45P"],
    artists: ["NOOKKIZZCOS", "XASIAT"],
    page_count: 25,
    status: "ok",
    real_people: false
  }));

  globalThis.fetch = async (input) => {
    const raw = typeof input === "string" ? input : input.url;
    const u = new URL(raw);
    if (u.pathname === "/auth/v1/user") {
      return new Response(JSON.stringify({ id: "11111111-1111-1111-1111-111111111111", email: "u@test.com", user_metadata: {} }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (u.pathname === "/rest/v1/user_history") {
      const sorted = sqlHistoryRows.slice().sort((a, b) => b.client_timestamp - a.client_timestamp);
      const rangeHeader = (typeof input === "object" && input.headers?.get?.("Range")) || "";
      const [s, e] = rangeHeader ? rangeHeader.split("-").map(Number) : [0, sorted.length - 1];
      const slice = sorted.slice(s, e + 1);
      return new Response(JSON.stringify(slice), {
        status: 200,
        headers: { "content-type": "application/json", "content-range": `${s}-${s + slice.length - 1}/${sorted.length}` }
      });
    }
    if (u.pathname === "/rest/v1/user_custom_history") {
      return new Response(JSON.stringify(customHistoryRows), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (u.pathname === "/rest/v1/items") {
      const offset = Number(u.searchParams.get("offset") || "0");
      const limit = Number(u.searchParams.get("limit") || "24");
      const order = u.searchParams.get("order") || "id.desc";
      const idFilter = u.searchParams.get("id") || "";
      const srcFilter = u.searchParams.get("source") || "";
      const orFilter = u.searchParams.get("or") || "";
      if (srcFilter.startsWith("eq.") || orFilter.includes("source.eq.xasiat")) {
        const hit = {
          id: 999112,
          source: srcFilter.startsWith("eq.") ? srcFilter.slice(3) : "xasiat",
          source_id: "36203",
          title: "[AIGirl] Cosplay Set]270MB {Spanish} xasiat.com",
          cover_url: "https://cdn.example/cov.jpg",
          media_type: "gallery",
          tags: ["xasiat", "270MB", "Cosplay"],
          artists: ["XASIAT"],
          pages: [{ index: 1, image_url: "https://cdn.example/1.jpg" }],
          page_count: 1,
          status: "ok",
          real_people: false
        };
        return new Response(JSON.stringify([hit]), { status: 200, headers: { "content-type": "application/json" } });
      }
      randomOffsetsSeen.push(offset);
      let list = order.includes(".asc") ? allCatalogRows : allCatalogRows.slice().reverse();
      if (idFilter.startsWith("lte.")) {
        const n = Number(idFilter.slice(4));
        list = list.filter((it) => it.id <= n);
      }
      const slice = list.slice(offset, offset + limit);
      return new Response(JSON.stringify(slice), {
        status: 200,
        headers: { "content-type": "application/json", "content-range": `${offset}-${offset + Math.max(0, slice.length - 1)}/${allCatalogRows.length}` }
      });
    }
    return new Response("[]", { status: 404, headers: { "content-type": "application/json" } });
  };

  try {
    const env = {
      SUPABASE_URL: "http://supabase.test",
      SUPABASE_ANON_KEY: "anon-key",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
      MEDIA_SECRET: "test-media-secret-min-32-chars-key",
      ENABLE_PMVHAVEN_LIVE: "false"
    };
    const authHeaders = { Authorization: "Bearer valid.jwt.token" };

    // A) Historial mixto paginado (page 1 & page 2 con Android UA => default 12/pág sin repetir)
    const h1Res = await onRequest({
      request: new Request("https://www.morbohub.com/api/user/history?page=1", {
        headers: { ...authHeaders, "User-Agent": "Mozilla/5.0 (Linux; Android 14)" }
      }),
      env,
      params: {},
      waitUntil() {}
    });
    const h1 = await h1Res.json();
    assert.equal(h1.pageSize, 12, "Android sin pageSize explícito debe usar 12");
    assert.equal(h1.items.length, 12);
    assert.equal(h1.total, 30);
    assert.equal(h1.totalPages, 3);

    const h2Res = await onRequest({
      request: new Request("https://www.morbohub.com/api/user/history?page=2", {
        headers: { ...authHeaders, "User-Agent": "Mozilla/5.0 (Linux; Android 14)" }
      }),
      env,
      params: {},
      waitUntil() {}
    });
    const h2 = await h2Res.json();
    assert.equal(h2.items.length, 12);
    const k1 = new Set(h1.items.map((x) => `${x.source}:${x.source_id}`));
    const dupes = h2.items.filter((x) => k1.has(`${x.source}:${x.source_id}`));
    assert.equal(dupes.length, 0, "Página 2 del historial mixto NO debe repetir elementos de Página 1");

    // B) PC default 18/pág sin pageSize explícito
    const pcRes = await onRequest({
      request: new Request("https://www.morbohub.com/api/user/history?page=1", {
        headers: { ...authHeaders, "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }
      }),
      env,
      params: {},
      waitUntil() {}
    });
    const pcData = await pcRes.json();
    assert.equal(pcData.pageSize, 18, "PC sin pageSize explícito debe usar 18");
    assert.equal(pcData.items.length, 18);

    // C) Alias opaco /api/items/mx/36203 + limpieza total en JSON público
    const detRes = await onRequest({
      request: new Request("https://www.morbohub.com/api/items/mx/36203"),
      env,
      params: {},
      waitUntil() {}
    });
    assert.equal(detRes.status, 200, "Alias opaco /api/items/mx/36203 debe resolver el elemento");
    const det = await detRes.json();
    assert.ok(!/270\s*mb|xasiat|\{spanish\}|aigirl/i.test(det.title), `Título público conservó basura: ${det.title}`);
    assert.deepEqual(det.tags, ["Cosplay"], `Tags públicos conservaron sitio o peso: ${JSON.stringify(det.tags)}`);
    assert.deepEqual(det.artists, [], "Galerías públicas no deben exponer nombres/sitios en artists");
    assert.equal(det.url, "", "Detalle nunca debe exponer URL original");

    // D) /api/random recorre todo el span del catálogo (incluyendo ids < 370000!)
    const randRes = await onRequest({
      request: new Request("https://www.morbohub.com/api/random?media_type=gallery&count=6"),
      env,
      params: {},
      waitUntil() {}
    });
    const randItems = await randRes.json();
    assert.equal(randItems.length, 6);
    const minRandId = Math.min(...randItems.map((it) => it.id));
    const maxRandId = Math.max(...randItems.map((it) => it.id));
    assert.ok(minRandId < 200000 && maxRandId - minRandId > 100000, `Random de galerías debe cubrir todo el rango de IDs (${minRandId}..${maxRandId})`);
    for (const r of randItems) {
      assert.ok(!/270\s*mb|xasiat|aigirl|\{digital\}/i.test(r.title), `Item random expuso peso/sitio: ${r.title}`);
      assert.deepEqual(r.artists, [], "Item random de galería no expone nombres reales");
      assert.deepEqual(r.tags, ["Cosplay"]);
    }
    console.log("✓ Backend: historial mixto pág 1/2 (12 Android / 18 PC), alias opacos, sanitización y /api/random full-DB OK.");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

console.log("\n====================================================");
console.log("✅ TODAS LAS PRUEBAS DE PAGINACIÓN Y SANITIZACIÓN PASARON");
console.log("====================================================");
