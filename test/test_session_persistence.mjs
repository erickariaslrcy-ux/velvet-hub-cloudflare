import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { onRequest } from "../functions/api/[[path]].js";

console.log("=== SESIÓN: PERSISTENCIA, REFRESH ÚNICO Y RLS ===");

const indexHtml = fs.readFileSync(path.join("public", "index.html"), "utf8");
const personal = fs.readFileSync(path.join("public", "js", "personal-data.js"), "utf8");
const store = fs.readFileSync(path.join("public", "js", "store.js"), "utf8");
const api = fs.readFileSync(path.join("functions", "api", "[[path]].js"), "utf8");

assert.ok(store.includes("setSession(user, token = null, refreshToken = null, expiresAt = null, deviceToken = null)"), "VelvetStore.setSession debe existir");
assert.ok(!personal.includes("headers['x-refresh-token'] ="), "El cliente no debe adjuntar el refresh token en cada petición");
assert.ok(personal.includes("delete headers['x-refresh-token']"), "Hay que quitar un refresh token heredado antes de enviar la petición");
assert.ok(personal.includes("async refreshSession()"), "Debe haber un refresh de un solo vuelo");
assert.ok(indexHtml.includes("resp.status === 503"), "Un 503 no debe cerrar la sesión local");
assert.ok(indexHtml.includes("rememberSession("), "Login y /api/auth/me deben persistir por el mismo camino");
assert.ok(!indexHtml.includes("VelvetStore.setSession(data.user, data.token)"), "El login no debe llamar una firma que ignoraba refresh y expires");
assert.ok(!api.includes('token: authData?.access_token || "velvet_token"'), "El registro no debe inventar un token falso");
assert.ok(!api.includes("velvet_master_media_hmac_secret_production_2026"), "No debe quedar el secreto HMAC de medios en el código");
assert.ok(api.includes("Bearer ${token || SUPABASE_ANON_KEY || SUPABASE_KEY}"), "Los datos personales deben ir con el JWT del usuario para que RLS vea auth.uid()");

const resolveStart = api.indexOf("async function resolveAuthUser");
const resolveEnd = api.indexOf("function updateSupabaseUserMetadata");
const resolveBody = api.slice(resolveStart, resolveEnd);
assert.ok(!resolveBody.includes("grant_type=refresh_token"), "resolveAuthUser no debe consumir el refresh token");

let refreshHits = 0;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname === "/auth/v1/user") {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "expired" }));
    return;
  }
  if (url.pathname === "/auth/v1/token" && url.searchParams.get("grant_type") === "refresh_token") {
    refreshHits += 1;
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        access_token: "fresh-access-token-value-long-enough",
        refresh_token: "fresh-refresh-token-value-long",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        user: { id: "usr_session", email: "session@velvet.test", user_metadata: { username: "session" } }
      }));
    });
    return;
  }
  if (url.pathname === "/rest/v1/profiles") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify([{ is_admin: false }]));
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
  MEDIA_SECRET: "media-secret-for-session-test-32chars"
};

const me = await onRequest({
  request: new Request("https://morbohub.pages.dev/api/auth/me", {
    headers: { Authorization: "Bearer expired-access", "x-refresh-token": "refresh-1" }
  }),
  env,
  params: {},
  waitUntil: () => {}
});
assert.equal(me.status, 401);
assert.equal(refreshHits, 0, "GET /api/auth/me no debe canjear el refresh token");

const fav = await onRequest({
  request: new Request("https://morbohub.pages.dev/api/user/favorites", {
    headers: { Authorization: "Bearer expired-access", "x-refresh-token": "refresh-1" }
  }),
  env,
  params: {},
  waitUntil: () => {}
});
assert.equal(fav.status, 401);
assert.equal(refreshHits, 0, "GET de favoritos no debe canjear el refresh token");

const [a, b] = await Promise.all([
  onRequest({
    request: new Request("https://www.morbohub.com/api/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://www.morbohub.com" },
      body: JSON.stringify({ refresh_token: "refresh-shared" })
    }),
    env,
    params: {},
    waitUntil: () => {}
  }),
  onRequest({
    request: new Request("https://www.morbohub.com/api/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://www.morbohub.com" },
      body: JSON.stringify({ refresh_token: "refresh-shared" })
    }),
    env,
    params: {},
    waitUntil: () => {}
  })
]);
assert.equal(a.status, 200);
assert.equal(b.status, 200);
const bodyA = await a.json();
const bodyB = await b.json();
assert.equal(bodyA.token, "fresh-access-token-value-long-enough");
assert.equal(bodyB.refresh_token, "fresh-refresh-token-value-long");
assert.equal(refreshHits, 1, "Dos refresh paralelos del mismo token deben canjearse una sola vez");
assert.ok(a.headers.get("set-cookie") && a.headers.get("set-cookie").includes("velvet_access"), "El refresh debe fijar cookie HttpOnly de acceso");

server.close();
console.log("✓ La sesión no se revoca por refrescos paralelos y los datos personales exigen el JWT del usuario.");
