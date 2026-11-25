import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import vm from "node:vm";
import { onRequest } from "../functions/api/[[path]].js";

console.log("=== SINCRONIZACIÓN DE FAVORITOS E HISTORIAL ENTRE NAVEGADORES ===");

const USER_1_ID = "11111111-1111-4111-8111-111111111111";
const USER_2_ID = "22222222-2222-4222-8222-222222222222";

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

function makeJwt(sub, email, extraMeta = {}) {
  return `${b64url({ alg: "none", typ: "JWT" })}.${b64url({
    sub,
    email,
    exp: Math.floor(Date.now() / 1000) + 3600,
    user_metadata: { username: email.split("@")[0], ...extraMeta }
  })}.sig`;
}

const TOKEN_1 = makeJwt(USER_1_ID, "cross1@velvet.test");
const TOKEN_2 = makeJwt(USER_2_ID, "cross2@velvet.test");
const LEGACY_TOKEN = makeJwt(USER_1_ID, "legacy@velvet.test", {
  favorites: [
    { id: 50861, source: "3hentai", source_id: "692453", title: "Legacy Comic", media_type: "comic" },
    { id: "6a49a21349896055df4298fe", source: "pmvhaven", source_id: "6a49a21349896055df4298fe", title: "Legacy Video", media_type: "video" }
  ]
});

const db = {
  items: {
    50861: {
      id: 50861,
      title: "[Test] Comic 50861",
      cover_url: "https://example.com/50861.jpg",
      media_type: "comic",
      source: "3hentai",
      source_id: "692453",
      url: "https://example.com/g/692453",
      page_count: 18,
      status: "ok"
    },
    6: {
      id: 6,
      title: "Unrelated Comic 6",
      cover_url: "https://example.com/6.jpg",
      media_type: "comic",
      source: "3hentai",
      source_id: "666",
      url: "",
      page_count: 5,
      status: "ok"
    }
  },
  favorites: [],
  custom_favorites: [],
  history: [],
  custom_history: [],
  metadataWrites: 0
};

let forceSql520 = false;

function readJsonBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); }
    });
  });
}

function getUserIdFromAuthHeader(req) {
  const auth = req.headers.authorization || "";
  const tok = auth.replace(/^Bearer\s+/i, "");
  if (!tok.includes(".")) return null;
  try {
    const payload = JSON.parse(Buffer.from(tok.split(".")[1], "base64url").toString("utf8"));
    return payload.sub || null;
  } catch {
    return null;
  }
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://127.0.0.1");

  if (u.pathname === "/auth/v1/user") {
    const uid = getUserIdFromAuthHeader(req);
    if (!uid) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    const auth = req.headers.authorization || "";
    const tok = auth.replace(/^Bearer\s+/i, "");
    const payload = JSON.parse(Buffer.from(tok.split(".")[1], "base64url").toString("utf8"));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ id: payload.sub, email: payload.email, user_metadata: payload.user_metadata || {} }));
    return;
  }

  if (u.pathname.startsWith("/auth/v1/admin/users/")) {
    if (req.method === "PUT") db.metadataWrites++;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (u.pathname === "/rest/v1/profiles") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("[]");
    return;
  }

  if (u.pathname === "/rest/v1/items") {
    const idIn = u.searchParams.get("id");
    const src = u.searchParams.get("source")?.replace(/^eq\./, "");
    const srcId = u.searchParams.get("source_id")?.replace(/^eq\./, "");
    let rows = [];
    if (idIn?.startsWith("in.(")) {
      const ids = idIn.slice(4, -1).split(",").map(Number);
      rows = ids.map((id) => db.items[id]).filter(Boolean);
    } else if (src && srcId) {
      rows = Object.values(db.items).filter((it) => it.source === src && it.source_id === srcId);
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(rows));
    return;
  }

  if (u.pathname === "/rest/v1/favorites") {
    if (forceSql520) {
      res.writeHead(520, { "Content-Type": "text/plain" });
      res.end("origin error 520");
      return;
    }
    const uid = u.searchParams.get("user_id")?.replace(/^eq\./, "");
    if (req.method === "GET") {
      const rows = db.favorites
        .filter((f) => f.user_id === uid)
        .map((f) => ({ item_id: f.item_id, created_at: f.created_at, items: db.items[f.item_id] || null }));
      const total = rows.length;
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Range": `0-${Math.max(0, total - 1)}/${total}`
      });
      res.end(JSON.stringify(rows));
      return;
    }
    if (req.method === "POST") {
      const body = await readJsonBody(req);
      const list = Array.isArray(body) ? body : [body];
      for (const entry of list) {
        if (!db.items[entry.item_id]) {
          res.writeHead(409, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ code: "23503", message: "FK violation" }));
          return;
        }
        if (!db.favorites.some((f) => f.user_id === entry.user_id && f.item_id === entry.item_id)) {
          db.favorites.push({ user_id: entry.user_id, item_id: entry.item_id, created_at: new Date().toISOString() });
        }
      }
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === "DELETE") {
      const itemIdParam = u.searchParams.get("item_id")?.replace(/^eq\./, "");
      if (itemIdParam) {
        const num = Number(itemIdParam);
        db.favorites = db.favorites.filter((f) => !(f.user_id === uid && f.item_id === num));
      } else {
        db.favorites = db.favorites.filter((f) => f.user_id !== uid);
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
      return;
    }
  }

  if (u.pathname === "/rest/v1/user_custom_favorites") {
    const uid = u.searchParams.get("user_id")?.replace(/^eq\./, "");
    const mFilter = u.searchParams.get("media_type")?.replace(/^eq\./, "");
    if (req.method === "GET") {
      let rows = db.custom_favorites.filter((f) => f.user_id === uid);
      if (mFilter) rows = rows.filter((f) => f.media_type === mFilter);
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Range": `0-${Math.max(0, rows.length - 1)}/${rows.length}`
      });
      res.end(JSON.stringify(rows));
      return;
    }
    if (req.method === "POST") {
      const body = await readJsonBody(req);
      const list = Array.isArray(body) ? body : [body];
      for (const entry of list) {
        const idx = db.custom_favorites.findIndex((f) => f.user_id === entry.user_id && f.item_key === entry.item_key);
        if (idx >= 0) db.custom_favorites[idx] = { ...db.custom_favorites[idx], ...entry };
        else db.custom_favorites.push(entry);
      }
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === "DELETE") {
      const orParam = u.searchParams.get("or");
      if (orParam) {
        const rawInner = orParam.slice(1, -1);
        const needles = rawInner.split(",").map((c) => c.split(".eq.").slice(1).join(".eq."));
        db.custom_favorites = db.custom_favorites.filter(
          (f) => !(f.user_id === uid && (needles.includes(f.item_key) || needles.includes(f.item_id) || needles.includes(f.source_id)))
        );
      } else {
        db.custom_favorites = db.custom_favorites.filter((f) => f.user_id !== uid);
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
      return;
    }
  }

  if (u.pathname === "/rest/v1/user_history") {
    const uid = u.searchParams.get("user_id")?.replace(/^eq\./, "");
    if (req.method === "GET") {
      const rows = db.history.filter((h) => h.user_id === uid);
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Range": `0-${Math.max(0, rows.length - 1)}/${rows.length}`
      });
      res.end(JSON.stringify(rows));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
    return;
  }

  if (u.pathname === "/rest/v1/user_custom_history") {
    const uid = u.searchParams.get("user_id")?.replace(/^eq\./, "");
    if (req.method === "GET") {
      const rows = db.custom_history.filter((h) => h.user_id === uid);
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Range": `0-${Math.max(0, rows.length - 1)}/${rows.length}`
      });
      res.end(JSON.stringify(rows));
      return;
    }
    if (req.method === "POST") {
      const body = await readJsonBody(req);
      const idx = db.custom_history.findIndex((h) => h.user_id === body.user_id && h.item_key === body.item_key);
      if (idx >= 0) db.custom_history[idx] = { ...db.custom_history[idx], ...body };
      else db.custom_history.push(body);
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === "DELETE") {
      db.custom_history = db.custom_history.filter((h) => h.user_id !== uid);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
      return;
    }
  }

  if (u.pathname === "/rest/v1/user_preferences") {
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
  SUPABASE_ANON_KEY: "anon-key",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
  MEDIA_SECRET: "test_secret_for_favs_sync_suite_2026"
};

try {
  // [1] Guardar cómic SQL + video PMVHaven hex ("6afabd3c3baa20d9f681648a") en Navegador 1
  const addComicRes = await onRequest({
    request: new Request("https://www.morbohub.com/api/user/favorites", {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN_1}`, "Content-Type": "application/json" },
      body: JSON.stringify({ id: 50861, item_id: 50861, source: "3hentai", source_id: "692453", media_type: "comic" })
    }),
    env,
    params: {},
    waitUntil: () => {}
  });
  assert.equal(addComicRes.status, 200);
  assert.equal(db.favorites.length, 1);
  assert.equal(db.favorites[0].item_id, 50861);

  const hexVideoId = "6afabd3c3baa20d9f681648a";
  const addVideoRes = await onRequest({
    request: new Request("https://www.morbohub.com/api/user/favorites", {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN_1}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        id: hexVideoId,
        item_id: hexVideoId,
        source: "pmvhaven",
        source_id: hexVideoId,
        media_type: "video",
        title: "Ren'Py Splitscreen PMV",
        cover_url: "https://video.pmvhaven.com/thumb.jpg",
        url: `https://pmvhaven.com/video?v=${hexVideoId}`
      })
    }),
    env,
    params: {},
    waitUntil: () => {}
  });
  assert.equal(addVideoRes.status, 200);
  assert.equal(db.favorites.length, 1, "Un ID hex '6afabd...' NO debe truncarse con parseInt a cómic #6 en SQL favorites");
  assert.equal(db.custom_favorites.length, 1, "El video PMVHaven debe guardarse en user_custom_favorites");
  assert.equal(db.custom_favorites[0].item_key, `pmvhaven:${hexVideoId}`);
  assert.equal(db.metadataWrites, 0, "Guardar favoritos NUNCA debe escribir user_metadata (evita inflar el JWT)");
  console.log("✓ Cómic SQL y video hex PMVHaven guardados limpiamente sin truncar '6afabd...' -> 6 ni inflar JWT.");

  // [2] Navegador 2 (otro navegador sin caché local): GET ?ids=1 y GET ?page=1
  const b2IdsRes = await onRequest({
    request: new Request("https://www.morbohub.com/api/user/favorites?ids=1", {
      headers: { Authorization: `Bearer ${TOKEN_1}` }
    }),
    env,
    params: {},
    waitUntil: () => {}
  });
  const b2Ids = await b2IdsRes.json();
  assert.deepEqual(b2Ids.ids, [50861]);
  assert.equal(b2Ids.refs.length, 1);
  assert.equal(b2Ids.refs[0].id, hexVideoId);
  assert.equal(b2Ids.total, 2);

  const b2ListRes = await onRequest({
    request: new Request("https://www.morbohub.com/api/user/favorites?page=1&pageSize=24", {
      headers: { Authorization: `Bearer ${TOKEN_1}` }
    }),
    env,
    params: {},
    waitUntil: () => {}
  });
  const b2List = await b2ListRes.json();
  assert.equal(b2List.total, 2);
  assert.equal(b2List.items.length, 2);
  assert.ok(b2List.items.some((i) => i.id === 50861), "Navegador 2 debe ver cómic 50861");
  assert.ok(b2List.items.some((i) => i.id === hexVideoId && i.source === "pmvhaven"), "Navegador 2 debe ver video PMVHaven");
  console.log("✓ Navegador 2 (cuenta limpia) recupera tanto favoritos SQL como videos PMVHaven.");

  // [3] Filtro por tipo (video vs comic)
  const vidOnlyRes = await onRequest({
    request: new Request("https://www.morbohub.com/api/user/favorites?page=1&pageSize=24&type=video", {
      headers: { Authorization: `Bearer ${TOKEN_1}` }
    }),
    env,
    params: {},
    waitUntil: () => {}
  });
  const vidOnly = await vidOnlyRes.json();
  assert.equal(vidOnly.items.length, 1);
  assert.equal(vidOnly.items[0].id, hexVideoId);

  // [4] Historial custom + sync-status suma ambos
  const histVidRes = await onRequest({
    request: new Request("https://www.morbohub.com/api/user/history", {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN_1}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        id: hexVideoId,
        source: "pmvhaven",
        source_id: hexVideoId,
        media_type: "video",
        title: "Ren'Py Splitscreen PMV",
        position: 42,
        duration: 180
      })
    }),
    env,
    params: {},
    waitUntil: () => {}
  });
  assert.equal(histVidRes.status, 200);
  assert.equal(db.custom_history.length, 1);
  assert.equal(db.metadataWrites, 0, "Historial NUNCA debe volver a inflar user_metadata");

  const statusRes = await onRequest({
    request: new Request("https://www.morbohub.com/api/user/sync-status", {
      headers: { Authorization: `Bearer ${TOKEN_1}` }
    }),
    env,
    params: {},
    waitUntil: () => {}
  });
  const statusData = await statusRes.json();
  assert.equal(statusData.favorites_count, 2);
  assert.equal(statusData.history_count, 1);

  // [5] Batch sync mixto con elemento sin FK SQL existente -> va a user_custom_favorites
  const batchRes = await onRequest({
    request: new Request("https://www.morbohub.com/api/user/favorites", {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN_2}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        items: [
          { id: 50861, source: "3hentai", source_id: "692453", media_type: "comic" },
          { id: 999999, source: "3hentai", source_id: "deleted", title: "Removed Comic", media_type: "comic" },
          { id: hexVideoId, source: "pmvhaven", source_id: hexVideoId, title: "Batch Video", media_type: "video" }
        ]
      })
    }),
    env,
    params: {},
    waitUntil: () => {}
  });
  assert.equal(batchRes.status, 200);
  assert.equal(db.favorites.filter((f) => f.user_id === USER_2_ID).length, 1);
  assert.equal(db.custom_favorites.filter((f) => f.user_id === USER_2_ID).length, 2, "Items sin FK y videos van a user_custom_favorites");

  // [6] Eliminación de favorito custom con source+source_id
  const delRes = await onRequest({
    request: new Request(`https://www.morbohub.com/api/user/favorites?id=${hexVideoId}&source=pmvhaven&source_id=${hexVideoId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${TOKEN_1}` }
    }),
    env,
    params: {},
    waitUntil: () => {}
  });
  assert.equal(delRes.status, 200);
  assert.equal(db.custom_favorites.filter((f) => f.user_id === USER_1_ID).length, 0);
  assert.equal(db.favorites.filter((f) => f.user_id === USER_1_ID).length, 1);

  // [7] Resiliencia si SQL falla (ej. 520) pero existen favoritos custom o legacy metadata
  forceSql520 = true;
  const legacyRes = await onRequest({
    request: new Request("https://www.morbohub.com/api/user/favorites?ids=1", {
      headers: { Authorization: `Bearer ${LEGACY_TOKEN}` }
    }),
    env,
    params: {},
    waitUntil: () => {}
  });
  const legacyData = await legacyRes.json();
  assert.ok(legacyData.ids.includes(50861), "Debe recuperar favoritos legacy de user_metadata si SQL devuelve 520");
  assert.ok(legacyData.refs.some((r) => r.id === "6a49a21349896055df4298fe"), "Debe conservar videos legacy");
  forceSql520 = false;
  console.log("✓ Batch mixto, DELETE custom, sync-status y recuperación fallback 520 verificados.");

  // [8] Verificación de regresión en index.html y personal-data.js (sin onclick rotos por comillas ni fugas de localStorage)
  const indexHtml = fs.readFileSync(path.join("public", "index.html"), "utf8");
  const personalJs = fs.readFileSync(path.join("public", "js", "personal-data.js"), "utf8");

  assert.ok(!indexHtml.includes('onclick="toggleFavorite(${JSON.stringify'), "Los botones de tarjetas no deben usar JSON.stringify en onclick (rompen con apóstrofos)");
  assert.ok(!indexHtml.includes('onclick="toggleWatchlist(${JSON.stringify'), "Watchlist tampoco debe usar JSON.stringify en onclick");
  assert.ok(indexHtml.includes("handleCardFavoriteClick(this, event)"), "Las tarjetas usan handler seguro por referencia");

  // Ejecutar VelvetPersonalData en VM para comprobar aislamiento entre cuentas + ID hex intacto
  const storage = {};
  const sandbox = {
    window: {
      addEventListener: () => {},
      dispatchEvent: () => {},
      location: { pathname: "/" }
    },
    document: {
      cookie: "",
      documentElement: { classList: { add: () => {}, remove: () => {} } },
      querySelector: () => null,
      querySelectorAll: () => [],
      getElementById: () => null
    },
    localStorage: {
      getItem: (k) => (k in storage ? storage[k] : null),
      setItem: (k, v) => { storage[k] = String(v); },
      removeItem: (k) => { delete storage[k]; },
      get length() { return Object.keys(storage).length; },
      key: (i) => Object.keys(storage)[i] || null
    },
    fetch: async (url) => {
      if (String(url).includes("/api/user/favorites?ids=1")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ids: [50861],
            refs: [{ id: hexVideoId, source: "pmvhaven", source_id: hexVideoId, media_type: "video", title: "Vid" }],
            total: 2
          })
        };
      }
      if (String(url).includes("/api/user/favorites")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            items: [
              { id: hexVideoId, item_id: hexVideoId, source: "pmvhaven", source_id: hexVideoId, media_type: "video", title: "Vid" },
              { id: 50861, item_id: 50861, source: "3hentai", source_id: "692453", media_type: "comic", title: "Com" }
            ],
            total: 2,
            page: 1,
            pageSize: 24,
            totalPages: 1
          })
        };
      }
      if (String(url).includes("/api/user/history")) {
        return { ok: true, status: 200, json: async () => ({ items: [], total: 0, page: 1, pageSize: 24, totalPages: 1 }) };
      }
      if (String(url).includes("/api/user/preferences")) {
        return { ok: true, status: 200, json: async () => ({ data: {} }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    },
    CustomEvent: function CustomEvent(n, d) { this.type = n; this.detail = d?.detail; },
    AbortController: globalThis.AbortController,
    URLSearchParams,
    console
  };
  sandbox.window.localStorage = sandbox.localStorage;
  sandbox.window.document = sandbox.document;
  vm.runInNewContext(personalJs, sandbox);

  const PD = sandbox.window.VelvetPersonalData;
  PD.setSession({ id: USER_1_ID, email: "u1@test" }, TOKEN_1, "ref-1", Math.floor(Date.now() / 1000) + 3600);
  await new Promise((r) => setTimeout(r, 40));

  assert.equal(PD.isFavorite(hexVideoId, "pmvhaven", hexVideoId), true, "Video hex PMVHaven debe detectarse como favorito");
  assert.equal(PD.isFavorite(6, "3hentai", "666"), false, "Video '6afabd...' NO debe marcar como favorito el cómic #6");
  assert.equal(storage["velvet_guest_favs"], undefined, "La sesión autenticada no debe contaminar velvet_guest_favs entre cuentas");
  assert.ok(storage[`velvet_usr_${USER_1_ID}_favs`]?.includes(hexVideoId), "Los favoritos se cachean bajo el prefijo aislado de USER_1");

  console.log("✓ Motor VelvetPersonalData conserva videos hex, aisla cuentas y protege tarjetas con apóstrofos.");
  console.log("\n====================================================");
  console.log("✅ TODAS LAS PRUEBAS DE SINCRONIZACIÓN CROSS-BROWSER PASARON");
  console.log("====================================================");
} finally {
  server.close();
}
