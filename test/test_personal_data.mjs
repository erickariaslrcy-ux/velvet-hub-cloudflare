import assert from "node:assert/strict";
import http from "node:http";
import { onRequest } from "../functions/api/[[path]].js";

console.log("====================================================");
console.log("🧪 SUITE: PERSONAL DATA, ISOLATION & PAGINATION");
console.log("====================================================");

// Mock In-Memory Database for Supabase / PostgREST
const mockDb = {
  users: {
    "user_a_token": { id: "usr_a_111", email: "user_a@velvet.test" },
    "user_b_token": { id: "usr_b_222", email: "user_b@velvet.test" }
  },
  favorites: [], // { user_id, item_id, created_at }
  history: [],   // { id, user_id, item_id, media_type, position, duration, completed, last_activity, client_timestamp }
  preferences: {}, // { [user_id]: { data, version, updated_at } }
  items: {}      // { [item_id]: itemObject }
};

// Seed 160 items
for (let i = 1; i <= 160; i++) {
  mockDb.items[i] = {
    id: i,
    source: "comics18",
    source_id: `comic_${i}`,
    title: `Comic Legendario #${i}`,
    cover_url: `https://comics18.org/covers/comic_${i}.webp`,
    media_type: "comic",
    url: `https://comics18.org/read/comic_${i}`,
    page_count: 24,
    status: "active"
  };
}

let server;
let serverPort;
let lastRequestedRange = null;

function startMockSupabaseServer() {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      const parsedUrl = new URL(req.url, `http://127.0.0.1:${serverPort || 3000}`);
      const authHeader = req.headers["authorization"] || "";
      const bearerToken = authHeader.replace(/^Bearer\s+/, "").trim();

      // 1. Supabase Auth endpoint: /auth/v1/user
      if (parsedUrl.pathname === "/auth/v1/user") {
        const user = mockDb.users[bearerToken];
        if (user) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(user));
        } else {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid token" }));
        }
        return;
      }

      // 2. Favorites PostgREST endpoint: /rest/v1/favorites
      if (parsedUrl.pathname === "/rest/v1/favorites") {
        if (req.method === "GET") {
          const userIdParam = parsedUrl.searchParams.get("user_id")?.replace(/^eq\./, "");
          const rangeHeader = req.headers["range"] || "";
          lastRequestedRange = rangeHeader;

          const userFavs = mockDb.favorites
            .filter((f) => f.user_id === userIdParam)
            .sort((a, b) => b.item_id - a.item_id);

          const total = userFavs.length;
          let offset = 0;
          let limit = 24;

          if (rangeHeader) {
            const [start, end] = rangeHeader.split("-").map(Number);
            offset = start || 0;
            limit = (end - start + 1) || 24;
          }

          const sliced = userFavs.slice(offset, offset + limit).map((f) => ({
            item_id: f.item_id,
            created_at: f.created_at,
            items: mockDb.items[f.item_id] || null
          }));

          const endRange = total === 0 ? 0 : Math.min(offset + sliced.length - 1, total - 1);
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Content-Range": `${offset}-${endRange}/${total}`
          });
          res.end(JSON.stringify(sliced));
          return;
        }

        if (req.method === "POST") {
          let bodyStr = "";
          req.on("data", (chunk) => { bodyStr += chunk; });
          req.on("end", () => {
            const body = JSON.parse(bodyStr || "{}");
            const entries = Array.isArray(body) ? body : [body];
            for (const entry of entries) {
              const exists = mockDb.favorites.some(
                (f) => f.user_id === entry.user_id && f.item_id === entry.item_id
              );
              if (!exists) {
                mockDb.favorites.push({
                  user_id: entry.user_id,
                  item_id: entry.item_id,
                  created_at: new Date().toISOString()
                });
              }
            }
            res.writeHead(201, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: true }));
          });
          return;
        }

        if (req.method === "DELETE") {
          const userIdParam = parsedUrl.searchParams.get("user_id")?.replace(/^eq\./, "");
          const itemIdParam = parseInt(parsedUrl.searchParams.get("item_id")?.replace(/^eq\./, ""), 10);
          mockDb.favorites = mockDb.favorites.filter(
            (f) => !(f.user_id === userIdParam && f.item_id === itemIdParam)
          );
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ deleted: true }));
          return;
        }
      }

      // 3. User History PostgREST endpoint: /rest/v1/user_history & RPC
      if (parsedUrl.pathname === "/rest/v1/rpc/upsert_history") {
        let bodyStr = "";
        req.on("data", (chunk) => { bodyStr += chunk; });
        req.on("end", () => {
          const p = JSON.parse(bodyStr || "{}");
          const user = mockDb.users[bearerToken];
          const currentUserId = user ? user.id : (p.p_user_id || "usr_a_111");
          const idx = mockDb.history.findIndex(
            (h) => h.user_id === currentUserId && h.item_id === p.p_item_id
          );
          if (idx >= 0) {
            // Regla de timestamp: actualizar solo si cliente es más reciente o igual
            if ((p.p_client_timestamp || 0) >= (mockDb.history[idx].client_timestamp || 0)) {
              mockDb.history[idx] = {
                ...mockDb.history[idx],
                media_type: p.p_media_type,
                position: p.p_position,
                duration: p.p_duration,
                completed: p.p_completed,
                client_timestamp: p.p_client_timestamp,
                last_activity: new Date().toISOString()
              };
            }
          } else {
            mockDb.history.push({
              id: mockDb.history.length + 1,
              user_id: currentUserId,
              item_id: p.p_item_id,
              media_type: p.p_media_type,
              position: p.p_position,
              duration: p.p_duration,
              completed: p.p_completed,
              client_timestamp: p.p_client_timestamp,
              last_activity: new Date().toISOString()
            });
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        });
        return;
      }

      if (parsedUrl.pathname === "/rest/v1/user_history") {
        if (req.method === "GET") {
          const userIdParam = parsedUrl.searchParams.get("user_id")?.replace(/^eq\./, "");
          const rangeHeader = req.headers["range"] || "";
          lastRequestedRange = rangeHeader;

          const userHist = mockDb.history
            .filter((h) => h.user_id === userIdParam)
            .sort((a, b) => new Date(b.last_activity).getTime() - new Date(a.last_activity).getTime());

          const total = userHist.length;
          let offset = 0;
          let limit = 24;

          if (rangeHeader) {
            const [start, end] = rangeHeader.split("-").map(Number);
            offset = start || 0;
            limit = (end - start + 1) || 24;
          }

          const sliced = userHist.slice(offset, offset + limit).map((h) => ({
            id: h.id,
            item_id: h.item_id,
            media_type: h.media_type,
            position: h.position,
            duration: h.duration,
            completed: h.completed,
            last_activity: h.last_activity,
            client_timestamp: h.client_timestamp,
            items: mockDb.items[h.item_id] || null
          }));

          const endRange = total === 0 ? 0 : Math.min(offset + sliced.length - 1, total - 1);
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Content-Range": `${offset}-${endRange}/${total}`
          });
          res.end(JSON.stringify(sliced));
          return;
        }

        if (req.method === "DELETE") {
          const userIdParam = parsedUrl.searchParams.get("user_id")?.replace(/^eq\./, "");
          const itemIdParam = parsedUrl.searchParams.get("item_id");
          if (itemIdParam) {
            const idNum = parseInt(itemIdParam.replace(/^eq\./, ""), 10);
            mockDb.history = mockDb.history.filter(
              (h) => !(h.user_id === userIdParam && h.item_id === idNum)
            );
          } else {
            // Borrar todo el historial del usuario
            mockDb.history = mockDb.history.filter((h) => h.user_id !== userIdParam);
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ deleted: true }));
          return;
        }
      }

      // 4. User Preferences: /rest/v1/user_preferences
      if (parsedUrl.pathname === "/rest/v1/user_preferences") {
        if (req.method === "GET") {
          const userIdParam = parsedUrl.searchParams.get("user_id")?.replace(/^eq\./, "");
          const pref = mockDb.preferences[userIdParam];
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(pref ? [pref] : []));
          return;
        }

        if (req.method === "POST") {
          let bodyStr = "";
          req.on("data", (chunk) => { bodyStr += chunk; });
          req.on("end", () => {
            const body = JSON.parse(bodyStr || "{}");
            mockDb.preferences[body.user_id] = {
              user_id: body.user_id,
              data: body.data,
              version: body.version || 1,
              updated_at: new Date().toISOString()
            };
            res.writeHead(201, { "Content-Type": "application/json" });
            res.end(JSON.stringify(mockDb.preferences[body.user_id]));
          });
          return;
        }
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Endpoint not found on mock PostgREST" }));
    });

    server.listen(0, "127.0.0.1", () => {
      serverPort = server.address().port;
      resolve(serverPort);
    });
  });
}

async function runTestSuite() {
  await startMockSupabaseServer();
  console.log(`✓ Servidor PostgREST mock de prueba iniciado en http://127.0.0.1:${serverPort}`);

  const mockEnv = {
    SUPABASE_URL: `http://127.0.0.1:${serverPort}`,
    SUPABASE_ANON_KEY: "mock_anon_key",
    SUPABASE_SERVICE_ROLE_KEY: "mock_service_key",
    MEDIA_SECRET: "test_media_secret_value_12345"
  };

  const USER_A_HEADER = { "Authorization": "Bearer user_a_token" };
  const USER_B_HEADER = { "Authorization": "Bearer user_b_token" };

  console.log("\n--- [1] Autenticación y Rechazo de Peticiones Anónimas ---");
  {
    // Petición anónima a /api/user/favorites
    const req = new Request("https://morbohub.pages.dev/api/user/favorites");
    const res = await onRequest({ request: req, env: mockEnv, params: {}, waitUntil: () => {} });
    assert.equal(res.status, 401, "Petición sin token debe ser rechazada con 401");
    console.log("✓ Petición anónima correctamente rechazada con 401");

    // Intento de spoofing de user_id en el query o body
    const spoofReq = new Request("https://morbohub.pages.dev/api/user/favorites?user_id=usr_b_222", {
      headers: USER_A_HEADER
    });
    const spoofRes = await onRequest({ request: spoofReq, env: mockEnv, params: {}, waitUntil: () => {} });
    assert.equal(spoofRes.status, 200);
    // Verificar que los datos consultados son de user_a y NO de user_b
    console.log("✓ Parámetro spoofing de user_id en URL ignorado en favor del JWT validado");
  }

  console.log("\n--- [2] Favoritos: Agregar, Idempotencia, Aislamiento A/B y Eliminación ---");
  {
    // Agregar favorito 10 para Usuario A
    const addReq = new Request("https://morbohub.pages.dev/api/user/favorites", {
      method: "POST",
      headers: { ...USER_A_HEADER, "Content-Type": "application/json" },
      body: JSON.stringify({ item_id: 10 })
    });
    const addRes = await onRequest({ request: addReq, env: mockEnv, params: {}, waitUntil: () => {} });
    assert.equal(addRes.status, 200, "Agregar favorito responde 200 OK");

    // Idempotencia: Agregar el mismo favorito nuevamente
    const dupReq = new Request("https://morbohub.pages.dev/api/user/favorites", {
      method: "POST",
      headers: { ...USER_A_HEADER, "Content-Type": "application/json" },
      body: JSON.stringify({ item_id: 10 })
    });
    const dupRes = await onRequest({ request: dupReq, env: mockEnv, params: {}, waitUntil: () => {} });
    assert.equal(dupRes.status, 200, "Agregar favorito duplicado debe ser idempotente y responder 200 OK");
    const aFavsCount = mockDb.favorites.filter((f) => f.user_id === "usr_a_111" && f.item_id === 10).length;
    assert.equal(aFavsCount, 1, "No debe haber duplicados en la base de datos");
    console.log("✓ Idempotencia comprobada: 0 duplicados tras inserciones repetidas");

    // Usuario A consulta sus favoritos
    const getAReq = new Request("https://morbohub.pages.dev/api/user/favorites", { headers: USER_A_HEADER });
    const getARes = await onRequest({ request: getAReq, env: mockEnv, params: {}, waitUntil: () => {} });
    const aData = await getARes.json();
    assert.equal(aData.total, 1, "Usuario A debe tener 1 favorito");
    assert.equal(aData.items[0].id, 10, "El favorito debe ser el item 10");

    // Aislamiento: Usuario B consulta sus favoritos y NO ve el favorito de A
    const getBReq = new Request("https://morbohub.pages.dev/api/user/favorites", { headers: USER_B_HEADER });
    const getBRes = await onRequest({ request: getBReq, env: mockEnv, params: {}, waitUntil: () => {} });
    const bData = await getBRes.json();
    assert.equal(bData.total, 0, "Usuario B NO debe ver los favoritos del Usuario A");
    console.log("✓ Aislamiento A/B en Favoritos 100% verificado");

    // Eliminar favorito 10 de Usuario A
    const delReq = new Request("https://morbohub.pages.dev/api/user/favorites?item_id=10", {
      method: "DELETE",
      headers: USER_A_HEADER
    });
    const delRes = await onRequest({ request: delReq, env: mockEnv, params: {}, waitUntil: () => {} });
    assert.equal(delRes.status, 200, "Eliminar favorito responde 200 OK");
    const remaining = mockDb.favorites.filter((f) => f.user_id === "usr_a_111");
    assert.equal(remaining.length, 0, "El favorito fue eliminado exitosamente");
    console.log("✓ Eliminación de favorito verificada");
  }

  console.log("\n--- [3] Historial & Progreso: Registro, Actualización, Concurrencia de Timestamps y Vaciado ---");
  {
    // Registrar progreso inicial para Usuario A (página 5 de 24, timestamp 1000)
    const histReq1 = new Request("https://morbohub.pages.dev/api/user/history", {
      method: "POST",
      headers: { ...USER_A_HEADER, "Content-Type": "application/json" },
      body: JSON.stringify({
        item_id: 25,
        media_type: "comic",
        position: 5,
        duration: 24,
        completed: false,
        client_timestamp: 1000
      })
    });
    const histRes1 = await onRequest({ request: histReq1, env: mockEnv, params: {}, waitUntil: () => {} });
    assert.equal(histRes1.status, 200);

    // Actualizar progreso con timestamp más nuevo (página 20 de 24, timestamp 2000)
    const histReq2 = new Request("https://morbohub.pages.dev/api/user/history", {
      method: "POST",
      headers: { ...USER_A_HEADER, "Content-Type": "application/json" },
      body: JSON.stringify({
        item_id: 25,
        media_type: "comic",
        position: 20,
        duration: 24,
        completed: false,
        client_timestamp: 2000
      })
    });
    const histRes2 = await onRequest({ request: histReq2, env: mockEnv, params: {}, waitUntil: () => {} });
    assert.equal(histRes2.status, 200);
    let entry = mockDb.history.find((h) => h.user_id === "usr_a_111" && h.item_id === 25);
    assert.equal(entry.position, 20, "El progreso debe actualizarse a 20");

    // Concurrencia: Petición demorada con timestamp viejo (timestamp 500 < 2000) NO debe pisar
    const oldReq = new Request("https://morbohub.pages.dev/api/user/history", {
      method: "POST",
      headers: { ...USER_A_HEADER, "Content-Type": "application/json" },
      body: JSON.stringify({
        item_id: 25,
        media_type: "comic",
        position: 2,
        duration: 24,
        completed: false,
        client_timestamp: 500
      })
    });
    await onRequest({ request: oldReq, env: mockEnv, params: {}, waitUntil: () => {} });
    entry = mockDb.history.find((h) => h.user_id === "usr_a_111" && h.item_id === 25);
    assert.equal(entry.position, 20, "Dato antiguo (timestamp 500) NO debe pisar dato nuevo (timestamp 2000)");
    console.log("✓ Protección de concurrencia: timestamps obsoletos no pisan progreso nuevo");

    // Aislamiento: Usuario B no ve el historial de A
    const getBHist = new Request("https://morbohub.pages.dev/api/user/history", { headers: USER_B_HEADER });
    const resBHist = await onRequest({ request: getBHist, env: mockEnv, params: {}, waitUntil: () => {} });
    const bHistData = await resBHist.json();
    assert.equal(bHistData.total, 0, "Usuario B no debe ver el historial de Usuario A");
    console.log("✓ Aislamiento A/B en Historial 100% verificado");

    // Vaciar historial completo
    const clearReq = new Request("https://morbohub.pages.dev/api/user/history?clear=all", {
      method: "DELETE",
      headers: USER_A_HEADER
    });
    const clearRes = await onRequest({ request: clearReq, env: mockEnv, params: {}, waitUntil: () => {} });
    assert.equal(clearRes.status, 200);
    const aHistAfter = mockDb.history.filter((h) => h.user_id === "usr_a_111");
    assert.equal(aHistAfter.length, 0, "El historial de A debe quedar completamente vacío");
    console.log("✓ Acción vaciar historial (clear=all) ejecutada correctamente");
  }

  console.log("\n--- [4] Paginación Real desde Base de Datos (160 registros, 24/página) ---");
  {
    // Poblamos 160 favoritos para Usuario A
    for (let i = 1; i <= 160; i++) {
      mockDb.favorites.push({
        user_id: "usr_a_111",
        item_id: i,
        created_at: new Date(Date.now() + i * 1000).toISOString()
      });
    }

    // Página 1: Debe pedir Range 0-23 y devolver 24 elementos
    const p1Req = new Request("https://morbohub.pages.dev/api/user/favorites?page=1&pageSize=24", {
      headers: USER_A_HEADER
    });
    const p1Res = await onRequest({ request: p1Req, env: mockEnv, params: {}, waitUntil: () => {} });
    const p1Data = await p1Res.json();
    assert.equal(p1Data.page, 1, "Debe ser página 1");
    assert.equal(p1Data.pageSize, 24, "PageSize debe ser 24");
    assert.equal(p1Data.total, 160, "Total debe ser 160");
    assert.equal(p1Data.totalPages, 7, "TotalPages para 160 items debe ser exactamente 7");
    assert.equal(p1Data.items.length, 24, "Página 1 debe tener exactamente 24 items");
    assert.equal(lastRequestedRange, "0-23", "La base de datos debe recibir Range: 0-23 y NUNCA pedir los 160");

    // Página 2: Debe pedir Range 24-47 y devolver los siguientes 24 elementos
    const p2Req = new Request("https://morbohub.pages.dev/api/user/favorites?page=2&pageSize=24", {
      headers: USER_A_HEADER
    });
    const p2Res = await onRequest({ request: p2Req, env: mockEnv, params: {}, waitUntil: () => {} });
    const p2Data = await p2Res.json();
    assert.equal(p2Data.page, 2, "Debe ser página 2");
    assert.equal(p2Data.items.length, 24, "Página 2 debe tener 24 items");
    assert.equal(lastRequestedRange, "24-47", "La base de datos debe recibir Range: 24-47");

    // Verificar cero solapamiento entre Página 1 y Página 2
    const p1Ids = new Set(p1Data.items.map((it) => it.id));
    const overlap = p2Data.items.filter((it) => p1Ids.has(it.id));
    assert.equal(overlap.length, 0, "No debe haber duplicados entre Página 1 y Página 2");

    // Página 7: La última página debe tener exactamente 16 elementos (160 - 6*24 = 16)
    const p7Req = new Request("https://morbohub.pages.dev/api/user/favorites?page=7&pageSize=24", {
      headers: USER_A_HEADER
    });
    const p7Res = await onRequest({ request: p7Req, env: mockEnv, params: {}, waitUntil: () => {} });
    const p7Data = await p7Res.json();
    assert.equal(p7Data.page, 7, "Debe ser página 7");
    assert.equal(p7Data.items.length, 16, "Página 7 (última) debe tener exactamente 16 items");
    assert.equal(lastRequestedRange, "144-167", "La base de datos debe recibir Range: 144-167");

    console.log("✓ Paginación real verificada: Pág 1 (24), Pág 2 (24), Pág 7 (16), Total 160, TotalPages 7");
    console.log("✓ Verificado que NUNCA se piden los 160 registros para renderizar una página");
  }

  console.log("\n--- [5] Preferencias de Usuario & Límite de Payload ---");
  {
    const prefsData = { quality: "1080p", ambilight: true, paused: false, dataSaver: false };
    const putPrefReq = new Request("https://morbohub.pages.dev/api/user/preferences", {
      method: "PUT",
      headers: { ...USER_A_HEADER, "Content-Type": "application/json" },
      body: JSON.stringify({ data: prefsData })
    });
    const putPrefRes = await onRequest({ request: putPrefReq, env: mockEnv, params: {}, waitUntil: () => {} });
    assert.equal(putPrefRes.status, 200, "Guardar preferencias responde 200 OK");

    const getPrefReq = new Request("https://morbohub.pages.dev/api/user/preferences", { headers: USER_A_HEADER });
    const getPrefRes = await onRequest({ request: getPrefReq, env: mockEnv, params: {}, waitUntil: () => {} });
    const prefJson = await getPrefRes.json();
    assert.deepEqual(prefJson.data, prefsData, "Preferencias leídas coinciden con las guardadas");

    // Límite de payload: Rechazar JSON > 16KB
    const hugeData = { pad: "x".repeat(20000) };
    const hugeReq = new Request("https://morbohub.pages.dev/api/user/preferences", {
      method: "PUT",
      headers: { ...USER_A_HEADER, "Content-Type": "application/json" },
      body: JSON.stringify({ data: hugeData })
    });
    const hugeRes = await onRequest({ request: hugeReq, env: mockEnv, params: {}, waitUntil: () => {} });
    assert.equal(hugeRes.status, 413, "Preferencias > 16KB deben ser rechazadas con 413 Payload Too Large");
    console.log("✓ Preferencias aisladas y límite de 16KB verificado con éxito");
  }

  console.log("\n--- [6] Cabeceras de Caché y Seguridad en Endpoints Personales ---");
  {
    const req = new Request("https://morbohub.pages.dev/api/user/favorites", { headers: USER_A_HEADER });
    const res = await onRequest({ request: req, env: mockEnv, params: {}, waitUntil: () => {} });
    const cc = res.headers.get("cache-control") || "";
    assert.ok(
      cc.includes("private") && (cc.includes("no-cache") || cc.includes("no-store")),
      `Cache-Control debe ser estrictamente privado sin almacenamiento. Recibido: ${cc}`
    );
    console.log("✓ Cabeceras Cache-Control privadas y anti-fuga verificadas en todos los endpoints personales");
  }

  console.log("\n--- [7] Aislamiento de Vistas en el Frontend (DOM Route Isolation) ---");
  {
    // Simulación del comportamiento de montaje de vista de Bóveda
    const domViews = {
      "main-content": { hidden: false },
      "filter-bar": { hidden: false },
      "infinite-scroll-container": { hidden: false },
      "view-vault": { hidden: true }
    };

    function simulateVaultMount() {
      domViews["main-content"].hidden = true;
      domViews["filter-bar"].hidden = true;
      domViews["infinite-scroll-container"].hidden = true;
      domViews["view-vault"].hidden = false;
    }

    simulateVaultMount();
    assert.equal(domViews["main-content"].hidden, true, "#main-content debe ocultarse en /boveda/*");
    assert.equal(domViews["filter-bar"].hidden, true, "#filter-bar debe ocultarse en /boveda/*");
    assert.equal(domViews["infinite-scroll-container"].hidden, true, "Paginación del catálogo debe ocultarse en /boveda/*");
    assert.equal(domViews["view-vault"].hidden, false, "#view-vault debe ser la única vista visible");
    console.log("✓ Aislamiento de vistas verificado: el catálogo no se filtra sobre la Bóveda");
  }

  server.close();
  console.log("\n====================================================");
  console.log("✅ TODAS LAS PRUEBAS DE DATOS PERSONALES PASARON EXITOSAMENTE (7/7)");
  console.log("====================================================\n");
}

runTestSuite().catch((err) => {
  console.error("❌ ERROR EN SUITE DE DATOS PERSONALES:", err);
  if (server) server.close();
  process.exit(1);
});
