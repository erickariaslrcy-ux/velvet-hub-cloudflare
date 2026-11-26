const CANONICAL_ORIGIN = "https://www.morbohub.com";
const GATE_TTL_SEC = 6 * 3600;
const GATE_REFRESH_MIN_REM_SEC = 1800;
const _GATE_KEY_CACHE = new Map();

function isPagesDevHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  return host === "morbohub.pages.dev" || host.endsWith(".morbohub.pages.dev");
}

function isSpaNavigation(pathname) {
  const p = pathname.toLowerCase();
  if (p === "/" || p === "/index.html") return false;
  if (p.startsWith("/api/")) return false;
  if (/\.[a-zA-Z0-9]+$/.test(p)) return false;
  return (
    p === "/shorts" ||
    p.startsWith("/shorts/") ||
    p === "/parati" ||
    p === "/videos" ||
    p === "/comics" ||
    p === "/cosplay" ||
    p === "/modelos" ||
    p === "/juegos" ||
    p === "/games" ||
    p === "/favoritos" ||
    p === "/historial" ||
    p === "/cuenta" ||
    p === "/acceso" ||
    p === "/perfil" ||
    p.startsWith("/c/") ||
    p.startsWith("/v/") ||
    p.startsWith("/g/") ||
    p.startsWith("/j/") ||
    p.startsWith("/comic/") ||
    p.startsWith("/video/") ||
    p.startsWith("/gallery/") ||
    p.startsWith("/galeria/") ||
    p.startsWith("/juego/") ||
    p.startsWith("/game/") ||
    p.startsWith("/boveda")
  );
}

function readCookie(request, name) {
  const raw = request.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      const v = part.slice(idx + 1).trim();
      try { return decodeURIComponent(v); } catch (e) { return v; }
    }
  }
  return "";
}

function uaDigest8(request) {
  const ua = String(request.headers.get("user-agent") || "ua").slice(0, 240);
  let h1 = 0x811c9dc5;
  for (let i = 0; i < ua.length; i++) {
    h1 ^= ua.charCodeAt(i);
    h1 = Math.imul(h1, 0x01000193) >>> 0;
  }
  return h1.toString(16).padStart(8, "0");
}

async function getGateHmacKey(secret) {
  if (!secret) return null;
  let k = _GATE_KEY_CACHE.get(secret);
  if (!k) {
    k = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("mh-gate|" + secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    if (_GATE_KEY_CACHE.size > 8) _GATE_KEY_CACHE.clear();
    _GATE_KEY_CACHE.set(secret, k);
  }
  return k;
}

async function signGateValue(expSec, ua8, secret) {
  const key = await getGateHmacKey(secret);
  if (!key) return "";
  const payload = `${expSec}.${ua8}`;
  const buf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  const hex = Array.from(new Uint8Array(buf)).slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${payload}.${hex}`;
}

async function hasFreshValidGateCookie(request, secret) {
  const raw = readCookie(request, "mh_gate");
  if (!raw || !secret) return false;
  const parts = raw.split(".");
  if (parts.length !== 3) return false;
  const expSec = parseInt(parts[0], 10);
  const ua8 = parts[1];
  const sig = parts[2];
  const nowSec = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(expSec) || expSec <= nowSec + GATE_REFRESH_MIN_REM_SEC) return false;
  if (ua8 !== uaDigest8(request) || !/^[0-9a-f]{32}$/.test(sig)) return false;
  const expected = await signGateValue(expSec, ua8, secret);
  return expected === raw;
}

async function attachGateCookieIfNeeded(request, response, secret) {
  if (!secret || !response || response.status !== 200) return response;
  const ctype = (response.headers.get("content-type") || "").toLowerCase();
  if (!ctype.includes("text/html")) return response;
  try {
    if (await hasFreshValidGateCookie(request, secret)) return response;
    const expSec = Math.floor(Date.now() / 1000) + GATE_TTL_SEC;
    const token = await signGateValue(expSec, uaDigest8(request), secret);
    if (!token) return response;
    const secure = new URL(request.url).protocol === "https:";
    const cookie = [
      `mh_gate=${encodeURIComponent(token)}`,
      `Max-Age=${GATE_TTL_SEC}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      secure ? "Secure" : ""
    ].filter(Boolean).join("; ");
    const hdrs = new Headers(response.headers);
    hdrs.append("Set-Cookie", cookie);
    hdrs.set("Cache-Control", "private, no-store, must-revalidate");
    return new Response(response.body, { status: response.status, headers: hdrs });
  } catch (e) {
    return response;
  }
}

export async function onRequest(context) {
  const current = new URL(context.request.url);
  const gateSecret = (context.env && context.env.MEDIA_SECRET) || "";
  if (isPagesDevHost(current.hostname)) {
    const dest = new URL(current.pathname + current.search, CANONICAL_ORIGIN);
    return Response.redirect(dest.toString(), 301);
  }

  // Bloquear acceso público HTTP directo a los catálogos estáticos crudos (/data/*.json).
  // El Worker interno los lee directamente vía env.ASSETS.fetch para enmascarar URLs y aplicar paywall VIP.
  if (current.pathname.toLowerCase().startsWith("/data/")) {
    return new Response(JSON.stringify({ error: "Not Found" }), {
      status: 404,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Robots-Tag": "noindex, nofollow, noarchive"
      }
    });
  }

  const hasFreshGate = await hasFreshValidGateCookie(context.request, gateSecret);
  const fetchFreshIndexShell = async () => {
    const fwdHeaders = new Headers();
    const accept = context.request.headers.get("accept");
    if (accept) fwdHeaders.set("accept", accept);
    const ua = context.request.headers.get("user-agent");
    if (ua) fwdHeaders.set("user-agent", ua);
    const indexReq = new Request(new URL("/", context.request.url), {
      method: context.request.method === "HEAD" ? "HEAD" : "GET",
      headers: fwdHeaders
    });
    const res = await context.env.ASSETS.fetch(indexReq);
    return await attachGateCookieIfNeeded(context.request, res, gateSecret);
  };

  if ((current.pathname === "/" || current.pathname === "/index.html") && !hasFreshGate) {
    const cleanHeaders = new Headers(context.request.headers);
    cleanHeaders.delete("if-none-match");
    cleanHeaders.delete("if-modified-since");
    const cleanReq = new Request(context.request.url, {
      method: context.request.method === "HEAD" ? "HEAD" : "GET",
      headers: cleanHeaders
    });
    const nextRes = await context.next(cleanReq);
    if (nextRes && nextRes.status === 200) {
      return await attachGateCookieIfNeeded(context.request, nextRes, gateSecret);
    }
    if (context.env && context.env.ASSETS && typeof context.env.ASSETS.fetch === "function") {
      return await fetchFreshIndexShell();
    }
    return nextRes;
  }

  // Fast-path para rutas SPA de la aplicación (shorts, cómics, videos, galerías, juegos, bóveda)
  if (isSpaNavigation(current.pathname) && context.env && context.env.ASSETS && typeof context.env.ASSETS.fetch === "function") {
    return await fetchFreshIndexShell();
  }

  const response = await context.next();

  // Si Cloudflare devolvió 404 para una ruta sin extensión (navegación SPA directa), servir /index.html desde raíz
  if (response.status === 404 && !current.pathname.startsWith("/api/")) {
    const hasExt = /\.[a-zA-Z0-9]+$/.test(current.pathname);
    if (!hasExt && context.env && context.env.ASSETS && typeof context.env.ASSETS.fetch === "function") {
      return await fetchFreshIndexShell();
    }
  }

  return await attachGateCookieIfNeeded(context.request, response, gateSecret);
}
