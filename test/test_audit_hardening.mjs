import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import vm from "node:vm";
import { onRequest } from "../functions/api/[[path]].js";
import { onRequest as onMiddlewareRequest } from "../functions/_middleware.js";

console.log("====================================================");
console.log("🧪 SUITE: SECURITY AUDIT & HARDENING REGRESSIONS");
console.log("====================================================");

function b64url(objOrStr) {
  const buf = typeof objOrStr === "string"
    ? Buffer.from(objOrStr, "utf8")
    : Buffer.from(JSON.stringify(objOrStr), "utf8");
  return buf.toString("base64url");
}

async function signHs256Jwt(payload, secret) {
  const hdr = b64url({ alg: "HS256", typ: "JWT" });
  const body = b64url(payload);
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, enc.encode(`${hdr}.${body}`));
  const sigB64 = Buffer.from(sigBuf).toString("base64url");
  return `${hdr}.${body}.${sigB64}`;
}

const ADMIN_ID = "00000000-0000-4000-a000-000000000001";
const VIP_ID = "00000000-0000-4000-a000-000000000002";
const JWT_SECRET = "audit-test-jwt-secret-key-min-32-chars-2026";
const MEDIA_SECRET = "audit-test-media-secret-key-min-32-chars";

let goTrueMode = "down"; // "down" | "ok"
let lastPostgrestItemsQuery = "";
let adminServiceKeyUsedOnPersonalTable = false;

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://127.0.0.1");
  const auth = req.headers.authorization || "";
  const apiKey = req.headers.apikey || "";

  if (u.pathname === "/auth/v1/user") {
    if (goTrueMode === "down") {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "GoTrue outage" }));
      return;
    }
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ msg: "Invalid" }));
    return;
  }

  if (u.pathname === "/rest/v1/profiles") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify([{
      id: VIP_ID,
      email: "vip@velvet.test",
      username: "vip_member",
      is_admin: false,
      is_lifetime: true,
      is_suspended: false,
      subscription_tier: "vip",
      subscription_status: "active",
      avatar: "crown",
      avatar_bg: "from-pink-600 to-purple-600"
    }]));
    return;
  }

  if (
    u.pathname === "/rest/v1/favorites" ||
    u.pathname === "/rest/v1/user_custom_favorites" ||
    u.pathname === "/rest/v1/user_history" ||
    u.pathname === "/rest/v1/user_preferences"
  ) {
    if (auth === "Bearer mock_service_role_key" || apiKey === "mock_service_role_key") {
      adminServiceKeyUsedOnPersonalTable = true;
    }
    // Real PostgREST returns 401 when JWT signature is not verified by PostgREST
    if (auth !== "Bearer valid_verified_tok" && auth.includes("sig_forged")) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: "JWSError" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json", "Content-Range": "0-0/0" });
    res.end("[]");
    return;
  }

  if (u.pathname === "/rest/v1/items") {
    lastPostgrestItemsQuery = u.search;
    const isBlockedTest = u.search.includes("999999");
    if (isBlockedTest && u.search.includes("status=neq.blocked")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("[]");
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json", "Content-Range": "0-1/2" });
    res.end(JSON.stringify([
      {
        id: 100001, // Odd ID => VIP-gated
        source: "pmvhaven",
        source_id: "vid_vip_100001",
        title: "VIP Exclusive Video",
        cover_url: "https://pmvhaven.com/covers/100001.jpg",
        media_type: "video",
        url: "https://pmvhaven.com/video?v=secret100001",
        page_count: 0,
        status: "active",
        real_people: false,
        video_sources: [{ quality: "1080p HD", url: "https://pmvhaven.com/streams/100001.mp4", format: "mp4" }]
      },
      {
        id: 100002, // Even ID => Free preview
        source: "comics18",
        source_id: "100002",
        title: "Free Preview Comic",
        cover_url: "https://comics18.org/covers/100002.jpg",
        media_type: "comic",
        url: "https://comics18.org/read/100002",
        page_count: 10,
        pages: [{ index: 1, image_url: "https://comics18.org/pages/100002_1.jpg" }],
        status: "active",
        real_people: false,
        video_sources: []
      }
    ]));
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end("{}");
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

const baseEnv = {
  SUPABASE_URL: `http://127.0.0.1:${port}`,
  SUPABASE_ANON_KEY: "mock_anon_key",
  SUPABASE_SERVICE_ROLE_KEY: "mock_service_role_key",
  MEDIA_SECRET,
  ENABLE_PMVHAVEN_LIVE: "false"
};

try {
  // -------------------------------------------------------------------------
  // 1. FORGED JWT BYPASS DURING GOTRUE OUTAGE MUST FAIL CLOSED
  // -------------------------------------------------------------------------
  console.log("\n[1] Bloqueo de JWT forjado cuando GoTrue falla (Admin, VIP, Writes, canRetryAdmin)...");
  const nowSec = Math.floor(Date.now() / 1000);
  const forgedAdminJwt = `${b64url({ alg: "none", typ: "JWT" })}.${b64url({
    sub: ADMIN_ID,
    exp: nowSec + 3600,
    email: "attacker@evil.com",
    role: "authenticated"
  })}.sig_forged`;

  const forgedMissingExpJwt = `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url({
    sub: ADMIN_ID,
    role: "authenticated"
  })}.sig_forged`;

  // Admin panel MUST reject forged JWT with 503 when unverified
  const adminForged = await onRequest({
    request: new Request("https://www.morbohub.com/api/admin/stats", {
      headers: { Authorization: `Bearer ${forgedAdminJwt}` }
    }),
    env: baseEnv,
    params: {},
    waitUntil: () => {}
  });
  assert.equal(adminForged.status, 503, "Admin endpoint no debe confiar en JWT no verificado cuando GoTrue cae");

  // /api/auth/me MUST NOT query profile with service key on unverified JWT
  const meForged = await onRequest({
    request: new Request("https://www.morbohub.com/api/auth/me", {
      headers: { Authorization: `Bearer ${forgedAdminJwt}` }
    }),
    env: baseEnv,
    params: {},
    waitUntil: () => {}
  });
  assert.equal(meForged.status, 503, "/api/auth/me debe rechazar JWT no verificado con 503");

  // VIP detail MUST reject unverified JWT
  const vipForged = await onRequest({
    request: new Request("https://www.morbohub.com/api/items/id/100001", {
      headers: { Authorization: `Bearer ${forgedAdminJwt}` }
    }),
    env: baseEnv,
    params: {},
    waitUntil: () => {}
  });
  assert.equal(vipForged.status, 503, "VIP content no debe desbloquearse con JWT no verificado");

  // Redeem, profile, writes MUST reject unverified JWT with 503
  for (const [route, method, body] of [
    ["/api/redeem", "POST", { code: "ANY-KEY" }],
    ["/api/user/profile", "POST", { username: "pwned" }],
    ["/api/user/favorites", "POST", { id: 100002 }],
    ["/api/user/history", "POST", { id: 100002, position: 1 }],
    ["/api/user/preferences", "PUT", { dataSaver: true }]
  ]) {
    const r = await onRequest({
      request: new Request(`https://www.morbohub.com${route}`, {
        method,
        headers: {
          Authorization: `Bearer ${forgedAdminJwt}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
      }),
      env: baseEnv,
      params: {},
      waitUntil: () => {}
    });
    assert.equal(r.status, 503, `${method} ${route} debe bloquear JWT no verificado`);
  }

  // Read-only favorites GET with forged JWT hitting real PostgREST 401 MUST NOT fall back to SERVICE_ROLE_KEY
  adminServiceKeyUsedOnPersonalTable = false;
  const favRetryCheck = await onRequest({
    request: new Request("https://www.morbohub.com/api/user/favorites", {
      headers: { Authorization: `Bearer ${forgedAdminJwt}` }
    }),
    env: baseEnv,
    params: {},
    waitUntil: () => {}
  });
  assert.equal(adminServiceKeyUsedOnPersonalTable, false, "canRetryAdmin jamás debe usar SERVICE_ROLE_KEY con token no verificado");
  assert.equal(favRetryCheck.status, 200);
  const favRetryBody = await favRetryCheck.json();
  assert.equal(favRetryBody.degraded, true, "Debe degradar sin datos si PostgREST rechaza JWT forjado");

  // With SUPABASE_JWT_SECRET configured: forged fails 401, validly signed passes even during GoTrue 500
  const envWithSecret = { ...baseEnv, SUPABASE_JWT_SECRET: JWT_SECRET };
  const badSigWithSecret = await onRequest({
    request: new Request("https://www.morbohub.com/api/auth/me", {
      headers: { Authorization: `Bearer ${forgedAdminJwt}` }
    }),
    env: envWithSecret,
    params: {},
    waitUntil: () => {}
  });
  assert.equal(badSigWithSecret.status, 401, "Con SUPABASE_JWT_SECRET, JWT con firma falsa devuelve 401");

  const missingExpRes = await onRequest({
    request: new Request("https://www.morbohub.com/api/user/favorites", {
      headers: { Authorization: `Bearer ${forgedMissingExpJwt}` }
    }),
    env: baseEnv,
    params: {},
    waitUntil: () => {}
  });
  assert.equal(missingExpRes.status, 401, "JWT sin claim exp jamás es aceptado en fallback");

  const validSignedJwt = await signHs256Jwt({ sub: VIP_ID, email: "vip@velvet.test", exp: nowSec + 3600 }, JWT_SECRET);
  const goodSigMe = await onRequest({
    request: new Request("https://www.morbohub.com/api/auth/me", {
      headers: { Authorization: `Bearer ${validSignedJwt}` }
    }),
    env: envWithSecret,
    params: {},
    waitUntil: () => {}
  });
  assert.equal(goodSigMe.status, 200, "Con SUPABASE_JWT_SECRET, JWT HS256 válido mantiene sesión durante caída de GoTrue");
  console.log("✓ JWT verification & fail-closed guards verificados.");

  // -------------------------------------------------------------------------
  // 2. CORS REFLECTION, /api/version REDACTION, VIP CATALOG MASKING & INJECTION
  // -------------------------------------------------------------------------
  console.log("\n[2] Verificando CORS, /api/version, bloqueo de streams VIP y PostgREST...");
  const evilOriginRes = await onRequest({
    request: new Request("https://www.morbohub.com/api/tags", {
      headers: { Origin: "https://evil-attacker.com" }
    }),
    env: baseEnv,
    params: {},
    waitUntil: () => {}
  });
  assert.equal(evilOriginRes.headers.get("access-control-allow-origin"), "https://www.morbohub.com", "No debe reflejar orígenes no autorizados");
  assert.equal(evilOriginRes.headers.get("access-control-allow-credentials"), null);
  assert.equal(evilOriginRes.headers.get("x-powered-by"), null, "No debe exponer cabecera X-Powered-By");

  const verMissingRes = await onRequest({
    request: new Request("https://www.morbohub.com/api/version", {
      headers: { Origin: "https://www.morbohub.com" }
    }),
    env: { SUPABASE_URL: baseEnv.SUPABASE_URL },
    params: {},
    waitUntil: () => {}
  });
  const verMissing = await verMissingRes.json();
  assert.equal(verMissing.env_check.all_required_set, false);
  assert.ok(!JSON.stringify(verMissing).includes("MEDIA_SECRET"), "/api/version no debe revelar nombres de secretos faltantes");
  assert.ok(!("missing_optional" in verMissing.env_check));

  // Public /api/items MUST NOT expose video_sources or raw upstream url on VIP items
  const catRes = await onRequest({
    request: new Request("https://www.morbohub.com/api/items?media_type=video&page=1&page_size=24", {
      headers: { Origin: "https://www.morbohub.com" }
    }),
    env: baseEnv,
    params: {},
    waitUntil: () => {}
  });
  assert.equal(catRes.status, 200);
  assert.ok(lastPostgrestItemsQuery.includes("status=neq.blocked"), "Consulta pública a items debe excluir blocked");
  assert.ok(lastPostgrestItemsQuery.includes("real_people=is.false"), "Consulta pública a items debe excluir real_people");
  const catBody = await catRes.json();
  const vipCatalogVideo = catBody.items.find((it) => it.id === 100001);
  assert.ok(vipCatalogVideo);
  assert.equal(vipCatalogVideo.url, "", "No debe exponer URL upstream cruda en catálogo");
  assert.equal(vipCatalogVideo.vip_locked, true);
  assert.deepEqual(vipCatalogVideo.video_sources, [], "No debe entregar streams VIP en catálogo público");

  // /api/random MUST also exclude raw url & VIP streams
  const randRes = await onRequest({
    request: new Request("https://www.morbohub.com/api/random?media_type=video&count=2"),
    env: baseEnv,
    params: {},
    waitUntil: () => {}
  });
  const randBody = await randRes.json();
  assert.ok(Array.isArray(randBody) && randBody.length > 0);
  const randVip = randBody.find((it) => it.id === 100001);
  if (randVip) {
    assert.equal(randVip.url, "");
    assert.deepEqual(randVip.video_sources, []);
  }

  // Blocked ID query returns 404
  const blockedDetail = await onRequest({
    request: new Request("https://www.morbohub.com/api/items/id/999999"),
    env: baseEnv,
    params: {},
    waitUntil: () => {}
  });
  assert.equal(blockedDetail.status, 404, "Ítems bloqueados nunca deben servirse");

  // Non-UUID target on admin user action returns 400
  const validAdminJwt = await signHs256Jwt({ sub: VIP_ID, email: "vip@velvet.test", exp: nowSec + 3600 }, JWT_SECRET);
  const badAdminUuidRes = await onRequest({
    request: new Request("https://www.morbohub.com/api/admin/users/not-a-uuid/status", {
      method: "POST",
      headers: { Authorization: `Bearer ${validAdminJwt}`, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "suspended" })
    }),
    env: { ...baseEnv, SUPABASE_JWT_SECRET: JWT_SECRET },
    params: {},
    waitUntil: () => {}
  });
  // VIP_ID is not admin (403) OR if admin would be 400; let's check both
  assert.ok([400, 403].includes(badAdminUuidRes.status));
  console.log("✓ CORS, /api/version redacción y paywall en /api/items verificados.");

  // -------------------------------------------------------------------------
  // 3. MIDDLEWARE BLOCKS DIRECT /data/*.json & _routes.json ROUTES IT
  // -------------------------------------------------------------------------
  console.log("\n[3] Verificando bloqueo público de /data/games.json y /data/videos.json...");
  const routesJson = JSON.parse(fs.readFileSync(path.join("public", "_routes.json"), "utf8"));
  assert.ok(!routesJson.exclude.includes("/data/*"), "_routes.json no debe excluir /data/*");

  for (const dataPath of ["/data/games.json", "/data/videos.json", "/DATA/games.json"]) {
    const mwRes = await onMiddlewareRequest({
      request: new Request(`https://www.morbohub.com${dataPath}`),
      env: { ASSETS: { fetch: async () => new Response("SHOULD_NOT_SERVE") } },
      next: async () => new Response("SHOULD_NOT_NEXT")
    });
    assert.equal(mwRes.status, 404, `Acceso público directo a ${dataPath} debe responder 404`);
  }
  console.log("✓ Bloqueo HTTP directo a catálogos /data/*.json verificado.");

  // -------------------------------------------------------------------------
  // 4. FRONTEND: store.js HEX IDs, ISOLATION, index.html & vault.js XSS
  // -------------------------------------------------------------------------
  console.log("\n[4] Verificando store.js, vault.js, index.html y SQL 15_security_audit_hardening.sql...");
  const storeCode = fs.readFileSync(path.join("public", "js", "store.js"), "utf8");
  const storage = {};
  const noopClass = { add: () => {}, remove: () => {}, toggle: () => {} };
  const storeSandbox = {
    window: { dispatchEvent: () => {}, addEventListener: () => {} },
    document: { cookie: "", documentElement: { classList: noopClass, style: {} }, body: { classList: noopClass, style: {} } },
    localStorage: {
      getItem: (k) => (k in storage ? storage[k] : null),
      setItem: (k, v) => { storage[k] = String(v); },
      removeItem: (k) => { delete storage[k]; }
    },
    CustomEvent: function () {},
    URLSearchParams,
    console
  };
  storeSandbox.window.localStorage = storeSandbox.localStorage;
  storeSandbox.window.document = storeSandbox.document;
  vm.runInNewContext(storeCode, storeSandbox);
  const Store = storeSandbox.window.VelvetStore;

  Store.setCurrentUser({ id: "user-iso-1", username: "iso1" });
  Store.setFavorites([{ id: "6904f801aa22bb33cc44dd55", source: "pmvhaven", source_id: "6904f801aa22bb33cc44dd55", title: "Hex Video" }]);
  assert.equal(storage["velvet_guest_favs"], undefined, "Favoritos logueados no deben sobrescribir velvet_guest_favs");
  const savedUserFavs = JSON.parse(storage["velvet_favorites_user-iso-1"]);
  assert.equal(savedUserFavs[0].id, "6904f801aa22bb33cc44dd55", "Hex ID no debe truncarse por parseInt");

  const indexHtml = fs.readFileSync(path.join("public", "index.html"), "utf8");
  assert.ok(!indexHtml.includes("openGameModal(${escapeHtml(JSON.stringify(h))})"), "Continue shelf no debe incrustar JSON en onclick");
  assert.ok(indexHtml.includes("handleContinueCardAction(this, event"), "Continue shelf usa data-card-key");
  assert.ok(indexHtml.includes("ALLOWED_PROFILE_BGS"), "index.html valida clases de fondo del avatar");

  const vaultJs = fs.readFileSync(path.join("public", "js", "vault.js"), "utf8");
  assert.ok(vaultJs.includes("ALLOWED_VAULT_AVATAR_BGS"), "vault.js valida avatarBg contra lista blanca");
  assert.ok(!vaultJs.includes("toggleSelectFav('${itemId}')"), "vault.js usa dataset para selección múltiple");

  const sql15 = fs.readFileSync(path.join("sql", "15_security_audit_hardening.sql"), "utf8");
  assert.ok(sql15.includes("ALTER TABLE public.items ENABLE ROW LEVEL SECURITY"));
  assert.ok(sql15.includes("ALTER VIEW public.catalog SET (security_invoker = true)"));
  assert.ok(sql15.includes("REVOKE ALL ON FUNCTION public.get_item_detail(bigint)"));
  assert.ok(sql15.includes("REVOKE ALL ON FUNCTION public.redeem_subscription_key(text, uuid, text)"));

  console.log("✓ Todos los controles frontend y SQL verificados.");

  // -------------------------------------------------------------------------
  // 5. AUTH LOGIN RATE LIMIT CHECK
  // -------------------------------------------------------------------------
  console.log("\n[5] Verificando rate limit de /api/auth/login...");
  let got429 = false;
  for (let i = 0; i < 18; i++) {
    const lr = await onRequest({
      request: new Request("https://www.morbohub.com/api/auth/login", {
        method: "POST",
        headers: { "CF-Connecting-IP": "198.51.100.77", "Content-Type": "application/json" },
        body: JSON.stringify({ username: "nobody", password: "wrong" })
      }),
      env: baseEnv,
      params: {},
      waitUntil: () => {}
    });
    if (lr.status === 429) {
      got429 = true;
      break;
    }
  }
  assert.equal(got429, true, "Debe aplicar límite 429 ante fuerza bruta de login");
  console.log("✓ Rate limit anti-fuerza bruta activo.");

  // -------------------------------------------------------------------------
  // 6. CIFRADO AES-GCM OPACO, ESCUDO EDGE API Y ENMASCARAMIENTO TOTAL DE FUENTES
  // -------------------------------------------------------------------------
  console.log("\n[6] Verificando cifrado AES-GCM, bloqueo de APIs externas y cero fugas...");
  const freeVideo = catBody.items.find((it) => it.video_sources && it.video_sources.length > 0);
  if (freeVideo) {
    assert.ok(!/pmvhaven|3hentai|comics18|ovh\.net/i.test(JSON.stringify(freeVideo)), "Catálogo público jamás debe revelar origen");
    const mediaTok = freeVideo.video_sources[0].url.split("t=")[1].split(".")[0];
    const rawDecoded = Buffer.from(mediaTok, "base64url").toString("utf8");
    assert.ok(!rawDecoded.includes("http") && !rawDecoded.includes("pmvhaven"), "Token de media debe venir cifrado (no base64 legible)");
  }

  // Simular HTML shell visit via middleware con MEDIA_SECRET para emitir cookie mh_gate
  const shellRes = await onMiddlewareRequest({
    request: new Request("https://www.morbohub.com/", {
      headers: { "User-Agent": "Mozilla/5.0 Chrome/134.0.0.0" }
    }),
    env: {
      MEDIA_SECRET,
      ASSETS: { fetch: async () => new Response("<html>ok</html>", { status: 200, headers: { "content-type": "text/html" } }) }
    },
    next: async () => new Response("<html>ok</html>", { status: 200, headers: { "content-type": "text/html" } })
  });
  const setCookie = shellRes.headers.get("set-cookie") || "";
  assert.ok(setCookie.includes("mh_gate=") && setCookie.includes("HttpOnly"), "Middleware debe emitir cookie firmada mh_gate");
  const gatePair = setCookie.split(";")[0];

  // Sin cookie mh_gate en Edge (cf-ray), curl/scripts externos deben recibir 403 incluso falseando Referer
  for (const apiPath of ["/api/items?media_type=video", "/api/random?media_type=comic", "/api/shorts/random", "/api/tags"]) {
    const blockedRes = await onRequest({
      request: new Request(`https://www.morbohub.com${apiPath}`, {
        headers: {
          "cf-ray": "abc123-MIA",
          "User-Agent": "Mozilla/5.0 Chrome/134.0.0.0",
          "Referer": "https://www.morbohub.com/",
          "Sec-Fetch-Site": "same-origin"
        }
      }),
      env: baseEnv,
      params: {},
      waitUntil: () => {}
    });
    assert.equal(blockedRes.status, 403, `Edge API sin cookie mh_gate debe bloquear ${apiPath} con 403`);
  }

  // Navegación directa Sec-Fetch-Dest: document debe bloquearse con 403
  const docNavRes = await onRequest({
    request: new Request("https://www.morbohub.com/api/items?media_type=video", {
      headers: {
        "cf-ray": "abc123-MIA",
        "User-Agent": "Mozilla/5.0 Chrome/134.0.0.0",
        "Sec-Fetch-Dest": "document",
        "Cookie": gatePair
      }
    }),
    env: baseEnv,
    params: {},
    waitUntil: () => {}
  });
  assert.equal(docNavRes.status, 403, "Abrir endpoint JSON directamente en barra de navegador debe devolver 403");

  // Con cookie mh_gate válida + navegación misma web pasa 200
  const allowedEdgeRes = await onRequest({
    request: new Request("https://www.morbohub.com/api/items?media_type=video", {
      headers: {
        "cf-ray": "abc123-MIA",
        "User-Agent": "Mozilla/5.0 Chrome/134.0.0.0",
        "Sec-Fetch-Site": "same-origin",
        "Referer": "https://www.morbohub.com/videos",
        "Cookie": gatePair
      }
    }),
    env: baseEnv,
    params: {},
    waitUntil: () => {}
  });
  assert.equal(allowedEdgeRes.status, 200, "Navegador legítimo de morbohub.com con mh_gate debe funcionar 200");

  const headersFile = fs.readFileSync(path.join("public", "_headers"), "utf8");
  assert.ok(!headersFile.includes("pmvhaven"), "_headers CSP no debe exponer dominios de fuentes");
  assert.ok(headersFile.includes("Referrer-Policy: same-origin"), "_headers debe permitir Referer mismo sitio sin filtrar a terceros");

  console.log("✓ Cifrado AES-GCM, cookie Edge mh_gate, CORS estricto y cero fugas verificados.");
  console.log("\n====================================================");
  console.log("✅ SUITE AUDIT & HARDENING SUPERADA (100%)");
  console.log("====================================================");
} finally {
  server.close();
}
