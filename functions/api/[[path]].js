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

// Extracción determinista de URLs upstream raw desde tokens anidados o URLs directas
function extractRawMediaUrl(urlOrToken) {
  if (!urlOrToken || typeof urlOrToken !== "string") return "";
  let current = urlOrToken.trim();
  let depth = 5;
  while (depth-- > 0) {
    if (current.includes("?t=") || current.includes("&t=")) {
      const match = current.match(/[?&]t=([^&]+)/);
      current = match ? decodeURIComponent(match[1]) : "";
    }
    if (current.includes(".")) {
      const b64 = current.split(".")[0];
      try {
        const payloadStr = fromBase64Url(b64);
        const parsed = JSON.parse(payloadStr);
        if (parsed && parsed.u) {
          current = parsed.u;
          continue;
        }
      } catch (e) {}
    }
    break;
  }
  if (/^https?:\/\//i.test(current)) {
    return current;
  }
  return "";
}

// Clave activa inyectada en runtime por onRequest
let _activeMediaSecret = "";
let _activeSupabaseUrl = "";
let _activeSupabaseKey = "";
let _activeSupabaseServiceKey = "";

// Paginación real de datos personales desde PostgreSQL (única fuente de verdad: máx 18 PC / 12 Android)
const PERSONAL_PAGE_SIZE = 18;

function resolvePersonalPageSize(request, url) {
  const raw = url.searchParams.get("pageSize");
  if (raw != null && raw !== "") {
    return Math.min(50, Math.max(1, parseInt(raw, 10) || PERSONAL_PAGE_SIZE));
  }
  const ua = request && request.headers ? (request.headers.get("User-Agent") || "") : "";
  return /Android/i.test(ua) ? 12 : PERSONAL_PAGE_SIZE;
}

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
      const rawUpstream = extractRawMediaUrl(payload.u);
      if (rawUpstream) {
        payload.u = rawUpstream;
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
      "anyporn.com",
      "porntubeai.com",
      "gamcore.com",
      "serverable.com",
      "supabase.co",
      "supabase.in",
      "morbohub.pages.dev",
      "cloudflare.com",
      "reddit.tube",
      "reddvideo.tube",
      "redd.it",
      "kiwi99.space",
      "xxxfollow.com",
      "xfollow.com",
      "nekyda.com",
      "nsfwswipe.com",
      "waptap.com",
      "onlytik.com"
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

function normalizeUpstreamUrl(raw) {
  let u = String(raw || "").trim().replace(/&amp;/g, "&");
  if (!u) return "";
  if (u.startsWith("//")) u = "https:" + u;
  if (!/^https?:\/\//i.test(u)) return "";
  try {
    const parsed = new URL(u);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    if (!parsed.hostname) return "";
    return parsed.href;
  } catch (e) {
    return u;
  }
}

function inferUpstreamReferer(targetMediaUrl, payloadReferer) {
  const given = String(payloadReferer || "").trim();
  if (given) return given;
  const target = String(targetMediaUrl || "");
  if (target.includes("buondua") || target.includes("imagedeliveries")) return "https://buondua.com/";
  if (target.includes("xasiat") || target.includes("xascdn")) return "https://xasiat.com/";
  if (target.includes("4khd")) return "https://4khd.com/";
  if (target.includes("hentaipaw")) return "https://hentaipaw.com/";
  if (target.includes("pmvhaven") || target.includes("ovh.net")) return "https://pmvhaven.com/";
  if (target.includes("pornone")) return "https://pornone.com/";
  if (target.includes("redporn")) return "https://redporn.porn/";
  if (target.includes("anyporn")) return "https://anyporn.com/";
  if (target.includes("damplips")) return "https://www.damplips.com/";
  if (target.includes("alotporn")) return "https://www.alotporn.com/";
  if (target.includes("pornhd")) return "https://pornhd.pet/";
  if (target.includes("gamcore") || target.includes("serverable")) return "https://gamcore.com/";
  if (target.includes("artgravia")) return "https://artgravia.com/";
  if (target.includes("pixibb")) return "https://pixibb.com/";
  try {
    return new URL(target).origin + "/";
  } catch (e) {
    return target;
  }
}

function refererOrigin(referer) {
  try {
    return new URL(referer).origin;
  } catch (e) {
    return "";
  }
}

// Image Resizing de Cloudflare pide el origen por su cuenta y no reenvía
// Referer. Los CDN de galerías (buondua, 4khd, xasiat, imagedeliveries)
// contestan 403 y la tarjeta cae en el placeholder de Play.
function hostRejectsImageResize(targetUrl) {
  return /buondua|imagedeliveries|xasiat|xascdn|4khd|artgravia|pixibb|leakgallery/i.test(String(targetUrl || ""));
}

function alternateCoverUrls(coverUrl) {
  const primary = normalizeUpstreamUrl(coverUrl);
  if (!primary) return [];
  const out = [];
  const add = (candidate) => {
    const n = normalizeUpstreamUrl(candidate);
    if (!n || n === primary || out.indexOf(n) !== -1) return;
    out.push(n);
  };
  add(primary.replace(/-\d{2,4}x\d{2,4}(?=\.(?:jpe?g|png|webp|gif)(?:\?|#|$))/i, ""));
  add(primary.replace(/\/thumb\.(jpe?g|png|webp|gif)(?=\?|#|$)/i, "/1.$1"));
  add(primary.replace(/\/thumbnails\/(?:cover|thumb|0)\.(webp|jpe?g|png)(?=\?|#|$)/i, "/thumbnails/1.$1"));
  if (/buondua/i.test(primary) && /\.gif(?=\?|#|$)/i.test(primary)) {
    add(primary.replace(/\.gif(?=\?|#|$)/i, ".jpeg"));
  }
  return out.slice(0, 2);
}

function hostnameEndsWith(hostname, suffix) {
  const host = String(hostname || "").toLowerCase();
  const tail = String(suffix || "").toLowerCase();
  return !!tail && (host === tail || host.endsWith("." + tail));
}

// El <video> pide el archivo con referrerpolicy=no-referrer. Este CDN
// responde 206 sin Referer. Retransmitirlo por el Worker hace que Cloudflare
// ignore Range y entregue el mp4 completo.
function directVideoRedirectUrl(targetUrl) {
  let parsed;
  try { parsed = new URL(String(targetUrl || "")); } catch (e) { return ""; }
  if (parsed.protocol !== "https:") return "";
  const path = parsed.pathname.toLowerCase();
  if (path.includes(".m3u8") || path.endsWith(".ts")) return "";
  const isFile = path.endsWith(".mp4") || path.endsWith(".m4v") || path.endsWith(".webm");
  if (!isFile) return "";
  if (!hostnameEndsWith(parsed.hostname.toLowerCase(), "ovh.net")) return "";
  return parsed.href;
}

// www.xasiat.com/get_image/.../sources/{carpeta}/{album}/... responde 403
// (challenge de Cloudflare) al worker. La portada del álbum en xascdn no.
function xasiatAlbumPreview(targetUrl) {
  const raw = String(targetUrl || "");
  if (!/xasiat\.com/i.test(raw)) return "";
  const match = raw.match(/\/sources\/(\d+)\/(\d+)\//i);
  if (!match) return "";
  return `https://pic.xascdn.li/contents/albums/preview/380x507/${match[1]}/${match[2]}/preview.jpg`;
}

// Para páginas individuales de galerías xasiat, cada foto tiene su miniatura
// correspondiente en el CDN de xascdn (evita repetir la portada del álbum en el lector).
function xasiatPhotoThumbnail(targetUrl) {
  const raw = String(targetUrl || "");
  if (!/xasiat\.com/i.test(raw)) return "";
  const match = raw.match(/\/sources\/(\d+)\/(\d+)\/(\d+)\.jpg/i);
  if (!match) return "";
  return `https://pic.xascdn.li/contents/albums/main/200x150/${match[1]}/${match[2]}/${match[3]}.jpg`;
}

// cdn.buondua.com/{host-real}/ruta también cae en el challenge. El archivo
// está en el host que va embebido en la ruta (pok.misskon.com, etc.).
function unwrapBuonduaEmbed(targetUrl) {
  const match = String(targetUrl || "").match(/^https?:\/\/cdn\.buondua\.com\/([a-z0-9.-]+\.[a-z]{2,})(\/[^?#]*)/i);
  if (!match) return "";
  const embedded = match[1].toLowerCase();
  if (hostnameEndsWith(embedded, "buondua.com")) return "";
  return `https://${embedded}${match[2]}`;
}

// i2.buondua.com y pic.4khd.com bloquean al worker o redirigen fuera de la
// lista. Photon (i0.wp.com) sí entrega esos archivos y comprime portadas.
function photonCoverUrl(targetUrl, thumbWidth = 0) {
  let parsed;
  try { parsed = new URL(String(targetUrl || "")); } catch (e) { return ""; }
  const host = parsed.hostname.toLowerCase();
  if (!hostnameEndsWith(host, "buondua.com") && !hostnameEndsWith(host, "4khd.com")) return "";
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
  const wNum = Number(thumbWidth) || 0;
  if (wNum > 0) {
    const clampedW = Math.min(720, Math.max(320, Math.round(wNum)));
    return `https://i0.wp.com/${host}${parsed.pathname}?ssl=1&w=${clampedW}&quality=78`;
  }
  return `https://i0.wp.com/${host}${parsed.pathname}?ssl=1`;
}

function galleryFetchPlan(targetUrl, targetWidth) {
  const primary = normalizeUpstreamUrl(targetUrl);
  if (!primary) return [];
  const ordered = [];
  const add = (candidate) => {
    const next = normalizeUpstreamUrl(candidate);
    if (!next || ordered.indexOf(next) !== -1) return;
    ordered.push(next);
  };
  const parsedW = targetWidth !== undefined ? Number(targetWidth) : 420;
  const isThumbnail = parsedW > 0;
  const thumbW = isThumbnail ? Math.min(720, Math.max(360, parsedW)) : 0;

  if (isThumbnail) {
    add(xasiatAlbumPreview(primary));
  }
  add(unwrapBuonduaEmbed(primary));
  let host = "";
  try { host = new URL(primary).hostname.toLowerCase(); } catch (e) { host = ""; }
  if (hostnameEndsWith(host, "buondua.com")) add(photonCoverUrl(primary, thumbW));
  add(primary);
  if (!isThumbnail) {
    add(xasiatPhotoThumbnail(primary));
    add(xasiatAlbumPreview(primary));
  }
  if (hostnameEndsWith(host, "4khd.com")) add(photonCoverUrl(primary, thumbW));
  return ordered;
}

function isGalleryFallbackUrl(urlStr) {
  try {
    const parsed = new URL(urlStr);
    if (parsed.protocol !== "https:") return false;
    const host = parsed.hostname.toLowerCase();
    if (host === "pic.xascdn.li" && (parsed.pathname.includes("/contents/albums/preview/") || parsed.pathname.includes("/contents/albums/main/"))) return true;
    if (host === "pok.misskon.com" && parsed.pathname.startsWith("/images/")) return true;
    if (host === "i0.wp.com") {
      const embedded = parsed.pathname.replace(/^\//, "").split("/")[0].toLowerCase();
      return hostnameEndsWith(embedded, "buondua.com") || hostnameEndsWith(embedded, "4khd.com");
    }
    return false;
  } catch (e) {
    return false;
  }
}

function isFollowableMediaRedirect(nextUrl, fromUrl) {
  if (isSafeUpstreamUrl(nextUrl) || isGalleryFallbackUrl(nextUrl)) return true;
  try {
    const nextHost = new URL(nextUrl).hostname.toLowerCase();
    const fromHost = new URL(fromUrl).hostname.toLowerCase();
    const googleCdn = hostnameEndsWith(nextHost, "googleusercontent.com") || hostnameEndsWith(nextHost, "ggpht.com");
    const fromGallery = hostnameEndsWith(fromHost, "4khd.com")
      || hostnameEndsWith(fromHost, "googleusercontent.com")
      || hostnameEndsWith(fromHost, "ggpht.com");
    return googleCdn && fromGallery;
  } catch (e) {
    return false;
  }
}

function upstreamLooksLikeImage(res) {
  if (!res || !res.ok) return false;
  const ctype = (res.headers.get("content-type") || "").toLowerCase();
  if (ctype.includes("text/html") || ctype.includes("application/json") || ctype.includes("text/plain")) return false;
  return ctype.includes("image/") || ctype.includes("octet-stream") || ctype === "";
}

async function maskCoverFields(rawCover, secret) {
  const primary = normalizeUpstreamUrl(rawCover);
  if (!primary || !secret) return { cover_url: "", cover_fallback: "" };
  const token = await encodeMediaToken(primary, inferUpstreamReferer(primary, ""), secret);
  let cover_fallback = "";
  const alts = alternateCoverUrls(primary);
  if (alts[0]) {
    const altToken = await encodeMediaToken(alts[0], inferUpstreamReferer(alts[0], ""), secret);
    if (altToken) cover_fallback = `/api/media?t=${altToken}`;
  }
  return {
    cover_url: token ? `/api/media?t=${token}` : "",
    cover_fallback
  };
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

const DETAIL_SOURCE_ALIAS_MAP = {
  mv: "pmvhaven",
  mx: "xasiat",
  mb: "buondua",
  m4: "4khd",
  mc: "3hentai",
  mp: "hentaipaw",
  md: "doujins",
  mg: "gamcore",
  ml: "leakgallery"
};

const EXTERNAL_SITE_LEAK_RE = /\b(?:xasiat|xascdn|buondua|misskon|4khd|imagedeliveries|pmvhaven|3hentai|hentaipaw|doujins|comics18(?:_net|_org)?|comicspornoxxx|reycomix|vercomics?porno|cartooncomixhd|pornocomic|sexkomix2?|comicsparaadultos|melapelacomics|melapelocondibujos|mhcomics|leermanhwas|manhwaweb|f95zone|gamcore|leakgallery|pornhd|damplips|pornone|redporn|anyporn|alotporn|nhentai|e-?hentai|exhentai|hitomi|pixibb|cosplaytele|everia|mrcong|pornhub|xvideos|xnxx|xhamster)\b(?:\.[a-z]{2,5})?/gi;

function isWeightOrNoiseTag(tag) {
  const s = String(tag || "").trim();
  if (!s) return true;
  if (EXTERNAL_SITE_LEAK_RE.test(s)) {
    EXTERNAL_SITE_LEAK_RE.lastIndex = 0;
    return true;
  }
  if (/\b(?:peso\s*:?\s*)?\d+(?:[.,]\d+)?\s*(?:kb|mb|gb|tb)\b/i.test(s)) return true;
  if (/^\d+\s*(?:p|pics?|photos?|fotos?|imgs?|videos?)$/i.test(s)) return true;
  if (/^[a-z0-9-]+\.(?:com|net|org|li|cc|me|io|xxx)$/i.test(s)) return true;
  if (/^(?:tg\s*@|t\.me\/|@)/i.test(s)) return true;
  return false;
}

function cleanPublicTitle(rawTitle) {
  const original = String(rawTitle || "").trim();
  if (!original) return "";
  let s = original;
  s = s.replace(/\{[^}]{1,90}\}/g, " ");
  const isDirtyBracketChunk = (inner) => {
    const t = String(inner || "").trim();
    if (/^(?:peso\b|aigirl\b|spanish|espa[nñ]ol|english|eng|raw|digital|complete|completo|uncensored|sin\s*censura|decensored|joselito|joselillo|mtl|rip|scan|ai[\s\-]*translat)/i.test(t)) return true;
    if (/(?:\([^)]+\)\s*)?\b(?:spanish|espa[nñ]ol|english|ai[\s\-]*translat(?:ed|ion)|machine[\s\-]*translat(?:ed|ion)|uncensored|sin\s*censura|decensored|mtl|dokiyuri)\b/i.test(t)) return true;
    if (/\b\d+(?:[.,]\d+)?\s*(?:kb|mb|gb|tb)\b/i.test(t) || /^\d+\s*(?:p|pics?|photos?|fotos?|imgs?|videos?)(?:\s*[+\-–—/]\s*\d+(?:[.,]\d+)?\s*(?:p|pics?|photos?|fotos?|imgs?|kb|mb|gb|tb|videos?))*$/i.test(t)) return true;
    if (EXTERNAL_SITE_LEAK_RE.test(t)) {
      EXTERNAL_SITE_LEAK_RE.lastIndex = 0;
      return true;
    }
    return false;
  };
  s = s.replace(/\[([^\[\]]{1,120})\]/g, (all, inner) => (isDirtyBracketChunk(inner) ? "" : all));
  s = s.replace(/[\(（【]([^\)）】]{1,120})[\)）】]/g, (all, inner) => (isDirtyBracketChunk(inner) ? "" : all));
  s = s.replace(/[\[\(（【][^\]\)）】]*\b\d+(?:[.,]\d+)?\s*(?:kb|mb|gb|tb|p|pics?|photo(?:s)?|fotos?|imgs?|videos?)\b[^\]\)）】]*$/gi, " ");
  s = s.replace(/[\[\(（【]\s*\d+\s*photo[^\])]*$/gi, " ");
  s = s.replace(/\]\s*\d+(?:[.,]\d+)?\s*(?:kb|mb|gb|tb)\b/gi, " ");
  s = s.replace(/\b(?:ai[\s\-]*translat(?:ed|ion)|machine[\s\-]*translat(?:ed|ion)|traducido\s+(?:con|por)\s+ia)\b/gi, " ");
  s = s.replace(/\b(?:peso\s*:?\s*)?\d+(?:[.,]\d+)?\s*(?:kb|mb|gb|tb)\b/gi, " ");
  s = s.replace(/\b\d+\s*(?:pics?|photos?|fotos?|im[aá]genes?|imgs?)\b(?=\s*(?:[\]|)\-–—]|$))/gi, " ");
  s = s.replace(/(?:tg\s*@[^\s\]]+|t\.me\/\S+|https?:\/\/\S+|[a-z0-9-]+\.(?:com|net|org|li|cc|me|io|xxx)\b)/gi, " ");
  s = s.replace(EXTERNAL_SITE_LEAK_RE, " ");
  s = s.replace(/\[([^\[\]]*)$/, " $1").replace(/^([^\[\]]*)\]/, "$1 ");
  s = s.replace(/\s+/g, " ").replace(/^[\s\-–—|:·]+|[\s\-–—|:·]+$/g, "").trim();
  if (s) return s;
  const fallbackClean = original
    .replace(/\{[^}]{1,90}\}/g, " ")
    .replace(/\[([^\[\]]{1,120})\]/g, (all, inner) => (isDirtyBracketChunk(inner) ? " " : all))
    .replace(/\b(?:ai[\s\-]*translat(?:ed|ion)|machine[\s\-]*translat(?:ed|ion)|traducido\s+(?:con|por)\s+ia)\b/gi, " ")
    .replace(/\b\d+(?:[.,]\d+)?\s*(?:kb|mb|gb|tb)\b/gi, " ")
    .replace(/\b\d+\s*(?:pics?|photos?|fotos?|im[aá]genes?|imgs?|videos?)\b/gi, " ")
    .replace(/(?:tg\s*@[^\s\]]+|t\.me\/\S+|https?:\/\/\S+)/gi, " ")
    .replace(EXTERNAL_SITE_LEAK_RE, " ")
    .replace(/[\[\]]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s\-–—|:·]+|[\s\-–—|:·]+$/g, "")
    .trim();
  return fallbackClean;
}

function sanitizePublicTags(tags) {
  if (!Array.isArray(tags)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of tags) {
    const cleaned = String(raw || "").trim();
    if (!cleaned || isWeightOrNoiseTag(cleaned)) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
    if (out.length >= 10) break;
  }
  return out;
}

function sanitizePublicArtists(artists, mediaType) {
  if (mediaType === "game") return Array.isArray(artists) ? artists : [];
  if (mediaType === "gallery" || mediaType === "cosplay") return [];
  if (!Array.isArray(artists)) return [];
  const out = [];
  for (const a of artists) {
    const cleaned = cleanPublicTitle(a);
    if (!cleaned || cleaned.length > 36 || isWeightOrNoiseTag(cleaned)) continue;
    out.push(cleaned);
    if (out.length >= 3) break;
  }
  return out;
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
  const logical = random ? ((safePage - 1) % totalPages) : (safePage - 1);
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
    const offSlots = rowSpan >= take * 2 ? Math.min(48, Math.max(2, Math.floor(rowSpan / take))) : 1;
    let offset = rowStart % total;
    if (offSlots >= 2) {
      const slot = permutePageIndex((page - 1) % offSlots, offSlots, (seed + (i + 1) * 131) >>> 0);
      const subStart = rowStart + Math.floor((slot * rowSpan) / offSlots);
      const subEnd = slot === offSlots - 1 ? (rowEnd - 1) : rowStart + Math.floor(((slot + 1) * rowSpan) / offSlots) - 1;
      const maxOff = Math.max(subStart, subEnd - take + 1);
      offset = (subStart + Math.floor(rng() * Math.max(1, maxOff - subStart + 1))) % total;
    } else {
      const rowJitter = Math.floor(rng() * rowSpan);
      const pageShift = ((page - 1) * take) % rowSpan;
      offset = (rowStart + ((rowJitter + pageShift) % rowSpan)) % total;
    }

    const idStart = minId + Math.floor((i * idSpan) / bands);
    const idEnd = minId + Math.floor(((i + 1) * idSpan) / bands) - 1;
    const idBand = Math.max(1, (idEnd < idStart ? idStart : idEnd) - idStart + 1);
    const idSlots = idBand >= 32 ? Math.min(48, Math.max(4, Math.floor(idBand / Math.max(2, take)))) : (idBand >= 4 ? Math.max(2, Math.floor(idBand / 2)) : 1);
    let anchorId = idStart;
    if (idSlots >= 2) {
      const idSlot = permutePageIndex((page - 1) % idSlots, idSlots, (seed + (i + 1) * 197) >>> 0);
      const subStart = idStart + Math.floor((idSlot * idBand) / idSlots);
      const subEnd = idSlot === idSlots - 1 ? Math.max(idStart, idEnd) : idStart + Math.floor(((idSlot + 1) * idBand) / idSlots) - 1;
      const subSpan = Math.max(1, subEnd - subStart + 1);
      anchorId = subStart + Math.floor(rng() * subSpan);
    } else {
      const idJitter = Math.floor(rng() * idBand);
      const idShift = ((page - 1) * take) % idBand;
      anchorId = idStart + ((idJitter + idShift) % idBand);
    }
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
  const safePage = Math.max(1, Math.floor(Number(page) || 1));
  const baseSeed = Math.abs(Math.floor(Number(seed) || 1)) || 1;
  if (total >= 1600) {
    const lowStart = 600;
    const lowSpan = 200; // [600..799]: fuera del bloque pegajoso < 600 de PMVHaven y siempre < 800
    const lowSlots = 24;
    const lowSlot = permutePageIndex((safePage - 1) % lowSlots, lowSlots, (baseSeed + 131) >>> 0);
    const subStart = lowStart + Math.floor((lowSlot * lowSpan) / lowSlots);
    const subEnd = lowSlot === lowSlots - 1 ? 799 : lowStart + Math.floor(((lowSlot + 1) * lowSpan) / lowSlots) - 1;
    const rng = shuffleRng((baseSeed ^ Math.imul(safePage, 0x9e3779b1)) >>> 0);
    const p0 = Math.min(799, Math.max(lowStart, subStart + Math.floor(rng() * Math.max(1, subEnd - subStart + 1))));
    const highPlan = planShuffleWindows({
      total: Math.max(1, total - 800 + 1),
      minId: 800,
      maxId: total,
      page: safePage,
      pageSize: pageSize || 24,
      seed: baseSeed,
      bands: 4
    });
    const pages = [p0];
    const seen = new Set([p0]);
    for (let i = 1; i < highPlan.windows.length; i++) {
      const p = Math.min(total, Math.max(800, Math.floor(Number(highPlan.windows[i].anchorId) || 800)));
      if (seen.has(p)) continue;
      seen.add(p);
      pages.push(p);
    }
    return pages;
  }
  const plan = planShuffleWindows({
    total,
    minId: 1,
    maxId: total,
    page: safePage,
    pageSize: pageSize || 24,
    seed: baseSeed,
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
  u.searchParams.set("cv", "10");
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

async function verifySupabaseJwtHS256(token, secret) {
  try {
    if (!secret || typeof token !== "string") return null;
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [hdrB64, payB64, sigB64] = parts;
    if (!hdrB64 || !payB64 || !sigB64) return null;
    const header = JSON.parse(fromBase64Url(hdrB64));
    if (!header || header.alg !== "HS256") return null;
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );
    let b64 = sigB64.replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    const sigBin = atob(b64);
    const sigBytes = new Uint8Array(sigBin.length);
    for (let i = 0; i < sigBin.length; i++) sigBytes[i] = sigBin.charCodeAt(i);
    const ok = await crypto.subtle.verify("HMAC", key, sigBytes, enc.encode(`${hdrB64}.${payB64}`));
    if (!ok) return null;
    const payload = JSON.parse(fromBase64Url(payB64));
    if (!payload || typeof payload !== "object" || !payload.sub) return null;
    const nowSec = Math.floor(Date.now() / 1000);
    if (!payload.exp || Number(payload.exp) <= nowSec) return null;
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
  const tagFilter = String((opts && opts.tag) || "").trim().toLowerCase();
  const seed = Number(opts && opts.seed) || 1;
  let list = Array.isArray(games) ? games.slice() : [];
  if (category && category !== "all") list = list.filter(g => gameMatchesCategory(g, category));
  if (tagFilter) {
    list = list.filter(g => {
      const gTags = Array.isArray(g.tags) ? g.tags.map(t => String(t || "").toLowerCase()) : [];
      return gTags.some(t => t === tagFilter || t.includes(tagFilter));
    });
  }
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
  const slice = start >= total ? [] : list.slice(start, start + pageSize);
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
    title: cleanPublicTitle(it.title) || "Juego VIP",
    cover_url: coverToken ? `/api/media?t=${coverToken}` : "",
    media_type: "game",
    tags: sanitizePublicTags(it.tags || []),
    artists: it.engine ? sanitizePublicArtists([it.engine], "game") : [],
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

const VIDEO_CAT_MAP = {
  pmv: ["pmv", "hmv", "music video", "edit", "compilation", "splitscreen"],
  milf: ["milf", "mom", "mature", "stepmom"],
  amateur: ["amateur", "homemade", "real", "verified"],
  anal: ["anal", "anals", "ass", "butt"],
  pov: ["pov"],
  group: ["threesome", "group", "trio", "trios", "gangbang", "foursome"],
  tits: ["big boobs", "big tits", "tits", "boobs", "busty", "tit"],
  blondes: ["blonde", "blondes"],
  brunettes: ["latina", "latinas", "brunette", "brunettes", "spanish"],
  russians: ["russian", "rusas", "russians", "rusia"],
  hd: ["hd", "1080p", "60fps", "4k"]
};

function videoMatchesCategory(v, category) {
  if (!category || category === "all") return true;
  if (Array.isArray(v.categories) && v.categories.includes(category)) return true;
  const terms = VIDEO_CAT_MAP[category] || [category];
  const hay = `${v.title || ""} ${(v.tags || []).join(" ")}`.toLowerCase();
  return terms.some(t => hay.includes(t));
}

function buildVideoCatalogPage(videos, opts) {
  const page = validatePage(opts && opts.page);
  const pageSize = validatePageSize(opts && opts.pageSize, 24);
  const sort = validateSort(opts && opts.sort);
  const q = sanitizeSearchQuery((opts && opts.q) || "");
  const category = sanitizeSlug((opts && opts.category) || "");
  const tagFilter = String((opts && opts.tag) || "").trim().toLowerCase();
  const seed = Number(opts && opts.seed) || 1;
  let list = Array.isArray(videos) ? videos.slice() : [];
  if (category && category !== "all") list = list.filter(v => videoMatchesCategory(v, category));
  if (tagFilter) {
    list = list.filter(v => {
      const vTags = Array.isArray(v.tags) ? v.tags.map(t => String(t || "").toLowerCase()) : [];
      return vTags.some(t => t === tagFilter || t.includes(tagFilter));
    });
  }
  if (q) {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    list = list.filter(v => {
      const hay = `${v.title || ""} ${(v.tags || []).join(" ")} ${(v.artists || []).join(" ")}`.toLowerCase();
      return words.every(w => hay.includes(w));
    });
  }
  if (sort === "random") {
    list = orderCatalogForSlot(list, seed, "video");
  } else if (sort === "views" || sort === "popular") {
    list.sort((a, b) => (b.views || 0) - (a.views || 0) || (Number(b.id) || 0) - (Number(a.id) || 0));
  } else if (sort === "rating") {
    list.sort((a, b) => (b.likes || 0) - (a.likes || 0) || (Number(b.id) || 0) - (Number(a.id) || 0));
  } else {
    list.sort((a, b) => (b.views || 0) - (a.views || 0) || (Number(b.id) || 0) - (Number(a.id) || 0));
  }
  const total = list.length;
  const start = (page - 1) * pageSize;
  const slice = start >= total ? [] : list.slice(start, start + pageSize);
  return {
    items: slice,
    total,
    page,
    page_size: pageSize,
    total_pages: Math.max(1, Math.ceil(total / pageSize) || 1),
    live: false
  };
}

let LOCAL_VIDEOS_CACHE = null;
let LOCAL_VIDEOS_CACHE_AT = 0;
let LOCAL_VIDEOS_BY_ID = null;

function indexLocalVideosCatalog(list) {
  const byId = new Map();
  if (Array.isArray(list)) {
    for (const v of list) {
      if (!v) continue;
      if (v.id !== undefined && v.id !== null) byId.set(String(v.id), v);
      if (v.source_id !== undefined && v.source_id !== null) byId.set(String(v.source_id), v);
    }
  }
  LOCAL_VIDEOS_BY_ID = byId;
}

function findLocalVideoFast(targetId, titleFallback) {
  if (targetId && LOCAL_VIDEOS_BY_ID) {
    const hit = LOCAL_VIDEOS_BY_ID.get(String(targetId));
    if (hit) return hit;
  }
  if (titleFallback && Array.isArray(LOCAL_VIDEOS_CACHE)) {
    const low = String(titleFallback).toLowerCase();
    return LOCAL_VIDEOS_CACHE.find((v) => v && v.title && v.title.toLowerCase() === low) || null;
  }
  return null;
}

async function loadVideoCatalog(context, pageUrl) {
  if (LOCAL_VIDEOS_CACHE && (Date.now() - LOCAL_VIDEOS_CACHE_AT) < 60 * 60 * 1000) {
    if (!LOCAL_VIDEOS_BY_ID) indexLocalVideosCatalog(LOCAL_VIDEOS_CACHE);
    return LOCAL_VIDEOS_CACHE;
  }
  const origin = (pageUrl && pageUrl.origin) || "https://www.morbohub.com";
  let response = null;
  const assets = context && context.env && context.env.ASSETS;
  if (assets && typeof assets.fetch === "function") {
    try {
      response = await assets.fetch(new Request(origin + "/data/videos.json"));
    } catch (e) {
      response = null;
    }
  }
  if (!response || !response.ok) {
    try {
      response = await fetch(origin + "/data/videos.json", { cf: { cacheEverything: true, cacheTtl: 86400 } });
    } catch (e) {
      response = null;
    }
  }
  if (response && response.ok) {
    try {
      const data = await response.json();
      if (Array.isArray(data)) {
        LOCAL_VIDEOS_CACHE = data;
        LOCAL_VIDEOS_CACHE_AT = Date.now();
        indexLocalVideosCatalog(data);
        return LOCAL_VIDEOS_CACHE;
      }
    } catch (e) {}
  }
  // Respaldo Node.js si corre en test local
  try {
    if (typeof process !== "undefined" && process.versions && process.versions.node) {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const candidates = [
        path.resolve("public/data/videos.json"),
        path.resolve("VERSION_CLOUDFLARE/public/data/videos.json")
      ];
      for (const cand of candidates) {
        if (fs.existsSync(cand)) {
          const raw = fs.readFileSync(cand, "utf8");
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            LOCAL_VIDEOS_CACHE = parsed;
            LOCAL_VIDEOS_CACHE_AT = Date.now();
            indexLocalVideosCatalog(parsed);
            return LOCAL_VIDEOS_CACHE;
          }
        }
      }
    }
  } catch (nodeErr) {}
  return [];
}

async function maskVideoItem(it, secret) {
  const rawCover = it.cover_url || "";
  const rawVideo = it.video_url || (it.video_sources && it.video_sources[0] && it.video_sources[0].url) || "";
  const coverToken = rawCover ? await encodeMediaToken(rawCover, "https://pmvhaven.com/", secret) : "";
  const vipLocked = isItemVIPGated(it);
  const videoToken = (!vipLocked && rawVideo) ? await encodeMediaToken(rawVideo, "https://pmvhaven.com/", secret) : "";
  return {
    id: it.id,
    source: it.source || "pmvhaven",
    source_id: it.source_id ? String(it.source_id) : String(it.id),
    title: cleanPublicTitle(it.title) || "Video HD",
    cover_url: coverToken ? `/api/media?t=${coverToken}` : "",
    media_type: "video",
    tags: sanitizePublicTags(it.tags || []),
    artists: sanitizePublicArtists(it.artists || [], "video"),
    url: "",
    vip_locked: vipLocked,
    page_count: 0,
    video_sources: (!vipLocked && rawVideo) ? [
      {
        quality: "1080p HD",
        url: videoToken ? `/api/media?t=${videoToken}` : "",
        format: "mp4"
      }
    ] : [],
    extra: {
      duration: it.duration || "4:00",
      durationSeconds: it.durationSeconds || 240,
      views: it.views || 0,
      likes: it.likes || 0
    },
    has_cover: !!rawCover
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
  const cacheKey = `span:v5:${filterQuery}`;
  const cached = getIsolateCache(ISOLATE_CATALOG_CACHE, cacheKey, 1800000);
  if (cached && cached.minId && cached.maxId && cached.total) return cached;
  const edgeCache = typeof caches !== "undefined" ? caches.default : null;
  const edgeReq = edgeCache
    ? new Request(`https://velvet-internal.cache/span/v5?s=${encodeURIComponent(supabaseUrl)}&q=${encodeURIComponent(filterQuery)}`, { method: "GET" })
    : null;
  if (edgeCache && edgeReq) {
    try {
      const hit = await edgeCache.match(edgeReq);
      if (hit) {
        const span = await hit.json();
        if (span && span.minId && span.maxId && span.total) {
          setIsolateCache(ISOLATE_CATALOG_CACHE, cacheKey, span);
          return span;
        }
      }
    } catch (e) {}
  }
  const headers = { "apikey": apiKey, "Authorization": `Bearer ${apiKey}` };
  // planned sale del plan de Postgres, sin recorrer la tabla. exact en un
  // ILIKE de categoría llegaba al statement_timeout y dejaba el índice colgado.
  const countHeaders = { ...headers, "Prefer": "count=planned" };
  const base = `${supabaseUrl}/rest/v1/items?select=id&limit=1&${filterQuery}`;
  try {
    const [maxRes, minRes] = await Promise.all([
      fetch(`${base}&order=id.desc`, { headers: countHeaders }),
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
    if (edgeCache && edgeReq && total > 0) {
      try {
        await edgeCache.put(edgeReq, new Response(JSON.stringify(span), {
          status: 200,
          headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=21600" }
        }));
      } catch (e) {}
    }
    return span;
  } catch (e) {
    return null;
  }
}

// Partición determinista por franja y sub-ranura biyectiva: cada página cae en
// sub-intervalos disjuntos del conjunto YA FILTRADO para evitar solapes entre páginas.
function planSpanBands(minId, maxId, total, page, pageSize, seed, perBandTake = 6) {
  const lo = Math.floor(Number(minId) || 1);
  const hi = Math.max(lo, Math.floor(Number(maxId) || lo));
  const span = Math.max(1, hi - lo + 1);
  const size = Math.max(1, Math.floor(Number(pageSize) || 24));
  const safePage = Math.max(1, Math.floor(Number(page) || 1));
  const available = Math.max(0, Math.floor(Number(total) || 0));
  const bands = Math.min(size, Math.max(1, available || size));
  const baseSeed = Math.abs(Number(seed) | 0) || 1;
  const rng = shuffleRng((Math.imul(baseSeed, 0x9E3779B1) ^ Math.imul(safePage, 0x85EBCA6B)) >>> 0);
  const targetPages = Math.max(2, Math.floor((available || size * 4) / Math.max(1, size)));
  const desiredSlots = Math.min(32, targetPages);
  const take = Math.max(2, Math.floor(Number(perBandTake) || 6));
  const out = [];
  for (let i = 0; i < bands; i++) {
    const start = lo + Math.floor((i * span) / bands);
    const end = i === bands - 1 ? hi : lo + Math.floor(((i + 1) * span) / bands) - 1;
    const width = Math.max(1, end - start + 1);
    const maxSlotsByWidth = width >= 8 ? Math.max(2, Math.floor(width / Math.max(4, take))) : 1;
    const slots = Math.max(1, Math.min(desiredSlots, maxSlotsByWidth));
    let subStart = start;
    let subEnd = end;
    let anchor = start + Math.floor(rng() * width);
    if (slots >= 2) {
      const slotIdx = permutePageIndex((safePage - 1) % slots, slots, (baseSeed + (i + 1) * 131) >>> 0);
      subStart = start + Math.floor((slotIdx * width) / slots);
      subEnd = slotIdx === slots - 1 ? end : start + Math.floor(((slotIdx + 1) * width) / slots) - 1;
      const subSpan = Math.max(1, subEnd - subStart + 1);
      const lowerMargin = Math.min(Math.max(0, subSpan - 1), Math.max(take + 1, Math.floor(subSpan * 0.5)));
      const jitterSpan = Math.max(1, subSpan - lowerMargin);
      anchor = subStart + lowerMargin + Math.floor(rng() * jitterSpan);
    }
    out.push({
      band: i,
      anchor: Math.min(hi, Math.max(lo, anchor)),
      subStart: Math.max(lo, subStart),
      subEnd: Math.min(hi, Math.max(subStart, subEnd)),
      slots
    });
  }
  return out;
}

function randomAnchorsInSpan(minId, maxId, total, page, pageSize, seed) {
  return planSpanBands(minId, maxId, total, page, pageSize, seed, 6).map((b) => b.anchor);
}

function shuffleHashId(id, seed) {
  const n = Math.floor(Number(id) || 0) | 0;
  let x = (n ^ Math.imul((seed | 0) || 1, 0x9E3779B1)) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x85EBCA6B) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 0xC2B2AE35) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

function comicCatalogSelect(selectFields) {
  const parts = String(selectFields || "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s && s !== "video_sources");
  return parts.length
    ? parts.join(",")
    : "id,source,source_id,title,cover_url,media_type,tags,page_count,artists";
}

// Ids uniformes en el rango real, particionados por cubeta biyectiva por página para no repetir entre páginas.
function lotteryCandidateIds(minId, maxId, count, seed, bucketFilter = null) {
  const lo = Math.floor(Number(minId) || 1);
  const hi = Math.max(lo, Math.floor(Number(maxId) || lo));
  const span = Math.max(1, hi - lo + 1);
  const rng = shuffleRng((Math.abs(Number(seed) | 0) || 1) >>> 0);
  const target = Math.max(1, Math.floor(Number(count) || 1));
  const slotMod = bucketFilter && bucketFilter.slotMod >= 2 ? Math.floor(bucketFilter.slotMod) : 0;
  const pageBucket = bucketFilter ? Math.floor(bucketFilter.pageBucket || 0) : 0;
  const partitionSeed = bucketFilter ? (Math.abs(Number(bucketFilter.partitionSeed) | 0) || 1) : 1;
  const picked = new Set();
  const out = [];
  let guard = target * (slotMod ? Math.max(12, slotMod * 3) : 8);
  while (out.length < target && guard-- > 0) {
    const id = lo + Math.floor(rng() * span);
    if (picked.has(id)) continue;
    if (slotMod && (shuffleHashId(id, partitionSeed) % slotMod) !== pageBucket) continue;
    picked.add(id);
    out.push(id);
  }
  return out;
}

async function sampleComicByIdLottery({ supabaseUrl, apiKey, filterQuery, selectFields, page, pageSize, seed, span }) {
  const minId = span && span.minId ? span.minId : 1;
  const maxId = span && span.maxId ? span.maxId : minId;
  const total = (span && span.total) || 0;
  const size = Math.max(1, Math.floor(Number(pageSize) || 24));
  const safePage = Math.max(1, Math.floor(Number(page) || 1));
  if (!total || (safePage - 1) * size >= total) {
    return { items: [], total: total || 0 };
  }
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
  const select = comicCatalogSelect(selectFields);
  const baseSeed = Math.abs(Number(seed) || 1) >>> 0;
  const mixSeed = (baseSeed + safePage * 997) >>> 0;
  if (total <= size * 8) {
    // Subconjunto compacto (< ~192 items): permutación biyectiva directa en índice denso (0 solape y 1 RTT).
    const plan = catalogPageOffset(safePage, size, total, baseSeed, true);
    const directRows = await fetchRows(`${supabaseUrl}/rest/v1/items?select=${select}&limit=${plan.pageSize}&offset=${plan.offset}&order=id.desc&${filterQuery}`);
    return { items: fisherYates(directRows, mixSeed).slice(0, size), total };
  }
  const idSpan = Math.max(1, Math.floor(maxId) - Math.floor(minId) + 1);
  const density = Math.min(1, Math.max(0.004, total / idSpan));
  const probes = Math.min(720, Math.max(size * 8, Math.ceil((size * 5) / density)));
  const slotMod = total > size * 2 ? Math.min(32, Math.max(2, Math.floor(total / Math.max(1, size * 2)))) : 0;
  const pageBucket = slotMod ? permutePageIndex((safePage - 1) % slotMod, slotMod, baseSeed) : 0;
  const bucketFilter = slotMod ? { slotMod, pageBucket, partitionSeed: baseSeed } : null;
  const chunkSize = 160;
  const pullIds = async (salt, useFilter) => {
    const candidates = lotteryCandidateIds(minId, maxId, probes, (mixSeed + salt * 104729) >>> 0, useFilter);
    const jobs = [];
    for (let i = 0; i < candidates.length; i += chunkSize) {
      const chunk = candidates.slice(i, i + chunkSize);
      if (!chunk.length) continue;
      const url = `${supabaseUrl}/rest/v1/items?select=${select}&limit=${chunk.length}&id=in.(${chunk.join(",")})&${filterQuery}`;
      jobs.push(fetchRows(url));
    }
    return Promise.all(jobs);
  };

  let bandRows = await pullIds(1, bucketFilter);
  let items = assembleShufflePage(bandRows, size, mixSeed);
  if (items.length < size) {
    bandRows = bandRows.concat(await pullIds(2, bucketFilter));
    items = assembleShufflePage(bandRows, size, mixSeed);
  }
  if (items.length < size) {
    const plan = planShuffleWindows({
      total,
      minId,
      maxId,
      page: safePage,
      pageSize: size,
      seed: baseSeed,
      bands: 6
    });
    const offsetRows = await Promise.all(plan.windows.map((w) => {
      const url = `${supabaseUrl}/rest/v1/items?select=${select}&limit=${w.take}&offset=${w.offset}&order=id.desc&${filterQuery}`;
      return fetchRows(url);
    }));
    bandRows = bandRows.concat(offsetRows);
    items = assembleShufflePage(bandRows, size, mixSeed);
  }
  if (items.length < size) {
    const hole = Math.max(0, total - size);
    const rng = shuffleRng((mixSeed ^ 0x51ed) >>> 0);
    const offset = Math.floor(rng() * (hole + 1));
    const extra = await fetchRows(`${supabaseUrl}/rest/v1/items?select=${select}&limit=${size}&offset=${offset}&order=id.desc&${filterQuery}`);
    bandRows.push(extra);
    items = assembleShufflePage(bandRows, size, mixSeed);
  }
  return { items: items.slice(0, size), total };
}

async function sampleSupabaseShuffle({ supabaseUrl, apiKey, filterQuery, selectFields, page, pageSize, seed, estimatedTotal, span: knownSpan }) {
  const span = (knownSpan && knownSpan.minId && knownSpan.maxId && knownSpan.total)
    ? knownSpan
    : await fetchCatalogSpan(supabaseUrl, apiKey, filterQuery);
  const minId = span && span.minId ? span.minId : 1;
  const maxId = span && span.maxId ? span.maxId : minId;
  const total = (span && span.total) || estimatedTotal || 0;
  const size = Math.max(1, Math.floor(Number(pageSize) || 24));
  const safePage = Math.max(1, Math.floor(Number(page) || 1));
  if (!total || (safePage - 1) * size >= total) {
    return { items: [], total: total || 0 };
  }
  if (String(filterQuery || "").includes("media_type=eq.comic")) {
    return sampleComicByIdLottery({
      supabaseUrl,
      apiKey,
      filterQuery,
      selectFields,
      page: safePage,
      pageSize: size,
      seed,
      span: { minId, maxId, total }
    });
  }
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
  // Una consulta por ficha supera el tope de subrequests; muestrear sub-bandas
  // disjuntas por página para que Page 1 y Page 2 no repitan elementos.
  const bandCount = Math.min(8, Math.max(4, Math.ceil(size / 3)));
  const take = Math.max(12, Math.ceil((size * 3) / bandCount));
  const bandPlan = planSpanBands(minId, maxId, total, safePage, bandCount, seed, take);
  const loadBand = (entry) => {
    const url = `${supabaseUrl}/rest/v1/items?select=${selectFields}&limit=${take}&offset=0&order=id.desc&id=lte.${entry.anchor}&${filterQuery}`;
    return fetchRows(url);
  };
  const baseSeed = Math.abs(Number(seed) || 1) >>> 0;
  const mixSeed = baseSeed + safePage * 997;
  const rawBandRows = await Promise.all(bandPlan.map(loadBand));
  const shuffleBand = (rows, bIdx) => {
    if (!Array.isArray(rows) || rows.length <= 1) return rows || [];
    const copy = rows.slice();
    const rng = shuffleRng((mixSeed + (bIdx + 1) * 7919) >>> 0);
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = copy[i];
      copy[i] = copy[j];
      copy[j] = tmp;
    }
    return copy;
  };
  const inSlotBands = rawBandRows.map((rows, bIdx) => {
    const b = bandPlan[bIdx];
    const strict = (Array.isArray(rows) ? rows : []).filter((r) => {
      const rid = Number(r && r.id);
      return rid >= b.subStart && rid <= b.subEnd;
    });
    return shuffleBand(strict, bIdx);
  });
  let items = assembleShufflePage(inSlotBands, size, mixSeed);
  if (items.length < size) {
    // Usar primero las filas ya cargadas en esta misma RTT particionadas por cubeta hash por página
    const spillBands = rawBandRows.map((rows, bIdx) => shuffleBand(rows, bIdx));
    const slotMod = total > size * 2 ? Math.min(32, Math.max(2, Math.floor(total / Math.max(1, size * 2)))) : 0;
    const pageBucket = slotMod ? permutePageIndex((safePage - 1) % slotMod, slotMod, baseSeed) : 0;
    const bucketSpill = slotMod
      ? spillBands.map((rows) => rows.filter((r) => (shuffleHashId(r && r.id, baseSeed) % slotMod) === pageBucket))
      : spillBands;
    const seen = new Set(items.map((r) => String(r.id)));
    for (const r of assembleShufflePage(bucketSpill, size, mixSeed)) {
      if (items.length >= size) break;
      const k = String(r.id);
      if (seen.has(k)) continue;
      seen.add(k);
      items.push(r);
    }
  }
  if (items.length < size && total > size) {
    // Fallback por índice denso solo si los huecos impidieron llenar la página en índice PK
    const plan = planShuffleWindows({
      total,
      minId,
      maxId,
      page: safePage,
      pageSize: size,
      seed: baseSeed,
      bands: 4
    });
    const offsetBands = await Promise.all(plan.windows.map((w) =>
      fetchRows(`${supabaseUrl}/rest/v1/items?select=${selectFields}&limit=${w.take}&offset=${w.offset}&order=id.desc&${filterQuery}`)
    ));
    const seen = new Set(items.map((r) => String(r.id)));
    for (const r of assembleShufflePage(offsetBands, size, mixSeed)) {
      if (items.length >= size) break;
      const k = String(r.id);
      if (seen.has(k)) continue;
      seen.add(k);
      items.push(r);
    }
  }
  if (items.length < size) {
    const hole = Math.max(0, total - size);
    const rng = shuffleRng((mixSeed ^ 0x51ed) >>> 0);
    const offset = Math.floor(rng() * (hole + 1));
    const extra = await fetchRows(`${supabaseUrl}/rest/v1/items?select=${selectFields}&limit=${size}&offset=${offset}&order=id.desc&${filterQuery}`);
    items = assembleShufflePage([items, extra], size, mixSeed);
  }
  return { items: items.slice(0, size), total };
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
    const vipLocked = isItemVIPGated({ id: v._id || v.id, source: "pmvhaven", source_id: v._id || v.id, title: v.title });
    const coverToken = rawCover && encodeToken ? await encodeToken(rawCover, "https://pmvhaven.com/") : "";
    const videoToken = (!vipLocked && rawVideo && encodeToken) ? await encodeToken(rawVideo, "https://pmvhaven.com/") : "";
    items.push({
      id: v._id || v.id,
      source: "pmvhaven",
      source_id: v._id || v.id,
      title: cleanPublicTitle(v.title) || "Video HD",
      cover_url: coverToken ? `/api/media?t=${coverToken}` : "",
      media_type: "video",
      tags: sanitizePublicTags(v.tags || []),
      artists: sanitizePublicArtists(v.uploaderUsername ? [v.uploaderUsername] : [], "video"),
      url: "",
      vip_locked: vipLocked,
      page_count: 0,
      video_sources: (!vipLocked && rawVideo) ? [{
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
  const allowOrigin = allowed ? origin : (origin === "*" ? "*" : "https://morbohub.pages.dev");
  const headers = {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, PATCH, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, Range, X-Requested-With, X-Refresh-Token, X-Device-Token, x-velvet-client",
    "Vary": "Origin"
  };
  if (allowed) {
    headers["Access-Control-Allow-Credentials"] = "true";
  }
  return headers;
}

const AUTH_RATE_LIMIT_MAP = new Map();
function getClientIp(request) {
  try {
    return (
      request.headers.get("cf-connecting-ip") ||
      (request.headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
      "unknown"
    ).slice(0, 64);
  } catch (e) {
    return "unknown";
  }
}

function checkAuthRateLimit(request, bucket, maxPerMin = 15) {
  const ip = getClientIp(request);
  const key = `${bucket}:${ip}`;
  const now = Date.now();
  let entry = AUTH_RATE_LIMIT_MAP.get(key);
  if (!entry || now - entry.windowStart > 60000) {
    entry = { windowStart: now, count: 1 };
    AUTH_RATE_LIMIT_MAP.set(key, entry);
    if (AUTH_RATE_LIMIT_MAP.size > 3000) {
      const oldest = AUTH_RATE_LIMIT_MAP.keys().next().value;
      AUTH_RATE_LIMIT_MAP.delete(oldest);
    }
    return true;
  }
  entry.count++;
  return entry.count <= maxPerMin;
}

const ALLOWED_AVATAR_ICONS = new Set([
  "crown", "gem", "bolt", "fire", "gamepad", "ghost", "heart", "rocket", "cat", "shield-halved"
]);
const ALLOWED_AVATAR_BGS = new Set([
  "from-pink-600 to-purple-600",
  "from-amber-500 to-rose-600",
  "from-cyan-500 to-blue-600",
  "from-emerald-500 to-teal-600",
  "from-emerald-500 to-teal-700",
  "from-purple-600 to-indigo-800",
  "from-purple-800 to-indigo-900",
  "from-rose-600 to-pink-700"
]);

function sanitizeProfileAvatar(raw) {
  const clean = String(raw || "").trim().toLowerCase();
  return ALLOWED_AVATAR_ICONS.has(clean) ? clean : "crown";
}

function sanitizeProfileAvatarBg(raw) {
  const clean = String(raw || "").trim();
  return ALLOWED_AVATAR_BGS.has(clean) ? clean : "from-pink-600 to-purple-600";
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
  if (cookies.length > 0) {
    cookies.push(publicSessionCookie("velvet_auth_active", "1", 60 * 60 * 24 * 30, secure));
  }
  return cookies;
}

function clearSessionCookies(request) {
  const secure = requestIsSecure(request);
  return [
    sessionCookie("velvet_access", "", 0, secure),
    sessionCookie("velvet_refresh", "", 0, secure),
    publicSessionCookie("velvet_auth_active", "", 0, secure)
  ];
}

function publicSessionCookie(name, value, maxAge, secure) {
  const parts = [
    `${name}=${encodeURIComponent(value || "")}`,
    `Max-Age=${Math.max(0, maxAge | 0)}`,
    "Path=/",
    "SameSite=Lax"
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
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

const RESERVED_USERNAMES = new Set([
  "admin", "administrator", "erick", "master", "owner", "root",
  "morbo", "morbohub", "velvet", "velvethub", "soporte", "support", "staff", "mod", "moderator"
]);

function isReservedUsername(raw) {
  const clean = sanitizeAuthAlias(raw);
  return !clean || RESERVED_USERNAMES.has(clean);
}

function escapePostgrestLike(input) {
  return String(input || "").replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

function enforceCookieMutationOrigin(request, corsOrigin) {
  const m = String(request.method || "GET").toUpperCase();
  if (m === "GET" || m === "HEAD" || m === "OPTIONS") return null;
  const authHeader = request.headers.get("authorization") || "";
  const hasExplicitBearer = authHeader.startsWith("Bearer ") && authHeader.length > 15;
  const hasSessionCookies = Boolean(
    readRequestCookie(request, "velvet_access") || readRequestCookie(request, "velvet_refresh")
  );
  const secFetchSite = String(request.headers.get("sec-fetch-site") || "").toLowerCase();
  if (secFetchSite === "cross-site") {
    return new Response(JSON.stringify({ error: "Origen cross-site no permitido", detail: "Origen cross-site no permitido" }), {
      status: 403,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...getCorsHeaders(corsOrigin) }
    });
  }
  const originHdr = request.headers.get("origin");
  if (originHdr && !isAllowedOrigin(originHdr)) {
    return new Response(JSON.stringify({ error: "Origen no permitido", detail: "Origen no permitido" }), {
      status: 403,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...getCorsHeaders(corsOrigin) }
    });
  }
  if (!hasExplicitBearer && hasSessionCookies && !originHdr) {
    const refOrigin = refererOrigin(request.headers.get("referer") || "");
    const secOk = secFetchSite === "same-origin" || secFetchSite === "same-site";
    const refOk = Boolean(refOrigin && isAllowedOrigin(refOrigin));
    if ((refOrigin && !refOk) || (!secOk && !refOk)) {
      return new Response(JSON.stringify({ error: "Solicitud CSRF bloqueada", detail: "Solicitud CSRF bloqueada" }), {
        status: 403,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...getCorsHeaders(corsOrigin) }
      });
    }
  }
  return null;
}

// Resuelve la sesión SIN consumir el refresh token. El canje vive solo en /api/auth/refresh
// para que las peticiones paralelas de favoritos/historial no revoquen la sesión.
let _activeJwtSecret = "";
const ISOLATE_AUTH_CACHE = new Map();
const ISOLATE_AUTH_TTL_MS = 15000;

function evictIsolateAuthToken(token) {
  if (!token) return;
  for (const k of ISOLATE_AUTH_CACHE.keys()) {
    if (k.endsWith("|" + token)) ISOLATE_AUTH_CACHE.delete(k);
  }
}

async function resolveAuthUser(request, sbUrl, sbKey, jwtSecret) {
  const activeUrl = sbUrl || _activeSupabaseUrl || (typeof SUPABASE_URL !== "undefined" ? SUPABASE_URL : "");
  const activeKey = sbKey || _activeSupabaseKey || (typeof SUPABASE_KEY !== "undefined" ? SUPABASE_KEY : "");
  const activeJwtSecret = jwtSecret || _activeJwtSecret || "";
  const authHeader = request.headers.get("authorization") || "";
  let token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  if (!token || token === "velvet_token" || token === "null" || token === "undefined") {
    token = readRequestCookie(request, "velvet_access") || "";
  }
  if (!token || token === "velvet_token" || token === "null" || token === "undefined") {
    return { user: null, token: null, newToken: null, newRefreshToken: null, unavailable: false, verified: false };
  }

  let reqPath = "";
  try { reqPath = new URL(request.url).pathname; } catch (e) {}
  const requireLiveCheck = !reqPath || reqPath === "/api/auth/me" || reqPath === "/api/auth/logout" || reqPath.startsWith("/api/admin/");

  if (!requireLiveCheck && activeJwtSecret && token.split(".").length === 3) {
    const fastJwt = await verifySupabaseJwtHS256(token, activeJwtSecret);
    if (!fastJwt) {
      return { user: null, token: null, newToken: null, newRefreshToken: null, unavailable: false, verified: false };
    }
    return {
      user: {
        id: fastJwt.sub,
        email: fastJwt.email || "",
        user_metadata: fastJwt.user_metadata || {},
        role: fastJwt.role || "authenticated"
      },
      token,
      newToken: null,
      newRefreshToken: null,
      unavailable: false,
      verified: true,
      degraded: false
    };
  }

  const authCacheKey = `${activeUrl}|${token}`;
  if (!requireLiveCheck) {
    const cachedAuth = ISOLATE_AUTH_CACHE.get(authCacheKey);
    if (cachedAuth && (Date.now() - cachedAuth.ts) < ISOLATE_AUTH_TTL_MS) {
      const exp = Number(cachedAuth.exp || 0);
      if (!exp || exp > Math.floor(Date.now() / 1000)) {
        return { user: cachedAuth.user, token, newToken: null, newRefreshToken: null, unavailable: false, verified: true, degraded: false };
      }
      ISOLATE_AUTH_CACHE.delete(authCacheKey);
    }
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
        if (ISOLATE_AUTH_CACHE.size > 500) {
          const oldestKey = ISOLATE_AUTH_CACHE.keys().next().value;
          if (oldestKey !== undefined) ISOLATE_AUTH_CACHE.delete(oldestKey);
        }
        const pExp = decodeJwtPayload(token)?.exp || 0;
        ISOLATE_AUTH_CACHE.set(authCacheKey, { ts: Date.now(), exp: pExp, user });
        return { user, token, newToken: null, newRefreshToken: null, unavailable: false, verified: true, degraded: false };
      }
    }
    // 401/403: token inválido o caducado. El cliente refresca. No es un 503.
    if (userRes.status === 401 || userRes.status === 403) {
      ISOLATE_AUTH_CACHE.delete(authCacheKey);
      return { user: null, token: null, newToken: null, newRefreshToken: null, unavailable: false, verified: false };
    }
  } catch (e) {
    upstreamStatus = 503;
  }

  // Si hay SUPABASE_JWT_SECRET configurado, validar criptográficamente la firma HS256 del JWT.
  if (activeJwtSecret) {
    const verifiedPayload = await verifySupabaseJwtHS256(token, activeJwtSecret);
    if (!verifiedPayload) {
      return { user: null, token: null, newToken: null, newRefreshToken: null, unavailable: false, verified: false };
    }
    return {
      user: {
        id: verifiedPayload.sub,
        email: verifiedPayload.email || "",
        user_metadata: verifiedPayload.user_metadata || {},
        role: verifiedPayload.role || "authenticated"
      },
      token,
      newToken: null,
      newRefreshToken: null,
      unavailable: false,
      verified: true,
      degraded: false
    };
  }

  // Sin SUPABASE_JWT_SECRET: solo fallback degradado de solo lectura cuando GoTrue falla,
  // exigiendo claim exp válido y sin autorizar acciones privilegiadas ni fallback admin.
  const payload = decodeJwtPayload(token);
  const nowSec = Math.floor(Date.now() / 1000);
  if (!payload || !payload.sub) {
    if (upstreamStatus >= 500 || upstreamStatus === 0) {
      return { user: null, token, newToken: null, newRefreshToken: null, unavailable: true, verified: false };
    }
    return { user: null, token: null, newToken: null, newRefreshToken: null, unavailable: false, verified: false };
  }
  if (!payload.exp || Number(payload.exp) <= nowSec) {
    return { user: null, token: null, newToken: null, newRefreshToken: null, unavailable: false, verified: false };
  }
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
    verified: false,
    degraded: true
  };
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
  const [userId, newMetadata, sbUrl, sbKey] = arguments;
  const activeUrl = sbUrl || _activeSupabaseUrl;
  const activeKey = sbKey || _activeSupabaseServiceKey || (typeof SUPABASE_SERVICE_ROLE_KEY !== "undefined" ? SUPABASE_SERVICE_ROLE_KEY : "") || _activeSupabaseKey;
  if (!userId || !activeUrl || !activeKey) return false;
  return updateSupabaseUserMetadata(userId, newMetadata, activeUrl, activeKey);
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

const SUBSCRIPTION_PROFILE_SELECT =
  "id,email,username,is_admin,avatar,avatar_bg,subscription_tier,subscription_status,subscription_expires_at,is_lifetime,registered_with_key,last_redeemed_at,patreon_id,patron_status,is_suspended,created_at,updated_at";

function sanitizeUsername(raw) {
  const cleaned = String(raw || "").trim().replace(/[^a-zA-Z0-9_.-]/g, "");
  return cleaned.slice(0, 32);
}

function sanitizeKeyCode(raw) {
  return String(raw || "").trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "").slice(0, 64);
}

function generateVipKeyCode(prefix = "VIP") {
  const cleanPrefix = String(prefix || "VIP").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12) || "VIP";
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const seg = (start) => {
    let out = "";
    for (let i = 0; i < 4; i++) out += alphabet[bytes[start + i] % alphabet.length];
    return out;
  };
  return `${cleanPrefix}-${seg(0)}-${seg(4)}-${seg(8)}`;
}

function constantTimeEqual(a, b) {
  const sa = String(a || "");
  const sb = String(b || "");
  if (sa.length !== sb.length || sa.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < sa.length; i++) {
    diff |= sa.charCodeAt(i) ^ sb.charCodeAt(i);
  }
  return diff === 0;
}

function parseRangeCount(contentRange) {
  if (!contentRange) return 0;
  const m = String(contentRange).match(/\/(\d+)$/);
  return m ? parseInt(m[1], 10) || 0 : 0;
}

async function fetchUserProfile(sbUrl, adminKey, anonKey, userId, userToken = null) {
  if (!userId || !sbUrl) return null;
  const authHeader = (adminKey && adminKey !== anonKey) ? adminKey : (userToken || anonKey || adminKey);
  const apiKey = (adminKey && adminKey !== anonKey) ? adminKey : (anonKey || adminKey);
  if (!apiKey || !authHeader) return null;

  try {
    let res = await fetch(
      `${sbUrl}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=${encodeURIComponent(SUBSCRIPTION_PROFILE_SELECT)}&limit=1`,
      {
        headers: {
          "apikey": apiKey,
          "Authorization": `Bearer ${authHeader}`
        }
      }
    );
    if (!res.ok && res.status === 400) {
      res = await fetch(
        `${sbUrl}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=is_admin&limit=1`,
        {
          headers: {
            "apikey": apiKey,
            "Authorization": `Bearer ${authHeader}`
          }
        }
      );
    }
    if (!res.ok) return null;
    const rows = await res.json().catch(() => []);
    return Array.isArray(rows) && rows[0] ? rows[0] : null;
  } catch (e) {
    return null;
  }
}

async function syncProfileExpiryIfNeeded(sbUrl, adminKey, userId) {
  if (!sbUrl || !adminKey || !userId) return;
  try {
    await fetch(`${sbUrl}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}`, {
      method: "PATCH",
      headers: {
        "apikey": adminKey,
        "Authorization": `Bearer ${adminKey}`,
        "Content-Type": "application/json",
        "Prefer": "return=minimal"
      },
      body: JSON.stringify({
        subscription_status: "expired",
        updated_at: new Date().toISOString()
      })
    });
  } catch (e) {}
}

function buildUserSubscriptionView(profile, authUser, env) {
  const p = profile || {};
  const meta = authUser?.user_metadata || {};
  const email = String(p.email || authUser?.email || "").trim().toLowerCase();
  const isAdmin = Boolean(p.is_admin === true);
  const bannedUntilMs = authUser?.banned_until ? Date.parse(authUser.banned_until) : null;
  const isSuspended = Boolean(p.is_suspended === true || (bannedUntilMs && !Number.isNaN(bannedUntilMs) && bannedUntilMs > Date.now()));
  const isLifetime = Boolean(p.is_lifetime === true);

  const expIso = p.subscription_expires_at || meta.subscription_expires_at || null;
  const expMs = expIso ? Date.parse(expIso) : null;
  const nowMs = Date.now();
  const hasValidExpiry = Boolean(expMs && !Number.isNaN(expMs));
  const hasFutureExpiry = Boolean(hasValidExpiry && expMs > nowMs);
  const hadExpiredExpiry = Boolean(hasValidExpiry && expMs <= nowMs);
  const patronStatus = p.patron_status || meta.patron_status || null;
  const patreonActive = patronStatus === "active_patron" && p.subscription_status === "active" && !hadExpiredExpiry;

  let subscription_status = "inactive";
  let is_pro = false;
  let has_active_subscription = false;
  let tier = "Cuenta Gratuita";
  let tier_level = "free";
  let days_remaining = 0;

  if (isSuspended) {
    subscription_status = "suspended";
    tier = "Cuenta Suspendida";
    tier_level = "suspended";
  } else if (isAdmin) {
    subscription_status = "admin";
    is_pro = true;
    has_active_subscription = true;
    tier = "Dueño";
    tier_level = "pro";
    days_remaining = null;
  } else if (isLifetime) {
    subscription_status = "active";
    is_pro = true;
    has_active_subscription = true;
    tier = "Morbo VIP Permanente";
    tier_level = "pro";
    days_remaining = null;
  } else if (hasFutureExpiry) {
    subscription_status = "active";
    is_pro = true;
    has_active_subscription = true;
    tier = p.subscription_tier === "patreon" ? "Patreon VIP" : "Morbo VIP";
    tier_level = "pro";
    days_remaining = Math.max(1, Math.ceil((expMs - nowMs) / 86400000));
  } else if (patreonActive) {
    subscription_status = "active";
    is_pro = true;
    has_active_subscription = true;
    tier = "Patreon VIP";
    tier_level = "pro";
    days_remaining = null;
  } else if (hadExpiredExpiry || p.subscription_status === "expired") {
    subscription_status = "expired";
    tier = "Suscripción Vencida";
    tier_level = "free";
    days_remaining = 0;
  }

  const displayName =
    p.username ||
    meta.username ||
    meta.full_name ||
    meta.display_name ||
    (email ? email.split("@")[0] : "Usuario");

  const needsExpirySync = Boolean(
    !isSuspended && !isAdmin && !isLifetime && hadExpiredExpiry && p.subscription_status === "active"
  );

  return {
    id: authUser?.id || p.id,
    username: displayName,
    email: authUser?.email || p.email || "",
    role: isAdmin ? "admin" : "member",
    tier,
    tier_level,
    is_pro,
    is_vip: is_pro,
    has_active_subscription,
    subscription_status,
    subscription_tier: isAdmin ? "admin" : (p.subscription_tier || (is_pro ? "vip" : "free")),
    subscription_expires_at: expIso,
    days_remaining,
    is_lifetime: isLifetime,
    is_suspended: isSuspended,
    registered_with_key: p.registered_with_key || meta.registered_with_key || null,
    last_redeemed_at: p.last_redeemed_at || null,
    patreon_id: p.patreon_id || meta.patreon_id || null,
    patron_status: patronStatus,
    avatar: p.avatar || meta.avatar || "crown",
    avatarBg: p.avatar_bg || meta.avatarBg || "from-pink-600 to-purple-600",
    created_at: p.created_at || authUser?.created_at || null,
    max_devices: 10,
    needsExpirySync
  };
}

function publicUserPayload(view) {
  if (!view) return null;
  const copy = { ...view };
  delete copy.needsExpirySync;
  return copy;
}

function isItemVIPGated(item, fallbackId = null) {
  const rawId = item && item.id != null ? item.id : fallbackId;
  const strId = String(rawId ?? "").trim();
  let num = /^\d{1,15}$/.test(strId) ? Number(strId) : 0;
  if (!num || !Number.isSafeInteger(num)) {
    const str = String(item?.source || "") + ":" + String(item?.source_id || item?.title || rawId || "");
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i);
      hash |= 0;
    }
    num = Math.abs(hash);
  }
  return (num % 2) === 1;
}

async function checkDetailVipAccess(context, itemObj, sbUrl, sbKey, sbAdminKey, env, origin) {
  if (!isItemVIPGated(itemObj)) return { allowed: true, vipGated: false };
  const { user, token, unavailable, degraded, verified } = await resolveAuthUser(context.request, sbUrl, sbKey);
  if (unavailable || degraded || (user && !verified)) {
    return {
      allowed: false,
      vipGated: true,
      response: new Response(JSON.stringify({ detail: "Servicio de sesión no disponible" }), {
        status: 503,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...getCorsHeaders(origin) }
      })
    };
  }
  if (!user || !token) {
    return {
      allowed: false,
      vipGated: true,
      response: new Response(JSON.stringify({
        error: "vip_required",
        subscription_required: true,
        subscription_status: "guest",
        detail: "Inicia sesión y activa tu suscripción VIP para ver este contenido."
      }), {
        status: 403,
        headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store", ...getCorsHeaders(origin) }
      })
    };
  }
  const profile = await fetchUserProfile(sbUrl, sbAdminKey, sbKey, user.id, token);
  const view = buildUserSubscriptionView(profile, user, env);
  if (view.needsExpirySync) {
    context.waitUntil?.(syncProfileExpiryIfNeeded(sbUrl, sbAdminKey, user.id));
  }
  if (!view.has_active_subscription) {
    const detailMsg = view.is_suspended
      ? "Tu cuenta se encuentra suspendida."
      : view.subscription_status === "expired"
        ? "Tu suscripción VIP venció. Canjea una nueva llave mensual para recuperar el acceso."
        : "Este contenido es exclusivo para miembros con suscripción VIP activa.";
    return {
      allowed: false,
      vipGated: true,
      response: new Response(JSON.stringify({
        error: "vip_required",
        subscription_required: true,
        subscription_status: view.subscription_status,
        detail: detailMsg
      }), {
        status: 403,
        headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store", ...getCorsHeaders(origin) }
      })
    };
  }
  return { allowed: true, vipGated: true };
}

async function requireAdminContext(request, sbUrl, sbKey, sbAdminKey, origin) {
  const { user, token, unavailable, degraded, verified } = await resolveAuthUser(request, sbUrl, sbKey);
  if (unavailable || degraded || (user && !verified)) {
    return {
      errorResponse: new Response(JSON.stringify({ error: "Servicio de sesión no disponible" }), {
        status: 503,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...getCorsHeaders(origin) }
      })
    };
  }
  if (!user || !token) {
    return {
      errorResponse: new Response(JSON.stringify({ error: "No autenticado" }), {
        status: 401,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...getCorsHeaders(origin) }
      })
    };
  }
  const profile = await fetchUserProfile(sbUrl, sbAdminKey, sbKey, user.id, token);
  if (!profile || profile.is_admin !== true) {
    return {
      errorResponse: new Response(JSON.stringify({ error: "Acceso denegado: Se requieren permisos de administrador" }), {
        status: 403,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...getCorsHeaders(origin) }
      })
    };
  }
  return { user, token, profile };
}

async function resolveLoginEmail(rawUser, sbUrl, serviceKey, env) {
  const rawLower = String(rawUser || "").trim().toLowerCase();
  if (rawLower.includes("@")) return { email: rawLower, invalid: false };
  const alias = sanitizeAuthAlias(rawLower);
  if (!alias) return { email: null, invalid: true };
  const master = String(env?.MASTER_EMAIL || "erickariaslrcy@gmail.com").trim().toLowerCase();
  if (alias === "admin" || alias === "erick" || alias === "master") {
    return { email: master, invalid: false };
  }
  if (serviceKey && sbUrl) {
    try {
      const escapedAlias = escapePostgrestLike(alias);
      const exactUserRes = await fetch(
        `${sbUrl}/rest/v1/profiles?select=email,username&username=ilike.${encodeURIComponent(escapedAlias)}&limit=5`,
        { headers: { "apikey": serviceKey, "Authorization": `Bearer ${serviceKey}` } }
      );
      if (exactUserRes.ok) {
        const rows = await exactUserRes.json().catch(() => []);
        const exactRow = (Array.isArray(rows) ? rows : []).find(
          (r) => String(r.username || "").toLowerCase() === alias
        );
        if (exactRow && exactRow.email) {
          return { email: exactRow.email.toLowerCase(), invalid: false };
        }
      }
      const prefixRes = await fetch(
        `${sbUrl}/rest/v1/profiles?select=email&email=ilike.${encodeURIComponent(escapedAlias + "@%")}&limit=5`,
        { headers: { "apikey": serviceKey, "Authorization": `Bearer ${serviceKey}` } }
      );
      if (prefixRes.ok) {
        const rows = await prefixRes.json().catch(() => []);
        const exactPrefix = (Array.isArray(rows) ? rows : []).find(
          (r) => String(r.email || "").toLowerCase().split("@")[0] === alias
        );
        if (exactPrefix && exactPrefix.email) {
          return { email: exactPrefix.email.toLowerCase(), invalid: false };
        }
      }
    } catch (e) {}
  }
  return { email: `${alias}@velvet.local`, invalid: false };
}

async function fetchAuthUserById(sbUrl, adminKey, userId) {
  if (!sbUrl || !adminKey || !userId) return null;
  try {
    const res = await fetch(`${sbUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
      headers: { "apikey": adminKey, "Authorization": `Bearer ${adminKey}` }
    });
    if (!res.ok) return null;
    return await res.json().catch(() => null);
  } catch (e) {
    return null;
  }
}

async function patchAuthUserLightMeta(sbUrl, adminKey, userId, existingMeta, patch) {
  if (!sbUrl || !adminKey || !userId) return false;
  const merged = { ...(existingMeta || {}), ...patch };
  return await updateSupabaseUserMetadata(userId, merged, sbUrl, adminKey);
}

// ============================================================================
// BLINDAJE STEALTH & VELOCIDAD SHORTS (TOKENS OPACOS POR ID + CACHE PoP)
// ============================================================================
const ISOLATE_SHORTS_MEDIA = new Map();
const SHORTS_POOL_CACHE = { items: [], lastRefillMs: 0, inflight: null };
const SHORTS_META_CACHE_PREFIX = "https://shorts-meta.internal/v1/";
const SHORTS_COVER_CACHE_PREFIX = "https://shorts-cover.internal/v1/";

function shortsQuantizedExp(ttlSeconds) {
  const now = Math.floor(Date.now() / 1000);
  const ttl = Math.max(3600, Number(ttlSeconds) || 43200);
  const bucket = Math.min(86400, Math.max(3600, Math.floor(ttl / 4)));
  return (Math.floor(now / bucket) * bucket) + ttl;
}

async function encodeShortToken(id, kind, secret, ttlSeconds = 43200) {
  const sid = parseInt(id, 10);
  if (!Number.isFinite(sid) || sid <= 0 || !secret || !kind) return "";
  try {
    const exp = shortsQuantizedExp(ttlSeconds);
    const dataB64 = toBase64Url(JSON.stringify({ i: sid, k: kind, e: exp }));
    const key = await getHmacKey(secret);
    if (!key) return "";
    const sigBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(dataB64));
    const sigHex = Array.from(new Uint8Array(sigBuf)).map(b => b.toString(16).padStart(2, "0")).join("");
    return `${dataB64}.${sigHex}`;
  } catch (e) {
    return "";
  }
}

async function decodeShortToken(token, secret, expectedKind = "") {
  if (!token || !secret || typeof token !== "string") return null;
  const dotIdx = token.indexOf(".");
  if (dotIdx === -1) return null;
  const dataB64 = token.substring(0, dotIdx);
  const sigHex = token.substring(dotIdx + 1);
  if (!/^[0-9a-f]{64}$/i.test(sigHex)) return null;
  try {
    const key = await getHmacKey(secret);
    if (!key) return null;
    const sigBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(dataB64));
    const expectedHex = Array.from(new Uint8Array(sigBuf)).map(b => b.toString(16).padStart(2, "0")).join("");
    if (!timingSafeEqualHex(expectedHex.toLowerCase(), sigHex.toLowerCase())) return null;
    const payload = JSON.parse(fromBase64Url(dataB64));
    const sid = parseInt(payload && payload.i, 10);
    if (!payload || !Number.isFinite(sid) || sid <= 0) return null;
    if (expectedKind && payload.k !== expectedKind) return null;
    if (payload.e && Math.floor(Date.now() / 1000) > Number(payload.e)) return null;
    return { i: sid, k: String(payload.k || ""), e: Number(payload.e || 0) };
  } catch (e) {
    return null;
  }
}

function isSameSiteHostname(a, b) {
  const h1 = String(a || "").toLowerCase().replace(/^www\./, "");
  const h2 = String(b || "").toLowerCase().replace(/^www\./, "");
  if (!h1 || !h2) return false;
  if (h1 === h2) return true;
  if ((h1 === "localhost" || h1 === "127.0.0.1") && (h2 === "localhost" || h2 === "127.0.0.1")) return true;
  return h1.endsWith(`.${h2}`) || h2.endsWith(`.${h1}`);
}

function checkSameSiteStreamRequest(request, reqUrl) {
  const dest = (request.headers.get("sec-fetch-dest") || "").toLowerCase();
  if (dest === "document" || dest === "iframe" || dest === "frame" || dest === "object" || dest === "embed") {
    return false;
  }
  const secSite = (request.headers.get("sec-fetch-site") || "").toLowerCase();
  if (secSite === "cross-site") return false;
  const hdrRef = request.headers.get("origin") || request.headers.get("referer") || "";
  if (hdrRef && hdrRef !== "null") {
    try {
      const refHost = new URL(hdrRef).hostname;
      if (!isSameSiteHostname(refHost, reqUrl.hostname)) return false;
    } catch (e) {
      return false;
    }
  }
  return true;
}

function cacheShortMediaInMemory(sid, meta) {
  if (!sid || !meta || (!meta.v && !meta.c)) return;
  if (ISOLATE_SHORTS_MEDIA.has(sid)) ISOLATE_SHORTS_MEDIA.delete(sid);
  while (ISOLATE_SHORTS_MEDIA.size >= 4000) {
    const firstKey = ISOLATE_SHORTS_MEDIA.keys().next().value;
    ISOLATE_SHORTS_MEDIA.delete(firstKey);
  }
  ISOLATE_SHORTS_MEDIA.set(sid, {
    v: String(meta.v || ""),
    c: String(meta.c || ""),
    r: String(meta.r || "")
  });
}

function persistShortsMetaEdge(rows, ctx) {
  if (typeof caches === "undefined" || !caches || !caches.default || !Array.isArray(rows) || rows.length === 0) return;
  const task = Promise.all(rows.map(async (row) => {
    const sid = parseInt(row && row.id, 10);
    if (!Number.isFinite(sid) || sid <= 0) return;
    const meta = {
      v: String(row.video_url || ""),
      c: String(row.cover_url || ""),
      r: String(row.referer || "")
    };
    cacheShortMediaInMemory(sid, meta);
    try {
      await caches.default.put(
        new Request(`${SHORTS_META_CACHE_PREFIX}${sid}`),
        new Response(JSON.stringify(meta), {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "public, max-age=604800"
          }
        })
      );
    } catch (e) {}
  })).catch(() => {});
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(task);
}

async function resolveShortMediaMeta(sid, sbUrl, sbKey, ctx) {
  const idNum = parseInt(sid, 10);
  if (!Number.isFinite(idNum) || idNum <= 0) return null;
  const mem = ISOLATE_SHORTS_MEDIA.get(idNum);
  if (mem && (mem.v || mem.c)) return mem;

  if (typeof caches !== "undefined" && caches && caches.default) {
    try {
      const edgeHit = await caches.default.match(new Request(`${SHORTS_META_CACHE_PREFIX}${idNum}`));
      if (edgeHit && edgeHit.ok) {
        const parsed = await edgeHit.json().catch(() => null);
        if (parsed && (parsed.v || parsed.c)) {
          cacheShortMediaInMemory(idNum, parsed);
          return parsed;
        }
      }
    } catch (e) {}
  }

  try {
    const lookupRes = await fetch(
      `${sbUrl}/rest/v1/shorts?select=id,video_url,cover_url,referer&id=eq.${idNum}&limit=1`,
      { headers: { "apikey": sbKey, "Authorization": `Bearer ${sbKey}` } }
    );
    if (!lookupRes.ok) return null;
    const rows = await lookupRes.json().catch(() => []);
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row) return null;
    const meta = {
      v: String(row.video_url || ""),
      c: String(row.cover_url || ""),
      r: String(row.referer || "")
    };
    persistShortsMetaEdge([{ id: idNum, video_url: meta.v, cover_url: meta.c, referer: meta.r }], ctx);
    return meta;
  } catch (e) {
    return null;
  }
}

async function fetchShortRowById(sid, sbUrl, sbKey, ctx) {
  const idNum = parseInt(sid, 10);
  if (!Number.isFinite(idNum) || idNum <= 0) return null;
  try {
    const res = await fetch(
      `${sbUrl}/rest/v1/shorts?select=id,title,cover_url,video_url,referer,tags,artists,duration,likes&id=eq.${idNum}&limit=1`,
      { headers: { "apikey": sbKey, "Authorization": `Bearer ${sbKey}` } }
    );
    if (!res.ok) return null;
    const rows = await res.json().catch(() => []);
    const row = Array.isArray(rows) ? rows[0] : null;
    if (row) persistShortsMetaEdge([row], ctx);
    return row || null;
  } catch (e) {
    return null;
  }
}

async function refillShortsPool(sbUrl, sbKey, excludeIds = []) {
  if (SHORTS_POOL_CACHE.inflight) return SHORTS_POOL_CACHE.inflight;
  SHORTS_POOL_CACHE.inflight = (async () => {
    try {
      const rpcRes = await fetch(`${sbUrl}/rest/v1/rpc/get_random_shorts`, {
        method: "POST",
        headers: {
          "apikey": sbKey,
          "Authorization": `Bearer ${sbKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ p_limit: 36, p_q: "", p_exclude: excludeIds.slice(-300) })
      });
      if (!rpcRes.ok) return [];
      const rows = await rpcRes.json().catch(() => []);
      const valid = Array.isArray(rows) ? rows.filter(r => r && r.id && r.video_url && !/nekyda\.com|\.m3u8(?:$|\?)/i.test(r.video_url)) : [];
      const seen = new Set(SHORTS_POOL_CACHE.items.map(x => Number(x.id)));
      for (const r of valid) {
        const rid = Number(r.id);
        cacheShortMediaInMemory(rid, { v: r.video_url, c: r.cover_url, r: r.referer });
        if (!seen.has(rid)) {
          seen.add(rid);
          SHORTS_POOL_CACHE.items.push(r);
        }
      }
      if (SHORTS_POOL_CACHE.items.length > 108) {
        SHORTS_POOL_CACHE.items = SHORTS_POOL_CACHE.items.slice(-108);
      }
      SHORTS_POOL_CACHE.lastRefillMs = Date.now();
      return valid;
    } catch (e) {
      return [];
    } finally {
      SHORTS_POOL_CACHE.inflight = null;
    }
  })();
  return SHORTS_POOL_CACHE.inflight;
}

async function formatShortPublicItem(row, secret) {
  const sid = Number(row.id);
  const [tVideo, tCover, tShare] = await Promise.all([
    encodeShortToken(sid, "v", secret, 43200),
    row.cover_url ? encodeShortToken(sid, "c", secret, 604800) : Promise.resolve(""),
    encodeShortToken(sid, "s", secret, 7776000)
  ]);
  return {
    id: sid,
    title: row.title || "Clip",
    cover_url: tCover ? `/api/shorts/img?t=${tCover}` : "",
    stream_url: `/api/shorts/v?t=${tVideo}`,
    share_id: tShare,
    tags: Array.isArray(row.tags) ? row.tags : [],
    artists: Array.isArray(row.artists) ? row.artists : [],
    duration: row.duration ?? null,
    likes: Number(row.likes || 0)
  };
}

export async function onRequest(context) {
  const env = context.env || {};
  const SUPABASE_URL = env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || "https://qnmcejlxoufheisgkuyo.supabase.co";
  const SUPABASE_ANON_KEY = env.SUPABASE_ANON_KEY || env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
  const SUPABASE_SERVICE_ROLE_KEY = env.SUPABASE_SERVICE_ROLE_KEY || "";
  const SUPABASE_URL_DB2 = env.SUPABASE_URL_DB2 || env.NEXT_PUBLIC_SUPABASE_URL_DB2 || "https://vtyleivfovkolpxjjkjs.supabase.co";
  const SUPABASE_ANON_KEY_DB2 = env.SUPABASE_ANON_KEY_DB2 || env.NEXT_PUBLIC_SUPABASE_ANON_KEY_DB2 || "";
  const SUPABASE_SERVICE_ROLE_KEY_DB2 = env.SUPABASE_SERVICE_ROLE_KEY_DB2 || "";
  const SUPABASE_URL_SHORTS = env.SUPABASE_URL_SHORTS || env.NEXT_PUBLIC_SUPABASE_URL_SHORTS || "https://gfzmxupwzbsdmjjiagnl.supabase.co";
  const SUPABASE_ANON_KEY_SHORTS = env.SUPABASE_ANON_KEY_SHORTS || env.NEXT_PUBLIC_SUPABASE_ANON_KEY_SHORTS || "";
  const SUPABASE_SERVICE_ROLE_KEY_SHORTS = env.SUPABASE_SERVICE_ROLE_KEY_SHORTS || "";
  const SUPABASE_KEY_SHORTS = SUPABASE_ANON_KEY_SHORTS || SUPABASE_SERVICE_ROLE_KEY_SHORTS;
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

  // Helper local con inyección de secreto para firmar tokens sin exponer nada al cliente.
  // Desempaqueta deterministamente cualquier token anidado para prevenir doble codificación.
  const encodeToken = async (targetUrl, referer = "") => {
    const raw = extractRawMediaUrl(targetUrl) || targetUrl;
    if (!raw || !/^https?:\/\//i.test(raw)) return "";
    return await encodeMediaToken(raw, referer, MEDIA_SECRET);
  };

  // Clave de mínimo privilegio para catálogo público y operaciones autenticadas con RLS
  const SUPABASE_KEY = SUPABASE_ANON_KEY || SUPABASE_SERVICE_ROLE_KEY;
  // Clave administrativa reservada para backend
  const SUPABASE_ADMIN_KEY = SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY;

  _activeSupabaseUrl = SUPABASE_URL;
  _activeSupabaseKey = SUPABASE_KEY;
  _activeSupabaseServiceKey = SUPABASE_ADMIN_KEY;
  _activeJwtSecret = env.SUPABASE_JWT_SECRET || env.JWT_SECRET || "";

  const url = new URL(context.request.url);
  const origin = context.request.headers.get("origin") || "*";
  const method = context.request.method;

  // Manejo de Preflight OPTIONS
  if (method === "OPTIONS") {
    return new Response(null, { status: 204, headers: getCorsHeaders(origin) });
  }

  const csrfBlock = enforceCookieMutationOrigin(context.request, origin);
  if (csrfBlock) return csrfBlock;

  // =========================================================================
  // 0. VERSIÓN Y OBSERVABILIDAD DEL SISTEMA (/api/version)
  // =========================================================================
  if (url.pathname === "/api/version" && (method === "GET" || method === "HEAD")) {
    const versionPayload = {
      version: "3.1.0",
      commit: "fix/auditoria-completa",
      engine: "Cloudflare-Pages-Functions",
      env_check: {
        all_required_set: missingRequired.length === 0,
        missing_required: missingRequired.map((_, idx) => `required_${idx + 1}`)
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
  // 0b. FEED VERTICAL TIKTOK +18 (/api/shorts/* -> BASE DEDICADA STEALTH)
  // =========================================================================
  if (url.pathname === "/api/shorts/categories" && method === "GET") {
    return new Response(JSON.stringify({ categories: [{ id: "all", label: "Para Ti" }] }), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        ...getCorsHeaders(origin)
      }
    });
  }

  if (url.pathname === "/api/shorts/random" && method === "GET") {
    if (!SUPABASE_URL_SHORTS || !SUPABASE_KEY_SHORTS || !MEDIA_SECRET) {
      return new Response(JSON.stringify({ items: [], has_more: false, detail: "Shorts stealth no configurado" }), {
        status: 503,
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...getCorsHeaders(origin) }
      });
    }
    const rawLim = parseInt(url.searchParams.get("limit") || "12", 10);
    const pLimit = Number.isFinite(rawLim) ? Math.min(30, Math.max(1, rawLim)) : 12;
    const rawQ = sanitizeSearchQuery(url.searchParams.get("q"));
    const rawCat = sanitizeSlug(url.searchParams.get("category"));
    const pQ = rawQ || (rawCat && rawCat !== "all" ? rawCat : "");
    const rawClipParam = url.searchParams.get("clip") || "";
    const rawExcl = (url.searchParams.get("exclude") || "").split(",")
      .map(s => parseInt(s.trim(), 10))
      .filter(n => Number.isFinite(n) && n > 0)
      .slice(-360);
    const excludeSet = new Set(rawExcl);

    try {
      const chosenRows = [];
      if (rawClipParam && !pQ) {
        const clipDecoded = await decodeShortToken(rawClipParam, MEDIA_SECRET, "s");
        if (clipDecoded && clipDecoded.i) {
          const clipRow = await fetchShortRowById(clipDecoded.i, SUPABASE_URL_SHORTS, SUPABASE_KEY_SHORTS, context);
          if (clipRow && clipRow.video_url) {
            chosenRows.push(clipRow);
            excludeSet.add(Number(clipRow.id));
          }
        }
      }

      const needed = Math.max(0, pLimit - chosenRows.length);
      if (needed > 0 && !pQ) {
        const poolAgeOk = (Date.now() - SHORTS_POOL_CACHE.lastRefillMs) < 180000;
        if (!poolAgeOk) {
          SHORTS_POOL_CACHE.items = [];
        }
        const popFromPool = () => {
          const remaining = [];
          for (const candidate of SHORTS_POOL_CACHE.items) {
            const cid = Number(candidate && candidate.id);
            if (chosenRows.length < pLimit && cid > 0 && !excludeSet.has(cid)) {
              excludeSet.add(cid);
              chosenRows.push(candidate);
            } else {
              remaining.push(candidate);
            }
          }
          SHORTS_POOL_CACHE.items = remaining;
        };

        popFromPool();
        if (chosenRows.length < pLimit) {
          await refillShortsPool(SUPABASE_URL_SHORTS, SUPABASE_KEY_SHORTS, Array.from(excludeSet));
          popFromPool();
        }
        if (
          SHORTS_POOL_CACHE.items.length < 24 &&
          (Date.now() - SHORTS_POOL_CACHE.lastRefillMs) > 4000 &&
          typeof context.waitUntil === "function"
        ) {
          context.waitUntil(refillShortsPool(SUPABASE_URL_SHORTS, SUPABASE_KEY_SHORTS, Array.from(excludeSet)));
        }
      } else if (needed > 0) {
        const rpcRes = await fetch(`${SUPABASE_URL_SHORTS}/rest/v1/rpc/get_random_shorts`, {
          method: "POST",
          headers: {
            "apikey": SUPABASE_KEY_SHORTS,
            "Authorization": `Bearer ${SUPABASE_KEY_SHORTS}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ p_limit: needed, p_q: pQ, p_exclude: Array.from(excludeSet).slice(-360) })
        });
        if (!rpcRes.ok) {
          return new Response(JSON.stringify({ items: [], has_more: false }), {
            status: rpcRes.status,
            headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...getCorsHeaders(origin) }
          });
        }
        const rows = await rpcRes.json().catch(() => []);
        if (Array.isArray(rows)) {
          for (const r of rows) {
            if (r && r.id && r.video_url && !/nekyda\.com|\.m3u8(?:$|\?)/i.test(r.video_url) && !excludeSet.has(Number(r.id))) {
              excludeSet.add(Number(r.id));
              chosenRows.push(r);
            }
          }
        }
      }

      persistShortsMetaEdge(chosenRows, context);
      const items = await Promise.all(chosenRows.map((row) => formatShortPublicItem(row, MEDIA_SECRET)));

      return new Response(JSON.stringify({ items, has_more: items.length > 0 }), {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
          ...getCorsHeaders(origin)
        }
      });
    } catch (e) {
      return new Response(JSON.stringify({ items: [], has_more: false }), {
        status: 500,
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...getCorsHeaders(origin) }
      });
    }
  }

  if ((url.pathname === "/api/shorts/v" || url.pathname === "/api/shorts/img") && (method === "GET" || method === "HEAD")) {
    if (!SUPABASE_URL_SHORTS || !SUPABASE_KEY_SHORTS || !MEDIA_SECRET) {
      return new Response("Servicio no configurado", { status: 503 });
    }
    if (!checkSameSiteStreamRequest(context.request, url)) {
      return new Response("Descarga directa o enlace externo bloqueado", {
        status: 403,
        headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "private, no-store" }
      });
    }
    const isImg = url.pathname === "/api/shorts/img";
    const tok = url.searchParams.get("t") || "";
    const decoded = await decodeShortToken(tok, MEDIA_SECRET, isImg ? "c" : "v");
    if (!decoded) {
      return new Response("Enlace expirado o inválido", {
        status: 403,
        headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "private, no-store" }
      });
    }

    try {
      const edgeCache = (typeof caches !== "undefined" && caches && caches.default) ? caches.default : null;
      const edgeCoverReq = isImg ? new Request(`${SHORTS_COVER_CACHE_PREFIX}${decoded.i}`) : null;
      if (isImg && method === "GET" && edgeCache && edgeCoverReq) {
        const hit = await edgeCache.match(edgeCoverReq).catch(() => null);
        if (hit && hit.ok) {
          const hitH = new Headers(hit.headers);
          hitH.set("X-Velvet-Cover", "HIT-EDGE");
          hitH.set("Cross-Origin-Resource-Policy", "same-origin");
          hitH.set("Vary", "Origin");
          return new Response(hit.body, { status: 200, headers: hitH });
        }
      }

      const meta = await resolveShortMediaMeta(decoded.i, SUPABASE_URL_SHORTS, SUPABASE_KEY_SHORTS, context);
      if (!meta) {
        return new Response("No encontrado", { status: 404 });
      }
      const initialUrl = isImg ? String(meta.c || "") : String(meta.v || "");
      let currentUrl = initialUrl;
      const refUrl = String(meta.r || "");
      if (!currentUrl || !isSafeUpstreamUrl(currentUrl)) {
        return new Response("Recurso bloqueado o no disponible", { status: 403 });
      }

      const baseHeaders = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
        "Accept": "*/*"
      };
      const rangeHdr = !isImg ? context.request.headers.get("range") : null;
      if (rangeHdr) baseHeaders["Range"] = rangeHdr;

      const fetchWithHops = async (sendReferer) => {
        let hopUrl = currentUrl;
        let res = null;
        for (let hop = 0; hop < 4; hop++) {
          const hdrs = { ...baseHeaders };
          if (sendReferer && refUrl && isSafeUpstreamUrl(refUrl)) hdrs["Referer"] = refUrl;
          res = await fetch(hopUrl, { method, headers: hdrs, redirect: "manual" });
          if (res.status >= 300 && res.status < 400) {
            const loc = res.headers.get("location");
            if (!loc) break;
            let nextAbs = "";
            try { nextAbs = new URL(loc, hopUrl).href; } catch (e) { break; }
            if (!isSafeUpstreamUrl(nextAbs)) {
              return { blocked: true, url: hopUrl, res: null };
            }
            hopUrl = nextAbs;
            continue;
          }
          break;
        }
        return { blocked: false, url: hopUrl, res };
      };

      let outcome = await fetchWithHops(true);
      if (!outcome.blocked && outcome.res && outcome.res.status === 403 && refUrl) {
        outcome = await fetchWithHops(false);
      }
      if (outcome.blocked) {
        return new Response("Redirect upstream no permitido", { status: 502 });
      }
      const upstream = outcome.res;
      if (!upstream || upstream.status >= 400) {
        return new Response("Recurso temporalmente no disponible", { status: (upstream && upstream.status) || 502 });
      }

      if (!isImg && outcome.url && outcome.url !== initialUrl && isSafeUpstreamUrl(outcome.url)) {
        const updated = { v: outcome.url, c: meta.c, r: meta.r };
        persistShortsMetaEdge([{ id: decoded.i, video_url: updated.v, cover_url: updated.c, referer: updated.r }], context);
      }

      let ctype = upstream.headers.get("content-type") || (isImg ? "image/jpeg" : "video/mp4");
      if (!isImg && (ctype.includes("octet-stream") || !ctype.startsWith("video/"))) {
        ctype = "video/mp4";
      }

      if (isImg) {
        const imgH = new Headers({
          "Content-Type": ctype,
          "Content-Disposition": "inline",
          "X-Content-Type-Options": "nosniff",
          "Cross-Origin-Resource-Policy": "same-origin",
          "Cache-Control": "public, max-age=604800, s-maxage=604800",
          "X-Velvet-Cover": "MISS-EDGE",
          "Vary": "Origin"
        });
        if (method === "GET" && upstream.status === 200 && ctype.startsWith("image/") && edgeCache && edgeCoverReq && upstream.body) {
          const [outStream, cacheStream] = upstream.body.tee();
          if (typeof context.waitUntil === "function") {
            context.waitUntil(
              edgeCache.put(edgeCoverReq, new Response(cacheStream, {
                status: 200,
                headers: {
                  "Content-Type": ctype,
                  "Content-Disposition": "inline",
                  "X-Content-Type-Options": "nosniff",
                  "Cache-Control": "public, max-age=604800"
                }
              })).catch(() => {})
            );
          }
          return new Response(outStream, { status: 200, headers: imgH });
        }
        return new Response(method === "HEAD" ? null : upstream.body, { status: upstream.status, headers: imgH });
      }

      const vidH = new Headers({
        "Content-Type": ctype,
        "Content-Disposition": "inline",
        "Accept-Ranges": upstream.headers.get("accept-ranges") || "bytes",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store, no-transform",
        "Cross-Origin-Resource-Policy": "same-origin",
        "Referrer-Policy": "no-referrer",
        "X-Robots-Tag": "noindex, noarchive, nosnippet",
        "Vary": "Origin"
      });
      if (upstream.headers.has("content-length")) vidH.set("Content-Length", upstream.headers.get("content-length"));
      if (upstream.headers.has("content-range")) vidH.set("Content-Range", upstream.headers.get("content-range"));
      return new Response(method === "HEAD" ? null : upstream.body, { status: upstream.status, headers: vidH });
    } catch (e) {
      return new Response("Error proxy shorts", { status: 502 });
    }
  }

  const legacyShortsMatch = url.pathname.match(/^\/api\/shorts\/(stream|cover)\/(\d+)$/);
  if (legacyShortsMatch) {
    return new Response("Enlace protegido", {
      status: 403,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "private, no-store" }
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
      /\.(?:mp4|m3u8|webm|m4v|ts)(?:$|[?#])/i.test(targetMediaUrl) ||
      url.pathname.includes("/video/");

    const directVideo = directVideoRedirectUrl(targetMediaUrl);
    if (directVideo && (method === "GET" || method === "HEAD")) {
      const directHeaders = new Headers();
      directHeaders.set("Location", directVideo);
      directHeaders.set("Cache-Control", "public, max-age=86400");
      directHeaders.set("Access-Control-Allow-Origin", "*");
      directHeaders.set("X-Velvet-Media", "direct");
      return new Response(null, { status: 302, headers: directHeaders });
    }

    // Parámetros de variantes y compresión de imagen (Fase B)
    const isCoverVariant = url.searchParams.get("cov") === "1";
    const rawW = parseInt(url.searchParams.get("w") || "0", 10);
    const ALLOWED_WIDTHS = [120, 240, 360, 480, 720, 1080];
    let targetWidth = 0;
    if (rawW > 0) {
      targetWidth = ALLOWED_WIDTHS.reduce((prev, curr) =>
        Math.abs(curr - rawW) < Math.abs(prev - rawW) ? curr : prev
      );
    }
    const effectiveThumbWidth = targetWidth > 0 ? targetWidth : (isCoverVariant ? 420 : 0);

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
    const etagSeed = `${targetMediaUrl}_w${targetWidth}_cov${isCoverVariant ? 1 : 0}_q${targetQuality}_f${targetFormat}`;
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
    normUrl.searchParams.set("mv", "2");
    if (tParam) normUrl.searchParams.set("t", tParam);
    if (targetWidth) normUrl.searchParams.set("w", String(targetWidth));
    if (isCoverVariant) normUrl.searchParams.set("cov", "1");
    if (targetQuality) normUrl.searchParams.set("q", String(targetQuality));
    normUrl.searchParams.set("fmt", targetFormat);

    const cache = typeof caches !== "undefined" ? caches.default : null;
    const cacheKey = new Request(normUrl.toString(), {
      method: "GET"
    });

    if (cache && !isVideo && method === "GET") {
      try {
        const cached = await cache.match(cacheKey);
        if (cached) {
          const ch = new Headers(cached.headers);
          ch.set("X-Media-Cache", "HIT-CLOUDFLARE");
          ch.delete("X-Powered-By");
          ch.set("Access-Control-Allow-Origin", "*");
          ch.set("ETag", etag);
          ch.set("Vary", "Accept");
          return new Response(cached.body, { status: cached.status, headers: ch });
        }
      } catch (e) {}
    }

    const spoofedReferer = inferUpstreamReferer(targetMediaUrl, payload.r || "");
    const clientRange = context.request.headers.get("Range");

    const buildUpstreamHeaders = (currentReferer, includeRange, currentUrl) => {
      let activeReferer = currentReferer || spoofedReferer;
      const targetStr = String(currentUrl || targetMediaUrl || "");
      let extraCookie = "";

      if (targetStr.includes("xasiat.com") || targetStr.includes("xascdn.li")) {
        const xMatch = targetStr.match(/\/sources\/(\d+)\/(\d+)\//i);
        if (xMatch) {
          const albumId = xMatch[2];
          activeReferer = `https://www.xasiat.com/albums/${albumId}/`;
          extraCookie = `kt_qparams=id%3D${albumId}; kt_acctoken=MTkwLjYyLjg5LjE3Mg`;
        }
      }

      const headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
        "Referer": activeReferer,
        "Accept": isVideo ? "*/*" : "image/avif,image/webp,image/apng,image/jpeg,image/png,*/*;q=0.8",
        "Accept-Encoding": "identity"
      };
      if (extraCookie) headers["Cookie"] = extraCookie;
      const originHeader = refererOrigin(activeReferer);
      if (originHeader) headers["Origin"] = originHeader;
      if (includeRange && clientRange) headers["Range"] = clientRange;
      return headers;
    };

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

      const fetchCandidate = async (candidateUrl, withResize = false) => {
        if (!isSafeUpstreamUrl(candidateUrl) && !isGalleryFallbackUrl(candidateUrl)) {
          return new Response("blocked", { status: 403, headers: { "content-type": "text/plain" } });
        }
        let current = candidateUrl;
        let last = null;
        for (let hop = 0; hop < 4; hop++) {
          last = await fetch(current, {
            method: method === "HEAD" ? "HEAD" : "GET",
            headers: buildUpstreamHeaders(spoofedReferer, false, current),
            redirect: "manual",
            signal: typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(5500) : undefined,
            cf: {
              cacheEverything: true,
              cacheTtl: 31536000,
              ...(withResize && hop === 0 && imageTransform ? { image: imageTransform } : {})
            }
          });
          if (last.status >= 300 && last.status < 400) {
            const loc = last.headers.get("location");
            if (!loc) return last;
            let next = "";
            try { next = new URL(loc, current).href; } catch (e) { return last; }
            if (!isFollowableMediaRedirect(next, current)) return last;
            current = next;
            continue;
          }
          return last;
        }
        return last;
      };

      let upstream;
      let finalVideoUrl = targetMediaUrl;
      let servedFrom = "";
      if (isVideo) {
        let curVideo = targetMediaUrl;
        for (let hop = 0; hop < 4; hop++) {
          upstream = await fetch(curVideo, {
            method,
            headers: buildUpstreamHeaders(spoofedReferer, true, curVideo),
            redirect: "manual",
            signal: typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined,
            cf: { cacheTtl: 0, cacheEverything: false }
          });
          if (upstream.status >= 300 && upstream.status < 400) {
            const loc = upstream.headers.get("location");
            if (!loc) break;
            let nextUrl = "";
            try { nextUrl = new URL(loc, curVideo).href; } catch (e) { break; }
            if (!isFollowableMediaRedirect(nextUrl, curVideo)) {
              return new Response("Redirect upstream no permitido", {
                status: 502,
                headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...getCorsHeaders(origin) }
              });
            }
            curVideo = nextUrl;
            finalVideoUrl = curVideo;
            continue;
          }
          break;
        }
        if (!upstream || (!upstream.ok && (upstream.status === 403 || upstream.status === 401 || upstream.status === 503))) {
          if (!upstream || (isSafeUpstreamUrl(finalVideoUrl) && (upstream.status >= 400 || !upstream.body))) {
            return new Response("Video upstream error", {
              status: (upstream && upstream.status) || 502,
              headers: { "Cache-Control": "no-store", ...getCorsHeaders(origin) }
            });
          }
        }
      } else {
        const plan = galleryFetchPlan(targetMediaUrl, effectiveThumbWidth);
        const primaryUrl = normalizeUpstreamUrl(targetMediaUrl);
        upstream = null;
        for (let i = 0; i < plan.length; i++) {
          const candidate = plan[i];
          const canResize = candidate === primaryUrl && !!imageTransform && !hostRejectsImageResize(candidate);
          try {
            upstream = await fetchCandidate(candidate, canResize);
            if (canResize && !upstreamLooksLikeImage(upstream)) {
              upstream = await fetchCandidate(candidate, false);
            }
          } catch (candidateErr) {
            upstream = null;
          }
          if (upstreamLooksLikeImage(upstream)) {
            servedFrom = candidate;
            break;
          }
        }
        if (!upstreamLooksLikeImage(upstream)) {
          return new Response("Imagen no disponible", {
            status: 502,
            headers: {
              "Content-Type": "text/plain; charset=utf-8",
              "Cache-Control": "no-store",
              "X-Velvet-Media": "upstream-rejected",
              ...getCorsHeaders(origin)
            }
          });
        }
      }

      const respHeaders = new Headers();
      respHeaders.set("Content-Type", upstream.headers.get("content-type") || (isVideo ? "video/mp4" : "image/jpeg"));
      respHeaders.set("Access-Control-Allow-Origin", "*");
      if (!isVideo && servedFrom && servedFrom !== normalizeUpstreamUrl(targetMediaUrl)) {
        respHeaders.set("X-Velvet-Media", "mirror");
      }

      if (isVideo) {
        respHeaders.set("Accept-Ranges", "bytes");
        respHeaders.set("Cache-Control", (upstream && upstream.ok) ? "public, max-age=7200" : "no-store");
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
      const isM3u8 = finalVideoUrl.includes(".m3u8") || (upstream.headers.get("content-type") || "").toLowerCase().includes("mpegurl");
      if (isM3u8 && upstream.ok) {
        try {
          const manifestText = await upstream.text();
          const lastSlash = finalVideoUrl.lastIndexOf("/");
          const baseUrl = lastSlash !== -1 ? finalVideoUrl.substring(0, lastSlash + 1) : finalVideoUrl + "/";
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
                  if (!isSafeUpstreamUrl(abs) && !isFollowableMediaRedirect(abs, finalVideoUrl)) return line;
                  const tok = await encodeMediaToken(abs, spoofedReferer, MEDIA_SECRET);
                  return line.replace(match[0], `URI="/api/media?t=${tok}"`);
                }
              }
              return line;
            }
            const abs = trimmed.startsWith("http") ? trimmed : new URL(trimmed, baseUrl).href;
            if (!isSafeUpstreamUrl(abs) && !isFollowableMediaRedirect(abs, finalVideoUrl)) return "";
            const tok = await encodeMediaToken(abs, spoofedReferer, MEDIA_SECRET);
            return `/api/media?t=${tok}`;
          }));
          const rewrittenBody = rewritten.join("\n");
          const m3u8Headers = new Headers(respHeaders);
          m3u8Headers.delete("Content-Length");
          m3u8Headers.set("Content-Type", "application/vnd.apple.mpegurl; charset=utf-8");
          m3u8Headers.set("Access-Control-Allow-Origin", "*");
          m3u8Headers.set("Cache-Control", "public, max-age=3600");
          return new Response(rewrittenBody, { status: 200, headers: m3u8Headers });
        } catch (mErr) {
          return new Response("Error procesando lista HLS", { status: 502, headers: { "Cache-Control": "no-store", ...getCorsHeaders(origin) } });
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
      console.error("[Velvet-Media] Error upstream:", err);
      return new Response(JSON.stringify({ error: "Media upstream no disponible" }), {
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
    const rawId = itemDetailMatch[1] ? itemDetailMatch[1].replace(/[^a-zA-Z0-9_\-]/g, "").slice(0, 64) : null;
    const decodedSourceSlug = itemDetailMatch[2] ? sanitizeSlug(decodeURIComponent(itemDetailMatch[2])) : null;
    const rawSource = decodedSourceSlug ? (DETAIL_SOURCE_ALIAS_MAP[decodedSourceSlug] || decodedSourceSlug) : null;
    const rawSourceId = itemDetailMatch[3] ? decodeURIComponent(itemDetailMatch[3]).replace(/[^a-zA-Z0-9_.\-:]/g, "").slice(0, 128) : null;
    if (!rawId && (!rawSource || !rawSourceId)) {
      return new Response(JSON.stringify({ detail: "Parámetros de elemento inválidos" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
      });
    }

    // Cache L1 de Memoria RAM Isolate (0ms)
    const detailCacheKey = `v2:${url.pathname}`;
    const l1Detail = getIsolateCache(ISOLATE_DETAIL_CACHE, detailCacheKey, 86400000);
    if (l1Detail && (!l1Detail.includes('"pages":[]') || l1Detail.includes('"chapters":['))) {
      let parsedL1 = null;
      try { parsedL1 = JSON.parse(l1Detail); } catch (e) {}
      const vipL1 = await checkDetailVipAccess(context, parsedL1 || { id: rawId || rawSourceId, source: rawSource, source_id: rawSourceId }, SUPABASE_URL, SUPABASE_KEY, SUPABASE_ADMIN_KEY, env, origin);
      if (!vipL1.allowed) return vipL1.response;
      return new Response(l1Detail, {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": vipL1.vipGated ? "private, no-store" : "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800",
          "X-Cloudflare-RAM-Cache": "HIT",
          "X-Cloudflare-Detail-Cache": "HIT",
          ...getCorsHeaders(origin)
        }
      });
    }

    // Cache L2 de Borde Cloudflare para detalle de cómics y videos (aceleración instantánea en móvil)
    const cache = typeof caches !== "undefined" ? caches.default : null;
    const cacheKey = new Request(`${url.origin}${url.pathname}?dcv=2`, { method: "GET" });
    if (cache) {
      try {
        const cached = await cache.match(cacheKey);
        if (cached) {
          const bodyText = await cached.text();
          if (!bodyText.includes('"pages":[]') || bodyText.includes('"chapters":[')) {
            setIsolateCache(ISOLATE_DETAIL_CACHE, detailCacheKey, bodyText);
            let parsedL2 = null;
            try { parsedL2 = JSON.parse(bodyText); } catch (e) {}
            const vipL2 = await checkDetailVipAccess(context, parsedL2 || { id: rawId || rawSourceId, source: rawSource, source_id: rawSourceId }, SUPABASE_URL, SUPABASE_KEY, SUPABASE_ADMIN_KEY, env, origin);
            if (!vipL2.allowed) return vipL2.response;
            const edgeHeaders = new Headers(cached.headers);
            edgeHeaders.set("X-Cloudflare-Detail-Cache", "HIT");
            for (const [k, v] of Object.entries(getCorsHeaders(origin))) edgeHeaders.set(k, v);
            if (vipL2.vipGated) edgeHeaders.set("Cache-Control", "private, no-store");
            return new Response(bodyText, { status: 200, headers: edgeHeaders });
          }
        }
      } catch (e) {}
    }

    const targetPmvId = (rawSource === "pmvhaven" ? rawSourceId : rawId);
    if (rawSource === "pmvhaven" || (targetPmvId && /^[a-f0-9]{24}$/i.test(targetPmvId))) {
      try {
        const pmvRes = await fetch(`https://pmvhaven.com/api/videos/${targetPmvId}`, {
          signal: typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(10000) : undefined,
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
            const rawVideo = v.videoUrl || v.hlsMasterPlaylistUrl || "";
            const coverToken = rawCover ? await encodeMediaToken(rawCover, "https://pmvhaven.com/", MEDIA_SECRET) : "";
            const videoToken = rawVideo ? await encodeMediaToken(rawVideo, "https://pmvhaven.com/", MEDIA_SECRET) : "";
            const hlsToken = (v.hlsMasterPlaylistUrl && v.hlsMasterPlaylistUrl !== rawVideo)
              ? await encodeMediaToken(v.hlsMasterPlaylistUrl, "https://pmvhaven.com/", MEDIA_SECRET)
              : "";
            const pmvSources = [];
            if (rawVideo) {
              pmvSources.push({
                quality: rawVideo.includes(".m3u8") ? "Auto HLS" : "1080p HD",
                url: videoToken ? `/api/media?t=${videoToken}` : "",
                format: rawVideo.includes(".m3u8") ? "m3u8" : "mp4"
              });
            }
            if (hlsToken) {
              pmvSources.push({
                quality: "Master Multi-Bitrate HD",
                url: `/api/media?t=${hlsToken}`,
                format: "m3u8"
              });
            }
            const detailPayload = {
              id: v._id,
              source: "pmvhaven",
              source_id: v._id,
              title: cleanPublicTitle(v.title) || "Video HD",
              cover_url: coverToken ? `/api/media?t=${coverToken}` : "",
              media_type: "video",
              tags: sanitizePublicTags(v.tags || []),
              artists: sanitizePublicArtists(v.uploaderUsername ? [v.uploaderUsername] : [], "video"),
              url: "",
              page_count: 0,
              pages: [],
              chapters: [],
              video_sources: pmvSources,
              extra: {
                duration: v.duration || "",
                durationSeconds: v.durationSeconds || 0,
                views: v.views || 0,
                likes: v.likes || 0
              }
            };
            const jsonStr = JSON.stringify(detailPayload);
            setIsolateCache(ISOLATE_DETAIL_CACHE, detailCacheKey, jsonStr);
            const vipPmv = await checkDetailVipAccess(context, detailPayload, SUPABASE_URL, SUPABASE_KEY, SUPABASE_ADMIN_KEY, env, origin);
            if (!vipPmv.allowed) return vipPmv.response;
            return new Response(jsonStr, {
              status: 200,
              headers: {
                "Content-Type": "application/json; charset=utf-8",
                "Cache-Control": vipPmv.vipGated ? "private, no-store" : "public, max-age=3600, s-maxage=86400",
                ...getCorsHeaders(origin)
              }
            });
          }
        }
      } catch (pmvErr) {
        console.error("PMVHaven detail fetch error:", pmvErr);
      }
      if (targetPmvId && /^[a-f0-9]{24}$/i.test(targetPmvId)) {
        return new Response(JSON.stringify({ detail: "Video no encontrado" }), {
          status: 404,
          headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
        });
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
        const vipGame = await checkDetailVipAccess(context, maskedGame, SUPABASE_URL, SUPABASE_KEY, SUPABASE_ADMIN_KEY, env, origin);
        if (!vipGame.allowed) return vipGame.response;
        return new Response(gameJson, {
          status: 200,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": vipGame.vipGated ? "private, no-store" : "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800",
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

    if (rawSource === "pmvhaven" || rawSource === "video" || rawSource === "damplips" || rawSource === "redporn" || rawSource === "pornone" || (rawId && String(rawId).startsWith("velvet_vid_"))) {
      try {
        const videos = await loadVideoCatalog(context, url);
        const wanted = String(rawSourceId || rawId || "");
        const found = (videos || []).find(v => String(v.source_id) === wanted || String(v.id) === wanted);
        if (found) {
          const maskedVideo = await maskVideoItem(found, MEDIA_SECRET);
          const videoJson = JSON.stringify({
            ...maskedVideo,
            pages: [],
            chapters: []
          });
          setIsolateCache(ISOLATE_DETAIL_CACHE, detailCacheKey, videoJson);
          const vipVid = await checkDetailVipAccess(context, maskedVideo, SUPABASE_URL, SUPABASE_KEY, SUPABASE_ADMIN_KEY, env, origin);
          if (!vipVid.allowed) return vipVid.response;
          return new Response(videoJson, {
            status: 200,
            headers: {
              "Content-Type": "application/json; charset=utf-8",
              "Cache-Control": vipVid.vipGated ? "private, no-store" : "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800",
              ...getCorsHeaders(origin)
            }
          });
        }
      } catch (videoDetailErr) {
        console.error("[Velvet-Detail] Video local fallback error:", videoDetailErr);
      }
    }

    try {
      const detailTargetUrl = SUPABASE_URL;
      const detailTargetKey = SUPABASE_ADMIN_KEY;
      const spRes = await fetch(`${detailTargetUrl}/rest/v1/items?${queryParam}&status=neq.blocked&real_people=is.false&limit=1`, {
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
      if (it.status === "blocked" || it.real_people === true) {
        return new Response(JSON.stringify({ detail: "Elemento no encontrado" }), {
          status: 404,
          headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
        });
      }

      // Función de limpieza estricta: elimina publicidad, banners VIP y miniaturas de posts relacionados (YARPP)
      const cleanComicPagesList = (pages) => {
        if (!pages || !Array.isArray(pages) || pages.length === 0) return [];
        const adRegex = /(logo|banner|advert|patrocinador|donar|promo|avatar|gravatar|ACCESO-VIPS|HACERSE-VIP|ZONAVIP|CHAT-VIPS|portadavip|unirse[-_]vip|acceso[-_]vip|hacerse[-_]vip|ms-icon|favicon|\/themes\/|\/plugins\/|discord|telegram|yarpp|thumbnail)/i;

        const out = [];
        for (const p of pages) {
          const u = (typeof p === "string" ? p : (p && (p.image_url || p.url) ? (p.image_url || p.url) : "")).trim();
          if (!u || u.startsWith("data:") || adRegex.test(u)) continue;
          out.push({
            index: out.length + 1,
            image_url: u,
            referer: (p && typeof p === "object" && p.referer) ? String(p.referer) : ""
          });
        }
        return out;
      };

      // Si el cómic ya tiene páginas, sanitizarlas inmediatamente sin sobrescribir la base de datos en lecturas
      const isComic = it.media_type === "comic" || !it.media_type;
      if (isComic && Array.isArray(it.pages) && it.pages.length > 0) {
        const cleaned = cleanComicPagesList(it.pages);
        it.pages = cleaned;
        it.page_count = cleaned.length;
        if (!it.cover_url && it.pages[0]) it.cover_url = it.pages[0].image_url;
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
                  "apikey": SUPABASE_ADMIN_KEY,
                  "Authorization": `Bearer ${SUPABASE_ADMIN_KEY}`,
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
              let high = 250;
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
                    "apikey": SUPABASE_ADMIN_KEY,
                    "Authorization": `Bearer ${SUPABASE_ADMIN_KEY}`,
                    "Content-Type": "application/json",
                    "Prefer": "return=minimal"
                  },
                  body: JSON.stringify({ pages: it.pages, page_count: it.page_count })
                }).catch(() => {})
              );
            }
          }
        } else if (it.url && it.url.startsWith("http") && isSafeUpstreamUrl(it.url)) {
          // Caso B: Cómics web / WordPress (melapelocondibujos, melapelacomics, reycomix, pornocomic, vercomicporno, etc.)
          try {
            const pageResp = await fetch(it.url, {
              signal: typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(10000) : undefined,
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
                        "apikey": SUPABASE_ADMIN_KEY,
                        "Authorization": `Bearer ${SUPABASE_ADMIN_KEY}`,
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
                signal: typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(10000) : undefined,
                headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", "Accept": "application/json" }
              });
              if (pmvRes.ok) {
                const pmvData = await pmvRes.json();
                const vData = pmvData?.video || pmvData?.data;
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
        if (streams.length === 0 && it.url && it.url.startsWith("http") && isSafeUpstreamUrl(it.url.replace("es.anyporn.com", "anyporn.com"))) {
          try {
            const cleanUrl = it.url.replace("es.anyporn.com", "anyporn.com");
            const vResp = await fetch(cleanUrl, {
              signal: typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(10000) : undefined,
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
                  "apikey": SUPABASE_ADMIN_KEY,
                  "Authorization": `Bearer ${SUPABASE_ADMIN_KEY}`,
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
        image_url: p.image_url ? `/api/media?t=${await encodeMediaToken(p.image_url, p.referer || it.url || "", MEDIA_SECRET)}` : ""
      })));
      const maskedVideoSources = await Promise.all(sortedSources.map(async vs => ({
        ...vs,
        url: vs.url ? `/api/media?t=${await encodeMediaToken(vs.url, it.url || vs.referer || "", MEDIA_SECRET)}` : ""
      })));

      const masked = {
        id: it.id,
        source: it.source || "",
        source_id: it.source_id != null ? String(it.source_id) : "",
        title: cleanPublicTitle(it.title) || it.title || "Contenido VIP",
        media_type: it.media_type || (isComic ? "comic" : "video"),
        tags: sanitizePublicTags(it.tags),
        artists: sanitizePublicArtists(it.artists, it.media_type),
        url: "", // Ocultar URL original
        cover_url: maskedCoverToken ? `/api/media?t=${maskedCoverToken}` : "",
        cover_fallback: it.cover_fallback || "",
        page_count: it.page_count || maskedPages.length || 0,
        chapters: Array.isArray(it.chapters) ? it.chapters : undefined,
        synopsis: it.synopsis || undefined,
        extra: it.extra || undefined,
        pages: maskedPages,
        video_sources: maskedVideoSources
      };

      const jsonStr = JSON.stringify(masked);
      const isComicEmpty = isComic && (!masked.pages || masked.pages.length === 0) && (!it.chapters || it.chapters.length === 0);
      const shouldCache = !isEphemeral && !isComicEmpty;

      if (shouldCache) {
        setIsolateCache(ISOLATE_DETAIL_CACHE, detailCacheKey, jsonStr);
      }

      const vipMain = await checkDetailVipAccess(context, masked, SUPABASE_URL, SUPABASE_KEY, SUPABASE_ADMIN_KEY, env, origin);
      if (!vipMain.allowed) return vipMain.response;

      const allowPublicEdge = shouldCache && !vipMain.vipGated;
      const resp = new Response(jsonStr, {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": vipMain.vipGated
            ? "private, no-store"
            : (allowPublicEdge ? "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800" : "no-store, no-cache, must-revalidate"),
          ...getCorsHeaders(origin)
        }
      });

      if (cache && allowPublicEdge && method === "GET") {
        try {
          context.waitUntil(cache.put(cacheKey, resp.clone()));
        } catch (e) {}
      }

      return resp;
    } catch (err) {
      console.error("[Velvet-Detail] Error cargando detalle:", err);
      return new Response(JSON.stringify({ detail: "Error interno consultando elemento" }), {
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
    const rawTagParam = (url.searchParams.get("tag") || "").trim();
    const tag = rawTagParam.replace(/[\x00-\x1f<>{}]/g, "").slice(0, 64);
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
          for (const [k, v] of Object.entries(getCorsHeaders(origin))) edgeHeaders.set(k, v);
          return new Response(method === "HEAD" ? null : bodyText, { status: 200, headers: edgeHeaders });
        }
      } catch (e) {}
    }



    const preferLivePmv = env.ENABLE_PMVHAVEN_LIVE !== "false" && url.searchParams.get("source") !== "supabase" && url.searchParams.get("source") !== "db";
    // "Al Azar" en videos: varias páginas repartidas por todo PMV, no el
    // sort=random cacheado que devuelve siempre el mismo cubo.
    if (mediaType === "video" && preferLivePmv && freshShuffle && (!category || category === "all")) {
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
    if (mediaType === "video" && preferLivePmv && !freshShuffle && (!category || category === "all")) {
      // sort=random de PMVHaven devuelve otra tanda en cada request.
      // La ventana de 3 h permuta la página y orderCatalogForSlot fija el orden.
      let pmvSort = "recent";
      if (sort === "views") pmvSort = "views";
      else if (sort === "rating") pmvSort = "rating";

      let fetchPmvPage = page;
      if ((sort === "random" || freshShuffle) && !q && (!category || category === "all")) {
        const seedVal = freshShuffle ? freshSeed : catalogSlot;
        const randomBasePage = ((seedVal * 137) % 2500) + 1;
        fetchPmvPage = ((randomBasePage + (page - 1) * 3) % 2500) + 1;
        // La fórmula anterior puede repetir página cuando PMV recorta el rango.
        // La permutación biyectiva deja la 494 y la 495 en páginas distintas
        // y cambia toda la categoría al cambiar la ventana de 3 horas.
        let pmvSeed = (Math.imul(seedVal, 997) ^ 0x51a7) >>> 0;
        if ((pmvSeed % 1900) < 23) pmvSeed = (pmvSeed + 137) >>> 0;
        fetchPmvPage = 600 + permutePageIndex(Math.max(0, page - 1), 1900, pmvSeed);
      }

      let pmvApiUrl = `https://pmvhaven.com/api/videos?page=${fetchPmvPage}&limit=${pageSize}&sort=${pmvSort}`;
      if (category && category !== "all") {
        pmvApiUrl += `&tag=${encodeURIComponent(category)}`;
      } else if (tag) {
        pmvApiUrl += `&tag=${encodeURIComponent(tag)}`;
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

          if (vList.length > 0) {
            if ((sort === "random" || freshShuffle) && !q && vList.length > 1) {
              vList = orderCatalogForSlot(
                vList.map((v) => ({ ...v, id: v._id || v.id })),
                freshShuffle ? freshSeed : catalogSlot,
                "video"
              );
            }

            const items = await Promise.all(vList.map(async v => {
              const rawCover = v.thumbnailUrl || (v.thumbnailSizes && v.thumbnailSizes.lg && v.thumbnailSizes.lg.url) || "";
              const rawVideo = v.videoUrl || v.hlsMasterPlaylistUrl || "";
              const vipLocked = isItemVIPGated({ id: v._id, source: "pmvhaven", source_id: v._id, title: v.title });
              const coverToken = rawCover ? await encodeMediaToken(rawCover, "https://pmvhaven.com/", MEDIA_SECRET) : "";
              const videoToken = (!vipLocked && rawVideo) ? await encodeMediaToken(rawVideo, "https://pmvhaven.com/", MEDIA_SECRET) : "";
              return {
                id: v._id,
                source: "pmvhaven",
                source_id: v._id,
                title: cleanPublicTitle(v.title) || "Video HD",
                cover_url: coverToken ? `/api/media?t=${coverToken}` : "",
                media_type: "video",
                tags: sanitizePublicTags(v.tags || []),
                artists: sanitizePublicArtists(v.uploaderUsername ? [v.uploaderUsername] : [], "video"),
                url: "",
                vip_locked: vipLocked,
                page_count: 0,
                video_sources: (!vipLocked && rawVideo) ? [
                  {
                    quality: rawVideo.includes(".m3u8") ? "Auto HLS" : "1080p HD",
                    url: videoToken ? `/api/media?t=${videoToken}` : "",
                    format: rawVideo.includes(".m3u8") ? "m3u8" : "mp4"
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

            const pmvResponse = new Response(method === "HEAD" ? null : jsonStr, {
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
    const rotateCatalog = (sort === "random" || freshShuffle) && !q;
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
          tag,
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

    const shouldUseVideoCatalog = mediaType === "video" && url.searchParams.get("source") !== "supabase" && url.searchParams.get("source") !== "db" && (
      (category && category !== "all") || env.ENABLE_PMVHAVEN_LIVE !== "false"
    );
    if (shouldUseVideoCatalog) {
      try {
        const videos = await loadVideoCatalog(context, url);
        if (videos && videos.length > 0) {
          const seeded = buildVideoCatalogPage(videos, {
            page,
            pageSize,
            sort,
            q,
            category,
            tag,
            seed: effectiveSeed
          });
          const items = await Promise.all((seeded.items || []).map(it => maskVideoItem(it, MEDIA_SECRET)));
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
          const vidResp = new Response(method === "HEAD" ? null : jsonStr, {
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
            try { context.waitUntil(cache.put(cacheKey, vidResp.clone())); } catch (e) {}
          }
          return vidResp;
        }
      } catch (vidErr) {
        console.error("[Velvet-Items] Videos error:", vidErr);
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
    filterQuery += "&status=neq.blocked&real_people=is.false";

    if (tag) {
      const safeTag = tag.replace(/["\\{}(),]/g, "").trim();
      if (safeTag) {
        const lowerTag = safeTag.toLowerCase();
        const titleTag = lowerTag.replace(/\b\w/g, ch => ch.toUpperCase());
        const variants = Array.from(new Set([safeTag, lowerTag, titleTag]));
        if (variants.length === 1) {
          filterQuery += `&tags=cs.{${encodeURIComponent(variants[0])}}`;
        } else {
          const orTags = variants.map(v => `tags.cs.{${encodeURIComponent(v)}}`).join(",");
          filterQuery += `&or=(${orTags})`;
        }
      }
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
        else if (category === "western") catTerm = "western";

        // Categorías semánticas reales para Cómics y Manga
        if (category === "doujin" || category === "manga") {
          filterQuery += "&or=(source.in.(3hentai,hentaipaw,doujins),search_text.ilike.*manga*,search_text.ilike.*doujin*,search_text.ilike.*japones*)";
        } else if (category === "western" || category === "comic" || category === "comics") {
          filterQuery += "&or=(source.in.(comics18_net,comics18_org,comicspornoxxx,reycomix,vercomicsporno,cartooncomixhd,pornocomic,sexkomix2,comicsparaadultos),search_text.ilike.*comic*)";
        } else if (category === "3d") {
          filterQuery += "&or=(source.in.(melapelacomics,melapelocondibujos,mhcomics),search_text.ilike.*3d*,search_text.ilike.*cgi*,search_text.ilike.*render*)";
        } else if (category === "manhwa") {
          filterQuery += "&or=(source.in.(leermanhwas,manhwaweb),search_text.ilike.*manhwa*,search_text.ilike.*corean*)";
        } else if (category === "parody") {
          filterQuery += "&or=(search_text.ilike.*parod*,source.in.(cartooncomixhd,melapelocondibujos))";
        } else {
          filterQuery += `&search_text=ilike.*${encodeURIComponent(catTerm)}*`;
        }
      }
      if (mediaType === "gallery" || mediaType === "cosplay" || mediaType === "video") {
        filterQuery += `&search_text=ilike.*${encodeURIComponent(catTerm)}*`;
      }
    }

    let rawItems = [];
    let totalCount = estimatedTotal;
    let usedShuffleSample = false;
    let filteredSpan = null;
    if (!q) {
      try {
        filteredSpan = await fetchCatalogSpan(SUPABASE_URL, SUPABASE_ADMIN_KEY, filterQuery);
      } catch (spanErr) {
        filteredSpan = null;
      }
      if (filteredSpan && filteredSpan.total > 0) {
        totalCount = filteredSpan.total;
      } else if (filteredSpan && filteredSpan.total === 0 && (tag || (category && category !== "all"))) {
        totalCount = 0;
      }
    }

    try {
      if (freshShuffle || rotateCatalog) {
        try {
          const sampled = await sampleSupabaseShuffle({
            supabaseUrl: SUPABASE_URL,
            apiKey: SUPABASE_ADMIN_KEY,
            filterQuery,
            selectFields,
            page: safePage,
            pageSize,
            seed: effectiveSeed,
            estimatedTotal: totalCount,
            span: filteredSpan
          });
          if (sampled && Array.isArray(sampled.items) && sampled.items.length) {
            rawItems = sampled.items;
            totalCount = sampled.total || totalCount;
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
      Math.max(pageSize, totalCount),
      rotateCatalog ? catalogSlot : 1,
      rotateCatalog
    );
    let offset = pagePlan.offset;
    let cursorId = null;
    if (offset > 240 && !q) {
      const boundaryKey = `boundary:v3:${filterQuery}:${offset}`;
      const cachedBoundary = getIsolateCache(ISOLATE_CATALOG_CACHE, boundaryKey, 1800000);
      let boundaryId = cachedBoundary && cachedBoundary.id ? Number(cachedBoundary.id) : 0;
      if (!boundaryId) {
        try {
          const probeUrl = `${SUPABASE_URL}/rest/v1/items?select=id&limit=1&offset=${offset}&order=id.desc&${filterQuery}`;
          const probeRes = await fetch(probeUrl, {
            headers: { "apikey": SUPABASE_ADMIN_KEY, "Authorization": `Bearer ${SUPABASE_ADMIN_KEY}` }
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
      const activeQueryKey = SUPABASE_ADMIN_KEY;
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
          // El offset ya no existe en este filtro. Repetir la página 1
          // hacía que el usuario viera otra vez los mismos títulos.
          rawItems = [];
          spRes = null;
        }
        if (spRes && !spRes.ok) {
          const finalErr = spRes === null ? errText : await spRes.text().catch(() => errText);
          console.error("[Velvet-Items] PostgREST error:", finalErr);
          return new Response(JSON.stringify({ error: "Error consultando catálogo" }), {
            status: 500,
            headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
          });
        }
      }

      // Obtener el conteo real exacto mediante cabecera Content-Range
      if (spRes) {
      const contentRange = spRes.headers.get("content-range");
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
      }
      }
      const items = await Promise.all((rawItems || []).map(async it => {
        const isGame = it.media_type === "game";
        const vipLocked = isItemVIPGated(it);
        const maskedCover = isGame
          ? { cover_url: it.cover_url || "", cover_fallback: "" }
          : await maskCoverFields(it.cover_url, MEDIA_SECRET);
        const videoSources = (vipLocked && !isGame)
          ? []
          : await Promise.all((it.video_sources || []).map(async vs => ({
              ...vs,
              url: vs.url ? `/api/media?t=${await encodeMediaToken(vs.url, "", MEDIA_SECRET)}` : ""
            })));
        const firstVs = (it.video_sources && it.video_sources[0]) || {};
        return {
          id: it.id,
          source: it.source || "velvet",
          source_id: it.source_id ? String(it.source_id) : String(it.id),
          title: cleanPublicTitle(it.title) || it.title,
          cover_url: maskedCover.cover_url,
          cover_fallback: maskedCover.cover_fallback,
          media_type: it.media_type,
          tags: sanitizePublicTags(it.tags),
          artists: sanitizePublicArtists(it.artists, it.media_type),
          url: "", // Ocultar URL original
          vip_locked: vipLocked,
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
      console.error("[Velvet-Items] Error fatal en /api/items:", err);
      return new Response(JSON.stringify({ error: "Error interno consultando catálogo" }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
      });
    }
  }

  // =========================================================================
  // 4. RANDOM / SORPRÉNDEME (/api/random)
  // =========================================================================
  if (url.pathname === "/api/random" && method === "GET") {
    const mediaType = (url.searchParams.get("media_type") || "comic").trim().toLowerCase();
    const count = Math.min(10, Math.max(1, parseInt(url.searchParams.get("count") || "1", 10)));
    const rndArr = new Uint32Array(1);
    crypto.getRandomValues(rndArr);
    const randomSeed = (rndArr[0] % 2147483645) + 1;

    if (mediaType === "game") {
      try {
        const games = await loadGameCatalog(context, url);
        const ordered = orderCatalogForSlot(games, randomSeed, "game");
        const sample = ordered.slice(0, count);
        const items = await Promise.all(sample.map(it => maskGameItem(it, MEDIA_SECRET)));
        return new Response(JSON.stringify(items), {
          status: 200,
          headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...getCorsHeaders(origin) }
        });
      } catch (gErr) {
        return new Response("[]", { status: 200, headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) } });
      }
    }

    const preferLivePmv = env.ENABLE_PMVHAVEN_LIVE !== "false" && url.searchParams.get("source") !== "supabase" && url.searchParams.get("source") !== "db";
    if (mediaType === "video") {
      if (preferLivePmv) {
        try {
          const pmvPage = (randomSeed % 2500) + 1;
          const pmvRes = await fetch(`https://pmvhaven.com/api/videos?sort=recent&page=${pmvPage}&limit=${Math.max(count, 6)}`, {
            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", "Referer": "https://pmvhaven.com/" }
          });
          if (pmvRes.ok) {
            const pmvData = await pmvRes.json();
            const rawList = pmvData.videos || [];
            const vList = orderCatalogForSlot(rawList.map(v => ({ ...v, id: v._id || v.id })), randomSeed, "video").slice(0, count);
            if (vList.length > 0) {
              const items = await Promise.all(vList.map(async v => {
                const rawCover = v.thumbnailUrl || (v.thumbnailSizes && v.thumbnailSizes.lg && v.thumbnailSizes.lg.url) || "";
                const rawVidUrl = v.videoUrl || v.hlsMasterPlaylistUrl || "";
                const vipLocked = isItemVIPGated({ id: v._id, source: "pmvhaven", source_id: v._id, title: v.title });
                const coverToken = rawCover ? await encodeMediaToken(rawCover, "https://pmvhaven.com/", MEDIA_SECRET) : "";
                const videoToken = (!vipLocked && rawVidUrl) ? await encodeMediaToken(rawVidUrl, "https://pmvhaven.com/", MEDIA_SECRET) : "";
                return {
                  id: v._id,
                  source: "pmvhaven",
                  source_id: v._id,
                  title: cleanPublicTitle(v.title) || "Video HD",
                  cover_url: coverToken ? `/api/media?t=${coverToken}` : "",
                  media_type: "video",
                  tags: sanitizePublicTags(v.tags || []),
                  artists: sanitizePublicArtists(v.uploaderUsername ? [v.uploaderUsername] : [], "video"),
                  url: "",
                  vip_locked: vipLocked,
                  page_count: 0,
                  video_sources: videoToken ? [{
                    quality: rawVidUrl.includes(".m3u8") ? "Auto HLS" : "1080p HD",
                    url: `/api/media?t=${videoToken}`,
                    format: rawVidUrl.includes(".m3u8") ? "m3u8" : "mp4"
                  }] : []
                };
              }));
              return new Response(JSON.stringify(items), {
                status: 200,
                headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...getCorsHeaders(origin) }
              });
            }
          }
        } catch (e) {}
      }

      try {
        const videos = await loadVideoCatalog(context, url);
        const ordered = orderCatalogForSlot(videos, randomSeed, "video");
        const sample = ordered.slice(0, count);
        const items = await Promise.all(sample.map(it => maskVideoItem(it, MEDIA_SECRET)));
        return new Response(JSON.stringify(items), {
          status: 200,
          headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...getCorsHeaders(origin) }
        });
      } catch (vidErr) {
        return new Response("[]", { status: 200, headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) } });
      }
    }

    const selectFields = "id,source,source_id,title,cover_url,media_type,tags,page_count,artists,video_sources";
    const filterQuery = (mediaType === "gallery" || mediaType === "cosplay")
      ? "media_type=eq.gallery&page_count=gt.0&source=neq.leakgallery&status=neq.blocked&real_people=is.false"
      : "media_type=eq.comic&page_count=gt.0&status=neq.blocked&real_people=is.false";

    try {
      const span = await fetchCatalogSpan(SUPABASE_URL, SUPABASE_ADMIN_KEY, filterQuery);
      let rawItems = [];
      try {
        const sampled = await sampleSupabaseShuffle({
          supabaseUrl: SUPABASE_URL,
          apiKey: SUPABASE_ADMIN_KEY,
          filterQuery,
          selectFields,
          page: 1,
          pageSize: Math.max(count, 6),
          seed: randomSeed,
          estimatedTotal: span?.total || 18000,
          span
        });
        rawItems = (sampled && sampled.items ? sampled.items : []).slice(0, count);
      } catch (sampleErr) {}

      if (!rawItems.length) {
        const maxPool = Math.max(1, (span && span.total ? span.total : 18000) - count);
        const randomOffset = randomSeed % maxPool;
        const spRes = await fetch(`${SUPABASE_URL}/rest/v1/items?select=${selectFields}&limit=${count}&offset=${randomOffset}&${filterQuery}&order=id.desc`, {
          headers: { "apikey": SUPABASE_ADMIN_KEY, "Authorization": `Bearer ${SUPABASE_ADMIN_KEY}` }
        });
        rawItems = await spRes.json().catch(() => []);
      }

      const items = await Promise.all((rawItems || []).map(async it => {
        const coverToken = it.cover_url ? await encodeMediaToken(it.cover_url, "", MEDIA_SECRET) : "";
        const vipLocked = isItemVIPGated(it);
        const videoSources = vipLocked
          ? []
          : await Promise.all((it.video_sources || []).map(async vs => ({
              quality: vs.quality || "HD",
              format: vs.format || "mp4",
              url: vs.url ? `/api/media?t=${await encodeMediaToken(vs.url, "", MEDIA_SECRET)}` : ""
            })));
        return {
          id: it.id,
          source: it.source || "",
          source_id: it.source_id != null ? String(it.source_id) : "",
          title: cleanPublicTitle(it.title) || it.title,
          media_type: it.media_type || (mediaType === "gallery" || mediaType === "cosplay" ? "gallery" : "comic"),
          page_count: it.page_count || 0,
          tags: sanitizePublicTags(it.tags),
          artists: sanitizePublicArtists(it.artists, it.media_type),
          url: "",
          vip_locked: vipLocked,
          cover_url: coverToken ? `/api/media?t=${coverToken}` : "",
          video_sources: videoSources
        };
      }));

      return new Response(JSON.stringify(items), {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...getCorsHeaders(origin) }
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
    if (!checkAuthRateLimit(context.request, "login", 15)) {
      return new Response(JSON.stringify({ detail: "Demasiados intentos de inicio de sesión. Espera un minuto." }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": "60", ...getCorsHeaders(origin) }
      });
    }
    try {
      const body = await context.request.json().catch(() => ({}));
      const rawUser = (body.username || "").trim();
      const password = body.password || "";

      if (!rawUser || !password) {
        return new Response(JSON.stringify({ detail: "Usuario o correo y contraseña requeridos" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
        });
      }

      const resolvedLogin = await resolveLoginEmail(rawUser, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, env);
      if (resolvedLogin.invalid || !resolvedLogin.email) {
        return new Response(JSON.stringify({ detail: "Usuario no válido" }), {
          status: 400,
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...getCorsHeaders(origin) }
        });
      }
      const email = resolvedLogin.email;

      // Conexión directa a Supabase Auth
      const authRes = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
        method: "POST",
        headers: { "apikey": SUPABASE_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ email, password })
      });

      const authData = await authRes.json().catch(() => ({}));
      if (!authRes.ok || !authData.user || !authData.access_token) {
        const msg = authData?.error_description || authData?.msg || "Credenciales incorrectas";
        return new Response(JSON.stringify({ detail: msg }), {
          status: 401,
          headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
        });
      }

      const profile = await fetchUserProfile(SUPABASE_URL, SUPABASE_ADMIN_KEY, SUPABASE_KEY, authData.user.id, authData.access_token);
      const view = buildUserSubscriptionView(profile, authData.user, env);
      if (view.is_suspended) {
        const suspendedResp = new Response(JSON.stringify({
          detail: "Tu cuenta está suspendida. Contacta al administrador.",
          suspended: true
        }), {
          status: 403,
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...getCorsHeaders(origin) }
        });
        return withSessionCookies(suspendedResp, clearSessionCookies(context.request));
      }
      if (view.needsExpirySync) {
        context.waitUntil?.(syncProfileExpiryIfNeeded(SUPABASE_URL, SUPABASE_ADMIN_KEY, authData.user.id));
      }

      const respData = {
        token: authData.access_token,
        refresh_token: authData.refresh_token,
        expires_at: authData.expires_at,
        device_token: "dev_" + generateVipKeyCode("DV").toLowerCase(),
        user: publicUserPayload(view)
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
      console.error("[Velvet-Auth] Error en login:", err);
      return new Response(JSON.stringify({ detail: "Error al procesar login" }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
      });
    }
  }

  // =========================================================================
  // 6. AUTENTICACIÓN: VERIFICAR SESIÓN (/api/auth/me)
  // =========================================================================
  if (url.pathname === "/api/auth/me" && method === "GET") {
    const { user, token, unavailable, degraded, verified } = await resolveAuthUser(context.request, SUPABASE_URL, SUPABASE_KEY);

    if (unavailable || degraded || (user && !verified)) {
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
      const profile = await fetchUserProfile(SUPABASE_URL, SUPABASE_ADMIN_KEY, SUPABASE_KEY, user.id, token);
      const view = buildUserSubscriptionView(profile, user, env);
      if (view.is_suspended) {
        const suspendedResp = new Response(JSON.stringify({ detail: "Cuenta suspendida", suspended: true }), {
          status: 403,
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...getCorsHeaders(origin) }
        });
        return withSessionCookies(suspendedResp, clearSessionCookies(context.request));
      }
      if (view.needsExpirySync) {
        context.waitUntil?.(syncProfileExpiryIfNeeded(SUPABASE_URL, SUPABASE_ADMIN_KEY, user.id));
      }

      let expiresAt = null;
      try {
        const part = token.split(".")[1];
        if (part) {
          const payload = JSON.parse(fromBase64Url(part));
          if (payload && payload.exp) expiresAt = payload.exp;
        }
      } catch (e) {}

      const cleanUser = publicUserPayload(view);
      const respData = {
        ...cleanUser,
        token,
        expires_at: expiresAt,
        user: cleanUser
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
    if (!checkAuthRateLimit(context.request, "refresh", 30)) {
      return new Response(JSON.stringify({ detail: "Demasiadas peticiones de actualización de sesión." }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Retry-After": "60", ...getCorsHeaders(origin) }
      });
    }
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
      if (!exchanged || !exchanged.ok || !refData.access_token || !refData.user) {
        const status = exchanged && exchanged.status >= 500 ? 503 : 401;
        return new Response(JSON.stringify({ detail: refData?.error_description || refData?.msg || "Sesión expirada" }), {
          status,
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...getCorsHeaders(origin) }
        });
      }

      const user = refData.user;
      const profile = await fetchUserProfile(SUPABASE_URL, SUPABASE_ADMIN_KEY, SUPABASE_KEY, user.id, refData.access_token);
      const view = buildUserSubscriptionView(profile, user, env);
      if (view.is_suspended) {
        const suspendedResp = new Response(JSON.stringify({ detail: "Cuenta suspendida", suspended: true }), {
          status: 403,
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...getCorsHeaders(origin) }
        });
        return withSessionCookies(suspendedResp, clearSessionCookies(context.request));
      }
      if (view.needsExpirySync) {
        context.waitUntil?.(syncProfileExpiryIfNeeded(SUPABASE_URL, SUPABASE_ADMIN_KEY, user.id));
      }

      const respData = {
        token: refData.access_token,
        refresh_token: refData.refresh_token,
        expires_at: refData.expires_at,
        user: publicUserPayload(view)
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
      console.error("[Velvet-Auth] Error al refrescar sesión:", err);
      return new Response(JSON.stringify({ detail: "Error al refrescar sesión" }), {
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
      evictIsolateAuthToken(token);
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
  // 6.3 AUTENTICACIÓN PATREON OAUTH (/api/auth/patreon & /callback)
  // =========================================================================
  if (url.pathname === "/api/auth/patreon" && method === "GET") {
    const clientId = env.PATREON_CLIENT_ID;
    const siteOrigin = env.SITE_URL || env.NEXT_PUBLIC_SITE_URL || url.origin;
    if (!clientId) {
      return Response.redirect(`${siteOrigin}/?patreon_error=patreon_not_configured`, 302);
    }
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    const state = Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
    const redirectUri = `${siteOrigin}/api/auth/patreon/callback`;
    const patreonUrl =
      `https://www.patreon.com/oauth2/authorize?response_type=code` +
      `&client_id=${encodeURIComponent(clientId)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&scope=${encodeURIComponent("identity identity[email] identity.memberships")}` +
      `&state=${encodeURIComponent(state)}`;
    const secure = requestIsSecure(context.request);
    return new Response(null, {
      status: 302,
      headers: {
        "Location": patreonUrl,
        "Cache-Control": "no-store",
        "Set-Cookie": sessionCookie("velvet_patreon_state", state, 600, secure)
      }
    });
  }

  if (url.pathname === "/api/auth/patreon/callback" && method === "GET") {
    const siteOrigin = env.SITE_URL || env.NEXT_PUBLIC_SITE_URL || url.origin;
    const secure = requestIsSecure(context.request);
    const clearPatreonCookie = sessionCookie("velvet_patreon_state", "", 0, secure);
    const errRedirect = (reason) => new Response(null, {
      status: 302,
      headers: {
        "Location": `${siteOrigin}/?patreon_error=${encodeURIComponent(reason)}`,
        "Cache-Control": "no-store",
        "Set-Cookie": clearPatreonCookie
      }
    });

    try {
      const clientId = env.PATREON_CLIENT_ID;
      const clientSecret = env.PATREON_CLIENT_SECRET;
      const campaignId = String(env.PATREON_CAMPAIGN_ID || "");
      const masterEmail = String(env.MASTER_EMAIL || "erickariaslrcy@gmail.com").trim().toLowerCase();
      const code = url.searchParams.get("code") || "";
      const stateParam = url.searchParams.get("state") || "";
      const stateCookie = readRequestCookie(context.request, "velvet_patreon_state") || "";

      if (!clientId || !clientSecret || !SUPABASE_SERVICE_ROLE_KEY) {
        return errRedirect("patreon_not_configured");
      }
      if (!code || !stateParam || !stateCookie || !constantTimeEqual(stateParam, stateCookie)) {
        return errRedirect("invalid_state");
      }

      const redirectUri = `${siteOrigin}/api/auth/patreon/callback`;
      const tokRes = await fetch("https://www.patreon.com/api/oauth2/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          grant_type: "authorization_code",
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri
        }).toString()
      });
      if (!tokRes.ok) return errRedirect("token_exchange_failed");
      const tokData = await tokRes.json().catch(() => ({}));
      if (!tokData.access_token) return errRedirect("missing_token");

      const idRes = await fetch(
        "https://www.patreon.com/api/oauth2/v2/identity?include=memberships,memberships.campaign&fields%5Buser%5D=email,full_name,image_url&fields%5Bmember%5D=patron_status,currently_entitled_amount_cents,next_charge_date&fields%5Bcampaign%5D=id",
        { headers: { "Authorization": `Bearer ${tokData.access_token}` } }
      );
      if (!idRes.ok) return errRedirect("identity_failed");
      const idData = await idRes.json().catch(() => ({}));
      const patreonUser = idData?.data;
      const email = String(patreonUser?.attributes?.email || "").trim().toLowerCase();
      if (!email) return errRedirect("email_required");

      const isMaster = masterEmail && email === masterEmail;
      if (!isMaster && !campaignId) {
        return errRedirect("patreon_campaign_not_configured");
      }
      const minTierCents = Math.max(100, parseInt(env.PATREON_MIN_CENTS || "100", 10) || 100);
      const memberships = Array.isArray(idData?.included) ? idData.included.filter((i) => i.type === "member") : [];
      const activeMember = memberships.find((m) => {
        if (m.attributes?.patron_status !== "active_patron") return false;
        const memberCampaignId = String(m.relationships?.campaign?.data?.id || "");
        if (!campaignId || memberCampaignId !== campaignId) return false;
        const cents = Number(m.attributes?.currently_entitled_amount_cents || 0);
        return cents >= minTierCents;
      });
      if (!isMaster && !activeMember) {
        return errRedirect("not_active_patron");
      }

      const fullName = sanitizeUsername(patreonUser?.attributes?.full_name || email.split("@")[0]) || "patreon_vip";
      const nextCharge = activeMember?.attributes?.next_charge_date;
      const defaultExp = new Date(Date.now() + 32 * 86400000).toISOString();
      const patreonExp = (nextCharge && Date.parse(nextCharge) > Date.now()) ? new Date(nextCharge).toISOString() : defaultExp;

      // Buscar o crear cuenta en Supabase Auth
      let supaUserId = null;
      const profFind = await fetch(
        `${SUPABASE_URL}/rest/v1/profiles?email=eq.${encodeURIComponent(email)}&select=id,is_admin,is_suspended&limit=1`,
        { headers: { "apikey": SUPABASE_SERVICE_ROLE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } }
      );
      if (profFind.ok) {
        const foundRows = await profFind.json().catch(() => []);
        if (foundRows && foundRows[0]) {
          if (foundRows[0].is_suspended) return errRedirect("suspended");
          supaUserId = foundRows[0].id;
        }
      }

      if (!supaUserId) {
        const randBytes = new Uint8Array(24);
        crypto.getRandomValues(randBytes);
        const randPass = Array.from(randBytes).map((b) => b.toString(16).padStart(2, "0")).join("");
        const createRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
          method: "POST",
          headers: {
            "apikey": SUPABASE_SERVICE_ROLE_KEY,
            "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            email,
            password: randPass,
            email_confirm: true,
            user_metadata: {
              username: fullName,
              patreon_id: String(patreonUser?.id || ""),
              patron_status: "active_patron",
              campaign_id: campaignId
            }
          })
        });
        const created = await createRes.json().catch(() => ({}));
        supaUserId = created?.id || created?.user?.id || null;
      }

      if (!supaUserId) return errRedirect("account_sync_failed");

      await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(supaUserId)}`, {
        method: "PATCH",
        headers: {
          "apikey": SUPABASE_SERVICE_ROLE_KEY,
          "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json",
          "Prefer": "return=minimal"
        },
        body: JSON.stringify({
          patreon_id: String(patreonUser?.id || ""),
          patron_status: "active_patron",
          subscription_tier: isMaster ? "admin" : "patreon",
          subscription_status: isMaster ? "admin" : "active",
          subscription_expires_at: isMaster ? null : patreonExp,
          is_lifetime: isMaster ? true : false,
          updated_at: new Date().toISOString()
        })
      });

      const linkRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/generate_link`, {
        method: "POST",
        headers: {
          "apikey": SUPABASE_SERVICE_ROLE_KEY,
          "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ type: "magiclink", email })
      });
      const linkData = await linkRes.json().catch(() => ({}));
      const hashedToken = linkData?.hashed_token || linkData?.properties?.hashed_token;
      if (!linkRes.ok || !hashedToken) return errRedirect("session_link_failed");

      const verifyRes = await fetch(`${SUPABASE_URL}/auth/v1/verify`, {
        method: "POST",
        headers: { "apikey": SUPABASE_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ token_hash: hashedToken, type: "magiclink" })
      });
      const sessionData = await verifyRes.json().catch(() => ({}));
      if (!verifyRes.ok || !sessionData.access_token) return errRedirect("session_verify_failed");

      const redirectResp = new Response(null, {
        status: 302,
        headers: {
          "Location": `${siteOrigin}/?patreon=connected`,
          "Cache-Control": "no-store"
        }
      });
      const cookies = buildSessionCookies(context.request, sessionData.access_token, sessionData.refresh_token, sessionData.expires_at);
      cookies.push(clearPatreonCookie);
      return withSessionCookies(redirectResp, cookies);
    } catch (err) {
      return errRedirect("patreon_error");
    }
  }

  // =========================================================================
  // 7. AUTENTICACIÓN: REGISTRO CON LLAVE VIP DE TIEMPO O CUENTA GRATUITA
  // =========================================================================
  if (url.pathname === "/api/auth/register" && method === "POST") {
    if (!checkAuthRateLimit(context.request, "register", 10)) {
      return new Response(JSON.stringify({ detail: "Demasiados intentos de registro. Espera un minuto." }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": "60", ...getCorsHeaders(origin) }
      });
    }
    try {
      const body = await context.request.json().catch(() => ({}));
      const rawUsername = String(body.username || "").trim();
      const username = sanitizeUsername(rawUsername);
      const emailInput = String(body.email || "").trim().toLowerCase();
      const password = String(body.password || "");
      const access_key = sanitizeKeyCode(body.access_key || body.key || "");

      if (!rawUsername || !password) {
        return new Response(JSON.stringify({ detail: "Nombre de usuario y contraseña requeridos" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
        });
      }
      if (!username || username.length < 3 || isReservedUsername(username)) {
        return new Response(JSON.stringify({ detail: "Ese nombre de usuario no está disponible o es inválido (mín. 3 caracteres válidos)." }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
        });
      }
      if (password.length < 6) {
        return new Response(JSON.stringify({ detail: "La contraseña debe tener al menos 6 caracteres" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
        });
      }

      const email = emailInput || `${username.toLowerCase()}@velvet.local`;
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return new Response(JSON.stringify({ detail: "El correo electrónico no tiene un formato válido" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
        });
      }

      // 1. Verificar disponibilidad del nombre de usuario antes de crear usuario o consumir llave
      if (SUPABASE_SERVICE_ROLE_KEY) {
        const escapedUsername = escapePostgrestLike(username);
        const dupUserRes = await fetch(
          `${SUPABASE_URL}/rest/v1/profiles?select=id,username&username=ilike.${encodeURIComponent(escapedUsername)}&limit=5`,
          { headers: { "apikey": SUPABASE_SERVICE_ROLE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } }
        );
        if (dupUserRes.ok) {
          const dupRows = await dupUserRes.json().catch(() => []);
          const exactTaken = (Array.isArray(dupRows) ? dupRows : []).some(
            (r) => String(r.username || "").toLowerCase() === username.toLowerCase()
          );
          if (exactTaken) {
            return new Response(JSON.stringify({ detail: "Ese nombre de usuario ya está en uso. Elige otro." }), {
              status: 409,
              headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
            });
          }
        }
      }

      // 2. Validar Llave VIP estrictamente contra la base de datos (sin bypass por regex)
      const MASTER_KEYS = String(env.MASTER_INVITE_KEYS || "")
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean);
      let isMasterKey = false;

      if (access_key) {
        if (MASTER_KEYS.includes(access_key)) {
          isMasterKey = true;
        } else {
          const keyCheckRes = await fetch(
            `${SUPABASE_URL}/rest/v1/invite_keys?code=eq.${encodeURIComponent(access_key)}&select=code,revoked,used_at,expires_at,duration_days,plan_label`,
            {
              headers: {
                "apikey": SUPABASE_ADMIN_KEY,
                "Authorization": `Bearer ${SUPABASE_ADMIN_KEY}`
              }
            }
          );
          if (!keyCheckRes.ok) {
            return new Response(JSON.stringify({ detail: "No se pudo validar la llave en el servidor. Intenta nuevamente." }), {
              status: 503,
              headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
            });
          }
          const keysData = await keyCheckRes.json().catch(() => []);
          if (!Array.isArray(keysData) || keysData.length === 0) {
            return new Response(JSON.stringify({ detail: "La llave de acceso VIP no existe." }), {
              status: 403,
              headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
            });
          }
          const kObj = keysData[0];
          if (kObj.revoked) {
            return new Response(JSON.stringify({ detail: "Esta llave VIP fue revocada por el administrador." }), {
              status: 403,
              headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
            });
          }
          if (kObj.used_at) {
            return new Response(JSON.stringify({ detail: "Esta llave VIP ya fue utilizada." }), {
              status: 403,
              headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
            });
          }
          if (kObj.expires_at && Date.parse(kObj.expires_at) <= Date.now()) {
            return new Response(JSON.stringify({ detail: "Esta llave VIP caducó antes de ser canjeada." }), {
              status: 403,
              headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
            });
          }
        }
      }

      // 3. Crear usuario en Supabase Auth (confirmado automáticamente si hay service role)
      let createdUser = null;
      if (SUPABASE_SERVICE_ROLE_KEY) {
        const regRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
          method: "POST",
          headers: {
            "apikey": SUPABASE_SERVICE_ROLE_KEY,
            "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            email,
            password,
            email_confirm: true,
            user_metadata: {
              username,
              registered_with_key: access_key || null
            }
          })
        });
        const regData = await regRes.json().catch(() => ({}));
        if (!regRes.ok || (!regData.id && !regData.user?.id)) {
          return new Response(JSON.stringify({
            detail: regData?.msg || regData?.message || regData?.error_description || "Ya existe una cuenta con ese usuario o correo."
          }), {
            status: 400,
            headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
          });
        }
        createdUser = regData.user || regData;
      } else {
        const regRes = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
          method: "POST",
          headers: { "apikey": SUPABASE_KEY, "Content-Type": "application/json" },
          body: JSON.stringify({
            email,
            password,
            data: { username, registered_with_key: access_key || null }
          })
        });
        const regData = await regRes.json().catch(() => ({}));
        if (!regRes.ok || !regData.user) {
          return new Response(JSON.stringify({
            detail: regData?.msg || regData?.error_description || "Error al registrar cuenta en el sistema"
          }), {
            status: 400,
            headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
          });
        }
        createdUser = regData.user;
      }

      // Asegurar que profiles tenga username sincronizado incluso en entornos mock/latencia de trigger
      if (SUPABASE_SERVICE_ROLE_KEY) {
        await fetch(`${SUPABASE_URL}/rest/v1/profiles`, {
          method: "POST",
          headers: {
            "apikey": SUPABASE_SERVICE_ROLE_KEY,
            "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates,return=minimal"
          },
          body: JSON.stringify({
            id: createdUser.id,
            email,
            username,
            updated_at: new Date().toISOString()
          })
        }).catch(() => {});
      }

      // 4. Si proveyó llave, canjearla atómicamente vía RPC transaccional (con rollback si falla)
      let redemptionInfo = null;
      if (access_key) {
        if (isMasterKey && SUPABASE_SERVICE_ROLE_KEY) {
          const thirtyDaysExp = new Date(Date.now() + 30 * 86400000).toISOString();
          await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(createdUser.id)}`, {
            method: "PATCH",
            headers: {
              "apikey": SUPABASE_SERVICE_ROLE_KEY,
              "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              subscription_tier: "vip",
              subscription_status: "active",
              subscription_expires_at: thirtyDaysExp,
              registered_with_key: access_key,
              last_redeemed_at: new Date().toISOString(),
              updated_at: new Date().toISOString()
            })
          }).catch(() => {});
          redemptionInfo = { ok: true, duration_days: 30, subscription_expires_at: thirtyDaysExp };
        } else {
          const rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/redeem_subscription_key`, {
            method: "POST",
            headers: {
              "apikey": SUPABASE_ADMIN_KEY,
              "Authorization": `Bearer ${SUPABASE_ADMIN_KEY}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              p_code: access_key,
              p_user_id: createdUser.id,
              p_email: email
            })
          });
          const rpcData = await rpcRes.json().catch(() => null);
          if (!rpcRes.ok || !rpcData || rpcData.ok !== true) {
            if (SUPABASE_SERVICE_ROLE_KEY) {
              await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${encodeURIComponent(createdUser.id)}`, {
                method: "DELETE",
                headers: { "apikey": SUPABASE_SERVICE_ROLE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` }
              }).catch(() => {});
            }
            return new Response(JSON.stringify({
              detail: rpcData?.message || "La llave VIP no pudo canjearse (ya usada o expirada)."
            }), {
              status: 403,
              headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
            });
          }
          redemptionInfo = rpcData;
        }
      }

      // 5. Iniciar sesión inmediatamente
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

      let profile = await fetchUserProfile(SUPABASE_URL, SUPABASE_ADMIN_KEY, SUPABASE_KEY, createdUser.id, authData.access_token);
      if (!profile && redemptionInfo?.ok) {
        profile = {
          id: createdUser.id,
          email,
          username,
          is_admin: false,
          subscription_tier: "vip",
          subscription_status: "active",
          subscription_expires_at: redemptionInfo.subscription_expires_at || null,
          is_lifetime: Boolean(redemptionInfo.is_lifetime),
          registered_with_key: access_key
        };
      }
      const view = buildUserSubscriptionView(profile, authData.user, env);
      const respData = {
        token: authData.access_token,
        refresh_token: authData.refresh_token || null,
        expires_at: authData.expires_at || null,
        device_token: "dev_" + generateVipKeyCode("DV").toLowerCase(),
        redemption: redemptionInfo,
        user: publicUserPayload(view)
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
      console.error("[Velvet-Auth] Error en register:", err);
      return new Response(JSON.stringify({ detail: "Error al registrar cuenta" }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
      });
    }
  }

  // =========================================================================
  // 7.1 CANJE DE LLAVE VIP PARA USUARIO AUTENTICADO (/api/redeem y /api/user/redeem-key)
  // =========================================================================
  if ((url.pathname === "/api/redeem" || url.pathname === "/api/user/redeem-key") && method === "POST") {
    if (!checkAuthRateLimit(context.request, "redeem", 10)) {
      return new Response(JSON.stringify({ error: "Demasiados intentos de canje. Espera un minuto.", detail: "Demasiados intentos de canje. Espera un minuto." }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Retry-After": "60", ...getCorsHeaders(origin) }
      });
    }
    const { user, token, unavailable, degraded, verified } = await resolveAuthUser(context.request, SUPABASE_URL, SUPABASE_KEY);
    if (unavailable || degraded || (user && !verified)) {
      return new Response(JSON.stringify({ error: "Servicio de sesión no disponible", detail: "Servicio de sesión no disponible" }), {
        status: 503,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...getCorsHeaders(origin) }
      });
    }
    if (!user || !token) {
      return new Response(JSON.stringify({ error: "Debes iniciar sesión para canjear una llave VIP", detail: "Debes iniciar sesión para canjear una llave VIP" }), {
        status: 401,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...getCorsHeaders(origin) }
      });
    }

    const body = await context.request.json().catch(() => ({}));
    const keyCode = sanitizeKeyCode(body.code || body.key || body.access_key || "");
    if (!keyCode) {
      return new Response(JSON.stringify({ error: "Introduce una llave de acceso válida", detail: "Introduce una llave de acceso válida" }), {
        status: 400,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...getCorsHeaders(origin) }
      });
    }

    const MASTER_KEYS = String(env.MASTER_INVITE_KEYS || "")
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);

    let resultData = null;
    if (MASTER_KEYS.includes(keyCode) && SUPABASE_SERVICE_ROLE_KEY) {
      const existingProf = await fetchUserProfile(SUPABASE_URL, SUPABASE_ADMIN_KEY, SUPABASE_KEY, user.id, token);
      if (existingProf?.is_suspended) {
        return new Response(JSON.stringify({ error: "Tu cuenta está suspendida", detail: "Tu cuenta está suspendida" }), {
          status: 403,
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...getCorsHeaders(origin) }
        });
      }
      const curMs = existingProf?.subscription_expires_at ? Date.parse(existingProf.subscription_expires_at) : 0;
      const baseMs = curMs > Date.now() ? curMs : Date.now();
      const newExpIso = new Date(baseMs + 30 * 86400000).toISOString();
      await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}`, {
        method: "PATCH",
        headers: {
          "apikey": SUPABASE_SERVICE_ROLE_KEY,
          "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          subscription_tier: existingProf?.is_admin ? "admin" : "vip",
          subscription_status: existingProf?.is_admin ? "admin" : "active",
          subscription_expires_at: existingProf?.is_admin ? null : newExpIso,
          registered_with_key: keyCode,
          last_redeemed_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
      });
      resultData = { ok: true, code: keyCode, duration_days: 30, plan_label: "Morbo VIP 1 Mes", subscription_expires_at: newExpIso };
    } else {
      const rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/redeem_subscription_key`, {
        method: "POST",
        headers: {
          "apikey": SUPABASE_ADMIN_KEY,
          "Authorization": `Bearer ${SUPABASE_ADMIN_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          p_code: keyCode,
          p_user_id: user.id,
          p_email: user.email || ""
        })
      });
      resultData = await rpcRes.json().catch(() => null);
      if (!rpcRes.ok || !resultData || resultData.ok !== true) {
        const msg = resultData?.message || "Llave inválida, expirada o ya utilizada.";
        return new Response(JSON.stringify({ error: msg, detail: msg, code: resultData?.error || "redeem_failed" }), {
          status: resultData?.error === "suspended" ? 403 : 400,
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...getCorsHeaders(origin) }
        });
      }
    }

    const updatedProfile = await fetchUserProfile(SUPABASE_URL, SUPABASE_ADMIN_KEY, SUPABASE_KEY, user.id, token);
    const view = buildUserSubscriptionView(updatedProfile, user, env);
    context.waitUntil?.(
      patchAuthUserLightMeta(SUPABASE_URL, SUPABASE_ADMIN_KEY, user.id, user.user_metadata, {
        registered_with_key: keyCode,
        subscription_status: view.subscription_status,
        subscription_expires_at: view.subscription_expires_at
      })
    );

    const daysMsg = resultData.duration_days === 0
      ? "Suscripción VIP Permanente activada"
      : `Suscripción VIP activada (+${resultData.duration_days || 30} días)`;

    return new Response(JSON.stringify({
      ok: true,
      success: true,
      message: daysMsg,
      code: keyCode,
      duration_days: resultData.duration_days,
      plan_label: resultData.plan_label || daysMsg,
      subscription_expires_at: view.subscription_expires_at,
      user: publicUserPayload(view),
      token
    }), {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...getCorsHeaders(origin) }
    });
  }

  // =========================================================================
  // 7.2 PANEL DE ADMINISTRADOR (/api/admin/*)
  // =========================================================================
  if (url.pathname.startsWith("/api/admin/")) {
    const adminCtx = await requireAdminContext(context.request, SUPABASE_URL, SUPABASE_KEY, SUPABASE_ADMIN_KEY, origin);
    if (adminCtx.errorResponse) return adminCtx.errorResponse;
    const adminHeaders = {
      "apikey": SUPABASE_ADMIN_KEY,
      "Authorization": `Bearer ${SUPABASE_ADMIN_KEY}`,
      "Content-Type": "application/json"
    };

    // GET /api/admin/stats
    if (url.pathname === "/api/admin/stats" && method === "GET") {
      try {
        const [profRes, keysRes, favRes] = await Promise.all([
          fetch(`${SUPABASE_URL}/rest/v1/profiles?select=is_admin,subscription_status,subscription_expires_at,is_lifetime,is_suspended,patron_status`, {
            headers: adminHeaders
          }),
          fetch(`${SUPABASE_URL}/rest/v1/invite_keys?select=code,used_at,revoked,expires_at`, {
            headers: adminHeaders
          }),
          fetch(`${SUPABASE_URL}/rest/v1/favorites?select=item_id`, {
            method: "HEAD",
            headers: { ...adminHeaders, "Prefer": "count=exact" }
          })
        ]);

        const profiles = profRes.ok ? await profRes.json().catch(() => []) : [];
        const keys = keysRes.ok ? await keysRes.json().catch(() => []) : [];
        const nowMs = Date.now();
        let activeSubs = 0;
        let expiredSubs = 0;
        for (const p of (Array.isArray(profiles) ? profiles : [])) {
          const view = buildUserSubscriptionView(p, null, env);
          if (view.has_active_subscription) activeSubs++;
          else if (view.subscription_status === "expired") expiredSubs++;
        }

        let availKeys = 0;
        let usedKeys = 0;
        let revokedKeys = 0;
        for (const k of (Array.isArray(keys) ? keys : [])) {
          if (k.revoked) revokedKeys++;
          else if (k.used_at) usedKeys++;
          else if (k.expires_at && Date.parse(k.expires_at) <= nowMs) revokedKeys++;
          else availKeys++;
        }

        const totalFavorites = parseRangeCount(favRes.headers.get("content-range"));
        return new Response(JSON.stringify({
          total_users: Array.isArray(profiles) ? profiles.length : 0,
          active_subscriptions: activeSubs,
          expired_subscriptions: expiredSubs,
          available_keys: availKeys,
          used_keys: usedKeys,
          revoked_keys: revokedKeys,
          total_favorites: totalFavorites
        }), {
          status: 200,
          headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...getCorsHeaders(origin) }
        });
      } catch (err) {
        console.error("[Velvet-Admin] stats error:", err);
        return new Response(JSON.stringify({ error: "Error consultando estadísticas" }), {
          status: 500,
          headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
        });
      }
    }

    // GET /api/admin/keys
    if (url.pathname === "/api/admin/keys" && method === "GET") {
      try {
        const filterStatus = (url.searchParams.get("status") || "all").toLowerCase();
        const kRes = await fetch(`${SUPABASE_URL}/rest/v1/invite_keys?select=*&order=created_at.desc&limit=500`, {
          headers: adminHeaders
        });
        if (!kRes.ok) {
          return new Response(JSON.stringify({ detail: "No se pudieron cargar las llaves" }), {
            status: 500,
            headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
          });
        }
        const rows = await kRes.json().catch(() => []);
        const nowMs = Date.now();
        const mapped = (Array.isArray(rows) ? rows : []).map((k) => {
          const isUsed = Boolean(k.used_at);
          const isRevoked = Boolean(k.revoked);
          const isKeyExpired = Boolean(!isUsed && !isRevoked && k.expires_at && Date.parse(k.expires_at) <= nowMs);
          const keyStatus = isRevoked ? "revoked" : (isUsed ? "used" : (isKeyExpired ? "expired" : "available"));
          return {
            id: k.code,
            code: k.code,
            key: k.code,
            note: k.note || "",
            duration_days: k.duration_days ?? 30,
            plan_label: k.plan_label || (k.duration_days === 0 ? "VIP Permanente" : `Morbo VIP ${k.duration_days ?? 30} días`),
            status: keyStatus,
            is_used: isUsed,
            revoked: isRevoked,
            created_at: k.created_at,
            expires_at: k.expires_at,
            used_at: k.used_at,
            used_by: k.used_by,
            used_email: k.used_email,
            used_by_username: k.used_email || null
          };
        }).filter((k) => {
          if (filterStatus === "all") return true;
          return k.status === filterStatus;
        });

        return new Response(JSON.stringify(mapped), {
          status: 200,
          headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...getCorsHeaders(origin) }
        });
      } catch (err) {
        console.error("[Velvet-Admin] keys error:", err);
        return new Response(JSON.stringify({ detail: "Error consultando llaves" }), {
          status: 500,
          headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
        });
      }
    }

    // POST /api/admin/keys/generate o POST /api/admin/keys
    if ((url.pathname === "/api/admin/keys/generate" || url.pathname === "/api/admin/keys") && method === "POST") {
      try {
        const body = await context.request.json().catch(() => ({}));
        const count = Math.min(50, Math.max(1, parseInt(body.count, 10) || 1));
        const prefix = String(body.prefix || "VELVET").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12) || "VELVET";
        const note = String(body.note || "").trim().slice(0, 200);
        const rawDays = body.duration_days !== undefined ? parseInt(body.duration_days, 10) : 30;
        const duration_days = Number.isNaN(rawDays) ? 30 : Math.min(3650, Math.max(0, rawDays));
        const keyExpiresDays = body.key_expires_days ? Math.min(3650, Math.max(1, parseInt(body.key_expires_days, 10))) : null;
        const expires_at = keyExpiresDays ? new Date(Date.now() + keyExpiresDays * 86400000).toISOString() : null;
        const plan_label = String(
          body.plan_label || (duration_days === 0 ? "VIP Permanente" : duration_days === 30 ? "Morbo VIP 1 Mes" : `Morbo VIP ${duration_days} días`)
        ).slice(0, 80);

        const toInsert = [];
        const seen = new Set();
        for (let i = 0; i < count; i++) {
          let code = generateVipKeyCode(prefix);
          while (seen.has(code)) code = generateVipKeyCode(prefix);
          seen.add(code);
          toInsert.push({
            code,
            note,
            created_by: adminCtx.user.id,
            duration_days,
            plan_label,
            expires_at
          });
        }

        const insRes = await fetch(`${SUPABASE_URL}/rest/v1/invite_keys`, {
          method: "POST",
          headers: { ...adminHeaders, "Prefer": "return=representation" },
          body: JSON.stringify(toInsert)
        });
        if (!insRes.ok) {
          const errTxt = await insRes.text().catch(() => "");
          console.error("[Velvet-Admin] Insert key error:", errTxt);
          return new Response(JSON.stringify({ detail: "Error guardando llaves" }), {
            status: 500,
            headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
          });
        }
        const createdRows = await insRes.json().catch(() => toInsert);
        const formatted = (Array.isArray(createdRows) ? createdRows : toInsert).map((k) => ({
          ...k,
          id: k.code,
          key: k.code
        }));

        return new Response(JSON.stringify({
          ok: true,
          count: formatted.length,
          duration_days,
          plan_label,
          keys: formatted
        }), {
          status: 200,
          headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...getCorsHeaders(origin) }
        });
      } catch (err) {
        console.error("[Velvet-Admin] keys error:", err);
        return new Response(JSON.stringify({ detail: "Error consultando llaves" }), {
          status: 500,
          headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
        });
      }
    }

    // DELETE /api/admin/keys/:code
    const delKeyMatch = url.pathname.match(/^\/api\/admin\/keys\/([^/]+)$/);
    if (delKeyMatch && method === "DELETE") {
      const rawCode = sanitizeKeyCode(decodeURIComponent(delKeyMatch[1]));
      if (!rawCode) {
        return new Response(JSON.stringify({ detail: "Código de llave inválido" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
        });
      }
      const patchRes = await fetch(`${SUPABASE_URL}/rest/v1/invite_keys?code=eq.${encodeURIComponent(rawCode)}`, {
        method: "PATCH",
        headers: { ...adminHeaders, "Prefer": "return=representation" },
        body: JSON.stringify({ revoked: true })
      });
      if (!patchRes.ok) {
        return new Response(JSON.stringify({ detail: "No se pudo revocar la llave" }), {
          status: 500,
          headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
        });
      }
      const revokedRows = await patchRes.json().catch(() => []);
      if (!Array.isArray(revokedRows) || revokedRows.length === 0) {
        return new Response(JSON.stringify({ detail: "La llave especificada no existe" }), {
          status: 404,
          headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
        });
      }
      return new Response(JSON.stringify({ ok: true, code: rawCode }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...getCorsHeaders(origin) }
      });
    }

    // GET /api/admin/users
    if (url.pathname === "/api/admin/users" && method === "GET") {
      try {
        const fetchAllAuthUsers = async () => {
          const all = [];
          for (let page = 1; page <= 10; page++) {
            const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?page=${page}&per_page=200`, { headers: adminHeaders });
            if (!r.ok) break;
            const d = await r.json().catch(() => ({}));
            const batch = Array.isArray(d?.users) ? d.users : [];
            all.push(...batch);
            if (batch.length < 200) break;
          }
          return all;
        };
        const [profRes, authUsers, favsRes, customFavsRes, histRes, customHistRes] = await Promise.all([
          fetch(`${SUPABASE_URL}/rest/v1/profiles?select=${encodeURIComponent(SUBSCRIPTION_PROFILE_SELECT)}&order=created_at.desc&limit=2000`, {
            headers: adminHeaders
          }),
          fetchAllAuthUsers(),
          fetch(`${SUPABASE_URL}/rest/v1/favorites?select=user_id&limit=10000`, {
            headers: adminHeaders
          }),
          fetch(`${SUPABASE_URL}/rest/v1/user_custom_favorites?select=user_id&limit=10000`, {
            headers: adminHeaders
          }).catch(() => null),
          fetch(`${SUPABASE_URL}/rest/v1/user_history?select=user_id&limit=10000`, {
            headers: adminHeaders
          }),
          fetch(`${SUPABASE_URL}/rest/v1/user_custom_history?select=user_id&limit=10000`, {
            headers: adminHeaders
          }).catch(() => null)
        ]);

        const profiles = profRes.ok ? await profRes.json().catch(() => []) : [];
        const favRows = favsRes.ok ? await favsRes.json().catch(() => []) : [];
        const customFavRows = customFavsRes && customFavsRes.ok ? await customFavsRes.json().catch(() => []) : [];
        const histRows = histRes.ok ? await histRes.json().catch(() => []) : [];
        const customHistRows = customHistRes && customHistRes.ok ? await customHistRes.json().catch(() => []) : [];

        const favCounts = new Map();
        for (const r of [...(Array.isArray(favRows) ? favRows : []), ...(Array.isArray(customFavRows) ? customFavRows : [])]) {
          favCounts.set(r.user_id, (favCounts.get(r.user_id) || 0) + 1);
        }
        const histCounts = new Map();
        for (const r of [...(Array.isArray(histRows) ? histRows : []), ...(Array.isArray(customHistRows) ? customHistRows : [])]) {
          histCounts.set(r.user_id, (histCounts.get(r.user_id) || 0) + 1);
        }

        const authMap = new Map();
        for (const au of authUsers) authMap.set(au.id, au);

        const seenIds = new Set();
        const combined = [];
        for (const p of (Array.isArray(profiles) ? profiles : [])) {
          seenIds.add(p.id);
          const au = authMap.get(p.id) || null;
          const view = buildUserSubscriptionView(p, au, env);
          combined.push({
            ...publicUserPayload(view),
            status: view.is_suspended ? "suspended" : "active",
            favorites_count: favCounts.get(p.id) || 0,
            history_count: histCounts.get(p.id) || 0,
            last_sign_in_at: au?.last_sign_in_at || null
          });
        }
        for (const au of authUsers) {
          if (seenIds.has(au.id)) continue;
          const view = buildUserSubscriptionView(null, au, env);
          combined.push({
            ...publicUserPayload(view),
            status: view.is_suspended ? "suspended" : "active",
            favorites_count: favCounts.get(au.id) || 0,
            history_count: histCounts.get(au.id) || 0,
            last_sign_in_at: au?.last_sign_in_at || null
          });
        }

        return new Response(JSON.stringify(combined), {
          status: 200,
          headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...getCorsHeaders(origin) }
        });
      } catch (err) {
        console.error("[Velvet-Admin] users error:", err);
        return new Response(JSON.stringify({ detail: "Error consultando usuarios" }), {
          status: 500,
          headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
        });
      }
    }

    // POST /api/admin/users/:id/status (Suspender / Reactivar cuenta)
    const userStatusMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)\/status$/);
    if (userStatusMatch && method === "POST") {
      const targetId = decodeURIComponent(userStatusMatch[1]);
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(targetId)) {
        return new Response(JSON.stringify({ detail: "ID de usuario inválido" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
        });
      }
      if (targetId === adminCtx.user.id) {
        return new Response(JSON.stringify({ detail: "No puedes suspender tu propia cuenta de administrador" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
        });
      }
      const body = await context.request.json().catch(() => ({}));
      const nextStatus = String(body.status || body.action || "").toLowerCase();
      const shouldSuspend = nextStatus === "suspended" || nextStatus === "suspend" || nextStatus === "ban";
      const curProf = await fetchUserProfile(SUPABASE_URL, SUPABASE_ADMIN_KEY, SUPABASE_KEY, targetId);
      if (curProf?.is_admin) {
        return new Response(JSON.stringify({ detail: "No se puede suspender a otro administrador" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
        });
      }

      const expMs = curProf?.subscription_expires_at ? Date.parse(curProf.subscription_expires_at) : 0;
      const reactivatedSubStatus = curProf?.is_lifetime || expMs > Date.now()
        ? "active"
        : (expMs > 0 ? "expired" : "inactive");

      const [profPatchRes, authPutRes] = await Promise.all([
        fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(targetId)}`, {
          method: "PATCH",
          headers: { ...adminHeaders, "Prefer": "return=representation" },
          body: JSON.stringify({
            is_suspended: shouldSuspend,
            subscription_status: shouldSuspend ? "suspended" : reactivatedSubStatus,
            updated_at: new Date().toISOString()
          })
        }).catch(() => null),
        fetch(`${SUPABASE_URL}/auth/v1/admin/users/${encodeURIComponent(targetId)}`, {
          method: "PUT",
          headers: adminHeaders,
          body: JSON.stringify({
            ban_duration: shouldSuspend ? "876000h" : "none"
          })
        }).catch(() => null)
      ]);
      if (!profPatchRes?.ok || !authPutRes?.ok) {
        return new Response(JSON.stringify({ detail: "No se pudo actualizar el estado del usuario en la base de datos" }), {
          status: 502,
          headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
        });
      }

      return new Response(JSON.stringify({
        ok: true,
        id: targetId,
        status: shouldSuspend ? "suspended" : "active",
        subscription_status: shouldSuspend ? "suspended" : reactivatedSubStatus
      }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...getCorsHeaders(origin) }
      });
    }

    // POST /api/admin/users/:id/subscription (Extender días, asignar días, vitalicio, vencer ahora)
    const userSubMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)\/subscription$/);
    if (userSubMatch && method === "POST") {
      const targetId = decodeURIComponent(userSubMatch[1]);
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(targetId)) {
        return new Response(JSON.stringify({ detail: "ID de usuario inválido" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
        });
      }
      const body = await context.request.json().catch(() => ({}));
      const action = String(body.action || "extend").toLowerCase();
      const days = Math.min(3650, Math.max(1, parseInt(body.days, 10) || 30));

      const curProf = await fetchUserProfile(SUPABASE_URL, SUPABASE_ADMIN_KEY, SUPABASE_KEY, targetId);
      if (!curProf) {
        return new Response(JSON.stringify({ detail: "Perfil de usuario no encontrado" }), {
          status: 404,
          headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
        });
      }
      if (curProf.is_admin && action === "expire") {
        return new Response(JSON.stringify({ detail: "No se puede vencer la cuenta del administrador" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
        });
      }

      const patchPayload = { updated_at: new Date().toISOString() };
      if (action === "lifetime" || action === "set_lifetime") {
        patchPayload.is_lifetime = true;
        patchPayload.subscription_tier = curProf.is_admin ? "admin" : "vip";
        patchPayload.subscription_status = curProf.is_admin ? "admin" : "active";
        patchPayload.subscription_expires_at = null;
      } else if (action === "expire" || action === "revoke") {
        patchPayload.is_lifetime = false;
        patchPayload.subscription_tier = "vip";
        patchPayload.subscription_status = "expired";
        patchPayload.subscription_expires_at = new Date(Date.now() - 1000).toISOString();
      } else if (action === "set_days") {
        patchPayload.is_lifetime = false;
        patchPayload.subscription_tier = curProf.is_admin ? "admin" : "vip";
        patchPayload.subscription_status = curProf.is_admin ? "admin" : "active";
        patchPayload.subscription_expires_at = new Date(Date.now() + days * 86400000).toISOString();
      } else {
        // extend: suma desde max(ahora, expiración actual)
        const curMs = curProf.subscription_expires_at ? Date.parse(curProf.subscription_expires_at) : 0;
        const baseMs = curMs > Date.now() ? curMs : Date.now();
        patchPayload.is_lifetime = false;
        patchPayload.subscription_tier = curProf.is_admin ? "admin" : "vip";
        patchPayload.subscription_status = curProf.is_admin ? "admin" : "active";
        patchPayload.subscription_expires_at = new Date(baseMs + days * 86400000).toISOString();
      }

      const patchRes = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(targetId)}`, {
        method: "PATCH",
        headers: { ...adminHeaders, "Prefer": "return=representation" },
        body: JSON.stringify(patchPayload)
      });
      if (!patchRes.ok) {
        return new Response(JSON.stringify({ detail: "Error actualizando suscripción en el servidor" }), {
          status: 502,
          headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
        });
      }
      const updatedRows = await patchRes.json().catch(() => []);
      if (!Array.isArray(updatedRows) || updatedRows.length === 0) {
        return new Response(JSON.stringify({ detail: "Perfil de usuario no encontrado para actualizar" }), {
          status: 404,
          headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
        });
      }
      const view = buildUserSubscriptionView(updatedRows[0], null, env);

      return new Response(JSON.stringify({
        ok: true,
        user: publicUserPayload(view)
      }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...getCorsHeaders(origin) }
      });
    }

    // POST /api/admin/change-password
    if (url.pathname === "/api/admin/change-password" && method === "POST") {
      const body = await context.request.json().catch(() => ({}));
      const oldPassword = String(body.old_password || "");
      const newPassword = String(body.new_password || "");
      if (!oldPassword || !newPassword || newPassword.length < 6) {
        return new Response(JSON.stringify({ detail: "Ingresa contraseña actual y nueva contraseña (mín. 6 caracteres)" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
        });
      }

      const verifyRes = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
        method: "POST",
        headers: { "apikey": SUPABASE_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ email: adminCtx.user.email, password: oldPassword })
      });
      if (!verifyRes.ok) {
        return new Response(JSON.stringify({ detail: "La contraseña actual es incorrecta" }), {
          status: 403,
          headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
        });
      }

      const upRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        method: "PUT",
        headers: {
          "apikey": SUPABASE_KEY,
          "Authorization": `Bearer ${adminCtx.token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ password: newPassword })
      });
      if (!upRes.ok) {
        const upErr = await upRes.json().catch(() => ({}));
        return new Response(JSON.stringify({ detail: upErr?.msg || "No se pudo actualizar la contraseña" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
        });
      }

      return new Response(JSON.stringify({ ok: true, message: "Contraseña actualizada con éxito" }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...getCorsHeaders(origin) }
      });
    }

    return new Response(JSON.stringify({ error: "Ruta admin no encontrada" }), {
      status: 404,
      headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
    });
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
  // Helpers compartidos para favoritos/historial en PostgreSQL (SQL + tablas custom)
  const parseContentRangeTotal = (res) => {
    if (!res || !res.headers) return 0;
    const cr = res.headers.get("content-range") || "";
    const slashIdx = cr.indexOf("/");
    if (slashIdx === -1) return 0;
    const totalPart = cr.substring(slashIdx + 1).trim();
    if (!totalPart || totalPart === "*") return 0;
    return parseInt(totalPart, 10) || 0;
  };

  const isUuid = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || "").trim());

  const canRetryAdmin = (res, userId, isVerified = false) =>
    Boolean(isVerified === true && SUPABASE_ADMIN_KEY && isUuid(userId) && (!res || res.status === 401 || res.status === 403 || res.status >= 500));

  const getUserRestHeaders = (token, extra = {}) => ({
    "apikey": SUPABASE_KEY,
    "Authorization": `Bearer ${token || SUPABASE_ANON_KEY || SUPABASE_KEY}`,
    ...extra
  });

  const getAdminRestHeaders = (extra = {}) => ({
    "apikey": SUPABASE_ADMIN_KEY,
    "Authorization": `Bearer ${SUPABASE_ADMIN_KEY}`,
    ...extra
  });

  const restFetchWithAdminFallback = async (restUrl, initFactory, userId, isVerified = false) => {
    let res = await fetch(restUrl, initFactory(false)).catch(() => null);
    if (canRetryAdmin(res, userId, isVerified)) {
      res = await fetch(restUrl, initFactory(true)).catch(() => null);
    }
    return res;
  };

  const inferPersonalMediaType = (item) => {
    const raw = String(item?.media_type || "").trim().toLowerCase();
    if (raw === "comic" || raw === "video" || raw === "game") return raw;
    if (raw === "gallery" || raw === "cosplay") return "gallery";
    const src = String(item?.source || "").trim().toLowerCase();
    if (["pmvhaven", "pornone", "redporn", "anyporn", "alotporn", "damplips", "pornhd", "spankbang", "xvideos", "eporner"].includes(src)) return "video";
    if (["buondua", "4khd", "xasiat", "leakgallery", "mitaku"].includes(src)) return "gallery";
    if (["gamcore", "games", "flash", "ruffle", "renpy"].includes(src) || item?.game_type) return "game";
    return "comic";
  };

  const buildCustomItemKey = (item) => {
    const src = String(item?.source || "").trim().toLowerCase();
    const srcId = String(item?.source_id || "").trim();
    const rawId = String(item?.id || item?.item_id || "").trim();
    if (src && srcId) return `${src}:${srcId}`.slice(0, 180);
    if (rawId) return rawId.slice(0, 180);
    return "";
  };

  const escapeFilterVal = (val) => String(val || "").replace(/[,()"]/g, "").trim();

  const parseStrictPositiveInt = (val) => {
    const s = String(val ?? "").trim();
    if (!/^\d{1,15}$/.test(s)) return null;
    const n = Number(s);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  };

  const resolveSqlItemId = async (candidate, tokenVal, userId) => {
    if (inferPersonalMediaType(candidate) === "game" || String(candidate?.source || "").toLowerCase() === "gamcore") {
      return null;
    }
    const rawNum = parseStrictPositiveInt(candidate?.id || candidate?.item_id);
    if (rawNum) return rawNum;
    const src = String(candidate?.source || "").trim();
    const srcId = String(candidate?.source_id || "").trim();
    if (!src || !srcId) return null;
    try {
      const lookupUrl = `${SUPABASE_URL}/rest/v1/items?source=eq.${encodeURIComponent(src)}&source_id=eq.${encodeURIComponent(srcId)}&status=neq.blocked&real_people=is.false&select=id&limit=1`;
      const res = await fetch(lookupUrl, {
        headers: SUPABASE_ADMIN_KEY ? getAdminRestHeaders() : getUserRestHeaders(tokenVal)
      }).catch(() => null);
      if (res && res.ok) {
        const rows = await res.json().catch(() => []);
        if (Array.isArray(rows) && rows[0]?.id) return parseStrictPositiveInt(rows[0].id);
      }
    } catch (e) {}
    return null;
  };

  const createVideoCatalogLoader = () => {
    let cached = null;
    return async () => {
      if (cached !== null) return cached;
      try {
        cached = (await loadVideoCatalog(context, url)) || [];
      } catch (e) {
        cached = [];
      }
      return cached;
    };
  };

  const formatPersonalMediaEntry = async (entry, getVideoCatalog, fallbackTitle = "Contenido guardado") => {
    const it = entry.items || {};
    const meta = entry.meta || {};
    let effectiveTitle = cleanPublicTitle(it.title || entry.title || meta.title) || fallbackTitle;
    let effectiveSource = it.source || entry.source || meta.source || "";
    let effectiveSourceId = it.source_id || entry.source_id || meta.source_id || "";
    const effectiveReferer = it.url || entry.url || meta.url || "";
    const rawCover = it.cover_url || entry.cover_url || meta.cover_url || "";
    const upstreamCover = extractRawMediaUrl(rawCover) || (rawCover && /^https?:\/\//i.test(rawCover) ? rawCover : "");
    let finalCover = "/velvet_logo.png";
    if (upstreamCover) {
      const freshTok = await encodeToken(upstreamCover, effectiveReferer);
      if (freshTok) finalCover = `/api/media?t=${freshTok}`;
    } else if (rawCover && rawCover.startsWith("/api/media?t=")) {
      finalCover = rawCover;
    }

    if (finalCover === "/velvet_logo.png" || effectiveTitle === fallbackTitle || effectiveTitle === "Guardado" || effectiveTitle === "Contenido visto") {
      const target = String(entry.item_id || entry.id || entry.source_id || "");
      await getVideoCatalog();
      const vMatch = findLocalVideoFast(
        target,
        (effectiveTitle && effectiveTitle !== fallbackTitle && effectiveTitle !== "Guardado" && effectiveTitle !== "Contenido visto") ? effectiveTitle : ""
      );
      if (vMatch) {
        effectiveTitle = cleanPublicTitle(vMatch.title) || effectiveTitle;
        effectiveSource = effectiveSource || "pmvhaven";
        effectiveSourceId = effectiveSourceId || String(vMatch.id || "");
        const vUpstream = extractRawMediaUrl(vMatch.cover_url) || vMatch.cover_url || "";
        if (vUpstream) {
          const freshTok = await encodeToken(vUpstream, vMatch.url || "");
          if (freshTok) finalCover = `/api/media?t=${freshTok}`;
        }
      }
    }
    return { effectiveTitle, effectiveSource, effectiveSourceId, effectiveUrl: "", finalCover };
  };

  const buildCustomFavRow = (userId, item) => {
    const itemKey = buildCustomItemKey(item);
    if (!itemKey) return null;
    return {
      user_id: userId,
      item_key: itemKey,
      item_id: String(item.id || item.item_id || item.source_id || itemKey).slice(0, 120),
      source: String(item.source || "external").slice(0, 40),
      source_id: String(item.source_id || item.id || "").slice(0, 120),
      media_type: inferPersonalMediaType(item),
      title: String(cleanPublicTitle(item.title) || "Contenido guardado").slice(0, 300),
      cover_url: String(extractRawMediaUrl(item.cover_url) || item.cover_url || "").slice(0, 1000),
      url: String(item.url || "").slice(0, 1000),
      created_at: new Date().toISOString()
    };
  };

  const upsertCustomFavoriteRow = async (userId, item, tokenVal, isVerified = false) => {
    const payload = buildCustomFavRow(userId, item);
    if (!payload) return { ok: false, status: 400 };
    const res = await restFetchWithAdminFallback(
      `${SUPABASE_URL}/rest/v1/user_custom_favorites?on_conflict=user_id,item_key`,
      (useAdmin) => ({
        method: "POST",
        headers: (useAdmin ? getAdminRestHeaders : (extra) => getUserRestHeaders(tokenVal, extra))({
          "Content-Type": "application/json",
          "Prefer": "resolution=merge-duplicates,return=minimal"
        }),
        body: JSON.stringify(payload)
      }),
      userId,
      isVerified
    );
    return { ok: Boolean(res && res.ok), status: res ? res.status : 0, item_key: payload.item_key, item_id: payload.item_id };
  };

  const deleteCustomTableTarget = async (tableName, userId, target, tokenVal, isVerified = false) => {
    const { clearAll, numId, rawId, source, sourceId, lastPart, secondLastPart } = target;
    let queryUrl = `${SUPABASE_URL}/rest/v1/${tableName}?user_id=eq.${userId}`;
    if (!clearAll) {
      const clauses = [];
      if (source && sourceId) {
        clauses.push(`item_key.eq.${escapeFilterVal(`${source.toLowerCase()}:${sourceId}`)}`);
      }
      if (secondLastPart && lastPart && lastPart !== "favorites" && lastPart !== "history") {
        clauses.push(`item_key.eq.${escapeFilterVal(`${secondLastPart.toLowerCase()}:${lastPart}`)}`);
      }
      if (rawId) {
        const cleanRaw = escapeFilterVal(rawId);
        if (cleanRaw) {
          clauses.push(`item_key.eq.${cleanRaw}`, `item_id.eq.${cleanRaw}`, `source_id.eq.${cleanRaw}`);
        }
      }
      if (Number.isInteger(numId) && numId > 0) {
        clauses.push(`item_key.eq.${numId}`, `item_id.eq.${numId}`);
      }
      if (lastPart && lastPart !== "favorites" && lastPart !== "history") {
        const cleanLast = escapeFilterVal(lastPart);
        if (cleanLast) {
          clauses.push(`item_key.eq.${cleanLast}`, `item_id.eq.${cleanLast}`, `source_id.eq.${cleanLast}`);
        }
      }
      if (clauses.length === 0) return;
      queryUrl += `&or=(${[...new Set(clauses)].join(",")})`;
    }
    await restFetchWithAdminFallback(
      queryUrl,
      (useAdmin) => ({
        method: "DELETE",
        headers: useAdmin ? getAdminRestHeaders() : getUserRestHeaders(tokenVal)
      }),
      userId,
      isVerified
    );
  };

  const isFavoritesRoute =
    url.pathname === "/api/favorites" ||
    url.pathname === "/api/user/favorites" ||
    url.pathname.startsWith("/api/favorites/") ||
    url.pathname.startsWith("/api/user/favorites/");

  if (isFavoritesRoute) {
    const { user, token, newToken, unavailable, degraded, verified } = await resolveAuthUser(context.request, SUPABASE_URL, SUPABASE_KEY);
    if (unavailable || ((method !== "GET") && (degraded || (user && !verified)))) {
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

    // --- GET ids: lista completa de IDs numéricos y referencias externas de la cuenta ---
    if (method === "GET" && url.searchParams.get("ids") === "1") {
      try {
        const customUrl = `${SUPABASE_URL}/rest/v1/user_custom_favorites?user_id=eq.${user.id}&select=item_key,item_id,source,source_id,media_type,title,cover_url,url&order=created_at.desc&limit=500`;
        const customPromise = restFetchWithAdminFallback(
          customUrl,
          (useAdmin) => ({ headers: useAdmin ? getAdminRestHeaders() : getUserRestHeaders(token) }),
          user.id,
          verified
        );

        const ids = [];
        const seenIds = new Set();
        let sqlOk = false;
        let offset = 0;
        const step = 1000;
        while (offset < 2000) {
          const idsRes = await restFetchWithAdminFallback(
            `${SUPABASE_URL}/rest/v1/favorites?user_id=eq.${user.id}&select=item_id&order=created_at.desc,item_id.desc`,
            (useAdmin) => ({
              headers: (useAdmin ? getAdminRestHeaders : (extra) => getUserRestHeaders(token, extra))({
                "Range": `${offset}-${offset + step - 1}`
              })
            }),
            user.id,
            verified
          );
          if (!idsRes || !idsRes.ok) break;
          sqlOk = true;
          const rows = await idsRes.json().catch(() => []);
          if (!Array.isArray(rows) || rows.length === 0) break;
          for (const r of rows) {
            const n = parseStrictPositiveInt(r.item_id);
            if (n && !seenIds.has(n)) {
              seenIds.add(n);
              ids.push(n);
            }
          }
          if (rows.length < step) break;
          offset += step;
        }

        const refs = [];
        const seenRefs = new Set();
        const pushRefEntry = async (cf) => {
          if (!cf) return;
          const n = parseStrictPositiveInt(cf.id || cf.item_id);
          if (n && !seenIds.has(n)) {
            seenIds.add(n);
            ids.push(n);
          }
          const src = String(cf.source || "external").slice(0, 40);
          const srcId = String(cf.source_id || cf.item_id || cf.id || "").slice(0, 120);
          const refKey = (src && srcId) ? `${src.toLowerCase()}:${srcId}` : String(cf.item_key || cf.id || srcId);
          if (!refKey || seenRefs.has(refKey)) return;
          seenRefs.add(refKey);
          const rawCover = String(cf.cover_url || "");
          const upstreamCover = extractRawMediaUrl(rawCover) || (rawCover && /^https?:\/\//i.test(rawCover) ? rawCover : "");
          let finalCover = rawCover.startsWith("/api/media?t=") ? rawCover : "/velvet_logo.png";
          if (upstreamCover) {
            const freshTok = await encodeToken(upstreamCover, "");
            if (freshTok) finalCover = `/api/media?t=${freshTok}`;
          }
          refs.push({
            id: n || cf.id || cf.item_id || srcId || null,
            item_key: cf.item_key || refKey,
            source: src,
            source_id: srcId,
            media_type: inferPersonalMediaType(cf),
            title: String(cleanPublicTitle(cf.title) || "Contenido guardado").slice(0, 120),
            cover_url: finalCover,
            url: ""
          });
        };

        const customRes = await customPromise;
        if (customRes && customRes.ok) {
          const customRows = await customRes.json().catch(() => []);
          for (const cf of (Array.isArray(customRows) ? customRows : [])) {
            await pushRefEntry(cf);
          }
        }

        // Respaldo de compatibilidad si quedase metadata sin migrar
        const legacyMetaFavs = [
          ...(Array.isArray(user.user_metadata?.favorites) ? user.user_metadata.favorites : []),
          ...(Array.isArray(user.user_metadata?.custom_favorites) ? user.user_metadata.custom_favorites : [])
        ];
        for (const mf of legacyMetaFavs) await pushRefEntry(mf);

        if (!sqlOk && refs.length === 0) {
          return new Response(JSON.stringify({ ids: [], refs: [], total: 0, degraded: true }), {
            status: 200,
            headers: getPersonalHeaders(origin, newToken)
          });
        }

        const customOnlyRefsCount = refs.filter((r) => !seenIds.has(parseStrictPositiveInt(r.id))).length;
        return new Response(JSON.stringify({ ids, refs, total: seenIds.size + customOnlyRefsCount }), {
          status: 200,
          headers: getPersonalHeaders(origin, newToken)
        });
      } catch (idsErr) {
        return new Response(JSON.stringify({ ids: [], refs: [], total: 0, degraded: true }), {
          status: 200,
          headers: getPersonalHeaders(origin, newToken)
        });
      }
    }

    // --- GET FAVORITOS (SQL + Custom unificado con paginación adaptativa máx 18 PC / 12 Android) ---
    if (method === "GET") {
      const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
      const pageSize = resolvePersonalPageSize(context.request, url);
      const offset = (page - 1) * pageSize;
      const to = offset + pageSize - 1;
      const typeFilter = url.searchParams.get("type") || url.searchParams.get("media_type");
      const hasTypeFilter = Boolean(typeFilter && ["comic", "video", "gallery", "game"].includes(typeFilter));
      const getVideoCatalog = createVideoCatalogLoader();

      try {
        const favQueryUrl = `${SUPABASE_URL}/rest/v1/favorites?user_id=eq.${user.id}&select=item_id,created_at,items(id,title,cover_url,media_type,source,source_id,page_count,status)&order=created_at.desc,item_id.desc`;
        const sqlRangeHeader = hasTypeFilter ? "0-499" : `${offset}-${to}`;

        let customUrl = `${SUPABASE_URL}/rest/v1/user_custom_favorites?user_id=eq.${user.id}&select=item_key,item_id,source,source_id,media_type,title,cover_url,url,created_at&order=created_at.desc&limit=500`;
        if (hasTypeFilter) customUrl += `&media_type=eq.${typeFilter}`;

        const [initialFavRes, customRes] = await Promise.all([
          restFetchWithAdminFallback(
            favQueryUrl,
            (useAdmin) => ({
              headers: (useAdmin ? getAdminRestHeaders : (extra) => getUserRestHeaders(token, extra))({
                "Prefer": "count=exact",
                "Range": sqlRangeHeader
              })
            }),
            user.id,
            verified
          ),
          restFetchWithAdminFallback(
            customUrl,
            (useAdmin) => ({
              headers: (useAdmin ? getAdminRestHeaders : (extra) => getUserRestHeaders(token, extra))({
                "Prefer": "count=exact"
              })
            }),
            user.id,
            verified
          )
        ]);

        let favRes = initialFavRes;
        // El embed items(...) falla si la FK no está cacheada. Reintento plano.
        if (!favRes || !favRes.ok) {
          const plainUrl = `${SUPABASE_URL}/rest/v1/favorites?user_id=eq.${user.id}&select=item_id,created_at&order=created_at.desc,item_id.desc`;
          favRes = await restFetchWithAdminFallback(
            plainUrl,
            (useAdmin) => ({
              headers: (useAdmin ? getAdminRestHeaders : (extra) => getUserRestHeaders(token, extra))({
                "Prefer": "count=exact",
                "Range": sqlRangeHeader
              })
            }),
            user.id,
            verified
          );
        }

        const customRowsRaw = customRes && customRes.ok ? await customRes.json().catch(() => []) : [];
        const customRows = Array.isArray(customRowsRaw) ? customRowsRaw : [];
        const customTotal = customRows.length;

        const legacyMetaFavs = [
          ...(Array.isArray(user.user_metadata?.favorites) ? user.user_metadata.favorites : []),
          ...(Array.isArray(user.user_metadata?.custom_favorites) ? user.user_metadata.custom_favorites : [])
        ].filter((mf) => !hasTypeFilter || inferPersonalMediaType(mf) === typeFilter);

        if ((!favRes || !favRes.ok) && customTotal === 0 && legacyMetaFavs.length === 0) {
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

        const sqlTotal = favRes && favRes.ok ? parseContentRangeTotal(favRes) : 0;
        let rawSqlRows = favRes && favRes.ok ? await favRes.json().catch(() => []) : [];
        if (!Array.isArray(rawSqlRows)) rawSqlRows = [];

        // Si existen favoritos custom + SQL paginados en más de 1 página, traer ventana suficiente para ordenar cronológicamente sin saltos
        if ((customTotal > 0 || legacyMetaFavs.length > 0) && sqlTotal > rawSqlRows.length && rawSqlRows.length < sqlTotal) {
          const fullWinTo = Math.min(999, Math.max(to, offset + pageSize + customTotal - 1));
          const winUrl = `${SUPABASE_URL}/rest/v1/favorites?user_id=eq.${user.id}&select=item_id,created_at,items(id,title,cover_url,media_type,source,source_id,page_count,status)&order=created_at.desc,item_id.desc`;
          const winRes = await restFetchWithAdminFallback(
            winUrl,
            (useAdmin) => ({
              headers: (useAdmin ? getAdminRestHeaders : (extra) => getUserRestHeaders(token, extra))({
                "Range": `0-${fullWinTo}`
              })
            }),
            user.id,
            verified
          );
          if (winRes && winRes.ok) {
            const winRows = await winRes.json().catch(() => []);
            if (Array.isArray(winRows) && winRows.length > 0) rawSqlRows = winRows;
          }
        }

        // Enriquecer filas SQL cuyo embed items(...) vino vacío
        const missingFavIds = rawSqlRows
          .filter((r) => !r.items || !r.items.title)
          .map((r) => r.item_id)
          .filter((id) => Number.isInteger(id) && id > 0);
        if (missingFavIds.length > 0 && SUPABASE_ADMIN_KEY) {
          try {
            const itemsRes = await fetch(
              `${SUPABASE_URL}/rest/v1/items?id=in.(${missingFavIds.join(",")})&status=neq.blocked&real_people=is.false&select=id,title,cover_url,media_type,source,source_id,page_count,status,real_people`,
              { headers: getAdminRestHeaders() }
            );
            if (itemsRes.ok) {
              const fetched = await itemsRes.json().catch(() => []);
              const itMap = new Map((Array.isArray(fetched) ? fetched : []).map((it) => [it.id, it]));
              for (const r of rawSqlRows) {
                if (!r.items || !r.items.title) {
                  const found = itMap.get(r.item_id);
                  if (found) r.items = found;
                }
              }
            }
          } catch (e) {}
        }

        const formattedSql = await Promise.all(
          rawSqlRows.map(async (r) => {
            const it = r.items || {};
            const metaMatch = legacyMetaFavs.find((cf) => String(cf.id) === String(r.item_id) || String(cf.source_id) === String(r.item_id));
            const { effectiveTitle, effectiveSource, effectiveSourceId, finalCover } =
              await formatPersonalMediaEntry({ item_id: r.item_id, items: it, meta: metaMatch }, getVideoCatalog, "Guardado");
            const isAvailable = Boolean((it && it.id && it.status !== "blocked" && it.real_people !== true) || metaMatch);
            return {
              id: it.id || r.item_id,
              item_id: r.item_id,
              title: isAvailable ? effectiveTitle : "Contenido no disponible",
              cover_url: finalCover,
              media_type: it.media_type || (metaMatch && metaMatch.media_type) || "comic",
              source: effectiveSource,
              source_id: effectiveSourceId,
              url: "",
              page_count: it.page_count || (metaMatch && metaMatch.page_count) || 0,
              created_at: r.created_at,
              available: isAvailable
            };
          })
        );

        const filteredSql = hasTypeFilter
          ? formattedSql.filter((it) => it.media_type === typeFilter)
          : formattedSql;

        if (customTotal === 0 && legacyMetaFavs.length === 0) {
          const totalOut = hasTypeFilter ? filteredSql.length : Math.max(sqlTotal, filteredSql.length);
          const totalPages = Math.max(1, Math.ceil(totalOut / pageSize));
          const sqlOutSlice = hasTypeFilter ? filteredSql.slice(offset, offset + pageSize) : filteredSql;
          return new Response(JSON.stringify({ items: sqlOutSlice, total: totalOut, page, pageSize, totalPages }), {
            status: 200,
            headers: getPersonalHeaders(origin, newToken)
          });
        }

        const formattedCustom = await Promise.all(
          [...customRows, ...legacyMetaFavs].map(async (cf) => {
            const { effectiveTitle, effectiveSource, effectiveSourceId, finalCover } =
              await formatPersonalMediaEntry(cf, getVideoCatalog, "Contenido guardado");
            const numId = parseStrictPositiveInt(cf.item_id || cf.id);
            const resolvedId = numId || (cf.id || cf.item_id || cf.source_id || cf.item_key);
            return {
              id: resolvedId,
              item_id: resolvedId,
              item_key: cf.item_key || buildCustomItemKey(cf),
              title: effectiveTitle,
              cover_url: finalCover,
              media_type: inferPersonalMediaType(cf),
              source: effectiveSource || "external",
              source_id: effectiveSourceId || String(resolvedId || ""),
              url: "",
              page_count: cf.page_count || 0,
              created_at: cf.created_at || new Date(0).toISOString(),
              available: true,
              is_custom: true
            };
          })
        );

        const seen = new Set();
        const combined = [];
        for (const entry of [...filteredSql, ...formattedCustom]) {
          const dedupKey = (entry.source && entry.source_id)
            ? `${entry.source.toLowerCase()}:${entry.source_id}`
            : String(entry.item_key || entry.id || entry.item_id);
          if (!dedupKey || seen.has(dedupKey)) continue;
          seen.add(dedupKey);
          combined.push(entry);
        }

        combined.sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime());

        const totalCombined = Math.max(combined.length, (hasTypeFilter ? filteredSql.length : sqlTotal) + customTotal);
        const totalPages = Math.max(1, Math.ceil(totalCombined / pageSize));
        const pageSlice = combined.slice(offset, offset + pageSize);

        return new Response(JSON.stringify({ items: pageSlice, total: totalCombined, page, pageSize, totalPages }), {
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

    // --- POST FAVORITOS (SQL favorites + user_custom_favorites, sin inflar JWT metadata) ---
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
          const numericCandidates = [];
          const customCandidates = [];
          for (const it of body.items.slice(0, 200)) {
            const num = parseStrictPositiveInt(it?.id || it?.item_id);
            const isGame = inferPersonalMediaType(it) === "game" || String(it?.source || "").toLowerCase() === "gamcore";
            if (num && !isGame) {
              numericCandidates.push({ num, item: it });
            } else if (it && (it.id || it.item_id || (it.source && it.source_id))) {
              customCandidates.push(it);
            }
          }

          let syncedCount = 0;
          if (numericCandidates.length > 0) {
            const rows = numericCandidates.map((c) => ({ user_id: user.id, item_id: c.num }));
            let batchRes = await restFetchWithAdminFallback(
              `${SUPABASE_URL}/rest/v1/favorites`,
              (useAdmin) => ({
                method: "POST",
                headers: (useAdmin ? getAdminRestHeaders : (extra) => getUserRestHeaders(token, extra))({
                  "Content-Type": "application/json",
                  "Prefer": "resolution=ignore-duplicates"
                }),
                body: JSON.stringify(rows)
              }),
              user.id,
              verified
            );

            if (batchRes && batchRes.ok) {
              syncedCount += numericCandidates.length;
            } else {
              // Batch fallback sin explotar subrequests: verificar qué IDs existen en Supabase en 1 consulta
              const idList = [...new Set(numericCandidates.map(c => c.num))].slice(0, 200);
              let validSet = new Set();
              if (idList.length > 0 && SUPABASE_ADMIN_KEY) {
                try {
                  const existRes = await fetch(
                    `${SUPABASE_URL}/rest/v1/items?id=in.(${idList.join(",")})&select=id&limit=200`,
                    { headers: getAdminRestHeaders() }
                  );
                  if (existRes.ok) {
                    const existRows = await existRes.json().catch(() => []);
                    validSet = new Set((Array.isArray(existRows) ? existRows : []).map(r => Number(r.id)));
                  }
                } catch (e) {}
              }
              const validRows = numericCandidates.filter(c => validSet.has(c.num)).map(c => ({ user_id: user.id, item_id: c.num }));
              for (const c of numericCandidates) {
                if (!validSet.has(c.num)) customCandidates.push(c.item);
              }
              if (validRows.length > 0) {
                const retryBatch = await restFetchWithAdminFallback(
                  `${SUPABASE_URL}/rest/v1/favorites`,
                  (useAdmin) => ({
                    method: "POST",
                    headers: (useAdmin ? getAdminRestHeaders : (extra) => getUserRestHeaders(token, extra))({
                      "Content-Type": "application/json",
                      "Prefer": "resolution=ignore-duplicates"
                    }),
                    body: JSON.stringify(validRows)
                  }),
                  user.id,
                  verified
                );
                if (retryBatch && retryBatch.ok) syncedCount += validRows.length;
              }
            }
          }

          if (customCandidates.length > 0) {
            const seenCustom = new Set();
            const customPayloads = [];
            for (const ci of customCandidates.slice(0, 100)) {
              const row = buildCustomFavRow(user.id, ci);
              if (row && !seenCustom.has(row.item_key)) {
                seenCustom.add(row.item_key);
                customPayloads.push(row);
              }
            }
            if (customPayloads.length > 0) {
              const cfBatchRes = await restFetchWithAdminFallback(
                `${SUPABASE_URL}/rest/v1/user_custom_favorites?on_conflict=user_id,item_key`,
                (useAdmin) => ({
                  method: "POST",
                  headers: (useAdmin ? getAdminRestHeaders : (extra) => getUserRestHeaders(token, extra))({
                    "Content-Type": "application/json",
                    "Prefer": "resolution=merge-duplicates,return=minimal"
                  }),
                  body: JSON.stringify(customPayloads)
                }),
                user.id,
                verified
              );
              if (cfBatchRes && cfBatchRes.ok) syncedCount += customPayloads.length;
            }
          }

          return new Response(JSON.stringify({ ok: true, synced: syncedCount }), {
            status: 200,
            headers: getPersonalHeaders(origin, newToken)
          });
        }

        // Caso B: Toggle a falso si se envía favorite: false
        if (body.favorite === false) {
          const removeId = await resolveSqlItemId(body, token, user.id);
          if (removeId) {
            await restFetchWithAdminFallback(
              `${SUPABASE_URL}/rest/v1/favorites?user_id=eq.${user.id}&item_id=eq.${removeId}`,
              (useAdmin) => ({
                method: "DELETE",
                headers: useAdmin ? getAdminRestHeaders() : getUserRestHeaders(token)
              }),
              user.id,
              verified
            );
          }
          await deleteCustomTableTarget("user_custom_favorites", user.id, {
            numId: Number.isInteger(removeId) ? removeId : null,
            rawId: body.id || body.item_id || null,
            source: body.source || "",
            sourceId: body.source_id || ""
          }, token, verified);
          return new Response(JSON.stringify({ ok: true, removed: true }), {
            status: 200,
            headers: getPersonalHeaders(origin, newToken)
          });
        }

        // Caso C: Agregar favorito individual (SQL favorites -> fallback user_custom_favorites)
        const targetItemId = await resolveSqlItemId(body, token, user.id);

        if (Number.isInteger(targetItemId) && targetItemId > 0) {
          const sqlFavRes = await restFetchWithAdminFallback(
            `${SUPABASE_URL}/rest/v1/favorites`,
            (useAdmin) => ({
              method: "POST",
              headers: (useAdmin ? getAdminRestHeaders : (extra) => getUserRestHeaders(token, extra))({
                "Content-Type": "application/json",
                "Prefer": "resolution=ignore-duplicates"
              }),
              body: JSON.stringify({ user_id: user.id, item_id: targetItemId })
            }),
            user.id,
            verified
          );

          if (sqlFavRes && sqlFavRes.ok) {
            return new Response(JSON.stringify({ ok: true, success: true, item_id: targetItemId }), {
              status: 200,
              headers: getPersonalHeaders(origin, newToken)
            });
          }
        }

        if (body.source || body.source_id || body.title || body.id || body.item_id || targetItemId) {
          const customWrite = await upsertCustomFavoriteRow(
            user.id,
            { ...body, id: body.id || targetItemId || body.item_id || body.source_id },
            token,
            verified
          );
          if (!customWrite.ok) {
            return new Response(JSON.stringify({ error: "No se pudo guardar el favorito en la nube", detail: customWrite.status }), {
              status: 502,
              headers: getPersonalHeaders(origin, newToken)
            });
          }
          return new Response(JSON.stringify({ ok: true, success: true, item_id: customWrite.item_id, item_key: customWrite.item_key, is_custom: true }), {
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
      const isBareFavorites = url.pathname === "/api/favorites" || url.pathname === "/api/user/favorites";
      const isClearAll = url.searchParams.get("clear") === "all";
      const rawId = url.searchParams.get("id") || url.searchParams.get("item_id");
      const qSource = url.searchParams.get("source") || "";
      const qSourceId = url.searchParams.get("source_id") || "";
      const effectiveSource = qSource || (secondLastPart && secondLastPart !== "favorites" ? secondLastPart : "");
      const effectiveSourceId = qSourceId || (!isBareFavorites && secondLastPart && secondLastPart !== "favorites" ? lastPart : "");

      let targetId = parseStrictPositiveInt(rawId);
      if (targetId && (effectiveSource === "gamcore" || url.searchParams.get("media_type") === "game")) {
        targetId = null;
      }
      if (!targetId && effectiveSource && effectiveSourceId) {
        targetId = await resolveSqlItemId({ source: effectiveSource, source_id: effectiveSourceId }, token, user.id);
      }
      if (!targetId && !effectiveSource && !isBareFavorites && lastPart !== "favorites") {
        targetId = parseStrictPositiveInt(lastPart);
      }

      const sqlDeletePromise = isClearAll
        ? restFetchWithAdminFallback(
            `${SUPABASE_URL}/rest/v1/favorites?user_id=eq.${user.id}`,
            (useAdmin) => ({ method: "DELETE", headers: useAdmin ? getAdminRestHeaders() : getUserRestHeaders(token) }),
            user.id,
            verified
          )
        : (Number.isInteger(targetId) && targetId > 0
            ? restFetchWithAdminFallback(
                `${SUPABASE_URL}/rest/v1/favorites?user_id=eq.${user.id}&item_id=eq.${targetId}`,
                (useAdmin) => ({ method: "DELETE", headers: useAdmin ? getAdminRestHeaders() : getUserRestHeaders(token) }),
                user.id,
                verified
              )
            : Promise.resolve(null));

      await Promise.all([
        sqlDeletePromise,
        deleteCustomTableTarget("user_custom_favorites", user.id, {
          clearAll: isClearAll,
          numId: Number.isInteger(targetId) ? targetId : null,
          rawId,
          source: effectiveSource,
          sourceId: effectiveSourceId,
          lastPart: isBareFavorites ? "favorites" : lastPart,
          secondLastPart
        }, token, verified)
      ]);

      return new Response(JSON.stringify({ ok: true, success: true, deleted: rawId || lastPart || targetId }), {
        status: 200,
        headers: getPersonalHeaders(origin, newToken)
      });
    }
  }

  // =========================================================================
  // 9. HISTORIAL Y PROGRESO (/api/user/history, /api/history)
  // Persistencia atómica en user_history + user_custom_history (sin inflar JWT)
  // =========================================================================
  const buildCustomHistRow = (userId, itemData, targetItemId) => {
    const mediaType = inferPersonalMediaType(itemData);
    const pos = Math.max(0, parseInt(itemData.position || itemData.page || itemData.currentTime || 0, 10) || 0);
    const dur = Math.max(0, parseInt(itemData.duration || itemData.total || 0, 10) || 0);
    const comp = Boolean(itemData.completed);
    const clientTs = parseInt(itemData.client_timestamp || itemData.at || Date.now(), 10) || Date.now();
    const itemKey = buildCustomItemKey(itemData);
    if (!itemKey) return null;
    return {
      user_id: userId,
      item_key: itemKey,
      item_id: String(targetItemId || itemData.id || itemData.item_id || itemData.source_id || itemKey).slice(0, 120),
      source: String(itemData.source || "").slice(0, 40),
      source_id: String(itemData.source_id || itemData.id || "").slice(0, 120),
      media_type: mediaType,
      title: String(cleanPublicTitle(itemData.title) || "Contenido visto").slice(0, 300),
      cover_url: String(extractRawMediaUrl(itemData.cover_url) || itemData.cover_url || "").slice(0, 1000),
      url: String(itemData.url || "").slice(0, 1000),
      position: pos,
      duration: dur,
      completed: comp,
      client_timestamp: clientTs,
      last_activity: new Date().toISOString()
    };
  };

  const upsertSqlOrCustomHistory = async (userId, itemData, targetItemId, tokenVal, isVerified = false) => {
    const mediaType = inferPersonalMediaType(itemData);
    const sqlMedia = mediaType === "video" ? "video" : (mediaType === "gallery" ? "gallery" : "comic");
    const pos = Math.max(0, parseInt(itemData.position || itemData.page || itemData.currentTime || 0, 10) || 0);
    const dur = Math.max(0, parseInt(itemData.duration || itemData.total || 0, 10) || 0);
    const comp = Boolean(itemData.completed);
    const clientTs = parseInt(itemData.client_timestamp || itemData.at || Date.now(), 10) || Date.now();

    if (Number.isInteger(targetItemId) && targetItemId > 0) {
      const rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/upsert_history`, {
        method: "POST",
        headers: getUserRestHeaders(tokenVal, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          p_item_id: targetItemId,
          p_media_type: sqlMedia,
          p_position: pos,
          p_duration: dur,
          p_completed: comp,
          p_client_timestamp: clientTs
        })
      }).catch(() => null);

      if (rpcRes && rpcRes.ok) return true;

      const postRes = await restFetchWithAdminFallback(
        `${SUPABASE_URL}/rest/v1/user_history?on_conflict=user_id,item_id`,
        (useAdmin) => ({
          method: "POST",
          headers: (useAdmin ? getAdminRestHeaders : (extra) => getUserRestHeaders(tokenVal, extra))({
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates"
          }),
          body: JSON.stringify({
            user_id: userId,
            item_id: targetItemId,
            media_type: sqlMedia,
            position: pos,
            duration: dur,
            completed: comp,
            last_activity: new Date().toISOString(),
            client_timestamp: clientTs
          })
        }),
        userId,
        isVerified
      );
      if (postRes && postRes.ok) return true;
    }

    const chPayload = buildCustomHistRow(userId, itemData, targetItemId);
    if (!chPayload) return false;
    const customRes = await restFetchWithAdminFallback(
      `${SUPABASE_URL}/rest/v1/user_custom_history?on_conflict=user_id,item_key`,
      (useAdmin) => ({
        method: "POST",
        headers: (useAdmin ? getAdminRestHeaders : (extra) => getUserRestHeaders(tokenVal, extra))({
          "Content-Type": "application/json",
          "Prefer": "resolution=merge-duplicates,return=minimal"
        }),
        body: JSON.stringify(chPayload)
      }),
      userId,
      isVerified
    );
    return Boolean(customRes && customRes.ok);
  };

  const isHistoryRoute =
    url.pathname === "/api/user/history" ||
    url.pathname.startsWith("/api/user/history/") ||
    url.pathname === "/api/history" ||
    url.pathname.startsWith("/api/history/");

  if (isHistoryRoute) {
    const { user, token, newToken, unavailable, degraded, verified } = await resolveAuthUser(context.request, SUPABASE_URL, SUPABASE_KEY);
    if (unavailable || ((method !== "GET") && (degraded || (user && !verified)))) {
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

    // --- GET HISTORIAL (Paginado determinista máx 18 PC / 12 Android desde SQL + Custom) ---
    if (method === "GET") {
      const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
      const pageSize = resolvePersonalPageSize(context.request, url);
      const onlyUnfinished = url.searchParams.get("unfinished") === "1";
      const effectiveSize = onlyUnfinished ? Math.max(pageSize, Math.min(60, parseInt(url.searchParams.get("pageSize") || "48", 10) || 48)) : pageSize;
      const offset = onlyUnfinished ? 0 : (page - 1) * pageSize;
      const to = offset + effectiveSize - 1;
      const typeFilter = url.searchParams.get("type") || url.searchParams.get("media_type");
      const hasTypeFilter = Boolean(typeFilter && ["comic", "video", "gallery", "game"].includes(typeFilter));
      const getVideoCatalog = createVideoCatalogLoader();

      const sqlQueryPromise = (typeFilter === "game")
        ? Promise.resolve(null)
        : (async () => {
            let histQueryUrl = `${SUPABASE_URL}/rest/v1/user_history?user_id=eq.${user.id}&select=id,item_id,media_type,position,duration,completed,last_activity,client_timestamp,items(id,title,cover_url,media_type,source,source_id,page_count,status)&order=last_activity.desc,id.desc`;
            if (onlyUnfinished) histQueryUrl += "&completed=is.false";
            if (typeFilter && ["comic", "video", "gallery"].includes(typeFilter)) {
              histQueryUrl += `&media_type=eq.${typeFilter}`;
            }
            let r = await restFetchWithAdminFallback(
              histQueryUrl,
              (useAdmin) => ({
                headers: (useAdmin ? getAdminRestHeaders : (extra) => getUserRestHeaders(token, extra))({
                  "Prefer": "count=exact",
                  "Range": `${offset}-${to}`
                })
              }),
              user.id,
              verified
            );
            if (!r || !r.ok) {
              let plainHistUrl = `${SUPABASE_URL}/rest/v1/user_history?user_id=eq.${user.id}&select=id,item_id,media_type,position,duration,completed,last_activity,client_timestamp&order=last_activity.desc,id.desc`;
              if (onlyUnfinished) plainHistUrl += "&completed=is.false";
              if (typeFilter && ["comic", "video", "gallery"].includes(typeFilter)) {
                plainHistUrl += `&media_type=eq.${typeFilter}`;
              }
              r = await restFetchWithAdminFallback(
                plainHistUrl,
                (useAdmin) => ({
                  headers: (useAdmin ? getAdminRestHeaders : (extra) => getUserRestHeaders(token, extra))({
                    "Prefer": "count=exact",
                    "Range": `${offset}-${to}`
                  })
                }),
                user.id,
                verified
              );
            }
            return r;
          })();

      let customHistUrl = `${SUPABASE_URL}/rest/v1/user_custom_history?user_id=eq.${user.id}&select=item_key,item_id,source,source_id,media_type,title,cover_url,url,position,duration,completed,client_timestamp,last_activity&order=last_activity.desc&limit=500`;
      if (onlyUnfinished) customHistUrl += "&completed=is.false";
      if (hasTypeFilter) customHistUrl += `&media_type=eq.${typeFilter}`;

      const [histRes, customHistRes] = await Promise.all([
        sqlQueryPromise,
        restFetchWithAdminFallback(
          customHistUrl,
          (useAdmin) => ({
            headers: (useAdmin ? getAdminRestHeaders : (extra) => getUserRestHeaders(token, extra))({
              "Prefer": "count=exact"
            })
          }),
          user.id,
          verified
        )
      ]);

      const customRowsRaw = customHistRes && customHistRes.ok ? await customHistRes.json().catch(() => []) : [];
      const customRows = Array.isArray(customRowsRaw) ? customRowsRaw : [];
      const metaHist = (Array.isArray(user.user_metadata?.history) ? user.user_metadata.history : [])
        .filter((mh) => (!hasTypeFilter || inferPersonalMediaType(mh) === typeFilter) && (!onlyUnfinished || !mh.completed));

      if (typeFilter !== "game" && (!histRes || !histRes.ok) && customRows.length === 0 && metaHist.length === 0) {
        return new Response(JSON.stringify({
          items: [],
          total: 0,
          page,
          pageSize,
          totalPages: 1,
          degraded: true,
          error: "No se pudo leer tu historial"
        }), {
          status: 200,
          headers: getPersonalHeaders(origin, newToken)
        });
      }

      const sqlTotal = (typeFilter !== "game" && histRes && histRes.ok) ? parseContentRangeTotal(histRes) : 0;
      let rawRows = (typeFilter !== "game" && histRes && histRes.ok) ? await histRes.json().catch(() => []) : [];
      if (!Array.isArray(rawRows)) rawRows = [];
      const needsCombinedWindow = typeFilter !== "game" && (customRows.length > 0 || metaHist.length > 0);

      // Si hay historial custom + SQL en más de 1 página, cargar ventana combinada para paginar correctamente sin repetir pág 1
      if (!onlyUnfinished && needsCombinedWindow && sqlTotal > rawRows.length && rawRows.length < sqlTotal) {
        const fullWinTo = Math.min(999, Math.max(to, offset + pageSize + customRows.length + metaHist.length - 1));
        let winHistUrl = `${SUPABASE_URL}/rest/v1/user_history?user_id=eq.${user.id}&select=id,item_id,media_type,position,duration,completed,last_activity,client_timestamp,items(id,title,cover_url,media_type,source,source_id,page_count,status)&order=last_activity.desc,id.desc`;
        if (typeFilter && ["comic", "video", "gallery"].includes(typeFilter)) {
          winHistUrl += `&media_type=eq.${typeFilter}`;
        }
        const winRes = await restFetchWithAdminFallback(
          winHistUrl,
          (useAdmin) => ({
            headers: (useAdmin ? getAdminRestHeaders : (extra) => getUserRestHeaders(token, extra))({
              "Range": `0-${fullWinTo}`
            })
          }),
          user.id,
          verified
        );
        if (winRes && winRes.ok) {
          const winRows = await winRes.json().catch(() => []);
          if (Array.isArray(winRows) && winRows.length > 0) rawRows = winRows;
        }
      }

      // Si algún item_id no vino con items(...) poblado, buscarlo en la tabla items
      const missingHistIds = (Array.isArray(rawRows) ? rawRows : [])
        .filter((r) => !r.items || !r.items.title)
        .map((r) => r.item_id)
        .filter((id) => Number.isInteger(id) && id > 0);
      if (missingHistIds.length > 0 && SUPABASE_ADMIN_KEY) {
        try {
          const itemsRes = await fetch(
            `${SUPABASE_URL}/rest/v1/items?id=in.(${missingHistIds.join(",")})&status=neq.blocked&real_people=is.false&select=id,title,cover_url,media_type,source,source_id,page_count,status,real_people`,
            { headers: getAdminRestHeaders() }
          );
          if (itemsRes.ok) {
            const fetched = await itemsRes.json().catch(() => []);
            const itMap = new Map((Array.isArray(fetched) ? fetched : []).map((it) => [it.id, it]));
            for (const r of rawRows) {
              if (!r.items || !r.items.title) {
                const found = itMap.get(r.item_id);
                if (found) r.items = found;
              }
            }
          }
        } catch (e) {}
      }

      const items = await Promise.all(
        (Array.isArray(rawRows) ? rawRows : []).map(async (r) => {
          const it = r.items || {};
          const metaMatch = metaHist.find((mh) => String(mh.id || mh.item_id) === String(r.item_id));
          const { effectiveTitle, effectiveSource, effectiveSourceId, finalCover } =
            await formatPersonalMediaEntry({ item_id: r.item_id, items: it, meta: metaMatch }, getVideoCatalog, "Contenido visto");
          const isAvailable = Boolean((it && it.id && it.status !== "blocked" && it.real_people !== true) || metaMatch);
          const mType = r.media_type || it.media_type || (metaMatch && metaMatch.media_type) || "comic";
          const pos = Number(r.position || (metaMatch && (metaMatch.position || metaMatch.page || metaMatch.currentTime)) || 0) || 0;
          const dur = Number(r.duration || (metaMatch && (metaMatch.duration || metaMatch.total)) || it.page_count || 0) || 0;
          const isComp = Boolean(r.completed || (metaMatch && metaMatch.completed));
          return {
            id: it.id || r.item_id,
            history_id: r.id,
            item_id: r.item_id,
            title: isAvailable ? effectiveTitle : "Contenido no disponible",
            cover_url: finalCover,
            media_type: mType,
            source: effectiveSource || (mType === "video" ? "pmvhaven" : ""),
            source_id: effectiveSourceId || String(it.id || r.item_id || ""),
            url: "",
            page_count: it.page_count || (metaMatch && metaMatch.page_count) || (mType !== "video" ? dur : 0) || 0,
            position: pos,
            duration: dur,
            page: mType === "video" ? 0 : pos,
            total: mType === "video" ? 0 : (dur || it.page_count || 0),
            currentTime: mType === "video" ? pos : 0,
            completed: isComp,
            last_activity: r.last_activity,
            at: r.client_timestamp ? Number(r.client_timestamp) : (metaMatch && metaMatch.at ? Number(metaMatch.at) : new Date(r.last_activity).getTime()),
            available: isAvailable
          };
        })
      );

      const formattedCustomHist = await Promise.all(
        [...customRows, ...metaHist].map(async (ch) => {
          const { effectiveTitle, effectiveSource, effectiveSourceId, finalCover } =
            await formatPersonalMediaEntry(ch, getVideoCatalog, "Contenido visto");
          const mType = inferPersonalMediaType(ch);
          const numId = parseStrictPositiveInt(ch.item_id || ch.id);
          const resolvedId = (numId && mType !== "game") ? numId : (ch.id || ch.item_id || ch.source_id || ch.item_key);
          const atTs = ch.client_timestamp ? Number(ch.client_timestamp) : (ch.at ? Number(ch.at) : new Date(ch.last_activity || 0).getTime());
          const pos = Number(ch.position || ch.page || ch.currentTime || 0) || 0;
          const dur = Number(ch.duration || ch.total || ch.page_count || 0) || 0;
          return {
            id: resolvedId,
            item_id: resolvedId,
            item_key: ch.item_key || buildCustomItemKey(ch),
            title: effectiveTitle,
            cover_url: finalCover,
            media_type: mType,
            source: effectiveSource || ch.source || "",
            source_id: effectiveSourceId || ch.source_id || String(resolvedId || ""),
            url: "",
            page_count: ch.page_count || (mType !== "video" ? dur : 0) || 0,
            position: pos,
            duration: dur,
            page: mType === "video" ? 0 : pos,
            total: mType === "video" ? 0 : dur,
            currentTime: mType === "video" ? pos : 0,
            completed: Boolean(ch.completed),
            last_activity: ch.last_activity || new Date(atTs || Date.now()).toISOString(),
            at: atTs,
            available: true
          };
        })
      );

      const seenHist = new Set();
      const mergedHist = [];
      for (const h of [...items, ...formattedCustomHist]) {
        if (onlyUnfinished && h.completed) continue;
        const k = (h.source && h.source_id) ? `${h.source.toLowerCase()}:${h.source_id}` : String(h.item_key || h.id || h.item_id);
        if (!k || seenHist.has(k)) continue;
        seenHist.add(k);
        mergedHist.push(h);
      }

      if (formattedCustomHist.length > 0 || onlyUnfinished) {
        mergedHist.sort((a, b) => (b.at || 0) - (a.at || 0));
      }

      const finalTotal = onlyUnfinished ? mergedHist.length : Math.max(sqlTotal + customRows.length, mergedHist.length);
      const totalPages = onlyUnfinished ? 1 : Math.max(1, Math.ceil(finalTotal / pageSize));
      const sliceOut = onlyUnfinished
        ? mergedHist.slice(0, effectiveSize)
        : (needsCombinedWindow ? mergedHist.slice(offset, offset + pageSize) : mergedHist.slice(0, pageSize));

      return new Response(JSON.stringify({ items: sliceOut, total: finalTotal, page: onlyUnfinished ? 1 : page, pageSize: onlyUnfinished ? effectiveSize : pageSize, totalPages }), {
        status: 200,
        headers: getPersonalHeaders(origin, newToken)
      });
    }

    // --- POST HISTORIAL (SQL user_history + user_custom_history, sin inflar JWT metadata) ---
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
          const batch = body.items.slice(0, 50);
          const resolvedEntries = [];
          for (let i = 0; i < batch.length; i += 6) {
            const chunk = batch.slice(i, i + 6);
            const part = await Promise.all(chunk.map(async (it) => ({
              it,
              resolvedId: await resolveSqlItemId(it, token, user.id)
            })));
            resolvedEntries.push(...part);
          }

          const sqlRows = [];
          const customRows = [];
          let synced = 0;
          const nowIso = new Date().toISOString();

          for (const { it, resolvedId } of resolvedEntries) {
            if (!it || typeof it !== "object") continue;
            if (Number.isInteger(resolvedId) && resolvedId > 0) {
              const mediaType = inferPersonalMediaType(it);
              const sqlMedia = mediaType === "video" ? "video" : (mediaType === "gallery" ? "gallery" : "comic");
              sqlRows.push({
                user_id: user.id,
                item_id: resolvedId,
                media_type: sqlMedia,
                position: Math.max(0, parseInt(it.position || it.page || it.currentTime || 0, 10) || 0),
                duration: Math.max(0, parseInt(it.duration || it.total || 0, 10) || 0),
                completed: Boolean(it.completed),
                last_activity: nowIso,
                client_timestamp: parseInt(it.client_timestamp || it.at || Date.now(), 10) || Date.now()
              });
            } else {
              const ch = buildCustomHistRow(user.id, it, resolvedId);
              if (ch) customRows.push(ch);
            }
          }

          if (sqlRows.length > 0) {
            const sqlBatchRes = await restFetchWithAdminFallback(
              `${SUPABASE_URL}/rest/v1/user_history?on_conflict=user_id,item_id`,
              (useAdmin) => ({
                method: "POST",
                headers: (useAdmin ? getAdminRestHeaders : (extra) => getUserRestHeaders(token, extra))({
                  "Content-Type": "application/json",
                  "Prefer": "resolution=merge-duplicates,return=minimal"
                }),
                body: JSON.stringify(sqlRows)
              }),
              user.id,
              verified
            );
            if (sqlBatchRes && sqlBatchRes.ok) synced += sqlRows.length;
          }

          if (customRows.length > 0) {
            const customBatchRes = await restFetchWithAdminFallback(
              `${SUPABASE_URL}/rest/v1/user_custom_history?on_conflict=user_id,item_key`,
              (useAdmin) => ({
                method: "POST",
                headers: (useAdmin ? getAdminRestHeaders : (extra) => getUserRestHeaders(token, extra))({
                  "Content-Type": "application/json",
                  "Prefer": "resolution=merge-duplicates,return=minimal"
                }),
                body: JSON.stringify(customRows)
              }),
              user.id,
              verified
            );
            if (customBatchRes && customBatchRes.ok) synced += customRows.length;
          }

          return new Response(JSON.stringify({ ok: true, synced }), {
            status: 200,
            headers: getPersonalHeaders(origin, newToken)
          });
        }

        // Caso B: Progreso individual
        const itemData = body.item || body;
        const targetItemId = await resolveSqlItemId(itemData, token, user.id);
        const savedOk = await upsertSqlOrCustomHistory(user.id, itemData, targetItemId, token, verified);
        if (!savedOk) {
          return new Response(JSON.stringify({ error: "No se pudo guardar el progreso en la nube" }), {
            status: 502,
            headers: getPersonalHeaders(origin, newToken)
          });
        }

        return new Response(JSON.stringify({ ok: true, success: true, item_id: targetItemId || itemData.id, sql: savedOk }), {
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

      const rawId = url.searchParams.get("id") || url.searchParams.get("item_id");
      const qSource = url.searchParams.get("source") || "";
      const qSourceId = url.searchParams.get("source_id") || "";
      const parts = url.pathname.split("/").filter(Boolean);
      const isBareHistoryPath = url.pathname === "/api/user/history" || url.pathname === "/api/history";
      const isClearAll = url.searchParams.get("clear") === "all" || url.searchParams.get("action") === "clear"
        || (isBareHistoryPath && !rawId && !qSource && !qSourceId);

      if (isClearAll) {
        await Promise.all([
          restFetchWithAdminFallback(
            `${SUPABASE_URL}/rest/v1/user_history?user_id=eq.${user.id}`,
            (useAdmin) => ({ method: "DELETE", headers: useAdmin ? getAdminRestHeaders() : getUserRestHeaders(token) }),
            user.id,
            verified
          ),
          deleteCustomTableTarget("user_custom_history", user.id, { clearAll: true }, token, verified)
        ]);
        return new Response(JSON.stringify({ ok: true, cleared: true }), {
          status: 200,
          headers: getPersonalHeaders(origin, newToken)
        });
      }

      let targetId = parseStrictPositiveInt(rawId);
      const lastPart = parts[parts.length - 1];
      const secondLastPart = parts.length >= 4 ? parts[parts.length - 2] : null;
      if (!targetId) {
        targetId = parseStrictPositiveInt(lastPart);
      }
      if (!targetId && ((qSource && qSourceId) || (secondLastPart && lastPart && secondLastPart !== "history"))) {
        targetId = await resolveSqlItemId({
          source: qSource || secondLastPart,
          source_id: qSourceId || lastPart
        }, token, user.id);
      }

      if (!targetId && !rawId && !qSource && !qSourceId && (!lastPart || lastPart === "history")) {
        return new Response(JSON.stringify({ error: "Identificador requerido para eliminar del historial" }), {
          status: 400,
          headers: getPersonalHeaders(origin, newToken)
        });
      }

      await Promise.all([
        (Number.isInteger(targetId) && targetId > 0)
          ? restFetchWithAdminFallback(
              `${SUPABASE_URL}/rest/v1/user_history?user_id=eq.${user.id}&item_id=eq.${targetId}`,
              (useAdmin) => ({ method: "DELETE", headers: useAdmin ? getAdminRestHeaders() : getUserRestHeaders(token) }),
              user.id,
              verified
            )
          : Promise.resolve(null),
        deleteCustomTableTarget("user_custom_history", user.id, {
          numId: Number.isInteger(targetId) ? targetId : null,
          rawId,
          source: qSource,
          sourceId: qSourceId,
          lastPart,
          secondLastPart
        }, token, verified)
      ]);

      return new Response(JSON.stringify({ ok: true, success: true, deleted_id: targetId || qSourceId || rawId || lastPart }), {
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
    const { user, token, newToken, unavailable, degraded, verified } = await resolveAuthUser(context.request, SUPABASE_URL, SUPABASE_KEY);
    if (unavailable || ((method !== "GET") && (degraded || (user && !verified)))) {
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
      const rawData = (body.data && typeof body.data === "object") ? { ...body.data } : { ...body };
      let dataObj = rawData;

      if (dataObj.game_saves === undefined) {
        try {
          const existingRes = await fetch(`${SUPABASE_URL}/rest/v1/user_preferences?user_id=eq.${user.id}&select=data&limit=1`, {
            headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${token || SUPABASE_ANON_KEY || SUPABASE_KEY}` }
          });
          if (existingRes.ok) {
            const existingRows = await existingRes.json().catch(() => []);
            const existingSaves = existingRows && existingRows[0] && existingRows[0].data && existingRows[0].data.game_saves;
            if (existingSaves && typeof existingSaves === "object") {
              dataObj = { ...dataObj, game_saves: existingSaves };
            }
          }
        } catch (e) {}
      }

      const serialized = JSON.stringify(dataObj);
      if (serialized.length > 16384) {
        return new Response(JSON.stringify({ error: "Tamaño máximo de preferencias excedido (16KB)" }), {
          status: 413,
          headers: getPersonalHeaders(origin, newToken)
        });
      }
      const ver = parseInt(body.version || 2, 10);
      const nowIso = new Date().toISOString();

      const prefWriteRes = await fetch(`${SUPABASE_URL}/rest/v1/user_preferences?on_conflict=user_id`, {
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

      if (!prefWriteRes.ok) {
        return new Response(JSON.stringify({ error: "No se pudieron guardar las preferencias" }), {
          status: 502,
          headers: getPersonalHeaders(origin, newToken)
        });
      }

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
    const { user, token, newToken, verified } = await resolveAuthUser(context.request, SUPABASE_URL, SUPABASE_KEY);
    if (!user) {
      return new Response(JSON.stringify({ authenticated: false }), {
        status: 200,
        headers: getPersonalHeaders(origin)
      });
    }

    try {
      const [favRes, customFavRes, histRes, customHistRes, prefRes] = await Promise.all([
        restFetchWithAdminFallback(
          `${SUPABASE_URL}/rest/v1/favorites?user_id=eq.${user.id}&select=item_id`,
          (useAdmin) => ({
            headers: (useAdmin ? getAdminRestHeaders : (extra) => getUserRestHeaders(token, extra))({
              "Prefer": "count=exact",
              "Range": "0-0"
            })
          }),
          user.id,
          verified
        ),
        restFetchWithAdminFallback(
          `${SUPABASE_URL}/rest/v1/user_custom_favorites?user_id=eq.${user.id}&select=item_key`,
          (useAdmin) => ({
            headers: (useAdmin ? getAdminRestHeaders : (extra) => getUserRestHeaders(token, extra))({
              "Prefer": "count=exact",
              "Range": "0-0"
            })
          }),
          user.id,
          verified
        ),
        restFetchWithAdminFallback(
          `${SUPABASE_URL}/rest/v1/user_history?user_id=eq.${user.id}&select=id`,
          (useAdmin) => ({
            headers: (useAdmin ? getAdminRestHeaders : (extra) => getUserRestHeaders(token, extra))({
              "Prefer": "count=exact",
              "Range": "0-0"
            })
          }),
          user.id,
          verified
        ),
        restFetchWithAdminFallback(
          `${SUPABASE_URL}/rest/v1/user_custom_history?user_id=eq.${user.id}&select=item_key`,
          (useAdmin) => ({
            headers: (useAdmin ? getAdminRestHeaders : (extra) => getUserRestHeaders(token, extra))({
              "Prefer": "count=exact",
              "Range": "0-0"
            })
          }),
          user.id,
          verified
        ),
        fetch(`${SUPABASE_URL}/rest/v1/user_preferences?user_id=eq.${user.id}&select=updated_at&limit=1`, {
          headers: getUserRestHeaders(token)
        })
      ]);

      const favCount = parseContentRangeTotal(favRes) + parseContentRangeTotal(customFavRes);
      const histCount = parseContentRangeTotal(histRes) + parseContentRangeTotal(customHistRes);
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
    const { user, token, newToken, unavailable, degraded, verified } = await resolveAuthUser(context.request, SUPABASE_URL, SUPABASE_KEY);
    if (unavailable || ((method !== "GET") && (degraded || (user && !verified)))) {
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

      const slotName = String(body.slot_name || "auto").trim().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32) || "auto";
      const saveData = String(body.save_data || "");
      if (saveData.length > 8192) {
        return new Response(JSON.stringify({ error: "El archivo de guardado excede el tamaño máximo permitido (8KB)" }), {
          status: 413,
          headers: getPersonalHeaders(origin, newToken)
        });
      }
      const gameTitle = String(body.game_title || "").slice(0, 200);
      const coverUrl = String(body.cover_url || "").slice(0, 500);
      const gameType = String(body.game_type || "html5").slice(0, 20);
      const playTime = Math.max(0, parseInt(body.play_time || 0, 10));
      const clientTimestamp = Date.now();
      const nowIso = new Date().toISOString();

      const savePayload = {
        user_id: user.id,
        game_id: targetGameId.slice(0, 120),
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
        // Fallback a user_preferences en DB1 (limitado a 16KB por constraint SQL)
        const prefRes = await fetch(`${SUPABASE_URL}/rest/v1/user_preferences?user_id=eq.${user.id}&select=data&limit=1`, {
          headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${token || SUPABASE_ANON_KEY || SUPABASE_KEY}` }
        });
        const prefData = prefRes.ok ? await prefRes.json().catch(() => []) : [];
        const currentData = (prefData && prefData[0] && prefData[0].data) || {};
        const gameSavesStore = currentData.game_saves || {};
        gameSavesStore[savePayload.game_id] = gameSavesStore[savePayload.game_id] || {};
        gameSavesStore[savePayload.game_id][slotName] = savePayload;
        currentData.game_saves = gameSavesStore;
        if (JSON.stringify(currentData).length > 16384) {
          return new Response(JSON.stringify({ error: "Espacio total de guardados en la nube lleno (16KB)" }), {
            status: 413,
            headers: getPersonalHeaders(origin, newToken)
          });
        }

        const prefWriteRes = await fetch(`${SUPABASE_URL}/rest/v1/user_preferences`, {
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
        if (!prefWriteRes.ok) {
          return new Response(JSON.stringify({ error: "No se pudo sincronizar la partida en la nube" }), {
            status: 502,
            headers: getPersonalHeaders(origin, newToken)
          });
        }
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

      if (!targetGameId) {
        return new Response(JSON.stringify({ error: "game_id requerido" }), {
          status: 400,
          headers: getPersonalHeaders(origin, newToken)
        });
      }

      let delUrl = `${SUPABASE_URL}/rest/v1/game_saves?user_id=eq.${user.id}&game_id=eq.${encodeURIComponent(targetGameId)}`;
      if (slotName) delUrl += `&slot_name=eq.${encodeURIComponent(slotName)}`;
      const delRes = await fetch(delUrl, {
        method: "DELETE",
        headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${token || SUPABASE_ANON_KEY || SUPABASE_KEY}` }
      }).catch(() => null);

      let prefClearedOk = false;
      try {
        const prefRes = await fetch(`${SUPABASE_URL}/rest/v1/user_preferences?user_id=eq.${user.id}&select=data&limit=1`, {
          headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${token || SUPABASE_ANON_KEY || SUPABASE_KEY}` }
        });
        if (prefRes.ok) {
          const prefRows = await prefRes.json().catch(() => []);
          const currentData = (prefRows && prefRows[0] && prefRows[0].data) ? { ...prefRows[0].data } : null;
          if (currentData && currentData.game_saves && currentData.game_saves[targetGameId]) {
            if (slotName) {
              delete currentData.game_saves[targetGameId][slotName];
              if (Object.keys(currentData.game_saves[targetGameId]).length === 0) {
                delete currentData.game_saves[targetGameId];
              }
            } else {
              delete currentData.game_saves[targetGameId];
            }
            const prefWriteRes = await fetch(`${SUPABASE_URL}/rest/v1/user_preferences?on_conflict=user_id`, {
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
                updated_at: new Date().toISOString()
              })
            });
            prefClearedOk = Boolean(prefWriteRes && prefWriteRes.ok);
          } else {
            prefClearedOk = true;
          }
        }
      } catch (e) {}

      if ((!delRes || !delRes.ok) && !prefClearedOk) {
        return new Response(JSON.stringify({ error: "No se pudo eliminar la partida guardada" }), {
          status: 502,
          headers: getPersonalHeaders(origin, newToken)
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
    const { user, token, newToken, unavailable, degraded, verified } = await resolveAuthUser(context.request, SUPABASE_URL, SUPABASE_KEY);
    if (unavailable || degraded || (user && !verified)) {
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
    const rawUsername = String(body.username || "").trim();
    const username = rawUsername ? sanitizeUsername(rawUsername) : "";
    const avatar = sanitizeProfileAvatar(body.avatar);
    const avatarBg = sanitizeProfileAvatarBg(body.avatarBg);

    if (rawUsername && (!username || username.length < 2)) {
      return new Response(JSON.stringify({ error: "El nombre de usuario debe tener al menos 2 caracteres válidos" }), {
        status: 400,
        headers: getPersonalHeaders(origin, newToken)
      });
    }
    if (username && isReservedUsername(username)) {
      return new Response(JSON.stringify({ error: "Ese nombre de usuario está reservado y no se puede utilizar" }), {
        status: 403,
        headers: getPersonalHeaders(origin, newToken)
      });
    }

    if (username && SUPABASE_ADMIN_KEY) {
      const escapedUserLike = escapePostgrestLike(username);
      const dupRes = await fetch(
        `${SUPABASE_URL}/rest/v1/profiles?select=id,username&username=ilike.${encodeURIComponent(escapedUserLike)}&id=neq.${encodeURIComponent(user.id)}&limit=5`,
        { headers: { "apikey": SUPABASE_ADMIN_KEY, "Authorization": `Bearer ${SUPABASE_ADMIN_KEY}` } }
      );
      if (dupRes.ok) {
        const dupRows = await dupRes.json().catch(() => []);
        if (Array.isArray(dupRows) && dupRows.some(r => String(r.username || "").trim().toLowerCase() === username.toLowerCase())) {
          return new Response(JSON.stringify({ error: "Ese nombre de usuario ya está en uso por otro miembro" }), {
            status: 409,
            headers: getPersonalHeaders(origin, newToken)
          });
        }
      }
    }

    const userMetadata = { ...(user.user_metadata || {}) };
    if (username) userMetadata.username = username;
    userMetadata.avatar = avatar;
    userMetadata.avatarBg = avatarBg;

    // Actualizar metadata en Supabase Auth
    const authPutRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      method: "PUT",
      headers: {
        "apikey": SUPABASE_KEY,
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ data: userMetadata })
    }).catch(() => null);

    // Actualizar perfil persistente en Postgres
    const profPatch = {
      avatar,
      avatar_bg: avatarBg,
      updated_at: new Date().toISOString()
    };
    if (username) profPatch.username = username;

    const patchKey = (SUPABASE_SERVICE_ROLE_KEY && SUPABASE_SERVICE_ROLE_KEY !== SUPABASE_ANON_KEY)
      ? SUPABASE_SERVICE_ROLE_KEY
      : (token || SUPABASE_ANON_KEY || SUPABASE_KEY);
    const patchApiKey = (SUPABASE_SERVICE_ROLE_KEY && SUPABASE_SERVICE_ROLE_KEY !== SUPABASE_ANON_KEY)
      ? SUPABASE_SERVICE_ROLE_KEY
      : (SUPABASE_ANON_KEY || SUPABASE_KEY);

    const profPatchRes = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}`, {
      method: "PATCH",
      headers: {
        "apikey": patchApiKey,
        "Authorization": `Bearer ${patchKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(profPatch)
    }).catch(() => null);

    if ((!authPutRes || !authPutRes.ok) && (!profPatchRes || !profPatchRes.ok)) {
      return new Response(JSON.stringify({ error: "No se pudo actualizar el perfil" }), {
        status: 502,
        headers: getPersonalHeaders(origin, newToken)
      });
    }
    if (profPatchRes && profPatchRes.status === 409) {
      return new Response(JSON.stringify({ error: "Ese nombre de usuario ya está en uso por otro miembro" }), {
        status: 409,
        headers: getPersonalHeaders(origin, newToken)
      });
    }

    const updatedProfile = await fetchUserProfile(SUPABASE_URL, SUPABASE_ADMIN_KEY, SUPABASE_KEY, user.id, token);
    const view = buildUserSubscriptionView(
      updatedProfile || { id: user.id, email: user.email, username, avatar, avatar_bg: avatarBg },
      { ...user, user_metadata: userMetadata },
      env
    );

    return new Response(JSON.stringify({
      ok: true,
      success: true,
      user: publicUserPayload(view)
    }), {
      status: 200,
      headers: getPersonalHeaders(origin, newToken)
    });
  }

  if (url.pathname === "/api/user/change-password" && method === "POST") {
    const { user, token, newToken, unavailable, degraded, verified } = await resolveAuthUser(context.request, SUPABASE_URL, SUPABASE_KEY);
    if (unavailable || degraded || (user && !verified)) {
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
    const oldPassword = String(body.old_password || "");
    const newPassword = String(body.new_password || "");
    if (!newPassword || newPassword.length < 6) {
      return new Response(JSON.stringify({ error: "La nueva contraseña debe tener al menos 6 caracteres" }), {
        status: 400,
        headers: getPersonalHeaders(origin, newToken)
      });
    }

    const isInitialPatreonPassword = Boolean(
      user.user_metadata?.patreon_id && user.user_metadata?.password_initialized !== true && !oldPassword
    );
    if (!isInitialPatreonPassword) {
      if (!oldPassword) {
        return new Response(JSON.stringify({ error: "Ingresa tu contraseña actual" }), {
          status: 400,
          headers: getPersonalHeaders(origin, newToken)
        });
      }
      const verifyRes = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
        method: "POST",
        headers: {
          "apikey": SUPABASE_ANON_KEY || SUPABASE_KEY,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ email: user.email, password: oldPassword })
      }).catch(() => null);
      if (!verifyRes || !verifyRes.ok) {
        return new Response(JSON.stringify({ error: "La contraseña actual es incorrecta" }), {
          status: 401,
          headers: getPersonalHeaders(origin, newToken)
        });
      }
    }

    const nextMeta = { ...(user.user_metadata || {}), password_initialized: true };
    const upRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      method: "PUT",
      headers: {
        "apikey": SUPABASE_KEY,
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ password: newPassword, data: nextMeta })
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
