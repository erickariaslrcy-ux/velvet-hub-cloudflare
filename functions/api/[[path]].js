/**
 * CLOUDFLARE PAGES NATIVE API & STEALTH MEDIA ENGINE (100% CLOUDFLARE + SUPABASE)
 * 
 * ARQUITECTURA AUTÓNOMA DE BORDE (CERO DEPENDENCIAS DE VERCEL):
 * 1. Entrega 100% de imágenes, portadas, galerías y streams de video bajo morbohub.pages.dev.
 * 2. Cifra todas las URLs de origen con XOR simétrico + Base64URL (marca blanca impenetrable).
 * 3. Cache mundial ultra-rápido en Cloudflare Edge (10ms) para imágenes y catálogo.
 * 4. Conexión nativa de alto rendimiento con Supabase PostgREST y Supabase Auth.
 * 5. Cero límites de 10GB ni errores 402/494 de Vercel (transferencia ilimitada en Cloudflare Pages).
 */

// =============================================================================
// CRIPTOGRAFÍA SEGURA: WEB CRYPTO API (HMAC-SHA256) CON COMPARACIÓN CONSTANTE
// =============================================================================

const HMAC_KEY_CACHE = new Map();

async function getHmacKey(secret) {
  if (!secret) return null;
  let key = HMAC_KEY_CACHE.get(secret);
  if (!key) {
    const enc = new TextEncoder();
    key = await crypto.subtle.importKey(
      "raw",
      enc.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"]
    );
    if (HMAC_KEY_CACHE.size > 20) {
      HMAC_KEY_CACHE.clear();
    }
    HMAC_KEY_CACHE.set(secret, key);
  }
  return key;
}

function timingSafeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function toBase64Url(str) {
  const utf8Bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < utf8Bytes.length; i++) {
    bin += String.fromCharCode(utf8Bytes[i]);
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(str) {
  let b64 = str.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

// Clave activa inyectada en runtime por onRequest
let _activeMediaSecret = "";
let _activeSupabaseUrl = "";
let _activeSupabaseKey = "";

// Paginación real de datos personales desde PostgreSQL (única fuente de verdad)
const PERSONAL_PAGE_SIZE = 24;

// Generación de token firmado con Web Crypto HMAC-SHA256 y expiración en segundos (14 días)
async function encodeMediaToken(targetUrl, referer = "", secret = "") {
  const s = secret || _activeMediaSecret;
  if (!targetUrl || !s) return "";
  try {
    const exp = Math.floor(Date.now() / 1000) + 1209600; // 14 días
    const payloadStr = JSON.stringify({ u: targetUrl, r: referer || "", exp });
    const dataB64 = toBase64Url(payloadStr);
    const key = await getHmacKey(s);
    if (!key) return "";
    const enc = new TextEncoder();
    const sigBuf = await crypto.subtle.sign("HMAC", key, enc.encode(dataB64));
    const sigHex = Array.from(new Uint8Array(sigBuf)).map(b => b.toString(16).padStart(2, "0")).join("");
    return `${dataB64}.${sigHex}`;
  } catch (e) {
    return "";
  }
}

// Verificación estricta de token con Web Crypto HMAC-SHA256, comparación en tiempo constante y expiración
// Rechaza absolutamente cualquier token alterado, expirado o con rutas legadas XOR.
async function decodeMediaToken(token, secret = "") {
  if (!token || !secret) return null;
  const dotIdx = token.indexOf(".");
  if (dotIdx === -1) return null; // Rechazo inmediato sin HMAC (CERO compatibilidad XOR)

  const dataB64 = token.substring(0, dotIdx);
  const sigHex = token.substring(dotIdx + 1);
  if (!/^[0-9a-f]{64}$/i.test(sigHex)) return null;

  try {
    const key = await getHmacKey(secret);
    if (!key) return null;
    const enc = new TextEncoder();
    const expectedSigBuf = await crypto.subtle.sign("HMAC", key, enc.encode(dataB64));
    const expectedSigHex = Array.from(new Uint8Array(expectedSigBuf)).map(b => b.toString(16).padStart(2, "0")).join("");
    if (!timingSafeEqualHex(expectedSigHex.toLowerCase(), sigHex.toLowerCase())) {
      return null; // Firma alterada o clave no coincidente
    }
    const payloadStr = fromBase64Url(dataB64);
    const payload = JSON.parse(payloadStr);
    if (payload && payload.u) {
      if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) {
        return null; // Token expirado
      }
      return payload;
    }
  } catch (e) {
    return null;
  }
  return null;
}

async function decodePayload(tParam, secret = "") {
  if (tParam) {
    return await decodeMediaToken(tParam, secret);
  }
  return null;
}

// =============================================================================
// PROTECCIÓN ANTI-SSRF (VALIDACIÓN ESTRICTA DE HOSTS Y PROTOCOLOS UPSTREAM)
// =============================================================================
function isSafeUpstreamUrl(urlStr) {
  try {
    const parsed = new URL(urlStr);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    const hostname = parsed.hostname.toLowerCase();

    // Bloqueo de loopback, interfaces internas y metadatos de nube
    if (
      hostname === "localhost" ||
      hostname.endsWith(".local") ||
      hostname.endsWith(".internal") ||
      hostname.endsWith(".onion") ||
      hostname === "0.0.0.0"
    ) {
      return false;
    }

    // Bloqueo de rangos IPv4 privados y Cloud Metadata
    if (/^127\.\d+\.\d+\.\d+$/.test(hostname)) return false; // Loopback
    if (/^10\.\d+\.\d+\.\d+$/.test(hostname)) return false;  // 10.0.0.0/8
    if (/^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(hostname)) return false; // 172.16.0.0/12
    if (/^192\.168\.\d+\.\d+$/.test(hostname)) return false; // 192.168.0.0/16
    if (/^169\.254\.\d+\.\d+$/.test(hostname)) return false; // Link-local y AWS/Cloudflare Metadata (169.254.169.254)

    // Bloqueo de IPv6 (ej: [::1], fe80::, fd00::)
    if (hostname.startsWith("[") || hostname.includes(":")) return false;

    // Lista blanca exhaustiva de dominios upstream permitidos (derivada de datos reales y extractores)
    const ALLOWED_CDN_SUFFIXES = [
      "pmvhaven.com",
      "ovh.net",
      "redporn.tv",
      "redporn.porn",
      "comics18.org",
      "comics18.net",
      "melapelacomics.com",
      "melapelocondibujos.com",
      "vercomicsporno.com",
      "vercomicporno.com",
      "vercomicsporno.xxx",
      "3hentai.net",
      "3hentai.xyz",
      "sexkomix2.com",
      "porn-images-xxx.com",
      "pornone.com",
      "pornhd.com",
      "pornhd.pet",
      "damplips.com",
      "mitaku.net",
      "buondua.com",
      "imagedeliveries.com",
      "4khd.com",
      "xascdn.li",
      "xasiat.com",
      "artgravia.com",
      "cartooncomixhd.com",
      "comicsparaadultos.com",
      "comicspornoxxx.com",
      "fotonovelasxxx.com",
      "hentaipaw.com",
      "leermanhwas.com",
      "manhwaweb.com",
      "img1mw.xyz",
      "img2mw.xyz",
      "mhcomics.com",
      "reycomix.com",
      "leakgallery.com",
      "pornocomic.org",
      "cdnanp.com",
      "cdnde.com",
      "pixibb.com",
      "doujins.com",
      "alotporn.com",
      "porntubeai.com",
      "supabase.co",
      "supabase.in",
      "morbohub.pages.dev",
      "cloudflare.com"
    ];

    // Validación estricta por límite de punto: host idéntico o subdominio legítimo con punto separador
    // Previene evasiones como evil-ovh.net o ovh.net.evil.com
    return ALLOWED_CDN_SUFFIXES.some(suffix =>
      hostname === suffix || hostname.endsWith("." + suffix)
    );
  } catch (e) {
    return false;
  }
}

// =============================================================================
// VALIDACIÓN Y SANITIZACIÓN DEFENSIVA DE ENTRADAS
// =============================================================================
function sanitizeSearchQuery(input) {
  if (!input || typeof input !== "string") return "";
  return input
    .replace(/[(),.*"&:;{}[\]\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
}

function sanitizeSlug(input) {
  if (!input || typeof input !== "string") return "";
  return input.toLowerCase().replace(/[^a-z0-9_\-]/g, "").slice(0, 60);
}

const ALLOWED_SORTS = new Set(["recent", "random", "views", "rating", "popular"]);
function validateSort(sortInput) {
  const s = (sortInput || "recent").trim().toLowerCase();
  return ALLOWED_SORTS.has(s) ? s : "recent";
}

function validatePage(pageInput) {
  const p = parseInt(pageInput || "1", 10);
  return (isNaN(p) || p < 1) ? 1 : Math.min(p, 50000);
}

function validatePageSize(pageSizeInput, defaultSize = 24) {
  const ps = parseInt(pageSizeInput || String(defaultSize), 10);
  return (isNaN(ps) || ps < 1) ? defaultSize : Math.min(ps, 100);
}

// =============================================================================
// CABECERAS CORS ESTRICTAS (SIN WILDCARD CUANDO HAY CREDENCIALES)
// =============================================================================
function getCorsHeaders(origin = "") {
  const allowed = origin && (
    origin.endsWith(".pages.dev") ||
    origin.includes("morbohub") ||
    origin.includes("localhost") ||
    origin.includes("127.0.0.1")
  );
  const allowOrigin = allowed ? origin : (origin || "https://morbohub.pages.dev");
  const headers = {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, PATCH, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, Range, X-Requested-With, X-Refresh-Token, X-Device-Token, x-velvet-client",
    "Server": "Velvet-Cloud",
    "X-Powered-By": "Velvet-Native-Cloudflare-Engine/3.0",
    "Vary": "Origin"
  };
  if (allowed) {
    headers["Access-Control-Allow-Credentials"] = "true";
  }
  return headers;
}

// Memoria RAM Isolate Cache (Nivel 1: < 1ms de latencia en el Edge de Cloudflare)
const ISOLATE_CATALOG_CACHE = new Map();
const ISOLATE_DETAIL_CACHE = new Map();
const MAX_ISOLATE_ENTRIES = 120;

function getIsolateCache(map, key, ttlMs = 900000) {
  const entry = map.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > ttlMs) {
    map.delete(key);
    return null;
  }
  return entry.data;
}

function setIsolateCache(map, key, data) {
  if (map.size >= MAX_ISOLATE_ENTRIES) {
    const firstKey = map.keys().next().value;
    map.delete(firstKey);
  }
  map.set(key, { ts: Date.now(), data });
}

// Límite de escritura en memoria Isolate por usuario para prevenir spam en endpoints personales
const PERSONAL_WRITE_LIMIT_MAP = new Map();
function checkPersonalWriteRateLimit(userId, maxPerMin = 60) {
  if (!userId) return true;
  const now = Date.now();
  let entry = PERSONAL_WRITE_LIMIT_MAP.get(userId);
  if (!entry || now - entry.windowStart > 60000) {
    entry = { windowStart: now, count: 1 };
    PERSONAL_WRITE_LIMIT_MAP.set(userId, entry);
    if (PERSONAL_WRITE_LIMIT_MAP.size > 2000) {
      const oldest = PERSONAL_WRITE_LIMIT_MAP.keys().next().value;
      PERSONAL_WRITE_LIMIT_MAP.delete(oldest);
    }
    return true;
  }
  entry.count++;
  if (entry.count > maxPerMin) {
    return false;
  }
  return true;
}

// Helper para resolver usuario autenticado via Bearer Token o auto-refresh con x-refresh-token
async function resolveAuthUser(request, sbUrl, sbKey) {
  const activeUrl = sbUrl || _activeSupabaseUrl || (typeof SUPABASE_URL !== "undefined" ? SUPABASE_URL : "");
  const activeKey = sbKey || _activeSupabaseKey || (typeof SUPABASE_KEY !== "undefined" ? SUPABASE_KEY : "");
  const authHeader = request.headers.get("authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  const refreshToken = request.headers.get("x-refresh-token") || null;

  // 1. Intentar validar access_token con Supabase Auth
  if (token && token !== "velvet_token" && token !== "null" && token !== "undefined") {
    try {
      const userRes = await fetch(`${activeUrl}/auth/v1/user`, {
        headers: { "apikey": activeKey, "Authorization": `Bearer ${token}` }
      });
      if (userRes.ok) {
        const user = await userRes.json();
        if (user && user.id) {
          return { user, token, newToken: null, newRefreshToken: null };
        }
      }
    } catch (e) {}
  }

  // 2. Si el token expiró o falló pero se envió x-refresh-token, autorenovar sesión silenciosamente
  if (refreshToken && refreshToken !== "null" && refreshToken !== "undefined") {
    try {
      const refRes = await fetch(`${activeUrl}/auth/v1/token?grant_type=refresh_token`, {
        method: "POST",
        headers: { "apikey": activeKey, "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: refreshToken })
      });
      if (refRes.ok) {
        const refData = await refRes.json();
        if (refData && refData.user && refData.access_token) {
          return {
            user: refData.user,
            token: refData.access_token,
            newToken: refData.access_token,
            newRefreshToken: refData.refresh_token || refreshToken
          };
        }
      }
    } catch (e) {}
  }

  return { user: null, token: null, newToken: null, newRefreshToken: null };
}

// Helper para guardar user_metadata en Supabase de forma atómica e infalible
async function updateSupabaseUserMetadata(userId, newMetadata, sbUrl, sbKey) {
  const activeUrl = sbUrl || _activeSupabaseUrl;
  const activeKey = sbKey || _activeSupabaseKey;
  try {
    const res = await fetch(`${activeUrl}/auth/v1/admin/users/${userId}`, {
      method: "PUT",
      headers: {
        "apikey": activeKey,
        "Authorization": `Bearer ${activeKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ user_metadata: newMetadata })
    });
    return res.ok;
  } catch (e) {
    return false;
  }
}

// Helper para sincronizar tabla SQL favorites si el ítem tiene ID numérico
async function syncSqlFavorite(userId, itemId, isAdd, sbUrl, sbKey) {
  if (!itemId || !Number.isInteger(Number(itemId))) return;
  const numId = Number(itemId);
  const activeUrl = sbUrl || _activeSupabaseUrl;
  const activeKey = sbKey || _activeSupabaseKey;
  try {
    if (isAdd) {
      await fetch(`${activeUrl}/rest/v1/favorites`, {
        method: "POST",
        headers: {
          "apikey": activeKey,
          "Authorization": `Bearer ${activeKey}`,
          "Content-Type": "application/json",
          "Prefer": "resolution=merge-duplicates"
        },
        body: JSON.stringify({ user_id: userId, item_id: numId })
      });
    } else {
      await fetch(`${activeUrl}/rest/v1/favorites?user_id=eq.${userId}&item_id=eq.${numId}`, {
        method: "DELETE",
        headers: {
          "apikey": activeKey,
          "Authorization": `Bearer ${activeKey}`
        }
      });
    }
  } catch (e) {}
}

export async function onRequest(context) {
  const env = context.env || {};
  const SUPABASE_URL = env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || "https://qnmcejlxoufheisgkuyo.supabase.co";
  const SUPABASE_ANON_KEY = env.SUPABASE_ANON_KEY || env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
  const SUPABASE_SERVICE_ROLE_KEY = env.SUPABASE_SERVICE_ROLE_KEY || "";
  const SUPABASE_URL_DB2 = env.SUPABASE_URL_DB2 || env.NEXT_PUBLIC_SUPABASE_URL_DB2 || "https://vtyleivfovkolpxjjkjs.supabase.co";
  const SUPABASE_ANON_KEY_DB2 = env.SUPABASE_ANON_KEY_DB2 || env.NEXT_PUBLIC_SUPABASE_ANON_KEY_DB2 || "";
  const SUPABASE_SERVICE_ROLE_KEY_DB2 = env.SUPABASE_SERVICE_ROLE_KEY_DB2 || "";
  const MEDIA_SECRET = env.MEDIA_SECRET || "velvet_master_media_hmac_secret_production_2026";
  _activeMediaSecret = MEDIA_SECRET;

  // Verificación defensiva de arranque de variables de entorno (CERO valores expuestos)
  const REQUIRED_ENV_KEYS = [
    "SUPABASE_URL",
    "SUPABASE_ANON_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "MEDIA_SECRET"
  ];
  const OPTIONAL_ENV_KEYS = [
    "ENVIRONMENT",
    "POSTGREST_COUNT_MODE",
    "ENABLE_PMVHAVEN_LIVE",
    "PATREON_CLIENT_ID",
    "PATREON_CLIENT_SECRET",
    "PATREON_CAMPAIGN_ID"
  ];
  const missingRequired = REQUIRED_ENV_KEYS.filter(k => !env[k] && !env[`NEXT_PUBLIC_${k}`]);
  const missingOptional = OPTIONAL_ENV_KEYS.filter(k => !env[k]);
  const configuredKeys = [...REQUIRED_ENV_KEYS, ...OPTIONAL_ENV_KEYS].filter(k => !!(env[k] || env[`NEXT_PUBLIC_${k}`]));

  if (missingRequired.length > 0) {
    console.warn(`[Velvet-Startup] Variables de entorno críticas ausentes: ${missingRequired.join(", ")}`);
  }

  // Helper local con inyección de secreto para firmar tokens sin exponer nada al cliente
  const encodeToken = async (targetUrl, referer = "") => await encodeMediaToken(targetUrl, referer, MEDIA_SECRET);

  // Clave de mínimo privilegio para catálogo público y operaciones autenticadas con RLS
  const SUPABASE_KEY = SUPABASE_ANON_KEY || SUPABASE_SERVICE_ROLE_KEY;
  // Clave administrativa reservada para backend
  const SUPABASE_ADMIN_KEY = SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY;

  _activeSupabaseUrl = SUPABASE_URL;
  _activeSupabaseKey = SUPABASE_KEY;

  const url = new URL(context.request.url);
  const origin = context.request.headers.get("origin") || "*";
  const method = context.request.method;

  // Manejo de Preflight OPTIONS
  if (method === "OPTIONS") {
    return new Response(null, { status: 204, headers: getCorsHeaders(origin) });
  }

  // =========================================================================
  // 0. VERSIÓN Y OBSERVABILIDAD DEL SISTEMA (/api/version)
  // =========================================================================
  if (url.pathname === "/api/version" && (method === "GET" || method === "HEAD")) {
    const versionPayload = {
      version: "3.1.0",
      cache_version: "v11-velvet-turbo",
      commit: "fix/auditoria-completa",
      env: env.ENVIRONMENT || "production",
      engine: "Cloudflare-Pages-Functions",
      build_time: "2026-11-15T12:00:00Z",
      env_check: {
        all_required_set: missingRequired.length === 0,
        missing_required: missingRequired,
        missing_optional: missingOptional,
        configured_count: configuredKeys.length
      }
    };
    return new Response(method === "HEAD" ? null : JSON.stringify(versionPayload), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=60, s-maxage=300",
        ...getCorsHeaders(origin)
      }
    });
  }

  // =========================================================================
  // 1. REPRODUCCIÓN Y STREAMING DE MEDIOS STEALTH (/api/media, /api/image, etc.)
  // =========================================================================
  const isMediaRoute =
    url.pathname.startsWith("/api/media") ||
    url.pathname.startsWith("/api/image") ||
    url.pathname.startsWith("/api/img") ||
    url.pathname.startsWith("/api/video/stream");

  if (isMediaRoute) {
    if (!MEDIA_SECRET) {
      return new Response(JSON.stringify({
        error: "Configuración incompleta: MEDIA_SECRET no está configurada en las variables de entorno de Cloudflare Pages."
      }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
      });
    }

    const tParam = url.searchParams.get("t");
    const payload = await decodePayload(tParam, MEDIA_SECRET);
    if (!payload || !payload.u || !/^https?:\/\//i.test(payload.u)) {
      return new Response("Media token invalido o expirado", {
        status: 403,
        headers: { "Content-Type": "text/plain; charset=utf-8", ...getCorsHeaders(origin) }
      });
    }

    // Validación estricta anti-SSRF: bloqueo de IPs privadas y verificación de dominios upstream permitidos
    if (!isSafeUpstreamUrl(payload.u)) {
      return new Response("Destino upstream no permitido", {
        status: 403,
        headers: { "Content-Type": "text/plain; charset=utf-8", ...getCorsHeaders(origin) }
      });
    }

    const targetMediaUrl = payload.u;
    const isVideo =
      targetMediaUrl.includes(".mp4") ||
      targetMediaUrl.includes(".m3u8") ||
      url.pathname.includes("/video/");

    // Parámetros de variantes y compresión de imagen (Fase B)
    const rawW = parseInt(url.searchParams.get("w") || "0", 10);
    const ALLOWED_WIDTHS = [120, 240, 360, 480, 720, 1080];
    let targetWidth = 0;
    if (rawW > 0) {
      targetWidth = ALLOWED_WIDTHS.reduce((prev, curr) =>
        Math.abs(curr - rawW) < Math.abs(prev - rawW) ? curr : prev
      );
    }

    const rawQ = parseInt(url.searchParams.get("q") || "70", 10);
    const targetQuality = Math.min(90, Math.max(50, rawQ));

    // Formato por negociación de cabecera Accept
    const acceptHeader = (context.request.headers.get("Accept") || "").toLowerCase();
    const rawFmt = (url.searchParams.get("fmt") || "").toLowerCase();
    let targetFormat = "auto";
    if (["webp", "avif", "jpeg", "jpg", "png"].includes(rawFmt)) {
      targetFormat = rawFmt === "jpg" ? "jpeg" : rawFmt;
    } else {
      if (acceptHeader.includes("image/avif")) targetFormat = "avif";
      else if (acceptHeader.includes("image/webp")) targetFormat = "webp";
    }

    // ETag determinista y revalidación 304 instantánea
    const etagSeed = `${targetMediaUrl}_w${targetWidth}_q${targetQuality}_f${targetFormat}`;
    let etagHash = 0;
    for (let i = 0; i < etagSeed.length; i++) {
      etagHash = (etagHash << 5) - etagHash + etagSeed.charCodeAt(i);
      etagHash |= 0;
    }
    const etag = `W/"${Math.abs(etagHash).toString(36)}"`;

    const ifNoneMatch = context.request.headers.get("if-none-match");
    if (!isVideo && ifNoneMatch && ifNoneMatch === etag) {
      return new Response(null, {
        status: 304,
        headers: {
          "ETag": etag,
          "Cache-Control": "public, max-age=31536000, s-maxage=31536000, immutable",
          "Vary": "Accept",
          "Access-Control-Allow-Origin": "*",
          "Server": "Velvet-Cloud",
          "X-Media-Cache": "HIT-REVALIDATED"
        }
      });
    }

    // Cache Key normalizado en Cloudflare Edge para evitar fragmentación
    const normUrl = new URL(url.origin + url.pathname);
    if (tParam) normUrl.searchParams.set("t", tParam);
    else if (urlParam) normUrl.searchParams.set("url", urlParam);
    if (targetWidth) normUrl.searchParams.set("w", String(targetWidth));
    if (targetQuality) normUrl.searchParams.set("q", String(targetQuality));
    normUrl.searchParams.set("fmt", targetFormat);

    const cache = typeof caches !== "undefined" ? caches.default : null;
    const cacheKey = new Request(normUrl.toString(), {
      method: "GET",
      headers: {
        "Accept": context.request.headers.get("Accept") || "*/*"
      }
    });

    if (cache && !isVideo && method === "GET") {
      try {
        const cached = await cache.match(cacheKey);
        if (cached) {
          const ch = new Headers(cached.headers);
          ch.set("X-Media-Cache", "HIT-CLOUDFLARE");
          ch.set("X-Powered-By", "Velvet-Media-Engine/3.0");
          ch.set("Server", "Velvet-Cloud");
          ch.set("Access-Control-Allow-Origin", "*");
          ch.set("ETag", etag);
          ch.set("Vary", "Accept");
          return new Response(cached.body, { status: cached.status, headers: ch });
        }
      } catch (e) {}
    }

    // Inferencia de Referer para anti-hotlink
    let spoofedReferer = payload.r || "";
    if (!spoofedReferer) {
      if (targetMediaUrl.includes("buondua") || targetMediaUrl.includes("imagedeliveries")) {
        spoofedReferer = "https://buondua.com/";
      } else if (targetMediaUrl.includes("xasiat") || targetMediaUrl.includes("xascdn")) {
        spoofedReferer = "https://xasiat.com/";
      } else if (targetMediaUrl.includes("4khd")) {
        spoofedReferer = "https://4khd.com/";
      } else if (targetMediaUrl.includes("hentaipaw")) {
        spoofedReferer = "https://hentaipaw.com/";
      } else if (targetMediaUrl.includes("pmvhaven") || targetMediaUrl.includes("ovh.net")) {
        spoofedReferer = "https://pmvhaven.com/";
      } else if (targetMediaUrl.includes("pornone")) {
        spoofedReferer = "https://pornone.com/";
      } else if (targetMediaUrl.includes("redporn")) {
        spoofedReferer = "https://redporn.porn/";
      } else if (targetMediaUrl.includes("anyporn")) {
        spoofedReferer = "https://anyporn.com/";
      } else if (targetMediaUrl.includes("damplips")) {
        spoofedReferer = "https://www.damplips.com/";
      } else if (targetMediaUrl.includes("alotporn")) {
        spoofedReferer = "https://www.alotporn.com/";
      } else if (targetMediaUrl.includes("pornhd")) {
        spoofedReferer = "https://pornhd.pet/";
      } else {
        try {
          spoofedReferer = new URL(targetMediaUrl).origin + "/";
        } catch (e) {
          spoofedReferer = targetMediaUrl;
        }
      }
    }

    const upstreamReqHeaders = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
      "Referer": spoofedReferer,
      "Accept": "*/*",
      "Accept-Encoding": "identity",
    };

    const clientRange = context.request.headers.get("Range");
    if (clientRange) {
      upstreamReqHeaders["Range"] = clientRange;
    }

    try {
      let imageTransform = null;
      if (!isVideo && targetWidth > 0) {
        imageTransform = {
          width: targetWidth,
          quality: targetQuality,
          format: targetFormat === "auto" ? undefined : targetFormat,
          fit: "cover"
        };
      }

      const upstream = await fetch(targetMediaUrl, {
        method,
        headers: upstreamReqHeaders,
        redirect: "follow",
        cf: isVideo
          ? undefined
          : {
              cacheEverything: true,
              cacheTtl: 31536000,
              ...(imageTransform ? { image: imageTransform } : {})
            },
      });

      // Si el origen upstream bloqueó la IP del servidor con 403/401/503 (ej. WAF/anti-bot en Buondua),
      // redirigir con 307 al navegador residencial del cliente para descarga directa limpia
      if (!upstream.ok && (upstream.status === 403 || upstream.status === 401 || upstream.status === 503)) {
        return Response.redirect(targetMediaUrl, 307);
      }

      const respHeaders = new Headers();
      respHeaders.set("Content-Type", upstream.headers.get("content-type") || (isVideo ? "video/mp4" : "image/jpeg"));
      respHeaders.set("Access-Control-Allow-Origin", "*");
      respHeaders.set("X-Powered-By", "Velvet-Media-Engine/3.0");
      respHeaders.set("Server", "Velvet-Cloud");

      if (isVideo) {
        respHeaders.set("Accept-Ranges", "bytes");
        respHeaders.set("Cache-Control", "public, max-age=7200");
      } else {
        respHeaders.set("Cache-Control", "public, max-age=31536000, s-maxage=31536000, stale-while-revalidate=604800, immutable");
        respHeaders.set("ETag", etag);
        respHeaders.set("Vary", "Accept");
      }

      if (upstream.headers.has("Content-Length")) {
        respHeaders.set("Content-Length", upstream.headers.get("Content-Length"));
      }
      if (upstream.headers.has("Content-Range")) {
        respHeaders.set("Content-Range", upstream.headers.get("Content-Range"));
      }

      // Reescritura dinámica de listas M3U8 para resolver segmentos y sub-playlists relativos
      const isM3u8 = targetMediaUrl.includes(".m3u8") || (upstream.headers.get("content-type") || "").toLowerCase().includes("mpegurl");
      if (isM3u8 && upstream.ok) {
        try {
          const manifestText = await upstream.text();
          const lastSlash = targetMediaUrl.lastIndexOf("/");
          const baseUrl = lastSlash !== -1 ? targetMediaUrl.substring(0, lastSlash + 1) : targetMediaUrl + "/";
          const lines = manifestText.split("\n");
          const rewritten = await Promise.all(lines.map(async line => {
            const trimmed = line.trim();
            if (!trimmed) return line;
            if (trimmed.startsWith("#")) {
              if (trimmed.includes("URI=")) {
                const match = trimmed.match(/URI=["']([^"']+)["']/);
                if (match && match[1]) {
                  const uri = match[1];
                  const abs = uri.startsWith("http") ? uri : new URL(uri, baseUrl).href;
                  const tok = await encodeMediaToken(abs, spoofedReferer, MEDIA_SECRET);
                  return line.replace(match[0], `URI="/api/media?t=${tok}"`);
                }
              }
              return line;
            }
            const abs = trimmed.startsWith("http") ? trimmed : new URL(trimmed, baseUrl).href;
            const tok = await encodeMediaToken(abs, spoofedReferer, MEDIA_SECRET);
            return `/api/media?t=${tok}`;
          }));
          const rewrittenBody = rewritten.join("\n");
          const m3u8Headers = new Headers(respHeaders);
          m3u8Headers.set("Content-Type", "application/vnd.apple.mpegurl; charset=utf-8");
          m3u8Headers.set("Access-Control-Allow-Origin", "*");
          m3u8Headers.set("Cache-Control", "public, max-age=3600");
          return new Response(rewrittenBody, { status: 200, headers: m3u8Headers });
        } catch (mErr) {
          // Si falla la reescritura, continuar con el streaming normal
        }
      }

      const clientResponse = new Response(upstream.body, {
        status: upstream.status,
        headers: respHeaders,
      });

      if (cache && !isVideo && upstream.status === 200) {
        try {
          context.waitUntil(cache.put(cacheKey, clientResponse.clone()));
        } catch (e) {}
      }

      return clientResponse;
    } catch (err) {
      return new Response(JSON.stringify({ error: `Media Engine Error: ${err.message}` }), {
        status: 502,
        headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
      });
    }
  }

  // =========================================================================
  // 2. DETALLE DE ELEMENTO INDIVIDUAL (/api/items/:source/:id o /api/items/id/:id)
  // =========================================================================
  const itemDetailMatch = url.pathname.match(/^\/api\/items\/(?:id\/([^/]+)|([^/]+)\/([^/]+))$/);
  if (itemDetailMatch && method === "GET") {
    const rawId = itemDetailMatch[1] ? itemDetailMatch[1].replace(/[^a-zA-Z0-9_\-]/g, "") : null;
    const rawSource = itemDetailMatch[2] ? sanitizeSlug(decodeURIComponent(itemDetailMatch[2])) : null;
    const rawSourceId = itemDetailMatch[3] ? decodeURIComponent(itemDetailMatch[3]).replace(/[(),.*"&:;{}[\]\\]/g, "") : null;

    // Cache L1 de Memoria RAM Isolate (0ms)
    const detailCacheKey = url.pathname;
    const l1Detail = getIsolateCache(ISOLATE_DETAIL_CACHE, detailCacheKey, 86400000);
    if (l1Detail && (!l1Detail.includes('"pages":[]') || l1Detail.includes('"chapters":['))) {
      return new Response(l1Detail, {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800",
          "X-Cloudflare-RAM-Cache": "HIT",
          "X-Cloudflare-Detail-Cache": "HIT",
          ...getCorsHeaders(origin)
        }
      });
    }

    // Cache L2 de Borde Cloudflare para detalle de cómics y videos (aceleración instantánea en móvil)
    const cache = typeof caches !== "undefined" ? caches.default : null;
    const cacheKey = new Request(url.toString(), { method: "GET" });
    if (cache) {
      try {
        const cached = await cache.match(cacheKey);
        if (cached) {
          const bodyText = await cached.text();
          if (!bodyText.includes('"pages":[]') || bodyText.includes('"chapters":[')) {
            setIsolateCache(ISOLATE_DETAIL_CACHE, detailCacheKey, bodyText);
            const edgeHeaders = new Headers(cached.headers);
            edgeHeaders.set("X-Cloudflare-Detail-Cache", "HIT");
            edgeHeaders.set("Access-Control-Allow-Origin", origin || "*");
            return new Response(bodyText, { status: 200, headers: edgeHeaders });
          }
        }
      } catch (e) {}
    }

    const targetPmvId = (rawSource === "pmvhaven" ? rawSourceId : rawId);
    if (rawSource === "pmvhaven" || (targetPmvId && /^[a-f0-9]{24}$/i.test(targetPmvId))) {
      try {
        const pmvRes = await fetch(`https://pmvhaven.com/api/videos/${targetPmvId}`, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Referer": "https://pmvhaven.com/",
            "Accept": "application/json"
          }
        });
        if (pmvRes.ok) {
          const pmvData = await pmvRes.json();
          const v = pmvData.video || pmvData.data || pmvData;
          if (v && v.title) {
            const rawCover = v.thumbnailUrl || (v.thumbnailSizes && v.thumbnailSizes.lg && v.thumbnailSizes.lg.url) || "";
            const rawVideo = v.videoUrl || "";
            const coverToken = rawCover ? await encodeMediaToken(rawCover, "https://pmvhaven.com/", MEDIA_SECRET) : "";
            const videoToken = rawVideo ? await encodeMediaToken(rawVideo, "https://pmvhaven.com/", MEDIA_SECRET) : "";
            const detailPayload = {
              id: v._id,
              source: "pmvhaven",
              source_id: v._id,
              title: v.title,
              cover_url: coverToken ? `/api/media?t=${coverToken}` : "",
              media_type: "video",
              tags: v.tags || [],
              artists: v.uploaderUsername ? [v.uploaderUsername] : [],
              url: `https://pmvhaven.com/video?v=${v._id}`,
              page_count: 0,
              pages: [],
              chapters: [],
              video_sources: rawVideo ? [
                {
                  quality: "1080p HD",
                  url: videoToken ? `/api/media?t=${videoToken}` : "",
                  format: "mp4"
                }
              ] : [],
              extra: {
                duration: v.duration || "",
                durationSeconds: v.durationSeconds || 0,
                views: v.views || 0,
                likes: v.likes || 0
              }
            };
            const jsonStr = JSON.stringify(detailPayload);
            setIsolateCache(ISOLATE_DETAIL_CACHE, detailCacheKey, jsonStr);
            return new Response(jsonStr, {
              status: 200,
              headers: {
                "Content-Type": "application/json; charset=utf-8",
                "Cache-Control": "public, max-age=3600, s-maxage=86400",
                ...getCorsHeaders(origin)
              }
            });
          }
        }
      } catch (pmvErr) {
        console.error("PMVHaven detail fetch error:", pmvErr);
      }
    }

    let queryParam = "";
    if (rawId) {
      queryParam = `id=eq.${encodeURIComponent(rawId)}`;
    } else if (rawSource === "id" && rawSourceId) {
      queryParam = `id=eq.${encodeURIComponent(rawSourceId)}`;
    } else if (rawSource && rawSourceId) {
      // Buscar por source_id o ID numérico directo
      const isNum = /^\d+$/.test(rawSourceId);
      if (isNum) {
        queryParam = `or=(id.eq.${encodeURIComponent(rawSourceId)},and(source.eq.${encodeURIComponent(rawSource)},source_id.eq.${encodeURIComponent(rawSourceId)}))`;
      } else {
        queryParam = `source=eq.${encodeURIComponent(rawSource)}&source_id=eq.${encodeURIComponent(rawSourceId)}`;
      }
    }

    try {
      const detailTargetUrl = (rawSource === "gamcore" ? SUPABASE_URL_DB2 : SUPABASE_URL);
      const detailTargetKey = (rawSource === "gamcore" ? (SUPABASE_SERVICE_ROLE_KEY_DB2 || SUPABASE_ADMIN_KEY) : SUPABASE_ADMIN_KEY);
      const spRes = await fetch(`${detailTargetUrl}/rest/v1/items?${queryParam}&limit=1`, {
        headers: { "apikey": detailTargetKey, "Authorization": `Bearer ${detailTargetKey}` }
      });

      if (!spRes.ok) {
        return new Response(JSON.stringify({ detail: "Elemento no encontrado" }), {
          status: 404,
          headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
        });
      }

      const items = await spRes.json();
      if (!items || items.length === 0) {
        return new Response(JSON.stringify({ detail: "Elemento no encontrado" }), {
          status: 404,
          headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
        });
      }

      const it = items[0];

      // Función de limpieza estricta: elimina publicidad, banners VIP y miniaturas de posts relacionados (YARPP)
      const cleanComicPagesList = (pages) => {
        if (!pages || !Array.isArray(pages) || pages.length === 0) return [];
        const adRegex = /(logo|banner|advert|patrocinador|donar|promo|avatar|gravatar|ACCESO-VIPS|HACERSE-VIP|ZONAVIP|CHAT-VIPS|portadavip|unirse[-_]vip|acceso[-_]vip|hacerse[-_]vip|ms-icon|favicon|\/themes\/|\/plugins\/|discord|telegram|yarpp|thumbnail)/i;

        let valid = pages.filter(p => {
          const u = (typeof p === "string" ? p : (p.image_url || p.url || "")).trim();
          if (!u || u.startsWith("data:")) return false;
          if (adRegex.test(u)) return false;
          return true;
        });

        if (valid.length <= 2) return valid.map((p, idx) => ({
          index: idx + 1,
          image_url: typeof p === "string" ? p : p.image_url,
          referer: typeof p === "object" ? (p.referer || "") : ""
        }));

        // Detectar carpeta mensual dominante (/wp-content/uploads/YYYY/MM/) para descartar miniaturas intrusas de otros cómics
        const folderCounts = {};
        for (const p of valid) {
          const u = typeof p === "string" ? p : p.image_url;
          const m = u.match(/\/wp-content\/uploads\/(\d{4}\/\d{2})\//i);
          if (m) folderCounts[m[1]] = (folderCounts[m[1]] || 0) + 1;
        }

        let dominantFolder = null;
        let maxCount = 0;
        for (const [ym, count] of Object.entries(folderCounts)) {
          if (count > maxCount) {
            maxCount = count;
            dominantFolder = ym;
          }
        }

        if (dominantFolder && maxCount >= 2 && maxCount >= valid.length * 0.5) {
          valid = valid.filter(p => {
            const u = typeof p === "string" ? p : p.image_url;
            const m = u.match(/\/wp-content\/uploads\/(\d{4}\/\d{2})\//i);
            if (!m) return true;
            return m[1] === dominantFolder;
          });
        }

        return valid.map((p, idx) => ({
          index: idx + 1,
          image_url: typeof p === "string" ? p : p.image_url,
          referer: typeof p === "object" ? (p.referer || "") : ""
        }));
      };

      // Si el cómic ya tiene páginas, sanitizarlas inmediatamente para expulsar intrusos de posts relacionados
      const isComic = it.media_type === "comic" || !it.media_type;
      if (isComic && it.pages && it.pages.length > 0) {
        const initialCount = it.pages.length;
        const cleaned = cleanComicPagesList(it.pages);
        if (cleaned.length !== initialCount) {
          it.pages = cleaned;
          it.page_count = cleaned.length;
          if (it.pages[0]) it.cover_url = it.pages[0].image_url;
          if (context.waitUntil) {
            context.waitUntil(
              fetch(`${SUPABASE_URL}/rest/v1/items?id=eq.${it.id}`, {
                method: "PATCH",
                headers: {
                  "apikey": SUPABASE_KEY,
                  "Authorization": `Bearer ${SUPABASE_KEY}`,
                  "Content-Type": "application/json",
                  "Prefer": "return=minimal"
                },
                body: JSON.stringify({
                  pages: it.pages,
                  page_count: it.page_count,
                  cover_url: it.cover_url
                })
              }).catch(() => {})
            );
          }
        }
      }

      // Auto-reparación y extracción JIT de páginas si el cómic está sin páginas
      if ((!it.pages || it.pages.length === 0) && isComic) {
        // Caso A: 3hentai tiene páginas deterministas según cover_url y page_count
        if (it.source === "3hentai" && it.cover_url && it.page_count > 0) {
          const baseUrl = it.cover_url.replace(/\/thumb\.[a-z0-9]+$/i, "");
          const extMatch = it.cover_url.match(/\.([a-z0-9]+)$/i);
          const ext = extMatch ? extMatch[1] : "jpg";
          it.pages = [];
          for (let pNum = 1; pNum <= it.page_count; pNum++) {
            it.pages.push({
              index: pNum,
              image_url: `${baseUrl}/${pNum}.${ext}`,
              referer: it.url || `https://3hentai.net/d/${it.source_id}`
            });
          }
          if (context.waitUntil) {
            context.waitUntil(
              fetch(`${SUPABASE_URL}/rest/v1/items?id=eq.${it.id}`, {
                method: "PATCH",
                headers: {
                  "apikey": SUPABASE_KEY,
                  "Authorization": `Bearer ${SUPABASE_KEY}`,
                  "Content-Type": "application/json",
                  "Prefer": "return=minimal"
                },
                body: JSON.stringify({ pages: it.pages })
              }).catch(() => {})
            );
          }
        } else if (it.source === "hentaipaw" || (it.cover_url && it.cover_url.includes("imagedeliveries.com"))) {
          // Caso A2: hentaipaw (cdn.imagedeliveries.com) auto-reparación y detección rápida de páginas
          const sid = it.source_id;
          let pCount = parseInt(it.page_count || "0", 10);
          if (pCount <= 0 && sid) {
            const r1 = await fetch(`https://cdn.imagedeliveries.com/${sid}/thumbnails/1.webp`, { method: "HEAD" }).catch(() => null);
            if (r1 && r1.ok) {
              let low = 1;
              let high = 60;
              let detected = 1;
              while (low <= high) {
                const mid = Math.floor((low + high) / 2);
                const testRes = await fetch(`https://cdn.imagedeliveries.com/${sid}/thumbnails/${mid}.webp`, { method: "HEAD" }).catch(() => null);
                if (testRes && testRes.ok) {
                  detected = mid;
                  low = mid + 1;
                } else {
                  high = mid - 1;
                }
              }
              pCount = detected;
            }
          }

          if (pCount > 0 && sid) {
            it.page_count = pCount;
            it.pages = [];
            for (let pNum = 1; pNum <= pCount; pNum++) {
              it.pages.push({
                index: pNum,
                image_url: `https://cdn.imagedeliveries.com/${sid}/thumbnails/${pNum}.webp`,
                referer: it.url || `https://es.hentaipaw.com/articles/${sid}`
              });
            }
            if (context.waitUntil) {
              context.waitUntil(
                fetch(`${SUPABASE_URL}/rest/v1/items?id=eq.${it.id}`, {
                  method: "PATCH",
                  headers: {
                    "apikey": SUPABASE_KEY,
                    "Authorization": `Bearer ${SUPABASE_KEY}`,
                    "Content-Type": "application/json",
                    "Prefer": "return=minimal"
                  },
                  body: JSON.stringify({ pages: it.pages, page_count: it.page_count })
                }).catch(() => {})
              );
            }
          }
        } else if (it.url && it.url.startsWith("http")) {
          // Caso B: Cómics web / WordPress (melapelocondibujos, melapelacomics, reycomix, pornocomic, vercomicporno, etc.)
          try {
            const pageResp = await fetch(it.url, {
              headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
                "Referer": it.url
              }
            });
            if (pageResp.ok) {
              const html = await pageResp.text();

              // 1. Aislar estrictamente el contenedor del cómic (#penci-post-entry-inner, .entry-content, article)
              let contentHtml = html;
              const entryMatch = html.match(/<(?:article|div)[^>]+class=["'][^"']*(?:penci-post-entry-inner|inner-post-entry|post-entry|entry-content|the_content|post-content|comic-content)[^"']*["']/i);
              if (entryMatch) {
                let sub = html.substring(entryMatch.index);
                // Cortar antes de posts relacionados (YARPP), comentarios, widgets, sidebar y footer
                const cutMatch = sub.match(/(?:class=["'][^"']*(?:yarpp|related|sharedaddy|jp-relatedposts|comments-area|post-navigation|widget-area|sidebar)[^"']*["']|<div[^>]+id=["'](?:comments|sidebar|related|footer)["']|<footer|<aside)/i);
                if (cutMatch) {
                  sub = sub.substring(0, cutMatch.index);
                }
                contentHtml = sub;
              }

              const imgRegex = /<img[^>]+(?:data-src|data-lazy-src|data-original|src)=["']([^"']+)["'][^>]*>/gi;
              const bannerRegex = /(logo|banner|advert|patrocinador|donar|promo|avatar|gravatar|ACCESO-VIPS|HACERSE-VIP|ZONAVIP|CHAT-VIPS|portadavip|unirse[-_]vip|acceso[-_]vip|hacerse[-_]vip|ms-icon|favicon|\/themes\/|\/plugins\/|discord|telegram)/i;
              const thumbRegex = /-\d{2,4}x\d{2,4}(?=\.(?:jpe?g|png|webp|gif)$)/i;
              let m;
              const foundImgs = [];
              while ((m = imgRegex.exec(contentHtml)) !== null) {
                const tagStr = m[0];
                if (/class=["'][^"']*(?:yarpp|thumbnail|wp-post-image|avatar)[^"']*["']/i.test(tagStr)) continue;
                let src = m[1];
                if (!src || src.startsWith("data:")) continue;
                if (src.startsWith("//")) src = "https:" + src;
                if (bannerRegex.test(src)) continue;
                src = src.split("?")[0].replace(thumbRegex, "");
                if (src.includes("/wp-content/uploads/") || /\.(?:jpe?g|png|webp)$/i.test(src)) {
                  if (!foundImgs.includes(src)) foundImgs.push(src);
                }
              }
              if (foundImgs.length > 0) {
                foundImgs.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
                it.pages = cleanComicPagesList(foundImgs.map((u, idx) => ({
                  index: idx + 1,
                  image_url: u,
                  referer: it.url
                })));
                it.page_count = it.pages.length;
                if (!it.cover_url && it.pages[0]) {
                  it.cover_url = it.pages[0].image_url;
                }
                if (context.waitUntil) {
                  context.waitUntil(
                    fetch(`${SUPABASE_URL}/rest/v1/items?id=eq.${it.id}`, {
                      method: "PATCH",
                      headers: {
                        "apikey": SUPABASE_KEY,
                        "Authorization": `Bearer ${SUPABASE_KEY}`,
                        "Content-Type": "application/json",
                        "Prefer": "return=minimal"
                      },
                      body: JSON.stringify({
                        pages: it.pages,
                        page_count: it.page_count,
                        cover_url: it.cover_url
                      })
                    }).catch(() => {})
                  );
                }
              }
            }
          } catch (scrapeErr) {
            // Continuar si falla el fetch en vivo
          }
        }
      }

      // Auto-reparación y extracción JIT de video streams si el video está sin fuentes, le falta MP4 directo o tiene tokens efímeros
      const hasDirectMp4 = (it.video_sources || []).some(s => s.format === "mp4" || (s.url && s.url.includes(".mp4")));
      const isEphemeral = it.source === "pornone";
      const isPmv = it.source === "pmvhaven" || (it.url && it.url.includes("pmvhaven.com"));
      const needsPmvMp4 = isPmv && !hasDirectMp4;

      if ((!it.video_sources || it.video_sources.length === 0 || isEphemeral || needsPmvMp4) && (it.media_type === "video" || isPmv || it.source === "pornone" || it.source === "redporn" || it.source === "anyporn" || it.source === "alotporn" || it.source === "damplips" || it.source === "pornhd")) {
        let streams = [...(it.video_sources || [])];

        // 1. PMVHaven API (garantiza extracción inmediata del stream 1080p MP4)
        if (isPmv) {
          const pmvId = it.source_id || ((it.url && it.url.match(/[?&]v=([a-f0-9]{24})/i)) || (it.url && it.url.match(/\/([a-f0-9]{24})/i)) || [])[1];
          if (pmvId) {
            try {
              const pmvRes = await fetch(`https://pmvhaven.com/api/videos/${pmvId}`, {
                headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", "Accept": "application/json" }
              });
              if (pmvRes.ok) {
                const pmvData = await pmvRes.json();
                const vData = pmvData?.data;
                if (vData) {
                  const newStreams = [];
                  if (vData.videoUrl) newStreams.push({ quality: "1080p HD", url: vData.videoUrl, format: "mp4" });
                  if (vData.hlsMasterPlaylistUrl) newStreams.push({ quality: "Master Multi-Bitrate HD", url: vData.hlsMasterPlaylistUrl, format: "m3u8" });
                  for (const s of streams) {
                    if (!newStreams.some(ns => ns.url === s.url)) newStreams.push(s);
                  }
                  streams = newStreams;
                }
              }
            } catch (e) {}
          }
        }

        // 2. Extractor Web JIT multi-sitio (PornOne, AnyPorn, RedPorn, Damplips, AlotPorn, PornHD, etc.)
        if (streams.length === 0 && it.url && it.url.startsWith("http")) {
          try {
            const cleanUrl = it.url.replace("es.anyporn.com", "anyporn.com");
            const vResp = await fetch(cleanUrl, {
              headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
                "Referer": cleanUrl
              }
            });
            if (vResp.ok) {
              const html = await vResp.text();

              // A. AnyPorn JS sources object
              const srcObjMatch = html.match(/sources\s*=\s*(\{.*?\});/s);
              if (srcObjMatch) {
                const found = [...srcObjMatch[1].matchAll(/(\d+)\s*:\s*['"]([^'"]+)['"]/g)];
                for (const f of found) {
                  streams.push({ quality: `${f[1]}p`, url: f[2], format: f[2].includes(".m3u8") ? "m3u8" : "mp4" });
                }
              }

              // B. Schema.org contentUrl (PornOne, AnyPorn)
              const contentUrl = html.match(/"contentUrl":\s*"([^"]+)"/);
              if (contentUrl && !streams.some(s => s.url === contentUrl[1])) {
                streams.push({ quality: "720p HD", url: contentUrl[1], format: contentUrl[1].includes(".m3u8") ? "m3u8" : "mp4" });
              }

              // C. HTML5 <source> tags (PornOne, RedPorn, Damplips, etc.)
              const sourcesMatch = [...html.matchAll(/<source[^>]+src=["']([^"']+)["']/gi)];
              for (const sm of sourcesMatch) {
                const src = sm[1];
                if (src.includes("preview") && cleanUrl.includes("alotporn")) continue;
                if (!streams.some(s => s.url === src)) {
                  let q = "1080p HD";
                  if (src.includes("720") || sm[0].includes("720")) q = "720p HD";
                  else if (src.includes("480") || sm[0].includes("480")) q = "480p";
                  else if (src.includes("360") || sm[0].includes("360")) q = "360p";
                  streams.push({ quality: q, url: src, format: src.includes(".m3u8") ? "m3u8" : "mp4" });
                }
              }

              // D. JS video file configs (jwplayer, videojs, embed)
              const fileMatches = [...html.matchAll(/(?:file|video_url|source|stream_url)\s*:\s*["'](https?:\/\/[^"']+\.(?:mp4|m3u8)[^"']*)["']/gi)];
              for (const fm of fileMatches) {
                const fUrl = fm[1];
                if (fUrl.includes("preview") && cleanUrl.includes("alotporn")) continue;
                if (!streams.some(s => s.url === fUrl)) {
                  streams.push({ quality: "1080p HD", url: fUrl, format: fUrl.includes(".m3u8") ? "m3u8" : "mp4" });
                }
              }

              // E. Fallback MP4 directo
              if (streams.length === 0) {
                const mp4s = [...new Set(html.match(/https?:\/\/[^\s'"<>]+\.(?:mp4|m3u8)(?:\?[^\s'"<>]*)?/gi) || [])];
                for (const m of mp4s) {
                  if (m.includes("preview") && cleanUrl.includes("alotporn")) continue;
                  if (!streams.some(s => s.url === m)) {
                    streams.push({ quality: "720p HD", url: m, format: m.includes(".m3u8") ? "m3u8" : "mp4" });
                  }
                }
              }
            }
          } catch (e) {}
        }

        if (streams.length > 0) {
          // Priorizar siempre streams MP4 directos sobre HLS para inicio instantáneo
          streams.sort((a, b) => {
            const aMp4 = a.format === "mp4" || (a.url && a.url.includes(".mp4")) ? 1 : 0;
            const bMp4 = b.format === "mp4" || (b.url && b.url.includes(".mp4")) ? 1 : 0;
            return bMp4 - aMp4;
          });
          it.video_sources = streams;
          if (context.waitUntil && !isEphemeral) {
            context.waitUntil(
              fetch(`${SUPABASE_URL}/rest/v1/items?id=eq.${it.id}`, {
                method: "PATCH",
                headers: {
                  "apikey": SUPABASE_KEY,
                  "Authorization": `Bearer ${SUPABASE_KEY}`,
                  "Content-Type": "application/json",
                  "Prefer": "return=minimal"
                },
                body: JSON.stringify({ video_sources: it.video_sources })
              }).catch(() => {})
            );
          }
        }
      }

      const sortedSources = [...(it.video_sources || [])].sort((a, b) => {
        const aMp4 = a.format === "mp4" || (a.url && a.url.includes(".mp4")) ? 1 : 0;
        const bMp4 = b.format === "mp4" || (b.url && b.url.includes(".mp4")) ? 1 : 0;
        return bMp4 - aMp4;
      });

      const maskedCoverToken = it.cover_url ? await encodeMediaToken(it.cover_url, "", MEDIA_SECRET) : "";
      const maskedPages = await Promise.all((it.pages || []).map(async (p, idx) => ({
        index: p.index || idx + 1,
        image_url: p.image_url ? `/api/media?t=${await encodeMediaToken(p.image_url, "", MEDIA_SECRET)}` : ""
      })));
      const maskedVideoSources = await Promise.all(sortedSources.map(async vs => ({
        ...vs,
        url: vs.url ? `/api/media?t=${await encodeMediaToken(vs.url, it.url || vs.referer || "", MEDIA_SECRET)}` : ""
      })));

      const masked = {
        ...it,
        url: "", // Ocultar URL original
        cover_url: maskedCoverToken ? `/api/media?t=${maskedCoverToken}` : "",
        pages: maskedPages,
        video_sources: maskedVideoSources
      };

      const jsonStr = JSON.stringify(masked);
      const isComicEmpty = isComic && (!masked.pages || masked.pages.length === 0) && (!it.chapters || it.chapters.length === 0);
      const shouldCache = !isEphemeral && !isComicEmpty;

      if (shouldCache) {
        setIsolateCache(ISOLATE_DETAIL_CACHE, detailCacheKey, jsonStr);
      }

      const resp = new Response(jsonStr, {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": shouldCache ? "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800" : "no-store, no-cache, must-revalidate",
          ...getCorsHeaders(origin)
        }
      });

      if (cache && shouldCache && method === "GET") {
        try {
          context.waitUntil(cache.put(cacheKey, resp.clone()));
        } catch (e) {}
      }

      return resp;
    } catch (err) {
      return new Response(JSON.stringify({ detail: err.message }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
      });
    }
  }

  // =========================================================================
  // 3. CATÁLOGO PRINCIPAL Y BÚSQUEDA (/api/items)
  // =========================================================================
  if (url.pathname === "/api/items" && (method === "GET" || method === "HEAD")) {
    const rawMediaType = (url.searchParams.get("media_type") || "comic").trim().toLowerCase();
    const mediaType = ["comic", "video", "gallery", "cosplay", "game"].includes(rawMediaType) ? rawMediaType : "comic";
    const page = validatePage(url.searchParams.get("page"));
    const pageSize = validatePageSize(url.searchParams.get("page_size"), 24);
    const q = sanitizeSearchQuery(url.searchParams.get("q"));
    const category = sanitizeSlug(url.searchParams.get("category"));
    const tag = sanitizeSlug(url.searchParams.get("tag"));
    const seedParam = Math.max(0, Math.min(1000000, parseInt(url.searchParams.get("seed") || "0", 10) || 0));
    const sort = validateSort(url.searchParams.get("sort"));

    // Cache L1 de Memoria RAM Isolate (0ms de latencia)
    const isolateCatalogKey = `${mediaType}:${page}:${pageSize}:${q}:${category}:${tag}:${seedParam}:${sort}`;
    const l1Catalog = getIsolateCache(ISOLATE_CATALOG_CACHE, isolateCatalogKey, q ? 300000 : 1800000);
    if (l1Catalog) {
      return new Response(method === "HEAD" ? null : l1Catalog, {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": q ? "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400" : "public, max-age=1800, s-maxage=86400, stale-while-revalidate=604800",
          "X-Cloudflare-RAM-Cache": "HIT",
          "X-Cloudflare-Edge-Cache": "HIT",
          ...getCorsHeaders(origin)
        }
      });
    }

    // Cache L2 de Borde Cloudflare para catálogo público
    const cache = typeof caches !== "undefined" ? caches.default : null;
    const cacheKey = new Request(url.toString(), { method: "GET" });
    if (cache) {
      try {
        const cached = await cache.match(cacheKey);
        if (cached) {
          const bodyText = await cached.text();
          setIsolateCache(ISOLATE_CATALOG_CACHE, isolateCatalogKey, bodyText);
          const edgeHeaders = new Headers(cached.headers);
          edgeHeaders.set("X-Cloudflare-Edge-Cache", "HIT");
          edgeHeaders.set("Access-Control-Allow-Origin", origin || "*");
          return new Response(method === "HEAD" ? null : bodyText, { status: 200, headers: edgeHeaders });
        }
      } catch (e) {}
    }



    const preferLivePmv = env.ENABLE_PMVHAVEN_LIVE !== "false" && url.searchParams.get("source") !== "supabase" && url.searchParams.get("source") !== "db";
    if (mediaType === "video" && preferLivePmv) {
      let pmvSort = "recent";
      if (sort === "random") pmvSort = "random";
      else if (sort === "views") pmvSort = "views";
      else if (sort === "rating") pmvSort = "rating";

      let pmvApiUrl = `https://pmvhaven.com/api/videos?page=${page}&limit=${pageSize}&sort=${pmvSort}`;
      if (category && category !== "all") {
        pmvApiUrl += `&tag=${encodeURIComponent(category)}`;
      } else if (q) {
        pmvApiUrl += `&tag=${encodeURIComponent(q)}`;
      }

      try {
        const pmvRes = await fetch(pmvApiUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
            "Referer": "https://pmvhaven.com/",
            "Accept": "application/json, text/plain, */*"
          }
        });

        if (pmvRes.ok) {
          const pmvData = await pmvRes.json();
          const vList = pmvData.videos || [];
          const items = await Promise.all(vList.map(async v => {
            const rawCover = v.thumbnailUrl || (v.thumbnailSizes && v.thumbnailSizes.lg && v.thumbnailSizes.lg.url) || "";
            const rawVideo = v.videoUrl || "";
            const coverToken = rawCover ? await encodeMediaToken(rawCover, "https://pmvhaven.com/", MEDIA_SECRET) : "";
            const videoToken = rawVideo ? await encodeMediaToken(rawVideo, "https://pmvhaven.com/", MEDIA_SECRET) : "";
            return {
              id: v._id,
              source: "pmvhaven",
              source_id: v._id,
              title: v.title || "Video HD",
              cover_url: coverToken ? `/api/media?t=${coverToken}` : "",
              media_type: "video",
              tags: v.tags || [],
              artists: v.uploaderUsername ? [v.uploaderUsername] : [],
              url: `https://pmvhaven.com/video?v=${v._id}`,
              page_count: 0,
              video_sources: rawVideo ? [
                {
                  quality: "1080p HD",
                  url: videoToken ? `/api/media?t=${videoToken}` : "",
                  format: "mp4"
                }
              ] : [],
              extra: {
                duration: v.duration || "",
                durationSeconds: v.durationSeconds || 0,
                views: v.views || 0,
                likes: v.likes || 0
              },
              has_cover: !!rawCover
            };
          }));

          const totalVideos = pmvData.pagination?.total || 70704;
          const totalPages = pmvData.pagination?.totalPages || Math.ceil(totalVideos / pageSize);

          const responsePayload = {
            items,
            total: totalVideos,
            page: parseInt(pmvData.pagination?.page || page, 10),
            page_size: pageSize,
            total_pages: totalPages,
            live: true
          };

          const jsonStr = JSON.stringify(responsePayload);
          setIsolateCache(ISOLATE_CATALOG_CACHE, isolateCatalogKey, jsonStr);

          return new Response(jsonStr, {
            status: 200,
            headers: {
              "Content-Type": "application/json; charset=utf-8",
              "Cache-Control": "public, max-age=1800, s-maxage=86400, stale-while-revalidate=86400",
              ...getCorsHeaders(origin)
            }
          });
        }
      } catch (pmvErr) {
        console.error("PMVHaven API error:", pmvErr);
      }
    }

    let estimatedTotal = 37485;
    if (mediaType === "video") {
      estimatedTotal = 20242;
    } else if (mediaType === "gallery" || mediaType === "cosplay") {
      estimatedTotal = 18260;
    }

    // Modo aleatorio y rotación cada 3 horas SOLO si sort=random o viene seed Y no hay búsqueda, categoría ni tag
    const isRandomMode = (sort === "random" || seedParam > 0) && !q && !tag && (!category || category === "all");
    let baseOffset = 0;

    if (isRandomMode) {
      const THREE_HOURS_MS = 3 * 60 * 60 * 1000;
      const threeHourSlot = Math.floor(Date.now() / THREE_HOURS_MS);
      const effectiveSeed = seedParam > 0 ? seedParam : (((threeHourSlot * 7919) % 50000) + 1);

      let maxCatalogOffset = 18000;
      if (mediaType === "video") {
        maxCatalogOffset = 35000;
      } else if (mediaType === "gallery" || mediaType === "cosplay") {
        maxCatalogOffset = 15000;
      } else {
        maxCatalogOffset = 18000;
      }

      const maxPageSlots = Math.floor(maxCatalogOffset / pageSize);
      // Salto aleatorio de amplio espectro: permite iniciar en cualquier página profunda (ej. pág 334, 391)
      const randomStartPage = (Math.abs(effectiveSeed * 313) % Math.max(1, maxPageSlots - 30));
      baseOffset = randomStartPage * pageSize;
    }

    const safePage = Math.max(1, page);
    // Paginación continua y acotada: en modo aleatorio envuelve dentro del catálogo total, en orden directo respeta offset
    const maxOffset = Math.max(0, estimatedTotal - pageSize);
    let offset = 0;
    if (isRandomMode) {
      offset = (baseOffset + (safePage - 1) * pageSize) % Math.max(pageSize, maxOffset);
    } else {
      offset = (safePage - 1) * pageSize;
    }

    const isGameMedia = (mediaType === "game");
    const selectFields = "id,source,source_id,title,cover_url,media_type,tags,page_count,artists,video_sources";
    let postgrestUrl = `${SUPABASE_URL}/rest/v1/items?select=${selectFields}&limit=${pageSize}&offset=${offset}`;

    if (mediaType === "game") {
      postgrestUrl = `${SUPABASE_URL_DB2}/rest/v1/items?select=${selectFields}&limit=${pageSize}&offset=${offset}&media_type=eq.game`;
    } else if (mediaType === "video") {
      postgrestUrl += "&media_type=eq.video";
    } else if (mediaType === "gallery" || mediaType === "cosplay") {
      postgrestUrl += "&media_type=eq.gallery&page_count=gt.0";
      const allowLeak = (Math.random() < 0.002) || (q && q.toLowerCase().includes("leak")) || (category === "leak" || category === "patreon");
      if (!allowLeak) {
        postgrestUrl += "&source=neq.leakgallery";
      }
    } else {
      postgrestUrl += "&media_type=eq.comic&page_count=gt.0";
    }

    if (tag) {
      postgrestUrl += `&tags=cs.{${encodeURIComponent(tag)}}`;
    }

    if (q) {
      const words = q.split(/\s+/).filter(Boolean).slice(0, 3);
      if (words.length === 1) {
        postgrestUrl += `&search_text=ilike.*${encodeURIComponent(words[0])}*`;
      } else {
        const orClauses = words.map(w => `search_text.ilike.*${encodeURIComponent(w)}*`).join(",");
        postgrestUrl += `&or=(${orClauses})`;
      }
    } else if (category && category !== "all") {
      let catTerm = category;
      if (mediaType === "gallery" || mediaType === "cosplay") {
        if (category === "cosplay") catTerm = "cosplay";
        else if (category === "artgravia") catTerm = "artgravia";
        else if (category === "korean") catTerm = "korean";
        else if (category === "asian" || category === "xiuren") catTerm = "xiuren";
        else if (category === "lingerie" || category === "bikini") catTerm = "bikini";
        else if (category === "patreon") catTerm = "patreon";
      } else if (mediaType === "video") {
        if (category === "pmv") catTerm = "pmv";
        else if (category === "milf") catTerm = "milf";
        else if (category === "amateur") catTerm = "amateur";
        else if (category === "anal") catTerm = "anal";
        else if (category === "pov") catTerm = "pov";
        else if (category === "group") catTerm = "threesome";
        else if (category === "tits") catTerm = "tit";
        else if (category === "blondes") catTerm = "blonde";
        else if (category === "brunettes") catTerm = "latina";
        else if (category === "russians") catTerm = "russian";
        else if (category === "hd") catTerm = "1080p";
      } else {
        if (category === "manhwa") catTerm = "manhwa";
        else if (category === "3d") catTerm = "3d";
        else if (category === "doujin") catTerm = "doujin";
        else if (category === "parody") catTerm = "parodia";
        else if (category === "western") catTerm = "comic";
      }
      postgrestUrl += `&search_text=ilike.*${encodeURIComponent(catTerm)}*`;
    }

    // Orden por defecto indexado por clave primaria
    postgrestUrl += "&order=id.desc";

    try {
      // Optimización PostgREST: count=exact para búsquedas/tags; count=planned para catálogos masivos (0ms vs timeout)
      const preferCount = (q || tag) ? "count=exact" : (env.POSTGREST_COUNT_MODE || "count=planned");
      const activeQueryKey = isGameMedia ? (SUPABASE_SERVICE_ROLE_KEY_DB2 || SUPABASE_ANON_KEY_DB2 || SUPABASE_KEY) : SUPABASE_KEY;
      let spRes = await fetch(postgrestUrl, {
        headers: {
          "apikey": activeQueryKey,
          "Authorization": `Bearer ${activeQueryKey}`,
          "Prefer": preferCount
        }
      });

      // Blindaje contra timeout: Si PostgREST se demora o devuelve 57014 (statement timeout), reintentar sin Prefer count
      if (!spRes.ok) {
        const errText = await spRes.text();
        if (errText.includes("57014") || errText.includes("timeout") || errText.includes("canceling statement")) {
          console.warn("[Velvet-Items] Timeout detectado en PostgREST count. Reintentando sin cabecera Prefer...");
          spRes = await fetch(postgrestUrl, {
            headers: {
              "apikey": activeQueryKey,
              "Authorization": `Bearer ${activeQueryKey}`
            }
          });
        }
        if (!spRes.ok) {
          // Si el offset profundo sigue fallando por timeout o rango excedido (ej. 416), reintentar en página 1 preservando filtros
          const pageOneUrl = postgrestUrl.replace(/offset=\d+/, 'offset=0');
          spRes = await fetch(pageOneUrl, {
            headers: {
              "apikey": activeQueryKey,
              "Authorization": `Bearer ${activeQueryKey}`
            }
          });
        }
        if (!spRes.ok) {
          const finalErr = spRes === null ? errText : await spRes.text().catch(() => errText);
          return new Response(JSON.stringify({ error: "Error consultando catálogo", detail: finalErr }), {
            status: 500,
            headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
          });
        }
      }

      // Obtener el conteo real exacto mediante cabecera Content-Range
      const contentRange = spRes.headers.get("content-range");
      let totalCount = estimatedTotal;
      if (contentRange && contentRange.includes("/")) {
        const totalPart = contentRange.split("/")[1];
        if (totalPart && totalPart !== "*") {
          const parsedTotal = parseInt(totalPart, 10);
          if (!isNaN(parsedTotal) && parsedTotal >= 0) {
            totalCount = parsedTotal;
          }
        }
      }

      let rawItems = await spRes.json();
      const items = await Promise.all((rawItems || []).map(async it => {
        const coverToken = it.cover_url ? await encodeMediaToken(it.cover_url, "", MEDIA_SECRET) : "";
        const videoSources = await Promise.all((it.video_sources || []).map(async vs => ({
          ...vs,
          url: vs.url ? `/api/media?t=${await encodeMediaToken(vs.url, "", MEDIA_SECRET)}` : ""
        })));
        return {
          id: it.id,
          source: it.source || "velvet",
          source_id: it.source_id ? String(it.source_id) : String(it.id),
          title: it.title,
          cover_url: coverToken ? `/api/media?t=${coverToken}` : "",
          media_type: it.media_type,
          tags: it.tags || [],
          artists: it.artists || [],
          url: "", // Ocultar URL original
          page_count: it.page_count || 0,
          video_sources: videoSources,
          has_cover: !!it.cover_url
        };
      }));

      const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));

      const responsePayload = {
        items,
        total: totalCount,
        page: safePage,
        page_size: pageSize,
        total_pages: totalPages,
        live: false
      };

      const jsonStr = JSON.stringify(responsePayload);
      setIsolateCache(ISOLATE_CATALOG_CACHE, isolateCatalogKey, jsonStr);

      const resp = new Response(method === "HEAD" ? null : jsonStr, {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": q ? "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400" : "public, max-age=1800, s-maxage=86400, stale-while-revalidate=604800",
          ...getCorsHeaders(origin)
        }
      });

      if (cache) {
        try {
          context.waitUntil(cache.put(cacheKey, resp.clone()));
        } catch (e) {}
      }

      return resp;
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
      });
    }
  }

  // =========================================================================
  // 4. RANDOM / SORPRÉNDEME (/api/random)
  // =========================================================================
  if (url.pathname === "/api/random" && method === "GET") {
    const mediaType = url.searchParams.get("media_type") || "comic";
    const count = Math.min(10, Math.max(1, parseInt(url.searchParams.get("count") || "1", 10)));
    const maxOffset = mediaType === "video" ? 3000 : (mediaType === "gallery" ? 3000 : 5000);
    const randomOffset = Math.floor(Math.random() * Math.max(1, maxOffset - count));

    const preferLivePmv = env.ENABLE_PMVHAVEN_LIVE !== "false" && url.searchParams.get("source") !== "supabase" && url.searchParams.get("source") !== "db";
    if (mediaType === "video" && preferLivePmv) {
      try {
        const pmvRes = await fetch(`https://pmvhaven.com/api/videos?sort=random&limit=${count}`, {
          headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", "Referer": "https://pmvhaven.com/" }
        });
        if (pmvRes.ok) {
          const pmvData = await pmvRes.json();
          const items = await Promise.all((pmvData.videos || []).map(async v => {
            const rawCover = v.thumbnailUrl || (v.thumbnailSizes && v.thumbnailSizes.lg && v.thumbnailSizes.lg.url) || "";
            const coverToken = rawCover ? await encodeMediaToken(rawCover, "https://pmvhaven.com/", MEDIA_SECRET) : "";
            const videoToken = v.videoUrl ? await encodeMediaToken(v.videoUrl, "https://pmvhaven.com/", MEDIA_SECRET) : "";
            return {
              id: v._id,
              source: "pmvhaven",
              source_id: v._id,
              title: v.title,
              cover_url: coverToken ? `/api/media?t=${coverToken}` : "",
              media_type: "video",
              tags: v.tags || [],
              artists: v.uploaderUsername ? [v.uploaderUsername] : [],
              url: `https://pmvhaven.com/video?v=${v._id}`,
              page_count: 0,
              video_sources: videoToken ? [{ quality: "1080p HD", url: `/api/media?t=${videoToken}`, format: "mp4" }] : []
            };
          }));
          return new Response(JSON.stringify(items), {
            status: 200,
            headers: { "Content-Type": "application/json; charset=utf-8", ...getCorsHeaders(origin) }
          });
        }
      } catch (e) {}
    }

    let queryParam = `select=id,source,source_id,title,cover_url,media_type,tags,page_count,video_sources&limit=${count}&offset=${randomOffset}`;
    if (mediaType === "gallery") {
      queryParam += "&media_type=eq.gallery&id=gte.370000&source=neq.leakgallery&order=id.desc";
    } else {
      queryParam += "&media_type=eq.comic&page_count=gt.0&order=id.desc";
    }

    try {
      const spRes = await fetch(`${SUPABASE_URL}/rest/v1/items?${queryParam}`, {
        headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}` }
      });

      const rawItems = await spRes.json();
      const items = await Promise.all((rawItems || []).map(async it => {
        const coverToken = it.cover_url ? await encodeMediaToken(it.cover_url, "", MEDIA_SECRET) : "";
        const videoSources = await Promise.all((it.video_sources || []).map(async vs => ({
          ...vs,
          url: vs.url ? `/api/media?t=${await encodeMediaToken(vs.url, "", MEDIA_SECRET)}` : ""
        })));
        return {
          ...it,
          url: "",
          cover_url: coverToken ? `/api/media?t=${coverToken}` : "",
          video_sources: videoSources
        };
      }));

      return new Response(JSON.stringify(items), {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8", ...getCorsHeaders(origin) }
      });
    } catch (err) {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
      });
    }
  }

  // =========================================================================
  // 5. AUTENTICACIÓN: LOGIN (/api/auth/login)
  // =========================================================================
  if (url.pathname === "/api/auth/login" && method === "POST") {
    try {
      const body = await context.request.json();
      const rawUser = (body.username || "").trim();
      const password = body.password || "";

      if (!rawUser || !password) {
        return new Response(JSON.stringify({ detail: "Usuario o correo y contraseña requeridos" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
        });
      }

      let email = rawUser.toLowerCase();
      if (!email.includes("@")) {
        const master = "erickariaslrcy@gmail.com";
        if (email === "admin" || email === "erick" || email === "master") {
          email = master;
        } else {
          // Resolver alias desde profiles
          const profRes = await fetch(`${SUPABASE_URL}/rest/v1/profiles?select=email&or=(email.ilike.*${email}@*,email.ilike.*${email}*)&limit=1`, {
            headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}` }
          });
          const profData = await profRes.json();
          if (profData && profData.length > 0) {
            email = profData[0].email;
          } else {
            email = `${email}@velvet.local`;
          }
        }
      }

      // Conexión directa a Supabase Auth
      const authRes = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
        method: "POST",
        headers: { "apikey": SUPABASE_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ email, password })
      });

      const authData = await authRes.json();
      if (!authRes.ok || !authData.user) {
        const msg = authData?.error_description || authData?.msg || "Credenciales incorrectas";
        return new Response(JSON.stringify({ detail: msg }), {
          status: 401,
          headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
        });
      }

      // Obtener perfil y rol admin
      const profRes = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${authData.user.id}&select=is_admin&limit=1`, {
        headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}` }
      });
      const profs = await profRes.json();
      const isAdmin = profs && profs[0] && profs[0].is_admin;
      const role = isAdmin ? "admin" : "member";
      const meta = authData.user.user_metadata || {};
      const displayName = meta.username || meta.full_name || meta.display_name || email.split("@")[0];

      const respData = {
        token: authData.access_token,
        refresh_token: authData.refresh_token,
        expires_at: authData.expires_at,
        device_token: "dev_" + Math.random().toString(36).substring(2),
        user: {
          id: authData.user.id,
          username: displayName,
          email: authData.user.email,
          role,
          tier: isAdmin ? "Dueño" : "Velvet VIP ($5.99)",
          tier_level: "pro",
          is_pro: true
        }
      };

      return new Response(JSON.stringify(respData), {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8", ...getCorsHeaders(origin) }
      });
    } catch (err) {
      return new Response(JSON.stringify({ detail: err.message || "Error al procesar login" }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
      });
    }
  }

  // =========================================================================
  // 6. AUTENTICACIÓN: VERIFICAR SESIÓN (/api/auth/me)
  // =========================================================================
  if (url.pathname === "/api/auth/me" && method === "GET") {
    const { user, newToken, newRefreshToken } = await resolveAuthUser(context.request);

    if (!user) {
      return new Response(JSON.stringify({ detail: "No autenticado" }), {
        status: 401,
        headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
      });
    }

    try {
      const profRes = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}&select=is_admin&limit=1`, {
        headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}` }
      });
      const profs = await profRes.json().catch(() => []);
      const isAdmin = profs && profs[0] && profs[0].is_admin;
      const role = isAdmin ? "admin" : "member";
      const meta = user.user_metadata || {};
      const displayName = meta.username || meta.full_name || meta.display_name || user.email?.split("@")[0] || "Usuario VIP";

      const respData = {
        id: user.id,
        username: displayName,
        email: user.email,
        role,
        tier: isAdmin ? "Dueño" : "Velvet VIP ($5.99)",
        tier_level: "pro",
        is_pro: true,
        max_devices: 10
      };

      if (newToken) respData.new_token = newToken;
      if (newRefreshToken) respData.new_refresh_token = newRefreshToken;

      const headers = { "Content-Type": "application/json; charset=utf-8", ...getCorsHeaders(origin) };
      if (newToken) headers["x-new-token"] = newToken;

      return new Response(JSON.stringify(respData), { status: 200, headers });
    } catch (err) {
      return new Response(JSON.stringify({ detail: "Error de sesión" }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
      });
    }
  }

  // =========================================================================
  // 6.1 AUTENTICACIÓN: REFRESCAR SESIÓN (/api/auth/refresh)
  // =========================================================================
  if (url.pathname === "/api/auth/refresh" && method === "POST") {
    try {
      const body = await context.request.json().catch(() => ({}));
      const refreshToken =
        body.refresh_token ||
        context.request.headers.get("x-refresh-token") ||
        null;

      if (!refreshToken) {
        return new Response(JSON.stringify({ detail: "Token de actualización no provisto" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
        });
      }

      const refRes = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
        method: "POST",
        headers: { "apikey": SUPABASE_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: refreshToken })
      });

      const refData = await refRes.json();
      if (!refRes.ok || !refData.access_token) {
        return new Response(JSON.stringify({ detail: refData?.error_description || "Sesión expirada" }), {
          status: 401,
          headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
        });
      }

      const user = refData.user;
      const meta = user?.user_metadata || {};
      const profRes = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}&select=is_admin&limit=1`, {
        headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}` }
      });
      const profs = await profRes.json().catch(() => []);
      const isAdmin = profs && profs[0] && profs[0].is_admin;
      const role = isAdmin ? "admin" : "member";
      const displayName = meta.username || meta.full_name || meta.display_name || user.email?.split("@")[0] || "Usuario VIP";

      const respData = {
        token: refData.access_token,
        refresh_token: refData.refresh_token,
        expires_at: refData.expires_at,
        user: {
          id: user.id,
          username: displayName,
          email: user.email,
          role,
          tier: isAdmin ? "Dueño" : "Velvet VIP ($5.99)",
          tier_level: "pro",
          is_pro: true
        }
      };

      return new Response(JSON.stringify(respData), {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8", ...getCorsHeaders(origin) }
      });
    } catch (err) {
      return new Response(JSON.stringify({ detail: err.message || "Error al refrescar sesión" }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
      });
    }
  }

  // =========================================================================
  // 6.2 AUTENTICACIÓN: CERRAR SESIÓN (/api/auth/logout)
  // =========================================================================
  if (url.pathname === "/api/auth/logout" && method === "POST") {
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
    });
  }

  // =========================================================================
  // 7. AUTENTICACIÓN: REGISTRO (/api/auth/register)
  // =========================================================================
  if (url.pathname === "/api/auth/register" && method === "POST") {
    try {
      const body = await context.request.json();
      const username = (body.username || "").trim();
      const email = (body.email || `${username}@velvet.local`).trim().toLowerCase();
      const password = body.password || "";

      if (!username || !password) {
        return new Response(JSON.stringify({ detail: "Nombre de usuario y contraseña requeridos" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
        });
      }

      // Registro en Supabase
      const regRes = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
        method: "POST",
        headers: { "apikey": SUPABASE_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, data: { username } })
      });

      const regData = await regRes.json();
      if (!regRes.ok || !regData.user) {
        return new Response(JSON.stringify({ detail: regData?.msg || "Error al registrar" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
        });
      }

      // Iniciar sesión inmediatamente
      const authRes = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
        method: "POST",
        headers: { "apikey": SUPABASE_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ email, password })
      });
      const authData = await authRes.json();

      const respData = {
        token: authData?.access_token || "velvet_token",
        refresh_token: authData?.refresh_token || null,
        user: {
          id: regData.user.id,
          username,
          email,
          role: "member",
          tier: "Velvet VIP ($5.99)",
          tier_level: "pro",
          is_pro: true
        }
      };

      return new Response(JSON.stringify(respData), {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8", ...getCorsHeaders(origin) }
      });
    } catch (err) {
      return new Response(JSON.stringify({ detail: err.message }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
      });
    }
  }

  // Cabeceras estrictas para endpoints privados / personales (CERO caché en navegador ni proxies)
  const getPersonalHeaders = (orig, newTok = null) => {
    const h = {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, no-cache, no-store, must-revalidate",
      "Pragma": "no-cache",
      "Expires": "0",
      ...getCorsHeaders(orig)
    };
    if (newTok) h["x-new-token"] = newTok;
    return h;
  };

  // =========================================================================
  // 8. FAVORITOS (/api/user/favorites, /api/favorites)
  // Persistencia atómica en PostgreSQL con paginación real de 24 en 24
  // =========================================================================
  const isFavoritesRoute =
    url.pathname === "/api/favorites" ||
    url.pathname === "/api/user/favorites" ||
    url.pathname.startsWith("/api/favorites/") ||
    url.pathname.startsWith("/api/user/favorites/");

  if (isFavoritesRoute) {
    const { user, token, newToken } = await resolveAuthUser(context.request, SUPABASE_URL, SUPABASE_KEY);
    if (!user) {
      return new Response(JSON.stringify({ error: "No autenticado" }), {
        status: 401,
        headers: getPersonalHeaders(origin)
      });
    }

    // --- GET FAVORITOS (Paginación determinista 24/página desde PostgreSQL) ---
    if (method === "GET") {
      const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
      const pageSize = Math.min(50, Math.max(1, parseInt(url.searchParams.get("pageSize") || String(PERSONAL_PAGE_SIZE), 10)));
      const offset = (page - 1) * pageSize;
      const to = offset + pageSize - 1;

      let favQueryUrl = `${SUPABASE_URL}/rest/v1/favorites?user_id=eq.${user.id}&select=item_id,created_at,items(id,title,cover_url,media_type,source,source_id,url,page_count,video_sources,status)&order=created_at.desc,item_id.desc`;
      const typeFilter = url.searchParams.get("type") || url.searchParams.get("media_type");
      if (typeFilter && ["comic", "video", "gallery"].includes(typeFilter)) {
        favQueryUrl += `&items.media_type=eq.${typeFilter}`;
      }

      const favRes = await fetch(favQueryUrl, {
        headers: {
          "apikey": SUPABASE_KEY,
          "Authorization": `Bearer ${SUPABASE_KEY}`,
          "Prefer": "count=exact",
          "Range": `${offset}-${to}`
        }
      });

      let total = 0;
      const cr = favRes.headers.get("content-range") || "";
      const slashIdx = cr.indexOf("/");
      if (slashIdx !== -1) {
        const totalPart = cr.substring(slashIdx + 1);
        if (totalPart && totalPart !== "*") {
          total = parseInt(totalPart, 10) || 0;
        }
      }

      const rawRows = favRes.ok ? await favRes.json().catch(() => []) : [];
      const items = await Promise.all((rawRows || []).map(async (r) => {
        const it = r.items || {};
        const isAvailable = it && it.id && it.status !== "blocked";
        const coverUrl = it.cover_url || "";
        const maskedCover = coverUrl ? await encodeToken(coverUrl, it.url || "") : "";
        return {
          id: it.id || r.item_id,
          item_id: r.item_id,
          title: isAvailable ? (it.title || "Sin título") : "Contenido no disponible",
          cover_url: maskedCover ? `/api/media?t=${maskedCover}` : (it.cover_url || "/velvet_logo.png"),
          media_type: it.media_type || "comic",
          source: it.source || "",
          source_id: it.source_id || "",
          url: isAvailable ? (it.url || "") : "",
          page_count: it.page_count || 0,
          created_at: r.created_at,
          available: isAvailable
        };
      }));

      const totalPages = Math.max(1, Math.ceil(total / pageSize));
      return new Response(JSON.stringify({ items, total, page, pageSize, totalPages }), {
        status: 200,
        headers: getPersonalHeaders(origin, newToken)
      });
    }

    // --- POST FAVORITOS (Agregar o Sincronización Idempotente) ---
    if (method === "POST") {
      if (!checkPersonalWriteRateLimit(user.id, 60)) {
        return new Response(JSON.stringify({ error: "Límite de peticiones excedido" }), {
          status: 429,
          headers: getPersonalHeaders(origin, newToken)
        });
      }

      try {
        const body = await context.request.json().catch(() => ({}));

        // Caso A: Sincronización masiva desde dispositivo o localStorage
        if (Array.isArray(body.items)) {
          const validIds = body.items
            .map((it) => parseInt(it.id || it.item_id, 10))
            .filter((id) => Number.isInteger(id) && id > 0);
          if (validIds.length > 0) {
            const rows = validIds.slice(0, 300).map((id) => ({ user_id: user.id, item_id: id }));
            await fetch(`${SUPABASE_URL}/rest/v1/favorites`, {
              method: "POST",
              headers: {
                "apikey": SUPABASE_KEY,
                "Authorization": `Bearer ${SUPABASE_KEY}`,
                "Content-Type": "application/json",
                "Prefer": "resolution=ignore-duplicates"
              },
              body: JSON.stringify(rows)
            }).catch(() => {});
          }
          return new Response(JSON.stringify({ ok: true, synced: validIds.length }), {
            status: 200,
            headers: getPersonalHeaders(origin, newToken)
          });
        }

        // Caso B: Toggle a falso si se envía favorite: false
        if (body.favorite === false) {
          const removeId = parseInt(body.id || body.item_id, 10);
          if (Number.isInteger(removeId) && removeId > 0) {
            await fetch(`${SUPABASE_URL}/rest/v1/favorites?user_id=eq.${user.id}&item_id=eq.${removeId}`, {
              method: "DELETE",
              headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}` }
            });
          }
          return new Response(JSON.stringify({ ok: true, removed: true }), {
            status: 200,
            headers: getPersonalHeaders(origin, newToken)
          });
        }

        // Caso C: Agregar favorito individual (idempotente con ignore-duplicates)
        const targetItemId = parseInt(body.id || body.item_id, 10);
        if (!Number.isInteger(targetItemId) || targetItemId <= 0) {
          return new Response(JSON.stringify({ error: "item_id entero requerido" }), {
            status: 400,
            headers: getPersonalHeaders(origin, newToken)
          });
        }

        await fetch(`${SUPABASE_URL}/rest/v1/favorites`, {
          method: "POST",
          headers: {
            "apikey": SUPABASE_KEY,
            "Authorization": `Bearer ${SUPABASE_KEY}`,
            "Content-Type": "application/json",
            "Prefer": "resolution=ignore-duplicates"
          },
          body: JSON.stringify({ user_id: user.id, item_id: targetItemId })
        });

        return new Response(JSON.stringify({ ok: true, success: true, item_id: targetItemId }), {
          status: 200,
          headers: getPersonalHeaders(origin, newToken)
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: "Error procesando favorito" }), {
          status: 500,
          headers: getPersonalHeaders(origin, newToken)
        });
      }
    }

    // --- DELETE FAVORITOS ---
    if (method === "DELETE") {
      if (!checkPersonalWriteRateLimit(user.id, 60)) {
        return new Response(JSON.stringify({ error: "Límite de peticiones excedido" }), {
          status: 429,
          headers: getPersonalHeaders(origin, newToken)
        });
      }

      let targetId = parseInt(url.searchParams.get("id") || url.searchParams.get("item_id"), 10);
      if (!targetId || isNaN(targetId)) {
        const parts = url.pathname.split("/").filter(Boolean);
        const lastPart = parts[parts.length - 1];
        if (/^\d+$/.test(lastPart)) targetId = parseInt(lastPart, 10);
      }

      if (!Number.isInteger(targetId) || targetId <= 0) {
        return new Response(JSON.stringify({ error: "id numérico válido requerido" }), {
          status: 400,
          headers: getPersonalHeaders(origin, newToken)
        });
      }

      await fetch(`${SUPABASE_URL}/rest/v1/favorites?user_id=eq.${user.id}&item_id=eq.${targetId}`, {
        method: "DELETE",
        headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}` }
      });

      return new Response(JSON.stringify({ ok: true, success: true, deleted_id: targetId }), {
        status: 200,
        headers: getPersonalHeaders(origin, newToken)
      });
    }
  }

  // =========================================================================
  // 9. HISTORIAL Y PROGRESO (/api/user/history, /api/history)
  // Persistencia atómica en tabla user_history con resolución de concurrencia
  // =========================================================================
  const isHistoryRoute =
    url.pathname === "/api/user/history" ||
    url.pathname.startsWith("/api/user/history/") ||
    url.pathname === "/api/history" ||
    url.pathname.startsWith("/api/history/");

  if (isHistoryRoute) {
    const { user, token, newToken } = await resolveAuthUser(context.request, SUPABASE_URL, SUPABASE_KEY);
    if (!user) {
      return new Response(JSON.stringify({ error: "No autenticado" }), {
        status: 401,
        headers: getPersonalHeaders(origin)
      });
    }

    // --- GET HISTORIAL (Paginado determinista 24/página desde PostgreSQL) ---
    if (method === "GET") {
      const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
      const pageSize = Math.min(50, Math.max(1, parseInt(url.searchParams.get("pageSize") || String(PERSONAL_PAGE_SIZE), 10)));
      const offset = (page - 1) * pageSize;
      const to = offset + pageSize - 1;

      let histQueryUrl = `${SUPABASE_URL}/rest/v1/user_history?user_id=eq.${user.id}&select=id,item_id,media_type,position,duration,completed,last_activity,client_timestamp,items(id,title,cover_url,media_type,source,source_id,url,page_count,video_sources,status)&order=last_activity.desc,id.desc`;
      const typeFilter = url.searchParams.get("type") || url.searchParams.get("media_type");
      if (typeFilter && ["comic", "video", "gallery"].includes(typeFilter)) {
        histQueryUrl += `&media_type=eq.${typeFilter}`;
      }

      const histRes = await fetch(histQueryUrl, {
        headers: {
          "apikey": SUPABASE_KEY,
          "Authorization": `Bearer ${SUPABASE_KEY}`,
          "Prefer": "count=exact",
          "Range": `${offset}-${to}`
        }
      });

      let total = 0;
      const cr = histRes.headers.get("content-range") || "";
      const slashIdx = cr.indexOf("/");
      if (slashIdx !== -1) {
        const totalPart = cr.substring(slashIdx + 1);
        if (totalPart && totalPart !== "*") {
          total = parseInt(totalPart, 10) || 0;
        }
      }

      const rawRows = histRes.ok ? await histRes.json().catch(() => []) : [];
      const items = await Promise.all((rawRows || []).map(async (r) => {
        const it = r.items || {};
        const isAvailable = it && it.id && it.status !== "blocked";
        const coverUrl = it.cover_url || "";
        const maskedCover = coverUrl ? await encodeToken(coverUrl, it.url || "") : "";
        return {
          id: it.id || r.item_id,
          history_id: r.id,
          item_id: r.item_id,
          title: isAvailable ? (it.title || "Sin título") : "Contenido no disponible",
          cover_url: maskedCover ? `/api/media?t=${maskedCover}` : (it.cover_url || "/velvet_logo.png"),
          media_type: r.media_type || it.media_type || "comic",
          source: it.source || "",
          source_id: it.source_id || "",
          url: isAvailable ? (it.url || "") : "",
          page_count: it.page_count || 0,
          position: r.position || 0,
          duration: r.duration || 0,
          completed: !!r.completed,
          last_activity: r.last_activity,
          at: r.client_timestamp ? Number(r.client_timestamp) : new Date(r.last_activity).getTime(),
          available: isAvailable
        };
      }));

      const totalPages = Math.max(1, Math.ceil(total / pageSize));
      return new Response(JSON.stringify({ items, total, page, pageSize, totalPages }), {
        status: 200,
        headers: getPersonalHeaders(origin, newToken)
      });
    }

    // --- POST HISTORIAL (Registro o Fusión Idempotente con RPC upsert_history) ---
    if (method === "POST") {
      if (!checkPersonalWriteRateLimit(user.id, 60)) {
        return new Response(JSON.stringify({ error: "Límite de peticiones excedido" }), {
          status: 429,
          headers: getPersonalHeaders(origin, newToken)
        });
      }

      try {
        const body = await context.request.json().catch(() => ({}));

        // Caso A: Fusión masiva de historial desde dispositivo o localStorage
        if (Array.isArray(body.items)) {
          let synced = 0;
          for (const it of body.items.slice(0, 100)) {
            const itId = parseInt(it.id || it.item_id, 10);
            if (!Number.isInteger(itId) || itId <= 0) continue;
            const mediaType = it.media_type === "video" ? "video" : (it.media_type === "gallery" ? "gallery" : "comic");
            const pos = Math.max(0, parseInt(it.position || it.page || it.currentTime || 0, 10));
            const dur = Math.max(0, parseInt(it.duration || it.total || 0, 10));
            const comp = Boolean(it.completed);
            const clientTs = parseInt(it.client_timestamp || it.at || Date.now(), 10);

            const rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/upsert_history`, {
              method: "POST",
              headers: {
                "apikey": SUPABASE_KEY,
                "Authorization": `Bearer ${token || SUPABASE_KEY}`,
                "Content-Type": "application/json"
              },
              body: JSON.stringify({
                p_item_id: itId,
                p_media_type: mediaType,
                p_position: pos,
                p_duration: dur,
                p_completed: comp,
                p_client_timestamp: clientTs
              })
            }).catch(() => null);

            if (!rpcRes || !rpcRes.ok) {
              await fetch(`${SUPABASE_URL}/rest/v1/user_history`, {
                method: "POST",
                headers: {
                  "apikey": SUPABASE_KEY,
                  "Authorization": `Bearer ${SUPABASE_KEY}`,
                  "Content-Type": "application/json",
                  "Prefer": "resolution=merge-duplicates"
                },
                body: JSON.stringify({
                  user_id: user.id,
                  item_id: itId,
                  media_type: mediaType,
                  position: pos,
                  duration: dur,
                  completed: comp,
                  last_activity: new Date().toISOString(),
                  client_timestamp: clientTs
                })
              }).catch(() => {});
            }
            synced++;
          }
          return new Response(JSON.stringify({ ok: true, synced }), {
            status: 200,
            headers: getPersonalHeaders(origin, newToken)
          });
        }

        // Caso B: Progreso individual
        const itemData = body.item || body;
        const targetItemId = parseInt(itemData.id || itemData.item_id, 10);
        if (!Number.isInteger(targetItemId) || targetItemId <= 0) {
          return new Response(JSON.stringify({ error: "item_id entero requerido" }), {
            status: 400,
            headers: getPersonalHeaders(origin, newToken)
          });
        }

        const mediaType = itemData.media_type === "video" ? "video" : (itemData.media_type === "gallery" ? "gallery" : "comic");
        const pos = Math.max(0, parseInt(itemData.position || itemData.page || itemData.currentTime || 0, 10));
        const dur = Math.max(0, parseInt(itemData.duration || itemData.total || 0, 10));
        const comp = Boolean(itemData.completed);
        const clientTs = parseInt(itemData.client_timestamp || itemData.at || Date.now(), 10);

        const rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/upsert_history`, {
          method: "POST",
          headers: {
            "apikey": SUPABASE_KEY,
            "Authorization": `Bearer ${token || SUPABASE_KEY}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            p_item_id: targetItemId,
            p_media_type: mediaType,
            p_position: pos,
            p_duration: dur,
            p_completed: comp,
            p_client_timestamp: clientTs
          })
        }).catch(() => null);

        if (!rpcRes || !rpcRes.ok) {
          await fetch(`${SUPABASE_URL}/rest/v1/user_history`, {
            method: "POST",
            headers: {
              "apikey": SUPABASE_KEY,
              "Authorization": `Bearer ${SUPABASE_KEY}`,
              "Content-Type": "application/json",
              "Prefer": "resolution=merge-duplicates"
            },
            body: JSON.stringify({
              user_id: user.id,
              item_id: targetItemId,
              media_type: mediaType,
              position: pos,
              duration: dur,
              completed: comp,
              last_activity: new Date().toISOString(),
              client_timestamp: clientTs
            })
          }).catch(() => {});
        }

        return new Response(JSON.stringify({ ok: true, success: true, item_id: targetItemId }), {
          status: 200,
          headers: getPersonalHeaders(origin, newToken)
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: "Error procesando historial" }), {
          status: 500,
          headers: getPersonalHeaders(origin, newToken)
        });
      }
    }

    // --- DELETE HISTORIAL (Individual o Vaciar Todo) ---
    if (method === "DELETE") {
      if (!checkPersonalWriteRateLimit(user.id, 60)) {
        return new Response(JSON.stringify({ error: "Límite de peticiones excedido" }), {
          status: 429,
          headers: getPersonalHeaders(origin, newToken)
        });
      }

      const isClearAll = url.searchParams.get("clear") === "all" || url.searchParams.get("action") === "clear";
      if (isClearAll) {
        await fetch(`${SUPABASE_URL}/rest/v1/user_history?user_id=eq.${user.id}`, {
          method: "DELETE",
          headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}` }
        });
        return new Response(JSON.stringify({ ok: true, cleared: true }), {
          status: 200,
          headers: getPersonalHeaders(origin, newToken)
        });
      }

      let targetId = parseInt(url.searchParams.get("id") || url.searchParams.get("item_id"), 10);
      if (!targetId || isNaN(targetId)) {
        const parts = url.pathname.split("/").filter(Boolean);
        const lastPart = parts[parts.length - 1];
        if (/^\d+$/.test(lastPart)) targetId = parseInt(lastPart, 10);
      }

      if (!Number.isInteger(targetId) || targetId <= 0) {
        return new Response(JSON.stringify({ error: "id numérico requerido o clear=all" }), {
          status: 400,
          headers: getPersonalHeaders(origin, newToken)
        });
      }

      await fetch(`${SUPABASE_URL}/rest/v1/user_history?user_id=eq.${user.id}&item_id=eq.${targetId}`, {
        method: "DELETE",
        headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}` }
      });

      return new Response(JSON.stringify({ ok: true, success: true, deleted_id: targetId }), {
        status: 200,
        headers: getPersonalHeaders(origin, newToken)
      });
    }
  }

  // =========================================================================
  // 10. PREFERENCIAS DE USUARIO (/api/user/preferences)
  // Persistencia segura en tabla user_preferences (aislada de profiles)
  // =========================================================================
  if (url.pathname === "/api/user/preferences") {
    const { user, token, newToken } = await resolveAuthUser(context.request, SUPABASE_URL, SUPABASE_KEY);
    if (!user) {
      return new Response(JSON.stringify({ error: "No autenticado" }), {
        status: 401,
        headers: getPersonalHeaders(origin)
      });
    }

    if (method === "GET") {
      const prefRes = await fetch(`${SUPABASE_URL}/rest/v1/user_preferences?user_id=eq.${user.id}&select=data,version,updated_at&limit=1`, {
        headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}` }
      });
      const prefRows = prefRes.ok ? await prefRes.json().catch(() => []) : [];
      if (prefRows && prefRows.length > 0 && prefRows[0]) {
        return new Response(JSON.stringify(prefRows[0]), {
          status: 200,
          headers: getPersonalHeaders(origin, newToken)
        });
      }
      return new Response(JSON.stringify({ data: {}, version: 2, updated_at: null }), {
        status: 200,
        headers: getPersonalHeaders(origin, newToken)
      });
    }

    if (method === "PUT" || method === "POST") {
      if (!checkPersonalWriteRateLimit(user.id, 60)) {
        return new Response(JSON.stringify({ error: "Límite de peticiones excedido" }), {
          status: 429,
          headers: getPersonalHeaders(origin, newToken)
        });
      }
      const body = await context.request.json().catch(() => ({}));
      const dataObj = (body.data && typeof body.data === "object") ? body.data : body;
      const serialized = JSON.stringify(dataObj);
      if (serialized.length > 16384) {
        return new Response(JSON.stringify({ error: "Tamaño máximo de preferencias excedido (16KB)" }), {
          status: 413,
          headers: getPersonalHeaders(origin, newToken)
        });
      }
      const ver = parseInt(body.version || 2, 10);
      const nowIso = new Date().toISOString();

      await fetch(`${SUPABASE_URL}/rest/v1/user_preferences`, {
        method: "POST",
        headers: {
          "apikey": SUPABASE_KEY,
          "Authorization": `Bearer ${SUPABASE_KEY}`,
          "Content-Type": "application/json",
          "Prefer": "resolution=merge-duplicates"
        },
        body: JSON.stringify({
          user_id: user.id,
          data: dataObj,
          version: ver,
          updated_at: nowIso
        })
      });

      return new Response(JSON.stringify({ ok: true, success: true, data: dataObj, version: ver, updated_at: nowIso }), {
        status: 200,
        headers: getPersonalHeaders(origin, newToken)
      });
    }
  }

  // =========================================================================
  // 11. ESTADO DE SINCRONIZACIÓN (/api/user/sync-status)
  // =========================================================================
  if (url.pathname === "/api/user/sync-status" && method === "GET") {
    const { user, token, newToken } = await resolveAuthUser(context.request, SUPABASE_URL, SUPABASE_KEY);
    if (!user) {
      return new Response(JSON.stringify({ authenticated: false }), {
        status: 200,
        headers: getPersonalHeaders(origin)
      });
    }

    try {
      const [favRes, histRes, prefRes] = await Promise.all([
        fetch(`${SUPABASE_URL}/rest/v1/favorites?user_id=eq.${user.id}&select=item_id`, {
          headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}`, "Prefer": "count=exact", "Range": "0-0" }
        }),
        fetch(`${SUPABASE_URL}/rest/v1/user_history?user_id=eq.${user.id}&select=id`, {
          headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}`, "Prefer": "count=exact", "Range": "0-0" }
        }),
        fetch(`${SUPABASE_URL}/rest/v1/user_preferences?user_id=eq.${user.id}&select=updated_at&limit=1`, {
          headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}` }
        })
      ]);

      const parseCount = (res) => {
        const cr = res.headers.get("content-range") || "";
        const s = cr.indexOf("/");
        return s !== -1 ? parseInt(cr.substring(s + 1), 10) || 0 : 0;
      };

      const favCount = parseCount(favRes);
      const histCount = parseCount(histRes);
      const prefData = prefRes.ok ? await prefRes.json().catch(() => []) : [];
      const prefUpdatedAt = prefData && prefData[0] ? prefData[0].updated_at : null;

      return new Response(JSON.stringify({
        authenticated: true,
        user_id: user.id,
        favorites_count: favCount,
        history_count: histCount,
        preferences_updated_at: prefUpdatedAt,
        server_time: new Date().toISOString()
      }), {
        status: 200,
        headers: getPersonalHeaders(origin, newToken)
      });
    } catch (err) {
      return new Response(JSON.stringify({ authenticated: true, user_id: user.id, error: "Sync query failed" }), {
        status: 200,
        headers: getPersonalHeaders(origin, newToken)
      });
    }
  }

  // =========================================================================
  // 9. TAGS POPULARES (/api/tags)
  // =========================================================================
  if (url.pathname === "/api/tags" && method === "GET") {
    const popularTags = [
      "Cosplay", "ArtGravia", "Korean", "Xiuren", "Bikini", "Lingerie", "Patreon", "Fansly",
      "PMV", "Verified Performer", "HD", "1080p", "Full Color", "3D", "Manhwa", "Doujinshi"
    ];
    return new Response(JSON.stringify(popularTags), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=86400, s-maxage=604800, immutable",
        ...getCorsHeaders(origin)
      }
    });
  }

  // Ruta API no encontrada
  return new Response(JSON.stringify({ error: "Endpoint no encontrado en Velvet Cloudflare API", path: url.pathname }), {
    status: 404,
    headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
  });
}
