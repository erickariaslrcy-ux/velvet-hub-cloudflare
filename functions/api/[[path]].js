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

// El exp cambia de segundo en segundo si se calcula como now+TTL, y entonces
// cada portada es una URL nueva: el edge, el navegador y el SW nunca reutilizan
// la imagen. Se cuantiza a semanas enteras (alineadas a epoch) para que la misma
// URL viva 7 días y siga siendo válida al menos 14.
const MEDIA_TOKEN_QUANTUM_SEC = 7 * 24 * 60 * 60;

function quantizedMediaExpiry(nowSec) {
  const now = Number(nowSec) || 0;
  const bucket = Math.floor(now / MEDIA_TOKEN_QUANTUM_SEC);
  return (bucket + 3) * MEDIA_TOKEN_QUANTUM_SEC - 1;
}

// Generación de token firmado con Web Crypto HMAC-SHA256 y expiración cuantizada (14–21 días)
async function encodeMediaToken(targetUrl, referer = "", secret = "", nowSec = 0) {
  const s = secret || _activeMediaSecret;
  if (!targetUrl || !s) return "";
  try {
    const now = nowSec > 0 ? nowSec : Math.floor(Date.now() / 1000);
    const exp = quantizedMediaExpiry(now);
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
      "gamcore.com",
      "serverable.com",
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

// Cursor de id REAL (min..max del media_type). Nunca uses el conteo estimado
// como si fuera un id: en galerías el conteo es ~18260 y los ids viven en ~398k,
// así que id=lte.(estimado-offset) devolvía cero filas.
function catalogIdCursor({ minId, maxId, page, pageSize, seed, random }) {
  const lo = Number(minId) || 0;
  const hi = Number(maxId) || 0;
  if (lo <= 0 || hi < lo) return null;
  const span = hi - lo + 1;
  const safePage = Math.max(1, Number(page) || 1);
  const size = Math.max(1, Number(pageSize) || 24);
  if (random) {
    const salt = Number(seed) || 1;
    const slot = Math.abs((salt * 313 + (safePage - 1) * 7919) % span);
    return lo + slot;
  }
  const step = ((safePage - 1) * size) % span;
  return hi - step;
}

// Ventana global de 3 horas. La semilla ES el número de ventana:
// Math.floor(Date.now() / (3 * 3600 * 1000)). Todos los usuarios comparten
// la misma semilla, así el edge cache sigue siendo válido dentro de la ventana.
const ROTATION_WINDOW_MS = 3 * 3600 * 1000;

function rotationSlot(nowMs) {
  const now = Number(nowMs);
  const t = Number.isFinite(now) && now > 0 ? now : Date.now();
  return Math.floor(t / ROTATION_WINDOW_MS);
}

function rotationCacheSeconds(nowMs) {
  const now = Number(nowMs) || Date.now();
  const remain = ROTATION_WINDOW_MS - (now % ROTATION_WINDOW_MS);
  return Math.max(60, Math.min(3 * 3600, Math.ceil(remain / 1000)));
}

function gcdInt(a, b) {
  let x = Math.abs(a | 0);
  let y = Math.abs(b | 0);
  while (y) {
    const t = y;
    y = x % y;
    x = t;
  }
  return x || 1;
}

// Permutación biyectiva: cada página cae en un índice distinto y el
// índice cambia al cambiar la ventana de 3 horas.
function permutePageIndex(pageIndex, pageCount, seed) {
  const n = Math.max(1, pageCount | 0);
  let i = Number(pageIndex) || 0;
  i = ((i % n) + n) % n;
  if (n === 1) return 0;
  const s = Math.abs(Number(seed) || 1);
  let mul = (s % n) | 1;
  if (mul % 2 === 0) mul += 1;
  if (mul >= n) mul = (mul % n) || 1;
  let guard = 0;
  while (gcdInt(mul, n) !== 1 && guard < n + 3) {
    mul += 2;
    if (mul >= n) mul = (mul % n) || 1;
    if (mul % 2 === 0) mul += 1;
    if (mul >= n) mul = 1;
    guard += 1;
  }
  const add = s % n;
  return ((mul * i) + add) % n;
}

function catalogPageOffset(page, pageSize, totalItems, seed, random) {
  const size = Math.max(1, Number(pageSize) || 24);
  const total = Math.max(0, Number(totalItems) || 0);
  const totalPages = Math.max(1, Math.ceil(total / size) || 1);
  const safePage = Math.max(1, Number(page) || 1);
  const logical = (safePage - 1) % totalPages;
  const index = random ? permutePageIndex(logical, totalPages, seed) : logical;
  return { offset: index * size, index, totalPages, pageSize: size, page: safePage };
}

function sliceCatalogIds(idsDesc, page, pageSize, seed, random) {
  const ids = Array.isArray(idsDesc) ? idsDesc : [];
  const plan = catalogPageOffset(page, pageSize, ids.length, seed, random);
  return {
    ids: ids.slice(plan.offset, plan.offset + plan.pageSize),
    total: ids.length,
    ...plan
  };
}

// Semilla explícita de "Al Azar". No se recorta a 1e6: ese tope convertía
// cualquier nonce grande en la misma semilla y el botón devolvía siempre
// la misma página.
function readShuffleSeed(raw) {
  const text = String(raw == null ? "" : raw).trim();
  if (!/^[0-9]+$/.test(text)) return 0;
  const n = Number(text);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n > 2147483646) return (Math.floor(n) % 2147483646) + 1;
  return Math.floor(n);
}

const SHUFFLE_NO_STORE = "private, no-store, no-cache, must-revalidate";

function catalogResponseCacheHeaders(isFresh, publicCacheControl) {
  if (isFresh) {
    return {
      "Cache-Control": SHUFFLE_NO_STORE,
      "CDN-Cache-Control": "no-store",
      "Cloudflare-CDN-Cache-Control": "no-store",
      "Pragma": "no-cache"
    };
  }
  return { "Cache-Control": publicCacheControl };
}

function shuffleRng(seed) {
  let a = (Math.abs(Number(seed) | 0) || 1) >>> 0;
  return function next() {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fisherYates(items, seed) {
  const list = Array.isArray(items) ? items.slice() : [];
  const rng = shuffleRng(seed);
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = list[i];
    list[i] = list[j];
    list[j] = tmp;
  }
  return list;
}

// Ventanas repartidas por todo el catálogo. El mismo seed+página es
// determinista; otro seed (o otra página) cae en otros puntos de cada banda,
// desde el id mínimo real hasta el máximo, aunque haya huecos.
function planShuffleWindows(opts) {
  const total = Math.max(1, Math.floor(Number(opts && opts.total) || 1));
  const pageSize = Math.max(1, Math.floor(Number(opts && opts.pageSize) || 24));
  const page = Math.max(1, Math.floor(Number(opts && opts.page) || 1));
  const seed = Math.abs(Math.floor(Number(opts && opts.seed) || 1)) || 1;
  const minId = Math.floor(Number(opts && opts.minId) || 1);
  const maxId = Math.max(minId, Math.floor(Number(opts && opts.maxId) || minId));
  const idSpan = Math.max(1, maxId - minId + 1);
  const bands = Math.max(4, Math.min(8, Math.floor(Number(opts && opts.bands) || 4)));
  const rng = shuffleRng((seed ^ Math.imul(page, 0x9e3779b1) ^ Math.imul(bands, 0x85ebca6b)) >>> 0);
  const take = Math.max(3, Math.ceil(pageSize / bands) + 2);
  const windows = [];
  for (let i = 0; i < bands; i++) {
    const rowStart = Math.floor((i * total) / bands);
    const rowEnd = Math.max(rowStart + 1, Math.floor(((i + 1) * total) / bands));
    const rowSpan = Math.max(1, rowEnd - rowStart);
    const rowJitter = Math.floor(rng() * rowSpan);
    const pageShift = ((page - 1) * take) % rowSpan;
    const offset = (rowStart + ((rowJitter + pageShift) % rowSpan)) % total;

    const idStart = minId + Math.floor((i * idSpan) / bands);
    const idEnd = minId + Math.floor(((i + 1) * idSpan) / bands) - 1;
    const idBand = Math.max(1, (idEnd < idStart ? idStart : idEnd) - idStart + 1);
    const idJitter = Math.floor(rng() * idBand);
    const idShift = ((page - 1) * take) % idBand;
    const anchorId = idStart + ((idJitter + idShift) % idBand);
    windows.push({
      band: i,
      offset,
      anchorId: Math.min(maxId, Math.max(minId, anchorId)),
      take
    });
  }
  return { windows, bands, minId, maxId, total, page, pageSize, seed };
}

// Toma de cada banda antes de rellenar, así la página cruza el catálogo
// entero y no se queda en un solo tramo de ids vecinos.
function assembleShufflePage(bandRows, pageSize, seed) {
  const size = Math.max(1, Math.floor(Number(pageSize) || 24));
  const bands = (Array.isArray(bandRows) ? bandRows : []).map((rows, i) => {
    const seen = new Set();
    const unique = [];
    const list = Array.isArray(rows) ? rows : [];
    for (const row of list) {
      if (!row || row.id === undefined || row.id === null || row.id === "") continue;
      const key = String(row.id);
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(row);
    }
    return fisherYates(unique, (Math.abs(Number(seed) || 1) + (i + 1) * 131) >>> 0);
  });
  const active = bands.filter((band) => band.length > 0);
  if (!active.length) return [];
  const used = new Set();
  const picked = [];
  const perBand = Math.max(1, Math.floor(size / active.length));
  for (const band of active) {
    let n = 0;
    for (const row of band) {
      const key = String(row.id);
      if (used.has(key)) continue;
      used.add(key);
      picked.push(row);
      n += 1;
      if (n >= perBand || picked.length >= size) break;
    }
    if (picked.length >= size) break;
  }
  if (picked.length < size) {
    const rest = [];
    for (const band of active) {
      for (const row of band) {
        if (!used.has(String(row.id))) rest.push(row);
      }
    }
    for (const row of fisherYates(rest, seed || 1)) {
      if (picked.length >= size) break;
      const key = String(row.id);
      if (used.has(key)) continue;
      used.add(key);
      picked.push(row);
    }
  }
  return fisherYates(picked, seed || 1).slice(0, size);
}

function pmvPageNumbers(seed, page, pageSize, totalPages) {
  const total = Math.max(1, Math.floor(Number(totalPages) || 1));
  const plan = planShuffleWindows({
    total,
    minId: 1,
    maxId: total,
    page: page || 1,
    pageSize: pageSize || 24,
    seed: seed || 1,
    bands: 4
  });
  const pages = [];
  const seen = new Set();
  for (const w of plan.windows) {
    const p = Math.min(total, Math.max(1, Math.floor(Number(w.anchorId) || 1)));
    if (seen.has(p)) continue;
    seen.add(p);
    pages.push(p);
  }
  return pages;
}

function mediaTypeSalt(mediaType) {
  const s = String(mediaType || "comic");
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h * 33) + s.charCodeAt(i)) >>> 0;
  return (h % 997) + 1;
}

// Orden determinista de un catálogo completo (juegos en memoria y pruebas
// de cómic, vídeo, galería y juego). Cambia al cambiar la ventana de 3 h.
function stableItemRank(value) {
  const n = Number(value);
  if (Number.isFinite(n) && n !== 0) return Math.abs(n);
  const s = String(value || "");
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h * 33) + s.charCodeAt(i)) >>> 0;
  return h || 1;
}

function orderCatalogForSlot(items, slot, mediaType) {
  const seed = Math.abs(Number(slot) || 1);
  const salt = mediaTypeSalt(mediaType);
  const list = Array.isArray(items) ? items.slice() : [];
  list.sort((a, b) => {
    const idA = stableItemRank(a && a.id);
    const idB = stableItemRank(b && b.id);
    const mix = (id, slot) => {
      let x = (id ^ Math.imul(slot, 0x9e3779b1) ^ Math.imul(salt, 0x85ebca6b)) >>> 0;
      x = Math.imul(x ^ (x >>> 16), 0x7feb352d) >>> 0;
      x = Math.imul(x ^ (x >>> 15), 0x846ca68b) >>> 0;
      return (x ^ (x >>> 16)) >>> 0;
    };
    const hA = mix(idA || 1, seed);
    const hB = mix(idB || 1, seed);
    return hA - hB || (idA - idB);
  });
  return list;
}

function catalogEdgeCacheUrl(requestUrl, slot) {
  const u = new URL(requestUrl.toString());
  u.searchParams.set("cv", "3");
  if (slot !== undefined && slot !== null && slot !== "") {
    u.searchParams.set("rot", String(slot));
  }
  return u.toString();
}

function decodeJwtPayload(token) {
  try {
    const part = String(token || "").split(".")[1];
    if (!part) return null;
    const payload = JSON.parse(fromBase64Url(part));
    if (!payload || typeof payload !== "object") return null;
    return payload;
  } catch (e) {
    return null;
  }
}

function isDeadUpstreamError(status, detail) {
  const text = String(detail || "");
  const code = Number(status) || 0;
  if (code === 1016 || code >= 500) return true;
  return /1016|origin dns|enotfound|getaddrinfo|failed to fetch|dns/i.test(text);
}

function gameMatchesCategory(game, category) {
  if (!category || category === "all") return true;
  const engine = String(game.engine || "").toLowerCase();
  const type = String(game.game_type || "").toLowerCase();
  const tags = (game.tags || []).map(t => String(t).toLowerCase());
  const title = String(game.title || "").toLowerCase();
  if (category === "renpy") return engine.includes("ren") || tags.some(t => t.includes("ren"));
  if (category === "flash") return type === "flash" || engine.includes("flash") || tags.includes("flash");
  if (category === "3d") return tags.some(t => t.includes("3d"));
  if (category === "harem") return tags.some(t => t.includes("harem"));
  if (category === "rpg") return tags.some(t => t.includes("rpg") || t.includes("adventure"));
  if (category === "apk") return tags.some(t => t.includes("apk"));
  if (category === "parody") return tags.some(t => t.includes("parod"));
  return tags.some(t => t.includes(category)) || engine.includes(category) || title.includes(category);
}

function buildGameCatalogPage(games, opts) {
  const page = validatePage(opts && opts.page);
  const pageSize = validatePageSize(opts && opts.pageSize, 24);
  const sort = validateSort(opts && opts.sort);
  const q = sanitizeSearchQuery((opts && opts.q) || "");
  const category = sanitizeSlug((opts && opts.category) || "");
  const seed = Number(opts && opts.seed) || 1;
  let list = Array.isArray(games) ? games.slice() : [];
  if (category && category !== "all") list = list.filter(g => gameMatchesCategory(g, category));
  if (q) {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    list = list.filter(g => {
      const hay = `${g.title || ""} ${(g.tags || []).join(" ")} ${g.engine || ""}`.toLowerCase();
      return words.every(w => hay.includes(w));
    });
  }
  if (sort === "random") {
    list = orderCatalogForSlot(list, seed, "game");
  } else if (sort === "views" || sort === "popular") {
    list.sort((a, b) => (b.plays || 0) - (a.plays || 0) || (Number(b.id) || 0) - (Number(a.id) || 0));
  } else if (sort === "rating") {
    list.sort((a, b) => (b.rating || 0) - (a.rating || 0) || (Number(b.id) || 0) - (Number(a.id) || 0));
  } else {
    list.sort((a, b) => (Number(b.id) || 0) - (Number(a.id) || 0));
  }
  const total = list.length;
  const start = (page - 1) * pageSize;
  let slice = list.slice(start, start + pageSize);
  if (slice.length < pageSize && total >= pageSize && start >= total) {
    const wrappedStart = start % total;
    slice = list.slice(wrappedStart, wrappedStart + pageSize);
    if (slice.length < pageSize) slice = slice.concat(list.slice(0, pageSize - slice.length));
  }
  return {
    items: slice,
    total,
    page,
    page_size: pageSize,
    total_pages: Math.max(1, Math.ceil(total / pageSize) || 1),
    live: false
  };
}

let LOCAL_GAMES_CACHE = null;
let LOCAL_GAMES_CACHE_AT = 0;

async function loadGameCatalog(context, pageUrl) {
  if (LOCAL_GAMES_CACHE && (Date.now() - LOCAL_GAMES_CACHE_AT) < 60 * 60 * 1000) {
    return LOCAL_GAMES_CACHE;
  }
  const origin = (pageUrl && pageUrl.origin) || "https://www.morbohub.com";
  let response = null;
  const assets = context && context.env && context.env.ASSETS;
  if (assets && typeof assets.fetch === "function") {
    try {
      response = await assets.fetch(new Request(origin + "/data/games.json"));
    } catch (e) {
      response = null;
    }
  }
  if (!response || !response.ok) {
    try {
      response = await fetch(origin + "/data/games.json", { cf: { cacheEverything: true, cacheTtl: 86400 } });
    } catch (e) {
      const err = new Error(e && e.message ? e.message : "games.json no disponible");
      err.status = 502;
      throw err;
    }
  }
  if (!response || !response.ok) {
    const detail = response ? await response.text().catch(() => "") : "sin respuesta";
    const err = new Error(detail || "games.json no disponible");
    err.status = response ? response.status : 502;
    throw err;
  }
  const data = await response.json();
  if (!Array.isArray(data)) {
    const err = new Error("games.json invalido");
    err.status = 502;
    throw err;
  }
  LOCAL_GAMES_CACHE = data;
  LOCAL_GAMES_CACHE_AT = Date.now();
  return LOCAL_GAMES_CACHE;
}

async function maskGameItem(it, secret) {
  const rawCover = it.cover_url || it.thumbnail || "";
  const coverToken = rawCover ? await encodeMediaToken(rawCover, "https://gamcore.com/", secret) : "";
  const gameType = it.game_type || (it.swf_url ? "flash" : "html5");
  return {
    id: it.id,
    source: it.source || "gamcore",
    source_id: it.source_id ? String(it.source_id) : String(it.id),
    title: it.title || "Juego VIP",
    cover_url: coverToken ? `/api/media?t=${coverToken}` : "",
    media_type: "game",
    tags: it.tags || [],
    artists: it.engine ? [it.engine] : [],
    url: "",
    page_count: 0,
    video_sources: [{
      embed_url: it.embed_url || "",
      swf_url: it.swf_url || "",
      game_type: gameType,
      engine: it.engine || "",
      plays: it.plays || 0,
      rating: it.rating || 0,
      badges: it.badges || []
    }],
    has_cover: !!rawCover,
    embed_url: it.embed_url || "",
    swf_url: it.swf_url || "",
    game_type: gameType,
    engine: it.engine || "",
    plays: it.plays || 0,
    rating: it.rating || 0,
    badges: it.badges || []
  };
}

async function fetchIdBounds(supabaseUrl, apiKey, filterQuery) {
  const cacheKey = `bounds:${supabaseUrl}|${filterQuery}`;
  const cached = getIsolateCache(ISOLATE_CATALOG_CACHE, cacheKey, 1800000);
  if (cached && cached.minId && cached.maxId) return cached;
  const headers = { "apikey": apiKey, "Authorization": `Bearer ${apiKey}` };
  const base = `${supabaseUrl}/rest/v1/items?select=id&limit=1&${filterQuery}`;
  const [maxRes, minRes] = await Promise.all([
    fetch(`${base}&order=id.desc`, { headers }),
    fetch(`${base}&order=id.asc`, { headers })
  ]);
  if (!maxRes.ok || !minRes.ok) return null;
  const maxRows = await maxRes.json().catch(() => []);
  const minRows = await minRes.json().catch(() => []);
  const maxId = maxRows && maxRows[0] ? Number(maxRows[0].id) : 0;
  const minId = minRows && minRows[0] ? Number(minRows[0].id) : 0;
  if (!maxId || !minId || maxId < minId) return null;
  const bounds = { minId, maxId };
  setIsolateCache(ISOLATE_CATALOG_CACHE, cacheKey, bounds);
  return bounds;
}

async function fetchCatalogSpan(supabaseUrl, apiKey, filterQuery) {
  const cacheKey = `span:v3:${filterQuery}`;
  const cached = getIsolateCache(ISOLATE_CATALOG_CACHE, cacheKey, 1800000);
  if (cached && cached.minId && cached.maxId) return cached;
  const headers = { "apikey": apiKey, "Authorization": `Bearer ${apiKey}` };
  const base = `${supabaseUrl}/rest/v1/items?select=id&limit=1&${filterQuery}`;
  try {
    const [maxRes, minRes] = await Promise.all([
      fetch(`${base}&order=id.desc`, { headers }),
      fetch(`${base}&order=id.asc`, { headers })
    ]);
    if (!maxRes.ok || !minRes.ok) return null;
    const maxRows = await maxRes.json().catch(() => []);
    const minRows = await minRes.json().catch(() => []);
    const maxId = maxRows && maxRows[0] ? Number(maxRows[0].id) : 0;
    const minId = minRows && minRows[0] ? Number(minRows[0].id) : 0;
    if (!maxId || !minId || maxId < minId) return null;
    let total = 0;
    const range = maxRes.headers.get("content-range") || "";
    if (range.includes("/")) {
      const part = range.split("/")[1];
      const n = parseInt(part, 10);
      if (!isNaN(n) && n > 0) total = n;
    }
    const span = { minId, maxId, total };
    setIsolateCache(ISOLATE_CATALOG_CACHE, cacheKey, span);
    return span;
  } catch (e) {
    return null;
  }
}

async function sampleSupabaseShuffle({ supabaseUrl, apiKey, filterQuery, selectFields, page, pageSize, seed, estimatedTotal }) {
  const span = await fetchCatalogSpan(supabaseUrl, apiKey, filterQuery);
  const minId = span && span.minId ? span.minId : 1;
  const maxId = span && span.maxId ? span.maxId : minId;
  const total = (span && span.total) || estimatedTotal || pageSize;
  const plan = planShuffleWindows({
    total: Math.max(pageSize, total),
    minId,
    maxId,
    page,
    pageSize,
    seed,
    bands: 4
  });
  const headers = { "apikey": apiKey, "Authorization": `Bearer ${apiKey}` };
  const fetchRows = async (url) => {
    try {
      const res = await fetch(url, { headers });
      if (!res.ok) return [];
      const rows = await res.json();
      return Array.isArray(rows) ? rows : [];
    } catch (e) {
      return [];
    }
  };
  const bandRows = await Promise.all(plan.windows.map((w) => {
    const url = `${supabaseUrl}/rest/v1/items?select=${selectFields}&limit=${w.take}&offset=0&order=id.desc&id=lte.${w.anchorId}&${filterQuery}`;
    return fetchRows(url);
  }));
  const mixSeed = Number(seed) + Number(page) * 997;
  let items = assembleShufflePage(bandRows, pageSize, mixSeed);
  if (items.length < Math.min(pageSize, Math.max(1, total))) {
    const offsetRows = await Promise.all(plan.windows.map((w) => {
      const off = Math.max(0, Math.min(w.offset, Math.max(0, total - 1)));
      const url = `${supabaseUrl}/rest/v1/items?select=${selectFields}&limit=${w.take}&offset=${off}&order=id.desc&${filterQuery}`;
      return fetchRows(url);
    }));
    items = assembleShufflePage(bandRows.concat(offsetRows), pageSize, mixSeed);
  }
  if (!items.length) {
    const fallback = await fetchRows(`${supabaseUrl}/rest/v1/items?select=${selectFields}&limit=${pageSize}&offset=0&order=id.desc&${filterQuery}`);
    if (fallback.length) items = fallback.slice(0, pageSize);
  }
  return { items, total: Math.max(total, items.length) };
}

async function fetchPmvShuffleItems({ page, pageSize, seed, category, q, encodeToken }) {
  const totalPages = 2500;
  const pages = pmvPageNumbers(seed, page, pageSize, totalPages);
  const take = Math.max(4, Math.ceil(pageSize / Math.max(1, pages.length)) + 2);
  const bandRows = await Promise.all(pages.map(async (p) => {
    let apiUrl = `https://pmvhaven.com/api/videos?page=${p}&limit=${take}&sort=recent`;
    if (category && category !== "all") apiUrl += `&tag=${encodeURIComponent(category)}`;
    else if (q) apiUrl += `&tag=${encodeURIComponent(q)}`;
    try {
      const res = await fetch(apiUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
          "Referer": "https://pmvhaven.com/",
          "Accept": "application/json, text/plain, */*"
        }
      });
      if (!res.ok) return [];
      const data = await res.json();
      const list = data.videos || data.data || [];
      return list.map((v) => ({ ...v, id: v._id || v.id }));
    } catch (e) {
      return [];
    }
  }));
  const picked = assembleShufflePage(bandRows, pageSize, Number(seed) + Number(page) * 997);
  const items = [];
  for (const v of picked) {
    const rawCover = v.thumbnailUrl || (v.thumbnailSizes && v.thumbnailSizes.lg && v.thumbnailSizes.lg.url) || "";
    const rawVideo = v.videoUrl || "";
    const coverToken = rawCover && encodeToken ? await encodeToken(rawCover, "https://pmvhaven.com/") : "";
    const videoToken = rawVideo && encodeToken ? await encodeToken(rawVideo, "https://pmvhaven.com/") : "";
    items.push({
      id: v._id || v.id,
      source: "pmvhaven",
      source_id: v._id || v.id,
      title: v.title || "Video HD",
      cover_url: coverToken ? `/api/media?t=${coverToken}` : "",
      media_type: "video",
      tags: v.tags || [],
      artists: v.uploaderUsername ? [v.uploaderUsername] : [],
      url: `https://pmvhaven.com/video?v=${v._id || v.id}`,
      page_count: 0,
      video_sources: rawVideo ? [{
        quality: "1080p HD",
        url: videoToken ? `/api/media?t=${videoToken}` : "",
        format: "mp4"
      }] : [],
      extra: {
        duration: v.duration || "",
        durationSeconds: v.durationSeconds || 0,
        views: v.views || 0,
        likes: v.likes || 0
      },
      has_cover: !!rawCover
    });
  }
  return { items, total: 70704, pages };
}

// =============================================================================
// CABECERAS CORS ESTRICTAS (SIN WILDCARD CUANDO HAY CREDENCIALES)
// =============================================================================
function isAllowedOrigin(origin) {
  if (!origin || origin === "*") return false;
  try {
    const u = new URL(origin);
    const host = u.hostname;
    if (u.protocol === "http:" && (host === "localhost" || host === "127.0.0.1")) return true;
    if (u.protocol !== "https:") return false;
    if (host === "morbohub.com" || host === "www.morbohub.com" || host === "morbohub.pages.dev") return true;
    if (host.endsWith(".morbohub.pages.dev")) return true;
    return false;
  } catch (e) {
    return false;
  }
}

function getCorsHeaders(origin = "") {
  const allowed = isAllowedOrigin(origin);
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

function readRequestCookie(request, name) {
  const raw = request.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      const value = part.slice(idx + 1).trim();
      try { return decodeURIComponent(value); } catch (e) { return value; }
    }
  }
  return null;
}

function requestIsSecure(request) {
  try { return new URL(request.url).protocol === "https:"; } catch (e) { return true; }
}

function buildSessionCookies(request, accessToken, refreshToken, expiresAtSec) {
  const secure = requestIsSecure(request);
  const cookies = [];
  const nowSec = Math.floor(Date.now() / 1000);
  const accessTtl = expiresAtSec && Number(expiresAtSec) > nowSec
    ? Math.max(60, Number(expiresAtSec) - nowSec)
    : 3600;
  // Las cookies HttpOnly son el respaldo cuando localStorage falla o se fragmenta.
  // No se escriben si el JWT no cabe: una cookie rechazada no debe tumbar el login.
  if (accessToken && accessToken.length > 20 && accessToken.length < 3200) {
    cookies.push(sessionCookie("velvet_access", accessToken, accessTtl, secure));
  }
  if (refreshToken && refreshToken.length > 10 && refreshToken.length < 3200) {
    cookies.push(sessionCookie("velvet_refresh", refreshToken, 60 * 60 * 24 * 30, secure));
  }
  return cookies;
}

function clearSessionCookies(request) {
  const secure = requestIsSecure(request);
  return [
    sessionCookie("velvet_access", "", 0, secure),
    sessionCookie("velvet_refresh", "", 0, secure)
  ];
}

function sessionCookie(name, value, maxAge, secure) {
  const parts = [
    `${name}=${encodeURIComponent(value || "")}`,
    `Max-Age=${Math.max(0, maxAge | 0)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax"
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

function withSessionCookies(response, cookies) {
  if (!cookies || cookies.length === 0) return response;
  const headers = new Headers(response.headers);
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(response.body, { status: response.status, headers });
}

// Un solo canje por refresh token dentro del isolate. Dos peticiones paralelas
// con el mismo token no deben pegarle dos veces a Supabase: la segunda reutilización
// revoca la familia de sesión completa.
const REFRESH_FLIGHTS = new Map();
async function exchangeRefreshToken(refreshToken, sbUrl, sbKey) {
  if (!refreshToken || refreshToken === "null" || refreshToken === "undefined") return null;
  const existing = REFRESH_FLIGHTS.get(refreshToken);
  if (existing) return existing;
  const job = (async () => {
    const refRes = await fetch(`${sbUrl}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: { "apikey": sbKey, "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken })
    });
    const refData = await refRes.json().catch(() => ({}));
    if (!refRes.ok || !refData || !refData.access_token) {
      return { ok: false, status: refRes.status || 401, data: refData || {} };
    }
    return { ok: true, status: 200, data: refData };
  })();
  REFRESH_FLIGHTS.set(refreshToken, job);
  try {
    const result = await job;
    if (!result || !result.ok) REFRESH_FLIGHTS.delete(refreshToken);
    return result;
  } finally {
    const timer = setTimeout(() => REFRESH_FLIGHTS.delete(refreshToken), 20000);
    if (timer && typeof timer.unref === "function") timer.unref();
  }
}

function sanitizeAuthAlias(input) {
  return String(input || "").toLowerCase().replace(/[^a-z0-9._-]/g, "").slice(0, 64);
}

// Resuelve la sesión SIN consumir el refresh token. El canje vive solo en /api/auth/refresh
// para que las peticiones paralelas de favoritos/historial no revoquen la sesión.
async function resolveAuthUser(request, sbUrl, sbKey) {
  const activeUrl = sbUrl || _activeSupabaseUrl || (typeof SUPABASE_URL !== "undefined" ? SUPABASE_URL : "");
  const activeKey = sbKey || _activeSupabaseKey || (typeof SUPABASE_KEY !== "undefined" ? SUPABASE_KEY : "");
  const authHeader = request.headers.get("authorization") || "";
  let token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  if (!token || token === "velvet_token" || token === "null" || token === "undefined") {
    token = readRequestCookie(request, "velvet_access") || "";
  }
  if (!token || token === "velvet_token" || token === "null" || token === "undefined") {
    return { user: null, token: null, newToken: null, newRefreshToken: null, unavailable: false };
  }

  let upstreamStatus = 0;
  try {
    const userRes = await fetch(`${activeUrl}/auth/v1/user`, {
      headers: { "apikey": activeKey, "Authorization": `Bearer ${token}` }
    });
    upstreamStatus = userRes.status || 0;
    if (userRes.ok) {
      const user = await userRes.json();
      if (user && user.id) {
        return { user, token, newToken: null, newRefreshToken: null, unavailable: false };
      }
    }
    // 401/403: token inválido o caducado. El cliente refresca. No es un 503.
    if (userRes.status === 401 || userRes.status === 403) {
      return { user: null, token: null, newToken: null, newRefreshToken: null, unavailable: false };
    }
  } catch (e) {
    upstreamStatus = 503;
  }

  // GoTrue caído o inalcanzable no debe vaciar la bóveda si el JWT sigue vigente.
  // PostgREST valida el mismo token con RLS (auth.uid()).
  const payload = decodeJwtPayload(token);
  const nowSec = Math.floor(Date.now() / 1000);
  if (payload && payload.sub && payload.exp && Number(payload.exp) <= nowSec) {
    return { user: null, token: null, newToken: null, newRefreshToken: null, unavailable: false };
  }
  if (payload && payload.sub) {
    return {
      user: {
        id: payload.sub,
        email: payload.email || "",
        user_metadata: payload.user_metadata || {},
        role: payload.role || "authenticated"
      },
      token,
      newToken: null,
      newRefreshToken: null,
      unavailable: false,
      degraded: true
    };
  }

  if (upstreamStatus >= 500 || upstreamStatus === 0) {
    return { user: null, token, newToken: null, newRefreshToken: null, unavailable: true };
  }
  return { user: null, token: null, newToken: null, newRefreshToken: null, unavailable: false };
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

async function updateUserMetadata() {
  // Los favoritos viven en public.favorites (RLS por auth.uid()).
  // Escribirlos en user_metadata hincha el JWT y tira la sesión al rotar el token.
  return false;
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
  const MEDIA_SECRET = env.MEDIA_SECRET || "";
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
      } else if (targetMediaUrl.includes("gamcore") || targetMediaUrl.includes("serverable")) {
        spoofedReferer = "https://gamcore.com/";
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

    if (rawSource === "gamcore" || rawSource === "game") {
      try {
        const games = await loadGameCatalog(context, url);
        const wanted = String(rawSourceId || rawId || "");
        const found = (games || []).find(g => String(g.source_id) === wanted || String(g.id) === wanted);
        if (!found) {
          return new Response(JSON.stringify({ detail: "Juego no encontrado" }), {
            status: 404,
            headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
          });
        }
        const maskedGame = await maskGameItem(found, MEDIA_SECRET);
        const gameJson = JSON.stringify(maskedGame);
        setIsolateCache(ISOLATE_DETAIL_CACHE, detailCacheKey, gameJson);
        return new Response(gameJson, {
          status: 200,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800",
            ...getCorsHeaders(origin)
          }
        });
      } catch (gameDetailErr) {
        console.error("[Velvet-Detail] Juego no disponible:", gameDetailErr);
        return new Response(JSON.stringify({ detail: "Juego no disponible" }), {
          status: 404,
          headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
        });
      }
    }

    try {
      const detailTargetUrl = SUPABASE_URL;
      const detailTargetKey = SUPABASE_ADMIN_KEY;
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
              let high = 24;
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
    const seedParam = readShuffleSeed(url.searchParams.get("seed"));
    const shuffleParam = readShuffleSeed(url.searchParams.get("shuffle"));
    const sort = validateSort(url.searchParams.get("sort"));

    // Cache L1 de Memoria RAM Isolate (0ms de latencia)
    // Semilla compartida: Math.floor(Date.now() / (3 * 3600 * 1000))
    const catalogSlot = Math.floor(Date.now() / (3 * 3600 * 1000));
    const freshSeed = shuffleParam || seedParam;
    const freshShuffle = url.searchParams.get("fresh") === "1" && freshSeed > 0;
    const rotationSeed = freshShuffle ? freshSeed : catalogSlot;
    const rotTtl = rotationCacheSeconds(Date.now());
    const catalogCacheControl = q
      ? "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400"
      : `public, max-age=${Math.min(1800, rotTtl)}, s-maxage=${rotTtl}, stale-while-revalidate=60`;
    const isolateCatalogKey = `v3:${mediaType}:${page}:${pageSize}:${q}:${category}:${tag}:${rotationSeed}:${sort}`;
    const l1Catalog = !freshShuffle ? getIsolateCache(ISOLATE_CATALOG_CACHE, isolateCatalogKey, q ? 300000 : 1800000) : null;
    if (l1Catalog) {
      return new Response(method === "HEAD" ? null : l1Catalog, {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": freshShuffle ? "private, no-store" : catalogCacheControl,
          "X-Cloudflare-RAM-Cache": "HIT",
          "X-Cloudflare-Edge-Cache": "HIT",
          "X-Velvet-Rotation": String(catalogSlot),
          ...getCorsHeaders(origin)
        }
      });
    }

    // Cache L2 de Borde Cloudflare para catálogo público.
    // cv=3 + rot=<ventana de 3 h> descarta respuestas de la ventana anterior.
    const cache = typeof caches !== "undefined" ? caches.default : null;
    const cacheKey = new Request(catalogEdgeCacheUrl(url, freshShuffle ? `fresh-${rotationSeed}` : catalogSlot), { method: "GET" });
    if (cache && !freshShuffle) {
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
    // "Al Azar" en videos: varias páginas repartidas por todo PMV, no el
    // sort=random cacheado que devuelve siempre el mismo cubo.
    if (mediaType === "video" && preferLivePmv && freshShuffle) {
      try {
        const shuffledPmv = await fetchPmvShuffleItems({
          page,
          pageSize,
          seed: freshSeed,
          category,
          q,
          encodeToken
        });
        if (shuffledPmv && shuffledPmv.items && shuffledPmv.items.length) {
          const totalVideos = shuffledPmv.total || 70704;
          const responsePayload = {
            items: shuffledPmv.items,
            total: totalVideos,
            page,
            page_size: pageSize,
            total_pages: Math.max(1, Math.ceil(totalVideos / pageSize)),
            live: true,
            shuffle: freshSeed
          };
          return new Response(JSON.stringify(responsePayload), {
            status: 200,
            headers: {
              "Content-Type": "application/json; charset=utf-8",
              "X-Velvet-Rotation": String(catalogSlot),
              "X-Velvet-Shuffle": String(freshSeed),
              ...catalogResponseCacheHeaders(true, catalogCacheControl),
              ...getCorsHeaders(origin)
            }
          });
        }
      } catch (pmvShuffleErr) {
        console.error("PMVHaven shuffle error:", pmvShuffleErr);
      }
    }
    if (mediaType === "video" && preferLivePmv && !freshShuffle) {
      let pmvSort = "recent";
      if (sort === "random") pmvSort = "random";
      else if (sort === "views") pmvSort = "views";
      else if (sort === "rating") pmvSort = "rating";

      let fetchPmvPage = page;
      if ((sort === "random" || freshShuffle) && !q && (!category || category === "all")) {
        const seedVal = freshShuffle ? freshSeed : catalogSlot;
        const randomBasePage = ((seedVal * 137) % 2500) + 1;
        fetchPmvPage = ((randomBasePage + (page - 1) * 3) % 2500) + 1;
        // La fórmula anterior puede repetir página cuando PMV recorta el rango.
        // La permutación biyectiva deja la 494 y la 495 en páginas distintas
        // y cambia toda la categoría al cambiar la ventana de 3 horas.
        fetchPmvPage = permutePageIndex(Math.max(0, page - 1), 2500, seedVal) + 1;
      }

      let pmvApiUrl = `https://pmvhaven.com/api/videos?page=${fetchPmvPage}&limit=${pageSize}&sort=${pmvSort}`;
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
          },
          cf: { cacheEverything: true, cacheTtl: 1800 }
        });

        if (pmvRes.ok) {
          const pmvData = await pmvRes.json();
          let vList = pmvData.videos || [];

          if ((sort === "random" || freshShuffle) && !q && vList.length > 1) {
            vList = orderCatalogForSlot(
              vList.map((v) => ({ ...v, id: v._id || v.id })),
              freshShuffle ? freshSeed : catalogSlot,
              "video"
            );
          }

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
            page: page,
            page_size: pageSize,
            total_pages: totalPages,
            live: true,
            seed: seedParam || undefined
          };

          const jsonStr = JSON.stringify(responsePayload);
          setIsolateCache(ISOLATE_CATALOG_CACHE, isolateCatalogKey, jsonStr);

          const pmvResponse = new Response(jsonStr, {
            status: 200,
            headers: {
              "Content-Type": "application/json; charset=utf-8",
              "Cache-Control": freshShuffle ? "private, no-store" : catalogCacheControl,
              "X-Velvet-Rotation": String(catalogSlot),
              ...getCorsHeaders(origin)
            }
          });
          if (cache && !freshShuffle) {
            try { context.waitUntil(cache.put(cacheKey, pmvResponse.clone())); } catch (e) {}
          }
          return pmvResponse;
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
    } else if (mediaType === "game") {
      estimatedTotal = 8032;
    }

    // Modo aleatorio y rotación cada 3 horas SOLO si sort=random o viene seed Y no hay búsqueda, categoría ni tag
    const isRandomMode = (sort === "random" || seedParam > 0) && !q && !tag && (!category || category === "all");
    const rotateCatalog = (sort === "random" || freshShuffle) && !q && !tag && (!category || category === "all");
    const effectiveSeed = freshShuffle ? freshSeed : (rotateCatalog ? catalogSlot : (((catalogSlot * 7919) % 50000) + 1));

    // Juegos: el proyecto Supabase DB2 (vtyleivfovkolpxjjkjs) ya no resuelve (Cloudflare 1016).
    // El catálogo real está en /data/games.json. Un fallo de origen NUNCA debe ser HTTP 500.
    if (mediaType === "game") {
      try {
        const games = await loadGameCatalog(context, url);
        const seeded = buildGameCatalogPage(games, {
          page,
          pageSize,
          sort,
          q,
          category,
          seed: effectiveSeed
        });
        const items = await Promise.all((seeded.items || []).map(it => maskGameItem(it, MEDIA_SECRET)));
        const responsePayload = {
          items,
          total: seeded.total,
          page: seeded.page,
          page_size: seeded.page_size,
          total_pages: seeded.total_pages,
          live: false
        };
        if (freshShuffle) responsePayload.shuffle = freshSeed;
        const jsonStr = JSON.stringify(responsePayload);
        if (!freshShuffle) setIsolateCache(ISOLATE_CATALOG_CACHE, isolateCatalogKey, jsonStr);
        const gameResp = new Response(method === "HEAD" ? null : jsonStr, {
          status: 200,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "X-Velvet-Rotation": String(catalogSlot),
            ...(freshShuffle ? { "X-Velvet-Shuffle": String(freshSeed) } : {}),
            ...catalogResponseCacheHeaders(freshShuffle, catalogCacheControl),
            ...getCorsHeaders(origin)
          }
        });
        if (cache && !freshShuffle) {
          try { context.waitUntil(cache.put(cacheKey, gameResp.clone())); } catch (e) {}
        }
        return gameResp;
      } catch (gameErr) {
        const detail = gameErr && gameErr.message ? gameErr.message : "catalogo de juegos no disponible";
        const status = gameErr && gameErr.status ? gameErr.status : 502;
        console.error("[Velvet-Items] Juegos degradados:", isDeadUpstreamError(status, detail), detail);
        return new Response(JSON.stringify({
          items: [],
          total: 0,
          page,
          page_size: pageSize,
          total_pages: 1,
          live: false,
          degraded: true
        }), {
          status: 200,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
            ...getCorsHeaders(origin)
          }
        });
      }
    }

    const safePage = Math.max(1, page);
    const selectFields = "id,source,source_id,title,cover_url,media_type,tags,page_count,artists,video_sources";
    let filterQuery = "";
    if (mediaType === "video") {
      filterQuery = "media_type=eq.video";
    } else if (mediaType === "gallery" || mediaType === "cosplay") {
      filterQuery = "media_type=eq.gallery&page_count=gt.0";
      const allowLeak = (q && q.toLowerCase().includes("leak")) || (category === "leak" || category === "patreon");
      if (!allowLeak) filterQuery += "&source=neq.leakgallery";
    } else {
      filterQuery = "media_type=eq.comic&page_count=gt.0";
    }

    if (tag) {
      filterQuery += `&tags=cs.{${encodeURIComponent(tag)}}`;
    }

    if (q) {
      const words = q.split(/\s+/).filter(Boolean).slice(0, 3);
      if (words.length === 1) {
        filterQuery += `&search_text=ilike.*${encodeURIComponent(words[0])}*`;
      } else {
        const orClauses = words.map(w => `search_text.ilike.*${encodeURIComponent(w)}*`).join(",");
        filterQuery += `&or=(${orClauses})`;
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
      filterQuery += `&search_text=ilike.*${encodeURIComponent(catTerm)}*`;
    }

    let rawItems = [];
    let totalCount = estimatedTotal;
    let usedShuffleSample = false;

    try {
      if (freshShuffle) {
        try {
          const sampled = await sampleSupabaseShuffle({
            supabaseUrl: SUPABASE_URL,
            apiKey: SUPABASE_KEY,
            filterQuery,
            selectFields,
            page: safePage,
            pageSize,
            seed: freshSeed,
            estimatedTotal
          });
          if (sampled && Array.isArray(sampled.items) && sampled.items.length) {
            rawItems = sampled.items;
            totalCount = sampled.total || estimatedTotal;
            usedShuffleSample = true;
          }
        } catch (shuffleErr) {
          console.error("[Velvet-Items] shuffle:", shuffleErr && shuffleErr.message ? shuffleErr.message : shuffleErr);
        }
      }

      if (!usedShuffleSample) {
    // Cada página es un tramo distinto del conjunto FILTRADO (no del espacio
    // de ids). Un cursor id=lte a 24 o 7919 ids de distancia caía en el mismo
    // hueco y la 494 y la 495 devolvían las mismas filas. La rotación de 3 h
    // permuta el índice de página, pero sigue siendo biyectiva.
    const pagePlan = catalogPageOffset(
      safePage,
      pageSize,
      Math.max(pageSize, estimatedTotal),
      rotateCatalog ? catalogSlot : 1,
      rotateCatalog
    );
    let offset = pagePlan.offset;
    let cursorId = null;
    if (offset > 240) {
      const boundaryKey = `boundary:v3:${filterQuery}:${offset}`;
      const cachedBoundary = getIsolateCache(ISOLATE_CATALOG_CACHE, boundaryKey, 1800000);
      let boundaryId = cachedBoundary && cachedBoundary.id ? Number(cachedBoundary.id) : 0;
      if (!boundaryId) {
        try {
          const probeUrl = `${SUPABASE_URL}/rest/v1/items?select=id&limit=1&offset=${offset}&order=id.desc&${filterQuery}`;
          const probeRes = await fetch(probeUrl, {
            headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}` }
          });
          if (probeRes.ok) {
            const probeRows = await probeRes.json().catch(() => []);
            boundaryId = probeRows && probeRows[0] ? Number(probeRows[0].id) : 0;
            if (boundaryId) setIsolateCache(ISOLATE_CATALOG_CACHE, boundaryKey, { id: boundaryId });
          }
        } catch (probeErr) {}
      }
      if (boundaryId) {
        cursorId = boundaryId;
        offset = 0;
      }
    }

    let postgrestUrl = `${SUPABASE_URL}/rest/v1/items?select=${selectFields}&limit=${pageSize}&offset=${offset}`;
    postgrestUrl += `&${filterQuery}`;
    if (cursorId) {
      postgrestUrl += `&id=lte.${cursorId}`;
    }

    // Orden por defecto indexado por clave primaria
    postgrestUrl += "&order=id.desc";

      // Optimización PostgREST: count=exact para búsquedas/tags; count=planned para catálogos masivos (0ms vs timeout)
      const preferCount = (q || tag) ? "count=exact" : "";
      const activeQueryKey = SUPABASE_KEY;
      const catalogHeaders = {
        "apikey": activeQueryKey,
        "Authorization": `Bearer ${activeQueryKey}`,
        ...(preferCount ? { "Prefer": preferCount } : {})
      };
      let spRes = await fetch(postgrestUrl, {
        headers: catalogHeaders
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
        if (!spRes.ok && spRes.status === 416 && offset > 0) {
          // Solo un 416 (offset pasado del final) puede caer a offset 0, y
          // únicamente para no perder los filtros. Una página profunda que
          // sí existe no se sustituye por la página 1.
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
      totalCount = estimatedTotal;
      if (contentRange && contentRange.includes("/")) {
        const totalPart = contentRange.split("/")[1];
        if (totalPart && totalPart !== "*") {
          const parsedTotal = parseInt(totalPart, 10);
          if (!isNaN(parsedTotal) && parsedTotal >= 0) {
            totalCount = parsedTotal;
          }
        }
      }

      rawItems = await spRes.json();
      if (cursorId && Array.isArray(rawItems) && rawItems.length > 0 && rawItems.length < pageSize) {
        const lastId = Number(rawItems[rawItems.length - 1].id) || 0;
        if (lastId > 1) {
          const moreUrl = postgrestUrl
            .replace(/&id=lte\.\d+/, `&id=lt.${lastId}`)
            .replace(/offset=\d+/, "offset=0")
            .replace(/limit=\d+/, `limit=${pageSize - rawItems.length}`);
          try {
            const moreRes = await fetch(moreUrl, {
              headers: { "apikey": activeQueryKey, "Authorization": `Bearer ${activeQueryKey}` }
            });
            if (moreRes.ok) {
              const extra = await moreRes.json();
              const seen = new Set(rawItems.map((it) => it.id));
              if (Array.isArray(extra)) {
                for (const it of extra) {
                  if (!seen.has(it.id)) {
                    rawItems.push(it);
                    seen.add(it.id);
                  }
                }
              }
            }
          } catch (moreErr) {}
        }
      }
      }
      const items = await Promise.all((rawItems || []).map(async it => {
        const isGame = it.media_type === "game";
        const coverToken = (!isGame && it.cover_url) ? await encodeMediaToken(it.cover_url, "", MEDIA_SECRET) : "";
        const videoSources = await Promise.all((it.video_sources || []).map(async vs => ({
          ...vs,
          url: vs.url ? `/api/media?t=${await encodeMediaToken(vs.url, "", MEDIA_SECRET)}` : ""
        })));
        const firstVs = (it.video_sources && it.video_sources[0]) || {};
        return {
          id: it.id,
          source: it.source || "velvet",
          source_id: it.source_id ? String(it.source_id) : String(it.id),
          title: it.title,
          cover_url: isGame ? (it.cover_url || "") : (coverToken ? `/api/media?t=${coverToken}` : ""),
          media_type: it.media_type,
          tags: it.tags || [],
          artists: it.artists || [],
          url: "", // Ocultar URL original
          page_count: it.page_count || 0,
          video_sources: videoSources,
          has_cover: !!it.cover_url,
          embed_url: firstVs.embed_url || "",
          swf_url: firstVs.swf_url || "",
          game_type: firstVs.game_type || (firstVs.swf_url ? "flash" : "html5"),
          engine: firstVs.engine || (it.artists && it.artists[0]) || "",
          plays: firstVs.plays || 0,
          rating: firstVs.rating || 0,
          badges: firstVs.badges || []
        };
      }));

      const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));

      const responsePayload = {
        items,
        total: totalCount,
        page: safePage,
        page_size: pageSize,
        total_pages: totalPages,
        live: false,
        rotation: catalogSlot,
        shuffle: freshShuffle ? freshSeed : undefined
      };

      const jsonStr = JSON.stringify(responsePayload);
      if (!freshShuffle) setIsolateCache(ISOLATE_CATALOG_CACHE, isolateCatalogKey, jsonStr);

      const resp = new Response(method === "HEAD" ? null : jsonStr, {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "X-Velvet-Rotation": String(catalogSlot),
          ...(freshShuffle ? { "X-Velvet-Shuffle": String(freshSeed) } : {}),
          ...catalogResponseCacheHeaders(freshShuffle, catalogCacheControl),
          ...getCorsHeaders(origin)
        }
      });

      if (cache && !freshShuffle) {
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
        const alias = sanitizeAuthAlias(email);
        const master = "erickariaslrcy@gmail.com";
        if (alias === "admin" || alias === "erick" || alias === "master") {
          email = master;
        } else if (!alias) {
          return new Response(JSON.stringify({ detail: "Usuario no válido" }), {
            status: 400,
            headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...getCorsHeaders(origin) }
          });
        } else if (SUPABASE_SERVICE_ROLE_KEY) {
          // La política RLS de profiles solo deja leer el perfil propio. El alias
          // se resuelve con la service role y un filtro ya saneado (sin metacaracteres PostgREST).
          const profRes = await fetch(`${SUPABASE_URL}/rest/v1/profiles?select=email&or=(email.ilike.*${alias}@*,email.ilike.*${alias}*)&limit=1`, {
            headers: { "apikey": SUPABASE_SERVICE_ROLE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` }
          });
          const profData = await profRes.json().catch(() => []);
          if (profData && profData.length > 0 && profData[0].email) {
            email = profData[0].email;
          } else {
            email = `${alias}@velvet.local`;
          }
        } else {
          email = `${alias}@velvet.local`;
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
      const profRes = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(authData.user.id)}&select=is_admin&limit=1`, {
        headers: { "apikey": SUPABASE_ANON_KEY || SUPABASE_KEY, "Authorization": `Bearer ${authData.access_token}` }
      });
      const profs = await profRes.json().catch(() => []);
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

      const loginResponse = new Response(JSON.stringify(respData), {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
          ...getCorsHeaders(origin)
        }
      });
      return withSessionCookies(
        loginResponse,
        buildSessionCookies(context.request, authData.access_token, authData.refresh_token, authData.expires_at)
      );
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
    const { user, token, unavailable } = await resolveAuthUser(context.request, SUPABASE_URL, SUPABASE_KEY);

    if (unavailable) {
      return new Response(JSON.stringify({ detail: "Servicio de sesión no disponible" }), {
        status: 503,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...getCorsHeaders(origin) }
      });
    }

    if (!user) {
      return new Response(JSON.stringify({ detail: "No autenticado" }), {
        status: 401,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...getCorsHeaders(origin) }
      });
    }

    try {
      const profRes = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&select=is_admin&limit=1`, {
        headers: { "apikey": SUPABASE_ANON_KEY || SUPABASE_KEY, "Authorization": `Bearer ${token}` }
      });
      const profs = await profRes.json().catch(() => []);
      const isAdmin = profs && profs[0] && profs[0].is_admin;
      const role = isAdmin ? "admin" : "member";
      const meta = user.user_metadata || {};
      const displayName = meta.username || meta.full_name || meta.display_name || user.email?.split("@")[0] || "Usuario VIP";
      let expiresAt = null;
      try {
        const part = token.split(".")[1];
        if (part) {
          const payload = JSON.parse(fromBase64Url(part));
          if (payload && payload.exp) expiresAt = payload.exp;
        }
      } catch (e) {}

      const respData = {
        id: user.id,
        username: displayName,
        email: user.email,
        role,
        tier: isAdmin ? "Dueño" : "Velvet VIP ($5.99)",
        tier_level: "pro",
        is_pro: true,
        max_devices: 10,
        token,
        expires_at: expiresAt
      };

      return new Response(JSON.stringify(respData), {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...getCorsHeaders(origin) }
      });
    } catch (err) {
      return new Response(JSON.stringify({ detail: "Error de sesión" }), {
        status: 500,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...getCorsHeaders(origin) }
      });
    }
  }

  // =========================================================================
  // 6.1 AUTENTICACIÓN: REFRESCAR SESIÓN (/api/auth/refresh)
  // =========================================================================
  if (url.pathname === "/api/auth/refresh" && method === "POST") {
    try {
      const originHeader = context.request.headers.get("origin");
      if (originHeader && !isAllowedOrigin(originHeader)) {
        return new Response(JSON.stringify({ detail: "Origen no permitido" }), {
          status: 403,
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...getCorsHeaders(origin) }
        });
      }

      const body = await context.request.json().catch(() => ({}));
      const refreshToken =
        body.refresh_token ||
        context.request.headers.get("x-refresh-token") ||
        readRequestCookie(context.request, "velvet_refresh") ||
        null;

      if (!refreshToken) {
        return new Response(JSON.stringify({ detail: "Token de actualización no provisto" }), {
          status: 400,
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...getCorsHeaders(origin) }
        });
      }

      const exchanged = await exchangeRefreshToken(refreshToken, SUPABASE_URL, SUPABASE_KEY);
      const refData = exchanged && exchanged.data ? exchanged.data : {};
      if (!exchanged || !exchanged.ok || !refData.access_token) {
        const status = exchanged && exchanged.status >= 500 ? 503 : 401;
        return new Response(JSON.stringify({ detail: refData?.error_description || refData?.msg || "Sesión expirada" }), {
          status,
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...getCorsHeaders(origin) }
        });
      }

      const user = refData.user;
      const meta = user?.user_metadata || {};
      const profRes = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&select=is_admin&limit=1`, {
        headers: { "apikey": SUPABASE_ANON_KEY || SUPABASE_KEY, "Authorization": `Bearer ${refData.access_token}` }
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

      const refreshResponse = new Response(JSON.stringify(respData), {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
          ...getCorsHeaders(origin)
        }
      });
      return withSessionCookies(
        refreshResponse,
        buildSessionCookies(context.request, refData.access_token, refData.refresh_token, refData.expires_at)
      );
    } catch (err) {
      return new Response(JSON.stringify({ detail: err.message || "Error al refrescar sesión" }), {
        status: 500,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...getCorsHeaders(origin) }
      });
    }
  }

  // =========================================================================
  // 6.2 AUTENTICACIÓN: CERRAR SESIÓN (/api/auth/logout)
  // =========================================================================
  if (url.pathname === "/api/auth/logout" && method === "POST") {
    const { token } = await resolveAuthUser(context.request, SUPABASE_URL, SUPABASE_KEY);
    if (token) {
      fetch(`${SUPABASE_URL}/auth/v1/logout`, {
        method: "POST",
        headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${token}`, "Content-Type": "application/json" }
      }).catch(() => {});
    }
    const logoutResponse = new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...getCorsHeaders(origin) }
    });
    return withSessionCookies(logoutResponse, clearSessionCookies(context.request));
  }

  // =========================================================================
  // 7. AUTENTICACIÓN: REGISTRO EXCLUSIVO CON LLAVE VIP (/api/auth/register)
  // =========================================================================
  if (url.pathname === "/api/auth/register" && method === "POST") {
    try {
      const body = await context.request.json();
      const username = (body.username || "").trim();
      const email = (body.email || `${username}@velvet.local`).trim().toLowerCase();
      const password = body.password || "";
      const access_key = String(body.access_key || "").trim().toUpperCase();

      if (!username || !password) {
        return new Response(JSON.stringify({ detail: "Nombre de usuario y contraseña requeridos" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
        });
      }

      if (!access_key) {
        return new Response(JSON.stringify({ detail: "Se requiere una Llave de Acceso VIP válida o ingresar con tu cuenta de Patreon." }), {
          status: 403,
          headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
        });
      }

      // Validar Llave VIP:
      // 1. Llaves maestras de sistema
      // 2. Consulta en la tabla invite_keys de Supabase DB1
      // 3. Patrones de llaves generadas (VELVET-, VIP-, PATREON-, CLIENTE-)
      let keyValid = false;
      let keyNote = "Llave VIP de Acceso";

      const MASTER_KEYS = String(env.MASTER_INVITE_KEYS || "")
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean);
      if (MASTER_KEYS.includes(access_key)) {
        keyValid = true;
        keyNote = "Llave Maestra Velvet VIP";
      } else {
        try {
          const keyCheckRes = await fetch(`${SUPABASE_URL}/rest/v1/invite_keys?code=eq.${encodeURIComponent(access_key)}&revoked=eq.false&select=*`, {
            headers: {
              "apikey": SUPABASE_ADMIN_KEY,
              "Authorization": `Bearer ${SUPABASE_ADMIN_KEY}`
            }
          });
          if (keyCheckRes.ok) {
            const keysData = await keyCheckRes.json();
            if (Array.isArray(keysData) && keysData.length > 0) {
              const kObj = keysData[0];
              if (!kObj.revoked) {
                keyValid = true;
                keyNote = kObj.note || "Llave VIP Invitación";
              }
            }
          }
        } catch (e) {
          console.warn("Error consultando invite_keys:", e);
        }

        if (!keyValid && /^(VELVET|VIP|PATREON|CLIENTE)-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(access_key)) {
          keyValid = true;
          keyNote = `Llave VIP ${access_key.split('-')[0]}`;
        }
      }

      if (!keyValid) {
        return new Response(JSON.stringify({ detail: "Llave de acceso VIP no válida o revocada. Para acceder necesitas una llave VIP válida o tu cuenta de Patreon." }), {
          status: 403,
          headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
        });
      }

      // Registro en Supabase Auth
      const regRes = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
        method: "POST",
        headers: { "apikey": SUPABASE_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, data: { username, registered_with_key: access_key, vip_status: "active" } })
      });

      const regData = await regRes.json();
      if (!regRes.ok || !regData.user) {
        return new Response(JSON.stringify({ detail: regData?.msg || regData?.error_description || "Error al registrar cuenta en el sistema" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
        });
      }

      // Marcar llave como utilizada en invite_keys si existe
      fetch(`${SUPABASE_URL}/rest/v1/invite_keys?code=eq.${encodeURIComponent(access_key)}`, {
        method: "PATCH",
        headers: {
          "apikey": SUPABASE_ADMIN_KEY,
          "Authorization": `Bearer ${SUPABASE_ADMIN_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          used_by: regData.user.id,
          used_email: email,
          used_at: new Date().toISOString()
        })
      }).catch(() => {});

      // Iniciar sesión inmediatamente
      const authRes = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
        method: "POST",
        headers: { "apikey": SUPABASE_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ email, password })
      });
      const authData = await authRes.json().catch(() => ({}));
      if (!authRes.ok || !authData.access_token || !authData.user) {
        return new Response(JSON.stringify({
          detail: "La cuenta se creó, pero no se pudo abrir la sesión. Entra con tu usuario y contraseña."
        }), {
          status: 401,
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...getCorsHeaders(origin) }
        });
      }

      const respData = {
        token: authData.access_token,
        refresh_token: authData.refresh_token || null,
        expires_at: authData.expires_at || null,
        user: {
          id: regData.user.id,
          username,
          email,
          role: "member",
          tier: "Velvet VIP ($5.99)",
          tier_level: "pro",
          is_pro: true,
          registered_with_key: access_key
        }
      };

      const registerResponse = new Response(JSON.stringify(respData), {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
          ...getCorsHeaders(origin)
        }
      });
      return withSessionCookies(
        registerResponse,
        buildSessionCookies(context.request, authData.access_token, authData.refresh_token, authData.expires_at)
      );
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
    const { user, token, newToken, unavailable } = await resolveAuthUser(context.request, SUPABASE_URL, SUPABASE_KEY);
    if (unavailable) {
      return new Response(JSON.stringify({ error: "Servicio de sesión no disponible" }), {
        status: 503,
        headers: getPersonalHeaders(origin)
      });
    }
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
      const authHeaders = {
        "apikey": SUPABASE_KEY,
        "Authorization": `Bearer ${token || SUPABASE_ANON_KEY || SUPABASE_KEY}`,
        "Prefer": "count=exact",
        "Range": `${offset}-${to}`
      };

      try {
        let favQueryUrl = `${SUPABASE_URL}/rest/v1/favorites?user_id=eq.${user.id}&select=item_id,created_at,items(id,title,cover_url,media_type,source,source_id,url,page_count,video_sources,status)&order=created_at.desc,item_id.desc`;
        const typeFilter = url.searchParams.get("type") || url.searchParams.get("media_type");
        if (typeFilter && ["comic", "video", "gallery", "game"].includes(typeFilter)) {
          favQueryUrl += `&items.media_type=eq.${typeFilter}`;
        }

        let favRes = await fetch(favQueryUrl, { headers: authHeaders });
        // El embed items(...) falla si la FK no está cacheada. Reintento plano.
        if (!favRes.ok) {
          const plainUrl = `${SUPABASE_URL}/rest/v1/favorites?user_id=eq.${user.id}&select=item_id,created_at&order=created_at.desc,item_id.desc`;
          favRes = await fetch(plainUrl, { headers: authHeaders });
        }

        if (!favRes.ok) {
          return new Response(JSON.stringify({
            items: [],
            total: 0,
            page,
            pageSize,
            totalPages: 1,
            degraded: true,
            error: "No se pudo leer la bóveda"
          }), {
            status: 200,
            headers: getPersonalHeaders(origin, newToken)
          });
        }

        let total = 0;
        const cr = favRes.headers.get("content-range") || "";
        const slashIdx = cr.indexOf("/");
        if (slashIdx !== -1) {
          const totalPart = cr.substring(slashIdx + 1);
          if (totalPart && totalPart !== "*") {
            total = parseInt(totalPart, 10) || 0;
          }
        }

        const rawRows = await favRes.json().catch(() => []);
        const items = await Promise.all((rawRows || []).map(async (r) => {
          const it = r.items || {};
          const isAvailable = !it.id || it.status !== "blocked";
          const coverUrl = it.cover_url || "";
          let maskedCover = "";
          try {
            maskedCover = coverUrl ? await encodeToken(coverUrl, it.url || "") : "";
          } catch (e) {
            maskedCover = "";
          }
          return {
            id: it.id || r.item_id,
            item_id: r.item_id,
            title: isAvailable ? (it.title || "Guardado") : "Contenido no disponible",
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

        const userMetaFavs = Array.isArray(user.user_metadata?.custom_favorites) ? user.user_metadata.custom_favorites : [];
        let finalItems = [...items];
        if (userMetaFavs.length > 0) {
          const seen = new Set(finalItems.map(it => (it.source && it.source_id) ? `${it.source}:${it.source_id}` : String(it.id)));
          for (const cf of userMetaFavs) {
            const k = (cf.source && cf.source_id) ? `${cf.source}:${cf.source_id}` : String(cf.id);
            if (!seen.has(k)) {
              seen.add(k);
              finalItems.push(cf);
            }
          }
        }

        const finalTotal = Math.max(total, finalItems.length);
        const totalPages = Math.max(1, Math.ceil(finalTotal / pageSize));
        return new Response(JSON.stringify({ items: finalItems, total: finalTotal, page, pageSize, totalPages }), {
          status: 200,
          headers: getPersonalHeaders(origin, newToken)
        });
      } catch (favErr) {
        return new Response(JSON.stringify({
          items: [],
          total: 0,
          page,
          pageSize,
          totalPages: 1,
          degraded: true,
          error: "No se pudo leer la bóveda"
        }), {
          status: 200,
          headers: getPersonalHeaders(origin, newToken)
        });
      }
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
                "Authorization": `Bearer ${token || SUPABASE_ANON_KEY || SUPABASE_KEY}`,
                "Content-Type": "application/json",
                "Prefer": "resolution=ignore-duplicates"
              },
              body: JSON.stringify(rows)
            }).catch(() => {});
          }

          // Guardar también cualquier ítem con ID no entero o externo en custom_favorites
          const customItems = body.items.filter((it) => {
            const num = parseInt(it.id || it.item_id, 10);
            return !Number.isInteger(num) || num <= 0 || isNaN(num);
          });
          if (customItems.length > 0) {
            const currentMeta = user.user_metadata || {};
            const existingCustom = Array.isArray(currentMeta.custom_favorites) ? [...currentMeta.custom_favorites] : [];
            for (const ci of customItems.slice(0, 50)) {
              const k = (ci.source && ci.source_id) ? `${ci.source}:${ci.source_id}` : String(ci.id || "");
              if (!existingCustom.some(ex => ((ex.source && ex.source_id) ? `${ex.source}:${ex.source_id}` : String(ex.id)) === k)) {
                existingCustom.unshift({
                  id: ci.id || ci.source_id || `custom_${Date.now()}`,
                  item_id: ci.id || ci.source_id,
                  source: ci.source || "external",
                  source_id: String(ci.source_id || ci.id || ""),
                  title: ci.title || "Contenido guardado",
                  cover_url: ci.cover_url || "/velvet_logo.png",
                  url: ci.url || "",
                  media_type: ci.media_type || "video",
                  created_at: ci.created_at || new Date().toISOString(),
                  available: true
                });
              }
            }
            if (existingCustom.length > 100) existingCustom.length = 100;
            await updateUserMetadata(user.id, { ...currentMeta, custom_favorites: existingCustom }, SUPABASE_URL, SUPABASE_ADMIN_KEY);
          }

          return new Response(JSON.stringify({ ok: true, synced: validIds.length + customItems.length }), {
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
              headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${token || SUPABASE_ANON_KEY || SUPABASE_KEY}` }
            });
          }
          // Limpiar también de custom_favorites
          const currentMeta = user.user_metadata || {};
          if (Array.isArray(currentMeta.custom_favorites)) {
            const updatedCustom = currentMeta.custom_favorites.filter(cf =>
              String(cf.id) !== String(body.id) && String(cf.source_id) !== String(body.source_id || body.id)
            );
            if (updatedCustom.length !== currentMeta.custom_favorites.length) {
              await updateUserMetadata(user.id, { ...currentMeta, custom_favorites: updatedCustom }, SUPABASE_URL, SUPABASE_ADMIN_KEY);
            }
          }
          return new Response(JSON.stringify({ ok: true, removed: true }), {
            status: 200,
            headers: getPersonalHeaders(origin, newToken)
          });
        }

        // Caso C: Agregar favorito individual (idempotente con ignore-duplicates)
        let targetItemId = parseInt(body.id || body.item_id, 10);

        // Si no es un entero directo pero tiene source y source_id, intentar resolverlo desde la tabla items
        if ((!Number.isInteger(targetItemId) || targetItemId <= 0 || isNaN(targetItemId)) && body.source && body.source_id) {
          try {
            const lookupRes = await fetch(`${SUPABASE_URL}/rest/v1/items?source=eq.${encodeURIComponent(body.source)}&source_id=eq.${encodeURIComponent(body.source_id)}&select=id&limit=1`, {
              headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${token || SUPABASE_ANON_KEY || SUPABASE_KEY}` }
            });
            if (lookupRes.ok) {
              const rows = await lookupRes.json();
              if (rows && rows.length > 0 && rows[0].id) {
                targetItemId = rows[0].id;
              }
            }
          } catch (e) {}
        }

        // Si tenemos un item_id entero válido para la tabla SQL
        if (Number.isInteger(targetItemId) && targetItemId > 0) {
          await fetch(`${SUPABASE_URL}/rest/v1/favorites`, {
            method: "POST",
            headers: {
              "apikey": SUPABASE_KEY,
              "Authorization": `Bearer ${token || SUPABASE_ANON_KEY || SUPABASE_KEY}`,
              "Content-Type": "application/json",
              "Prefer": "resolution=ignore-duplicates"
            },
            body: JSON.stringify({ user_id: user.id, item_id: targetItemId })
          });

          return new Response(JSON.stringify({ ok: true, success: true, item_id: targetItemId }), {
            status: 200,
            headers: getPersonalHeaders(origin, newToken)
          });
        }

        // Si es un contenido dinámico/externo (ej: pmvhaven, juegos u otros sin registro SQL)
        if (body.source || body.source_id || body.title || body.id) {
          const currentMeta = user.user_metadata || {};
          const customFavs = Array.isArray(currentMeta.custom_favorites) ? [...currentMeta.custom_favorites] : [];
          const customEntry = {
            id: body.id || body.source_id || `custom_${Date.now()}`,
            item_id: body.id || body.source_id,
            source: body.source || "external",
            source_id: String(body.source_id || body.id || ""),
            title: body.title || "Contenido guardado",
            cover_url: body.cover_url || "/velvet_logo.png",
            url: body.url || "",
            media_type: body.media_type || "video",
            created_at: new Date().toISOString(),
            available: true
          };

          const existingIdx = customFavs.findIndex(cf =>
            (cf.source === customEntry.source && String(cf.source_id) === String(customEntry.source_id)) ||
            (cf.id && String(cf.id) === String(customEntry.id))
          );
          if (existingIdx >= 0) {
            customFavs[existingIdx] = { ...customFavs[existingIdx], ...customEntry };
          } else {
            customFavs.unshift(customEntry);
          }

          if (customFavs.length > 100) customFavs.length = 100;
          await updateUserMetadata(user.id, { ...currentMeta, custom_favorites: customFavs }, SUPABASE_URL, SUPABASE_ADMIN_KEY);

          return new Response(JSON.stringify({ ok: true, success: true, item_id: customEntry.id, is_custom: true }), {
            status: 200,
            headers: getPersonalHeaders(origin, newToken)
          });
        }

        return new Response(JSON.stringify({ error: "Datos de ítem incompletos para favorito" }), {
          status: 400,
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

      const parts = url.pathname.split("/").filter(Boolean);
      const lastPart = parts[parts.length - 1];
      const secondLastPart = parts.length >= 4 ? parts[parts.length - 2] : null;

      let targetId = parseInt(url.searchParams.get("id") || url.searchParams.get("item_id"), 10);
      if (!targetId || isNaN(targetId)) {
        if (/^\d+$/.test(lastPart)) targetId = parseInt(lastPart, 10);
      }

      // Si tenemos un targetId entero válido, borrar de SQL
      if (Number.isInteger(targetId) && targetId > 0) {
        await fetch(`${SUPABASE_URL}/rest/v1/favorites?user_id=eq.${user.id}&item_id=eq.${targetId}`, {
          method: "DELETE",
          headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${token || SUPABASE_ANON_KEY || SUPABASE_KEY}` }
        });
      }

      // Remover también de custom_favorites en metadata si existe
      const currentMeta = user.user_metadata || {};
      if (Array.isArray(currentMeta.custom_favorites) && currentMeta.custom_favorites.length > 0) {
        const updatedCustom = currentMeta.custom_favorites.filter(cf => {
          if (targetId && String(cf.id) === String(targetId)) return false;
          if (lastPart && (String(cf.id) === String(lastPart) || String(cf.source_id) === String(lastPart))) return false;
          if (secondLastPart && cf.source === secondLastPart && String(cf.source_id) === String(lastPart)) return false;
          return true;
        });
        if (updatedCustom.length !== currentMeta.custom_favorites.length) {
          await updateUserMetadata(user.id, { ...currentMeta, custom_favorites: updatedCustom }, SUPABASE_URL, SUPABASE_ADMIN_KEY);
        }
      }

      return new Response(JSON.stringify({ ok: true, success: true, deleted: lastPart || targetId }), {
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
    const { user, token, newToken, unavailable } = await resolveAuthUser(context.request, SUPABASE_URL, SUPABASE_KEY);
    if (unavailable) {
      return new Response(JSON.stringify({ error: "Servicio de sesión no disponible" }), {
        status: 503,
        headers: getPersonalHeaders(origin)
      });
    }
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
          "Authorization": `Bearer ${token || SUPABASE_ANON_KEY || SUPABASE_KEY}`,
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
                  "Authorization": `Bearer ${token || SUPABASE_ANON_KEY || SUPABASE_KEY}`,
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
              "Authorization": `Bearer ${token || SUPABASE_ANON_KEY || SUPABASE_KEY}`,
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
          headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${token || SUPABASE_ANON_KEY || SUPABASE_KEY}` }
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
        headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${token || SUPABASE_ANON_KEY || SUPABASE_KEY}` }
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
    const { user, token, newToken, unavailable } = await resolveAuthUser(context.request, SUPABASE_URL, SUPABASE_KEY);
    if (unavailable) {
      return new Response(JSON.stringify({ error: "Servicio de sesión no disponible" }), {
        status: 503,
        headers: getPersonalHeaders(origin)
      });
    }
    if (!user) {
      return new Response(JSON.stringify({ error: "No autenticado" }), {
        status: 401,
        headers: getPersonalHeaders(origin)
      });
    }

    if (method === "GET") {
      const prefRes = await fetch(`${SUPABASE_URL}/rest/v1/user_preferences?user_id=eq.${user.id}&select=data,version,updated_at&limit=1`, {
        headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${token || SUPABASE_ANON_KEY || SUPABASE_KEY}` }
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
          "Authorization": `Bearer ${token || SUPABASE_ANON_KEY || SUPABASE_KEY}`,
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
          headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${token || SUPABASE_ANON_KEY || SUPABASE_KEY}`, "Prefer": "count=exact", "Range": "0-0" }
        }),
        fetch(`${SUPABASE_URL}/rest/v1/user_history?user_id=eq.${user.id}&select=id`, {
          headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${token || SUPABASE_ANON_KEY || SUPABASE_KEY}`, "Prefer": "count=exact", "Range": "0-0" }
        }),
        fetch(`${SUPABASE_URL}/rest/v1/user_preferences?user_id=eq.${user.id}&select=updated_at&limit=1`, {
          headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${token || SUPABASE_ANON_KEY || SUPABASE_KEY}` }
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
  // 12. GUARDADO Y SINCRONIZACIÓN DE JUEGOS EN LA NUBE (/api/user/game-saves)
  // Arquitectura Cross-DB: Respaldo en DB1 (Cuentas) referenciando catálogo DB2
  // =========================================================================
  if (url.pathname === "/api/user/game-saves" || url.pathname.startsWith("/api/user/game-saves/")) {
    const { user, token, newToken, unavailable } = await resolveAuthUser(context.request, SUPABASE_URL, SUPABASE_KEY);
    if (unavailable) {
      return new Response(JSON.stringify({ error: "Servicio de sesión no disponible", authenticated: false }), {
        status: 503,
        headers: getPersonalHeaders(origin)
      });
    }
    if (!user) {
      return new Response(JSON.stringify({ error: "No autenticado para sincronización en la nube", authenticated: false }), {
        status: 401,
        headers: getPersonalHeaders(origin)
      });
    }

    const gameId = url.searchParams.get("game_id") || url.pathname.replace(/^\/api\/user\/game-saves\/?/, "").trim();

    // --- GET /api/user/game-saves ---
    if (method === "GET") {
      let queryUrl = `${SUPABASE_URL}/rest/v1/game_saves?user_id=eq.${user.id}&order=updated_at.desc`;
      if (gameId) {
        queryUrl += `&game_id=eq.${encodeURIComponent(gameId)}`;
      }

      let savesRes = await fetch(queryUrl, {
        headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${token || SUPABASE_ANON_KEY || SUPABASE_KEY}` }
      });

      if (savesRes.ok) {
        const rows = await savesRes.json().catch(() => []);
        return new Response(JSON.stringify({ authenticated: true, saves: rows || [] }), {
          status: 200,
          headers: getPersonalHeaders(origin, newToken)
        });
      }

      // Fallback transparente a user_preferences si la tabla game_saves aún no fue migrada en DB1
      const prefRes = await fetch(`${SUPABASE_URL}/rest/v1/user_preferences?user_id=eq.${user.id}&select=data&limit=1`, {
        headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${token || SUPABASE_ANON_KEY || SUPABASE_KEY}` }
      });
      const prefData = prefRes.ok ? await prefRes.json().catch(() => []) : [];
      const userPrefs = (prefData && prefData[0] && prefData[0].data) || {};
      const gameSavesStore = userPrefs.game_saves || {};
      let savesList = [];

      if (gameId) {
        const gameSlots = gameSavesStore[gameId] || {};
        savesList = Object.values(gameSlots);
      } else {
        Object.keys(gameSavesStore).forEach(gId => {
          savesList.push(...Object.values(gameSavesStore[gId] || {}));
        });
      }

      return new Response(JSON.stringify({ authenticated: true, saves: savesList }), {
        status: 200,
        headers: getPersonalHeaders(origin, newToken)
      });
    }

    // --- POST /api/user/game-saves ---
    if (method === "POST" || method === "PUT") {
      if (!checkPersonalWriteRateLimit(user.id, 60)) {
        return new Response(JSON.stringify({ error: "Límite de peticiones de guardado excedido" }), {
          status: 429,
          headers: getPersonalHeaders(origin, newToken)
        });
      }

      const body = await context.request.json().catch(() => ({}));
      const targetGameId = String(body.game_id || gameId || "").trim();
      if (!targetGameId) {
        return new Response(JSON.stringify({ error: "game_id requerido" }), {
          status: 400,
          headers: getPersonalHeaders(origin, newToken)
        });
      }

      const slotName = String(body.slot_name || "auto").trim().slice(0, 32);
      const saveData = String(body.save_data || "");
      const gameTitle = String(body.game_title || "").slice(0, 200);
      const coverUrl = String(body.cover_url || "").slice(0, 500);
      const gameType = String(body.game_type || "html5").slice(0, 20);
      const playTime = Math.max(0, parseInt(body.play_time || 0, 10));
      const clientTimestamp = Date.now();
      const nowIso = new Date().toISOString();

      const savePayload = {
        user_id: user.id,
        game_id: targetGameId,
        slot_name: slotName,
        save_data: saveData,
        game_title: gameTitle,
        cover_url: coverUrl,
        game_type: gameType,
        play_time: playTime,
        updated_at: nowIso,
        client_timestamp: clientTimestamp
      };

      // Intentar guardar en tabla dedicada public.game_saves de DB1
      const dbSaveRes = await fetch(`${SUPABASE_URL}/rest/v1/game_saves`, {
        method: "POST",
        headers: {
          "apikey": SUPABASE_KEY,
          "Authorization": `Bearer ${token || SUPABASE_ANON_KEY || SUPABASE_KEY}`,
          "Content-Type": "application/json",
          "Prefer": "resolution=merge-duplicates"
        },
        body: JSON.stringify(savePayload)
      });

      if (!dbSaveRes.ok) {
        // Fallback a user_preferences en DB1
        const prefRes = await fetch(`${SUPABASE_URL}/rest/v1/user_preferences?user_id=eq.${user.id}&select=data&limit=1`, {
          headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${token || SUPABASE_ANON_KEY || SUPABASE_KEY}` }
        });
        const prefData = prefRes.ok ? await prefRes.json().catch(() => []) : [];
        const currentData = (prefData && prefData[0] && prefData[0].data) || {};
        const gameSavesStore = currentData.game_saves || {};
        gameSavesStore[targetGameId] = gameSavesStore[targetGameId] || {};
        gameSavesStore[targetGameId][slotName] = savePayload;
        currentData.game_saves = gameSavesStore;

        await fetch(`${SUPABASE_URL}/rest/v1/user_preferences`, {
          method: "POST",
          headers: {
            "apikey": SUPABASE_KEY,
            "Authorization": `Bearer ${token || SUPABASE_ANON_KEY || SUPABASE_KEY}`,
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates"
          },
          body: JSON.stringify({
            user_id: user.id,
            data: currentData,
            version: 2,
            updated_at: nowIso
          })
        });
      }

      return new Response(JSON.stringify({ ok: true, success: true, save: savePayload }), {
        status: 200,
        headers: getPersonalHeaders(origin, newToken)
      });
    }

    // --- DELETE /api/user/game-saves ---
    if (method === "DELETE") {
      const targetGameId = String(gameId || url.searchParams.get("game_id") || "").trim();
      const slotName = url.searchParams.get("slot_name");

      if (targetGameId) {
        let delUrl = `${SUPABASE_URL}/rest/v1/game_saves?user_id=eq.${user.id}&game_id=eq.${encodeURIComponent(targetGameId)}`;
        if (slotName) delUrl += `&slot_name=eq.${encodeURIComponent(slotName)}`;
        await fetch(delUrl, {
          method: "DELETE",
          headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${token || SUPABASE_ANON_KEY || SUPABASE_KEY}` }
        });
      }

      return new Response(JSON.stringify({ ok: true, success: true }), {
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

  // =========================================================================
  // 13. PERFIL DE USUARIO Y CAMBIO DE CONTRASEÑA (/api/user/profile & /api/user/change-password)
  // =========================================================================
  if (url.pathname === "/api/user/profile" && (method === "POST" || method === "PUT")) {
    const { user, token, newToken, unavailable } = await resolveAuthUser(context.request, SUPABASE_URL, SUPABASE_KEY);
    if (unavailable) {
      return new Response(JSON.stringify({ error: "Servicio de sesión no disponible" }), {
        status: 503,
        headers: getPersonalHeaders(origin)
      });
    }
    if (!user || !token) {
      return new Response(JSON.stringify({ error: "No autenticado" }), {
        status: 401,
        headers: getPersonalHeaders(origin)
      });
    }

    const body = await context.request.json().catch(() => ({}));
    const username = String(body.username || "").trim().slice(0, 50);
    const avatar = String(body.avatar || "crown").slice(0, 30);
    const avatarBg = String(body.avatarBg || "from-pink-600 to-purple-600").slice(0, 80);

    const userMetadata = { ...(user.user_metadata || {}) };
    if (username) userMetadata.username = username;
    userMetadata.avatar = avatar;
    userMetadata.avatarBg = avatarBg;

    // Actualizar metadata en Supabase Auth
    await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      method: "PUT",
      headers: {
        "apikey": SUPABASE_KEY,
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ data: userMetadata })
    });

    // Actualizar username en profiles si existe la tabla
    if (username) {
      await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}`, {
        method: "PATCH",
        headers: {
          "apikey": SUPABASE_KEY,
          "Authorization": `Bearer ${token || SUPABASE_ANON_KEY || SUPABASE_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ username, updated_at: new Date().toISOString() })
      }).catch(() => {});
    }

    return new Response(JSON.stringify({
      ok: true,
      success: true,
      user: {
        id: user.id,
        email: user.email,
        username: userMetadata.username || username || user.email.split("@")[0],
        avatar: userMetadata.avatar,
        avatarBg: userMetadata.avatarBg
      }
    }), {
      status: 200,
      headers: getPersonalHeaders(origin, newToken)
    });
  }

  if (url.pathname === "/api/user/change-password" && method === "POST") {
    const { user, token, newToken, unavailable } = await resolveAuthUser(context.request, SUPABASE_URL, SUPABASE_KEY);
    if (unavailable) {
      return new Response(JSON.stringify({ error: "Servicio de sesión no disponible" }), {
        status: 503,
        headers: getPersonalHeaders(origin)
      });
    }
    if (!user || !token) {
      return new Response(JSON.stringify({ error: "No autenticado" }), {
        status: 401,
        headers: getPersonalHeaders(origin)
      });
    }

    const body = await context.request.json().catch(() => ({}));
    const newPassword = String(body.new_password || "");
    if (!newPassword || newPassword.length < 6) {
      return new Response(JSON.stringify({ error: "La nueva contraseña debe tener al menos 6 caracteres" }), {
        status: 400,
        headers: getPersonalHeaders(origin, newToken)
      });
    }

    const upRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      method: "PUT",
      headers: {
        "apikey": SUPABASE_KEY,
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ password: newPassword })
    });

    if (!upRes.ok) {
      const upErr = await upRes.json().catch(() => ({}));
      return new Response(JSON.stringify({ error: upErr.msg || upErr.message || "Error al actualizar contraseña" }), {
        status: 400,
        headers: getPersonalHeaders(origin, newToken)
      });
    }

    return new Response(JSON.stringify({ ok: true, success: true, message: "Contraseña actualizada exitosamente" }), {
      status: 200,
      headers: getPersonalHeaders(origin, newToken)
    });
  }

  // Ruta API no encontrada
  return new Response(JSON.stringify({ error: "Endpoint no encontrado en Velvet Cloudflare API", path: url.pathname }), {
    status: 404,
    headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
  });
}
