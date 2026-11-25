import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import vm from "node:vm";
import { onRequest } from "../functions/api/[[path]].js";

console.log("====================================================");
console.log("🧪 SUITE: SUSCRIPCIONES POR TIEMPO, USUARIOS Y ADMIN");
console.log("====================================================");

function makeJwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig_mock_2026`;
}

const nowSec = Math.floor(Date.now() / 1000);
const ADMIN_ID = "00000000-0000-4000-a000-000000000001";
const FREE_ID = "00000000-0000-4000-a000-000000000002";
const EXPIRED_ID = "00000000-0000-4000-a000-000000000003";
const BANANA_ID = "00000000-0000-4000-a000-000000000004";

const db = {
  users: [
    { id: ADMIN_ID, email: "erickariaslrcy@gmail.com", password: "adminpass123", user_metadata: { username: "erick" }, banned_until: null, created_at: "2026-10-01T00:00:00Z" },
    { id: FREE_ID, email: "freeuser@velvet.local", password: "password123", user_metadata: { username: "freeuser" }, banned_until: null, created_at: "2026-11-01T00:00:00Z" },
    { id: EXPIRED_ID, email: "expired@velvet.local", password: "password123", user_metadata: { username: "expireduser" }, banned_until: null, created_at: "2026-10-01T00:00:00Z" },
    { id: BANANA_ID, email: "bananas@velvet.local", password: "password123", user_metadata: { username: "bananas" }, banned_until: null, created_at: "2026-11-05T00:00:00Z" }
  ],
  profiles: [
    {
      id: ADMIN_ID, email: "erickariaslrcy@gmail.com", username: "erick", is_admin: true,
      subscription_tier: "admin", subscription_status: "admin", subscription_expires_at: null,
      is_lifetime: true, is_suspended: false, registered_with_key: null, created_at: "2026-10-01T00:00:00Z"
    },
    {
      id: FREE_ID, email: "freeuser@velvet.local", username: "freeuser", is_admin: false,
      subscription_tier: "free", subscription_status: "inactive", subscription_expires_at: null,
      is_lifetime: false, is_suspended: false, registered_with_key: null, created_at: "2026-11-01T00:00:00Z"
    },
    {
      id: EXPIRED_ID, email: "expired@velvet.local", username: "expireduser", is_admin: false,
      subscription_tier: "vip", subscription_status: "active",
      subscription_expires_at: new Date(Date.now() - 2 * 86400000).toISOString(),
      is_lifetime: false, is_suspended: false, registered_with_key: "OLD-KEY-1111", created_at: "2026-10-01T00:00:00Z"
    },
    {
      id: BANANA_ID, email: "bananas@velvet.local", username: "bananas", is_admin: false,
      subscription_tier: "free", subscription_status: "inactive", subscription_expires_at: null,
      is_lifetime: false, is_suspended: false, registered_with_key: null, created_at: "2026-11-05T00:00:00Z"
    }
  ],
  invite_keys: [
    { code: "VALID-30D-0001", note: "Cliente Mes 1", duration_days: 30, plan_label: "Morbo VIP 1 Mes", created_by: ADMIN_ID, created_at: "2026-11-20T00:00:00Z", expires_at: null, used_by: null, used_email: null, used_at: null, revoked: false },
    { code: "VALID-30D-0002", note: "Renovacion", duration_days: 30, plan_label: "Morbo VIP 1 Mes", created_by: ADMIN_ID, created_at: "2026-11-20T00:00:00Z", expires_at: null, used_by: null, used_email: null, used_at: null, revoked: false },
    { code: "VALID-30D-0003", note: "Registro", duration_days: 30, plan_label: "Morbo VIP 1 Mes", created_by: ADMIN_ID, created_at: "2026-11-20T00:00:00Z", expires_at: null, used_by: null, used_email: null, used_at: null, revoked: false },
    { code: "USED-KEY-9999", note: "Usada", duration_days: 30, plan_label: "Morbo VIP 1 Mes", created_by: ADMIN_ID, created_at: "2026-11-01T00:00:00Z", expires_at: null, used_by: EXPIRED_ID, used_email: "expired@velvet.local", used_at: "2026-11-02T00:00:00Z", revoked: false },
    { code: "REVOKED-KEY-9999", note: "Revocada", duration_days: 30, plan_label: "Morbo VIP 1 Mes", created_by: ADMIN_ID, created_at: "2026-11-01T00:00:00Z", expires_at: null, used_by: null, used_email: null, used_at: null, revoked: true },
    { code: "DEAD-KEY-9999", note: "Caducada", duration_days: 30, plan_label: "Morbo VIP 1 Mes", created_by: ADMIN_ID, created_at: "2026-11-01T00:00:00Z", expires_at: "2026-11-05T00:00:00Z", used_by: null, used_email: null, used_at: null, revoked: false }
  ],
  items: [
    { id: 100001, source: "3hentai", source_id: "100001", title: "VIP Locked Comic", media_type: "comic", cover_url: "https://s4.3hentai.net/d1/thumb.jpg", pages: [{ index: 1, image_url: "https://s4.3hentai.net/d1/1.jpg" }], status: "active", real_people: false },
    { id: 100002, source: "3hentai", source_id: "100002", title: "Free Preview Comic", media_type: "comic", cover_url: "https://s4.3hentai.net/d2/thumb.jpg", pages: [{ index: 1, image_url: "https://s4.3hentai.net/d2/1.jpg" }], status: "active", real_people: false }
  ],
  favorites: [],
  user_history: []
};

let server;
let port;
let lastResolvedLoginEmail = null;

function tokenForUser(u) {
  return makeJwt({ sub: u.id, email: u.email, role: "authenticated", exp: nowSec + 3600 });
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const str = Buffer.concat(chunks).toString("utf8");
      try { resolve(str ? JSON.parse(str) : {}); } catch { resolve({}); }
    });
  });
}

function userFromAuthHeader(req) {
  const auth = req.headers.authorization || "";
  const tok = auth.replace(/^Bearer\s+/i, "").trim();
  if (!tok || tok === "mock_service_key") return null;
  try {
    const payload = JSON.parse(Buffer.from(tok.split(".")[1], "base64url").toString("utf8"));
    return db.users.find((u) => u.id === payload.sub) || null;
  } catch { return null; }
}

await new Promise((resolve) => {
  server = http.createServer(async (req, res) => {
    const u = new URL(req.url, `http://127.0.0.1:${port || 3000}`);
    const body = (req.method === "POST" || req.method === "PUT" || req.method === "PATCH") ? await readBody(req) : {};

    if (u.pathname === "/auth/v1/user" && req.method === "GET") {
      const usr = userFromAuthHeader(req);
      if (!usr) { res.writeHead(401, { "Content-Type": "application/json" }); res.end(JSON.stringify({ msg: "Invalid" })); return; }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(usr));
      return;
    }

    if (u.pathname === "/auth/v1/token" && req.method === "POST") {
      const grant = u.searchParams.get("grant_type");
      if (grant === "password") {
        lastResolvedLoginEmail = body.email;
        const usr = db.users.find((x) => x.email.toLowerCase() === String(body.email || "").toLowerCase() && x.password === body.password);
        if (!usr) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error_description: "Credenciales incorrectas" })); return; }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ access_token: tokenForUser(usr), refresh_token: "ref_" + usr.id, expires_at: nowSec + 3600, user: usr }));
        return;
      }
      if (grant === "refresh_token") {
        const uid = String(body.refresh_token || "").replace(/^ref_/, "");
        const usr = db.users.find((x) => x.id === uid);
        if (!usr) { res.writeHead(401, { "Content-Type": "application/json" }); res.end(JSON.stringify({ msg: "Invalid refresh" })); return; }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ access_token: tokenForUser(usr), refresh_token: "ref_" + usr.id, expires_at: nowSec + 3600, user: usr }));
        return;
      }
    }

    if (u.pathname === "/auth/v1/admin/users" && req.method === "POST") {
      if (db.users.some((x) => x.email === body.email)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ msg: "User already registered" }));
        return;
      }
      const newId = `00000000-0000-4000-a000-${String(db.users.length + 10).padStart(12, "0")}`;
      const newUser = { id: newId, email: body.email, password: body.password, user_metadata: body.user_metadata || {}, banned_until: null, created_at: new Date().toISOString() };
      db.users.push(newUser);
      db.profiles.push({
        id: newId, email: body.email, username: body.user_metadata?.username || body.email.split("@")[0],
        is_admin: false, subscription_tier: "free", subscription_status: "inactive", subscription_expires_at: null,
        is_lifetime: false, is_suspended: false, registered_with_key: null, created_at: newUser.created_at
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(newUser));
      return;
    }

    if (u.pathname === "/auth/v1/admin/users" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ users: db.users }));
      return;
    }

    const adminUserMatch = u.pathname.match(/^\/auth\/v1\/admin\/users\/([^/]+)$/);
    if (adminUserMatch) {
      const uid = decodeURIComponent(adminUserMatch[1]);
      if (req.method === "PUT") {
        const usr = db.users.find((x) => x.id === uid);
        if (usr) {
          if (body.user_metadata) usr.user_metadata = body.user_metadata;
          if (body.ban_duration === "none") usr.banned_until = null;
          else if (body.ban_duration) usr.banned_until = new Date(Date.now() + 86400000).toISOString();
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(usr || {}));
        return;
      }
      if (req.method === "DELETE") {
        db.users = db.users.filter((x) => x.id !== uid);
        db.profiles = db.profiles.filter((x) => x.id !== uid);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({}));
        return;
      }
    }

    if (u.pathname === "/rest/v1/rpc/redeem_subscription_key" && req.method === "POST") {
      const code = String(body.p_code || "").trim().toUpperCase();
      const k = db.invite_keys.find((x) => x.code === code);
      if (!k) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: "not_found", message: "La llave de acceso no existe." })); return; }
      if (k.revoked) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: "revoked", message: "Esta llave fue revocada." })); return; }
      if (k.used_at) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: "already_used", message: "Esta llave ya fue utilizada." })); return; }
      if (k.expires_at && Date.parse(k.expires_at) <= Date.now()) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: "key_expired", message: "Esta llave caducó." })); return; }
      const p = db.profiles.find((x) => x.id === body.p_user_id);
      if (!p) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: "no_profile", message: "Perfil no encontrado" })); return; }
      if (p.is_suspended) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: "suspended", message: "Cuenta suspendida" })); return; }
      const days = k.duration_days ?? 30;
      let newExp = null;
      if (days === 0) {
        p.is_lifetime = true;
      } else {
        const curMs = p.subscription_expires_at ? Date.parse(p.subscription_expires_at) : 0;
        const baseMs = curMs > Date.now() ? curMs : Date.now();
        newExp = new Date(baseMs + days * 86400000).toISOString();
        p.subscription_expires_at = newExp;
      }
      p.subscription_tier = p.is_admin ? "admin" : "vip";
      p.subscription_status = p.is_admin ? "admin" : "active";
      p.registered_with_key = code;
      k.used_by = p.id;
      k.used_email = body.p_email || p.email;
      k.used_at = new Date().toISOString();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, code, duration_days: days, plan_label: k.plan_label, subscription_expires_at: newExp, is_lifetime: p.is_lifetime }));
      return;
    }

    if (u.pathname === "/rest/v1/profiles") {
      if (req.method === "GET") {
        let rows = db.profiles.slice();
        const idEq = u.searchParams.get("id");
        if (idEq?.startsWith("eq.")) rows = rows.filter((p) => p.id === idEq.slice(3));
        if (idEq?.startsWith("neq.")) rows = rows.filter((p) => p.id !== idEq.slice(4));
        const unameIlike = u.searchParams.get("username");
        if (unameIlike?.startsWith("ilike.")) {
          const val = unameIlike.slice(6).toLowerCase();
          rows = rows.filter((p) => String(p.username || "").toLowerCase() === val);
        }
        const emailIlike = u.searchParams.get("email");
        if (emailIlike?.startsWith("ilike.")) {
          const pat = emailIlike.slice(6).toLowerCase().replace(/%$/, "");
          rows = rows.filter((p) => String(p.email || "").toLowerCase().startsWith(pat));
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(rows));
        return;
      }
      if (req.method === "POST") {
        const idx = db.profiles.findIndex((p) => p.id === body.id);
        if (idx >= 0) db.profiles[idx] = { ...db.profiles[idx], ...body };
        else db.profiles.push(body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify([body]));
        return;
      }
      if (req.method === "PATCH") {
        const idEq = u.searchParams.get("id");
        const targetId = idEq?.startsWith("eq.") ? idEq.slice(3) : null;
        const updated = [];
        for (const p of db.profiles) {
          if (!targetId || p.id === targetId) {
            Object.assign(p, body);
            updated.push(p);
          }
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(updated));
        return;
      }
    }

    if (u.pathname === "/rest/v1/invite_keys") {
      if (req.method === "GET") {
        let rows = db.invite_keys.slice();
        const codeEq = u.searchParams.get("code");
        if (codeEq?.startsWith("eq.")) rows = rows.filter((k) => k.code === codeEq.slice(3));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(rows));
        return;
      }
      if (req.method === "POST") {
        const arr = Array.isArray(body) ? body : [body];
        const inserted = arr.map((k) => ({ ...k, created_at: new Date().toISOString(), used_at: null, used_by: null, used_email: null, revoked: false }));
        db.invite_keys.push(...inserted);
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify(inserted));
        return;
      }
      if (req.method === "PATCH") {
        const codeEq = u.searchParams.get("code");
        const code = codeEq?.startsWith("eq.") ? codeEq.slice(3) : null;
        const rows = [];
        for (const k of db.invite_keys) {
          if (!code || k.code === code) { Object.assign(k, body); rows.push(k); }
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(rows));
        return;
      }
    }

    if (u.pathname === "/rest/v1/favorites") {
      res.writeHead(200, { "Content-Type": "application/json", "Content-Range": `0-0/${db.favorites.length}` });
      res.end(JSON.stringify(db.favorites));
      return;
    }

    if (u.pathname === "/rest/v1/user_history") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(db.user_history));
      return;
    }

    if (u.pathname === "/rest/v1/items") {
      const idEq = u.searchParams.get("id");
      const wanted = idEq?.startsWith("eq.") ? parseInt(idEq.slice(3), 10) : null;
      const matched = wanted ? db.items.filter((i) => i.id === wanted) : db.items;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(matched));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not mocked: " + u.pathname }));
  });
  server.listen(0, "127.0.0.1", () => {
    port = server.address().port;
    resolve();
  });
});

const env = {
  SUPABASE_URL: `http://127.0.0.1:${port}`,
  SUPABASE_ANON_KEY: "mock_anon_key",
  SUPABASE_SERVICE_ROLE_KEY: "mock_service_key",
  MEDIA_SECRET: "test_secret_subscriptions_2026_velvet_hub",
  MASTER_EMAIL: "erickariaslrcy@gmail.com"
};

async function apiCall(pathname, { method = "GET", token = null, body = null } = {}) {
  const headers = { "origin": "https://www.morbohub.com" };
  if (body !== null) headers["content-type"] = "application/json";
  if (token) headers["authorization"] = `Bearer ${token}`;
  return await onRequest({
    request: new Request(`https://www.morbohub.com${pathname}`, {
      method,
      headers,
      body: body !== null ? JSON.stringify(body) : undefined
    }),
    env,
    params: {},
    waitUntil: () => {}
  });
}

try {
  console.log("\n[1] Registro rechaza llaves falsas, usadas, revocadas y expiradas...");
  for (const badKey of ["VIP-FAKE-1234-ABCD", "USED-KEY-9999", "REVOKED-KEY-9999", "DEAD-KEY-9999"]) {
    const res = await apiCall("/api/auth/register", {
      method: "POST",
      body: { username: `bad_${badKey.slice(0, 4).toLowerCase()}`, password: "password123", access_key: badKey }
    });
    assert.equal(res.status, 403, `La llave ${badKey} debe rechazarse con 403`);
  }
  console.log("✓ Llaves falsas por regex, usadas, revocadas y caducadas rechazadas.");

  console.log("\n[2] Registro válido con llave de 30 días y registro gratuito...");
  const regVipRes = await apiCall("/api/auth/register", {
    method: "POST",
    body: { username: "comprador1", password: "password123", access_key: "VALID-30D-0003" }
  });
  assert.equal(regVipRes.status, 200);
  const regVip = await regVipRes.json();
  assert.equal(regVip.user.is_pro, true);
  assert.equal(regVip.user.subscription_status, "active");
  assert.ok(regVip.user.days_remaining >= 29 && regVip.user.days_remaining <= 31, "Debe otorgar ~30 días");
  assert.ok(regVip.user.subscription_expires_at, "Debe tener fecha de vencimiento");

  const regFreeRes = await apiCall("/api/auth/register", {
    method: "POST",
    body: { username: "gratuito1", password: "password123" }
  });
  assert.equal(regFreeRes.status, 200);
  const regFree = await regFreeRes.json();
  assert.equal(regFree.user.is_pro, false);
  assert.equal(regFree.user.has_active_subscription, false);
  assert.equal(regFree.user.subscription_status, "inactive");
  console.log("✓ Registro con llave mensual (30d) y registro gratuito verificados.");

  console.log("\n[3] Expiración automática de suscripción vencida y renovación por canje...");
  const expLoginRes = await apiCall("/api/auth/login", {
    method: "POST",
    body: { username: "expireduser", password: "password123" }
  });
  assert.equal(expLoginRes.status, 200);
  const expLogin = await expLoginRes.json();
  assert.equal(expLogin.user.is_pro, false, "Usuario vencido NO debe tener acceso pro");
  assert.equal(expLogin.user.has_active_subscription, false);
  assert.equal(expLogin.user.subscription_status, "expired");
  assert.equal(expLogin.user.days_remaining, 0);

  // Al consultar /api/auth/me sigue bloqueado el VIP hasta que pague otro mes
  const expMeRes = await apiCall("/api/auth/me", { token: expLogin.token });
  assert.equal(expMeRes.status, 200);
  const expMe = await expMeRes.json();
  assert.equal(expMe.user.is_pro, false);
  assert.equal(expMe.user.subscription_status, "expired");

  // Canjear llave de 30 días (/api/redeem) reactiva VIP y acumula +30d si vuelve a canjear
  const redeem1Res = await apiCall("/api/redeem", {
    method: "POST",
    token: expLogin.token,
    body: { code: "VALID-30D-0001" }
  });
  assert.equal(redeem1Res.status, 200);
  const redeem1 = await redeem1Res.json();
  assert.equal(redeem1.user.is_pro, true);
  assert.equal(redeem1.user.subscription_status, "active");
  assert.ok(redeem1.user.days_remaining >= 29);

  // Acumular otro mes mientras sigue activo
  const redeem2Res = await apiCall("/api/redeem", {
    method: "POST",
    token: expLogin.token,
    body: { code: "VALID-30D-0002" }
  });
  assert.equal(redeem2Res.status, 200);
  const redeem2 = await redeem2Res.json();
  assert.ok(redeem2.user.days_remaining >= 58, "Debe sumar 30 días sobre el tiempo restante");

  // Reintentar llave ya usada debe fallar
  const replayRes = await apiCall("/api/redeem", {
    method: "POST",
    token: regFree.token,
    body: { code: "VALID-30D-0001" }
  });
  assert.equal(replayRes.status, 400);
  console.log("✓ Vencimiento de suscripción, renovación (/api/redeem) y acumulación de días verificados.");

  console.log("\n[4] Bloqueo de contenido VIP en servidor (/api/items/:source/:id)...");
  const guestLocked = await apiCall("/api/items/id/100001");
  assert.equal(guestLocked.status, 403, "Invitado no debe abrir ítem VIP en API");
  const guestFree = await apiCall("/api/items/id/100002");
  assert.equal(guestFree.status, 200, "Invitado sí puede ver vista previa gratuita");
  const freeLocked = await apiCall("/api/items/id/100001", { token: regFree.token });
  assert.equal(freeLocked.status, 403, "Cuenta gratuita no debe abrir ítem VIP");
  const vipUnlocked = await apiCall("/api/items/id/100001", { token: regVip.token });
  assert.equal(vipUnlocked.status, 200, "VIP activo sí abre ítem VIP");
  console.log("✓ Paywall de backend verificado (403 gratuito/vencido, 200 VIP activo).");

  console.log("\n[5] Panel Admin (/api/admin/*): estadísticas, llaves por duración y gestión de usuarios...");
  const nonAdminRes = await apiCall("/api/admin/stats", { token: regVip.token });
  assert.equal(nonAdminRes.status, 403, "Usuario normal no puede entrar a /api/admin");

  const adminLoginRes = await apiCall("/api/auth/login", {
    method: "POST",
    body: { username: "erick", password: "adminpass123" }
  });
  assert.equal(adminLoginRes.status, 200);
  const adminTok = (await adminLoginRes.json()).token;

  const genRes = await apiCall("/api/admin/keys/generate", {
    method: "POST",
    token: adminTok,
    body: { count: 2, duration_days: 30, prefix: "MORBO", note: "Lote Venta" }
  });
  assert.equal(genRes.status, 200);
  const genData = await genRes.json();
  assert.equal(genData.count, 2);
  assert.equal(genData.duration_days, 30);

  const keysListRes = await apiCall("/api/admin/keys?status=available", { token: adminTok });
  assert.equal(keysListRes.status, 200);
  const keysList = await keysListRes.json();
  assert.ok(Array.isArray(keysList) && keysList.some((k) => k.code === genData.keys[0].code));

  const delKeyRes = await apiCall(`/api/admin/keys/${encodeURIComponent(genData.keys[0].code)}`, {
    method: "DELETE",
    token: adminTok
  });
  assert.equal(delKeyRes.status, 200);

  // Extender tiempo manual al usuario gratuito + suspender y bloquear login
  const extendRes = await apiCall(`/api/admin/users/${FREE_ID}/subscription`, {
    method: "POST",
    token: adminTok,
    body: { action: "extend", days: 30 }
  });
  assert.equal(extendRes.status, 200);
  const extendData = await extendRes.json();
  assert.equal(extendData.user.is_pro, true);

  const suspendRes = await apiCall(`/api/admin/users/${FREE_ID}/status`, {
    method: "POST",
    token: adminTok,
    body: { status: "suspended" }
  });
  assert.equal(suspendRes.status, 200);
  const suspendedLoginRes = await apiCall("/api/auth/login", {
    method: "POST",
    body: { username: "freeuser", password: "password123" }
  });
  assert.equal(suspendedLoginRes.status, 403, "Usuario suspendido no puede iniciar sesión");
  console.log("✓ APIs de Administrador (generar llaves, revocar, extender suscripción, suspender) verificadas.");

  console.log("\n[6] Resolución exacta de username en login (sin comodines *alias*)...");
  await apiCall("/api/auth/login", {
    method: "POST",
    body: { username: "ana", password: "password123" }
  });
  assert.equal(lastResolvedLoginEmail, "ana@velvet.local", "Alias 'ana' no debe emparejar a 'bananas@velvet.local'");
  console.log("✓ Alias exacto verificado.");

  console.log("\n[7] Perfil de usuario y lógica cliente VelvetStore.hasFullAccess() en store.js...");
  const profDupRes = await apiCall("/api/user/profile", {
    method: "POST",
    token: regVip.token,
    body: { username: "bananas", avatar: "fire" }
  });
  assert.equal(profDupRes.status, 409, "No debe permitir cambiar a un username ya ocupado");

  const profOkRes = await apiCall("/api/user/profile", {
    method: "POST",
    token: regVip.token,
    body: { username: "comprador1_vip", avatar: "fire" }
  });
  assert.equal(profOkRes.status, 200);
  const profOk = await profOkRes.json();
  assert.equal(profOk.user.username, "comprador1_vip");
  assert.equal(profOk.user.is_pro, true, "Actualizar perfil debe conservar el estado VIP vigente");

  const storeCode = fs.readFileSync(path.join(process.cwd(), "public", "js", "store.js"), "utf8");
  const storage = {};
  const noopClassList = { add: () => {}, remove: () => {}, toggle: () => {} };
  const docMock = {
    cookie: "",
    documentElement: { classList: noopClassList, style: {} },
    body: { classList: noopClassList, style: {} },
    getElementById: () => null
  };
  const sandbox = {
    window: {
      VelvetStore: null,
      dispatchEvent: () => {},
      addEventListener: () => {}
    },
    document: docMock,
    localStorage: {
      getItem: (k) => (k in storage ? storage[k] : null),
      setItem: (k, v) => { storage[k] = String(v); },
      removeItem: (k) => { delete storage[k]; }
    },
    CustomEvent: function CustomEvent() {},
    URLSearchParams,
    console
  };
  sandbox.window.localStorage = sandbox.localStorage;
  sandbox.window.document = sandbox.document;
  vm.runInNewContext(storeCode, sandbox);
  const Store = sandbox.window.VelvetStore;

  assert.equal(Store.hasFullAccess(), false, "Invitado = false");
  Store.setCurrentUser({ id: "u1", role: "member", subscription_status: "inactive", is_pro: false });
  assert.equal(Store.hasFullAccess(), false, "Cuenta gratuita = false");
  Store.setCurrentUser({
    id: "u2", role: "member", is_pro: true, subscription_status: "active",
    subscription_expires_at: new Date(Date.now() + 5 * 86400000).toISOString()
  });
  assert.equal(Store.hasFullAccess(), true, "VIP vigente = true");
  Store.setCurrentUser({
    id: "u3", role: "member", is_pro: true, subscription_status: "active",
    subscription_expires_at: new Date(Date.now() - 3600000).toISOString()
  });
  assert.equal(Store.hasFullAccess(), false, "VIP expirado por reloj = false incluso si caché decía is_pro: true");
  Store.setCurrentUser({ id: "a1", role: "admin", is_admin: true });
  assert.equal(Store.hasFullAccess(), true, "Admin = true");
  console.log("✓ VelvetStore.hasFullAccess() y actualización de perfil verificados.");

  console.log("\n====================================================");
  console.log("✅ TODAS LAS PRUEBAS DE SUSCRIPCIÓN Y USUARIOS PASARON (100%)");
  console.log("====================================================");
} finally {
  server.close();
}
