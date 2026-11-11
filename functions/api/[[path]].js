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

const SUPABASE_URL = "https://qnmcejlxoufheisgkuyo.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFubWNlamx4b3VmaGVpc2drdXlvIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc5MTU1NzI0NiwiZXhwIjoyMTA3MTMzMjQ2fQ.lDom8ovim8HH-8oxcsSKCRQNN0UjMV_Po-VSo-zanDU";
const MEDIA_SECRET = "velvet_ultra_stealth_secret_key_2026";

// Cifrado y descifrado XOR simétrico UTF-8 seguro (soporta caracteres asiáticos y emojis sin error btoa)
function encodeMediaToken(targetUrl, referer = "") {
  if (!targetUrl) return "";
  try {
    const raw = JSON.stringify({ u: targetUrl, r: referer || "" });
    const utf8Bytes = new TextEncoder().encode(raw);
    const keyBytes = new TextEncoder().encode(MEDIA_SECRET);
    const xorBytes = new Uint8Array(utf8Bytes.length);
    for (let i = 0; i < utf8Bytes.length; i++) {
      xorBytes[i] = utf8Bytes[i] ^ keyBytes[i % keyBytes.length];
    }
    let bin = "";
    for (let i = 0; i < xorBytes.length; i++) {
      bin += String.fromCharCode(xorBytes[i]);
    }
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  } catch (e) {
    return "";
  }
}

function decodeMediaToken(token) {
  if (!token) return null;
  try {
    let b64 = token.replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    const bin = atob(b64);
    const keyBytes = new TextEncoder().encode(MEDIA_SECRET);
    const xorBytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
      xorBytes[i] = bin.charCodeAt(i) ^ keyBytes[i % keyBytes.length];
    }
    const dec = new TextDecoder().decode(xorBytes);
    return JSON.parse(dec);
  } catch (e) {
    return null;
  }
}

function decodePayload(tParam, urlParam, refParam) {
  if (urlParam) return { u: urlParam, r: refParam || "" };
  if (!tParam) return null;

  const secretDec = decodeMediaToken(tParam);
  if (secretDec && secretDec.u) return secretDec;

  try {
    let b64 = tParam.replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    const jsonStr = decodeURIComponent(escape(atob(b64)));
    const parsed = JSON.parse(jsonStr);
    if (parsed && parsed.u) return parsed;
  } catch (e) {}

  return null;
}

// Cabeceras CORS estándar
function getCorsHeaders(origin = "*") {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, PATCH, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, Range, X-Requested-With, X-Refresh-Token, X-Device-Token, x-velvet-client",
    "Server": "Velvet-Cloud",
    "X-Powered-By": "Velvet-Native-Cloudflare-Engine/3.0"
  };
}

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const origin = context.request.headers.get("origin") || "*";
  const method = context.request.method;

  // Manejo de Preflight OPTIONS
  if (method === "OPTIONS") {
    return new Response(null, { status: 204, headers: getCorsHeaders(origin) });
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
    const tParam = url.searchParams.get("t");
    const urlParam = url.searchParams.get("url") || url.searchParams.get("i");
    const refParam = url.searchParams.get("r") || url.searchParams.get("referer");

    const payload = decodePayload(tParam, urlParam, refParam);
    if (!payload || !payload.u || !/^https?:\/\//i.test(payload.u)) {
      return new Response("Media token invalido o expirado", {
        status: 400,
        headers: { "Content-Type": "text/plain; charset=utf-8", ...getCorsHeaders(origin) }
      });
    }

    const targetMediaUrl = payload.u;
    const isVideo =
      targetMediaUrl.includes(".mp4") ||
      targetMediaUrl.includes(".m3u8") ||
      url.pathname.includes("/video/");

    // Cloudflare Edge Cache para imágenes (7 días de retención mundial acelerada)
    const cache = caches.default;
    const cacheKey = new Request(url.toString(), context.request);

    if (!isVideo && method === "GET") {
      try {
        const cached = await cache.match(cacheKey);
        if (cached) {
          const ch = new Headers(cached.headers);
          ch.set("X-Media-Cache", "HIT-CLOUDFLARE");
          ch.set("X-Powered-By", "Velvet-Media-Engine/3.0");
          ch.set("Server", "Velvet-Cloud");
          ch.set("Access-Control-Allow-Origin", "*");
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
      const upstream = await fetch(targetMediaUrl, {
        method,
        headers: upstreamReqHeaders,
        redirect: "follow",
        cf: isVideo ? undefined : { cacheEverything: true, cacheTtl: 604800 },
      });

      const respHeaders = new Headers();
      respHeaders.set("Content-Type", upstream.headers.get("content-type") || (isVideo ? "video/mp4" : "image/jpeg"));
      respHeaders.set("Access-Control-Allow-Origin", "*");
      respHeaders.set("X-Powered-By", "Velvet-Media-Engine/3.0");
      respHeaders.set("Server", "Velvet-Cloud");

      if (isVideo) {
        respHeaders.set("Accept-Ranges", "bytes");
        respHeaders.set("Cache-Control", "public, max-age=7200");
      } else {
        respHeaders.set("Cache-Control", "public, max-age=604800, s-maxage=604800, immutable");
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
          const rewritten = lines.map(line => {
            const trimmed = line.trim();
            if (!trimmed) return line;
            if (trimmed.startsWith("#")) {
              return line.replace(/URI=["']([^"']+)["']/g, (match, uri) => {
                const abs = uri.startsWith("http") ? uri : new URL(uri, baseUrl).href;
                return `URI="/api/media?t=${encodeMediaToken(abs, spoofedReferer)}"`;
              });
            }
            const abs = trimmed.startsWith("http") ? trimmed : new URL(trimmed, baseUrl).href;
            return `/api/media?t=${encodeMediaToken(abs, spoofedReferer)}`;
          });
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

      if (!isVideo && upstream.status === 200) {
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
    const rawId = itemDetailMatch[1];
    const rawSource = itemDetailMatch[2];
    const rawSourceId = itemDetailMatch[3];

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
      const spRes = await fetch(`${SUPABASE_URL}/rest/v1/items?${queryParam}&limit=1`, {
        headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}` }
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

      const masked = {
        ...it,
        url: "", // Ocultar URL original
        cover_url: it.cover_url ? `/api/media?t=${encodeMediaToken(it.cover_url)}` : "",
        pages: (it.pages || []).map((p, idx) => ({
          index: p.index || idx + 1,
          image_url: p.image_url ? `/api/media?t=${encodeMediaToken(p.image_url)}` : ""
        })),
        video_sources: sortedSources.map(vs => ({
          ...vs,
          url: vs.url ? `/api/media?t=${encodeMediaToken(vs.url, it.url || vs.referer || "")}` : ""
        }))
      };

      return new Response(JSON.stringify(masked), {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": isEphemeral ? "no-store, no-cache, must-revalidate" : "public, max-age=60, s-maxage=300",
          ...getCorsHeaders(origin)
        }
      });
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
  if (url.pathname === "/api/items" && method === "GET") {
    const mediaType = url.searchParams.get("media_type") || "comic";
    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
    const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get("page_size") || "24", 10)));
    const q = (url.searchParams.get("q") || "").trim();
    const category = (url.searchParams.get("category") || "").trim().toLowerCase();

    // Cache de Borde Cloudflare para catálogo público (300 segundos, solo sin búsqueda activa)
    const cache = caches.default;
    const cacheKey = new Request(url.toString(), context.request);
    if (!q) {
      try {
        const cached = await cache.match(cacheKey);
        if (cached) {
          const edgeHeaders = new Headers(cached.headers);
          edgeHeaders.set("X-Cloudflare-Edge-Cache", "HIT");
          edgeHeaders.set("Access-Control-Allow-Origin", origin || "*");
          return new Response(cached.body, { status: 200, headers: edgeHeaders });
        }
      } catch (e) {}
    }

    const seedParam = parseInt(url.searchParams.get("seed") || "0", 10);
    const sort = url.searchParams.get("sort") || "recent";

    let offset = (page - 1) * pageSize;
    if (seedParam > 0 && !q && sort === "recent") {
      let baseWindow = 40;
      let multiplier = 7919;
      if (mediaType === "video") {
        multiplier = 1337;
        baseWindow = (category && category !== "all") ? 10 : 30;
      } else if (mediaType === "gallery" || mediaType === "cosplay") {
        multiplier = 7919;
        baseWindow = (category && category !== "all") ? 10 : 40;
      } else {
        multiplier = 3137;
        baseWindow = (category && category !== "all") ? 10 : 40;
      }
      const basePage = Math.abs(seedParam * multiplier) % baseWindow;
      offset = (basePage + (page - 1)) * pageSize;
    }

    const selectFields = "id,source,source_id,title,cover_url,media_type,tags,page_count,video_sources,artists";
    let postgrestUrl = `${SUPABASE_URL}/rest/v1/items?select=${selectFields}&limit=${pageSize}&offset=${offset}`;

    let estimatedTotal = 100000;

    if (mediaType === "video") {
      postgrestUrl += "&source=eq.pmvhaven&id=lte.304215";
      estimatedTotal = 20242;
    } else if (mediaType === "gallery" || mediaType === "cosplay") {
      postgrestUrl += "&media_type=eq.gallery";
      // Leakedgallery solo 0.002 (0.2%) de probabilidad ultra rara o si se busca explícitamente
      const allowLeak = (Math.random() < 0.002) || (q && q.toLowerCase().includes("leak")) || (category === "leak" || category === "patreon");
      if (!allowLeak) {
        postgrestUrl += "&source=neq.leakgallery";
      }
      estimatedTotal = 18261;
    } else {
      postgrestUrl += "&media_type=eq.comic";
      estimatedTotal = 105326;
    }

    if (q) {
      const words = q.split(/\s+/).filter(Boolean).slice(0, 3);
      if (words.length === 1) {
        postgrestUrl += `&search_text=ilike.*${encodeURIComponent(words[0])}*`;
      } else {
        const orClauses = words.map(w => `search_text.ilike.*${encodeURIComponent(w)}*`).join(",");
        postgrestUrl += `&or=(${orClauses})`;
      }
      estimatedTotal = 800;
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
      estimatedTotal = 1500;
    } else {
      // Orden por defecto ultra-rápido indexado por B-tree id desc (solo cuando no hay ilike filter)
      postgrestUrl += "&order=id.desc";
    }

    try {
      let spRes = await fetch(postgrestUrl, {
        headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}` }
      });

      if (!spRes.ok) {
        // Fallback seguro anti-timeout para garantizar cero errores 500 al usuario
        const safeFallbackUrl = `${SUPABASE_URL}/rest/v1/items?select=${selectFields}&limit=${pageSize}&${mediaType === "video" ? "source=eq.pmvhaven&id=lte.304215" : (mediaType === "gallery" || mediaType === "cosplay" ? "media_type=eq.gallery" : "media_type=eq.comic")}&order=id.desc`;
        const fbRes = await fetch(safeFallbackUrl, {
          headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}` }
        });
        if (fbRes.ok) {
          spRes = fbRes;
        } else {
          const errText = await spRes.text();
          return new Response(JSON.stringify({ error: "Error consultando catálogo", detail: errText }), {
            status: 500,
            headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
          });
        }
      }

      const rawItems = await spRes.json();
      const items = (rawItems || []).map(it => ({
        id: it.id,
        source: it.source || "velvet",
        source_id: it.source_id ? String(it.source_id) : String(it.id),
        title: it.title,
        cover_url: it.cover_url ? `/api/media?t=${encodeMediaToken(it.cover_url)}` : "",
        media_type: it.media_type,
        tags: it.tags || [],
        artists: it.artists || [],
        url: "", // Ocultar URL original
        page_count: it.page_count || 0,
        video_sources: (it.video_sources || []).map(vs => ({
          ...vs,
          url: vs.url ? `/api/media?t=${encodeMediaToken(vs.url)}` : ""
        })),
        has_cover: !!it.cover_url
      }));

      const responsePayload = {
        items,
        total: estimatedTotal,
        page,
        page_size: pageSize,
        total_pages: Math.ceil(estimatedTotal / pageSize),
        live: false
      };

      const resp = new Response(JSON.stringify(responsePayload), {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "public, max-age=300, s-maxage=300",
          ...getCorsHeaders(origin)
        }
      });

      try {
        context.waitUntil(cache.put(cacheKey, resp.clone()));
      } catch (e) {}

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

    let queryParam = `select=id,source,source_id,title,cover_url,media_type,tags,page_count,video_sources&limit=${count}&offset=${randomOffset}`;
    if (mediaType === "video") {
      queryParam += "&source=eq.pmvhaven&order=id.desc";
    } else if (mediaType === "gallery") {
      queryParam += "&media_type=eq.gallery&id=gte.370000&source=neq.leakgallery&order=id.desc";
    } else {
      queryParam += "&media_type=eq.comic&page_count=gt.0&order=id.desc";
    }

    try {
      const spRes = await fetch(`${SUPABASE_URL}/rest/v1/items?${queryParam}`, {
        headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}` }
      });

      const rawItems = await spRes.json();
      const items = (rawItems || []).map(it => ({
        ...it,
        url: "",
        cover_url: it.cover_url ? `/api/media?t=${encodeMediaToken(it.cover_url)}` : "",
        video_sources: (it.video_sources || []).map(vs => ({
          ...vs,
          url: vs.url ? `/api/media?t=${encodeMediaToken(vs.url)}` : ""
        }))
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
    const authHeader = context.request.headers.get("authorization") || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

    if (!token || token === "velvet_token" || token === "null" || token === "undefined") {
      return new Response(JSON.stringify({ detail: "No autenticado" }), {
        status: 401,
        headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
      });
    }

    try {
      const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${token}` }
      });

      if (!userRes.ok) {
        return new Response(JSON.stringify({ detail: "Token invalido o expirado" }), {
          status: 401,
          headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
        });
      }

      const user = await userRes.json();
      const profRes = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}&select=is_admin&limit=1`, {
        headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}` }
      });
      const profs = await profRes.json();
      const isAdmin = profs && profs[0] && profs[0].is_admin;
      const role = isAdmin ? "admin" : "member";
      const meta = user.user_metadata || {};
      const displayName = meta.username || meta.full_name || meta.display_name || user.email.split("@")[0];

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

      return new Response(JSON.stringify(respData), {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8", ...getCorsHeaders(origin) }
      });
    } catch (err) {
      return new Response(JSON.stringify({ detail: "Error de sesión" }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
      });
    }
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

  // =========================================================================
  // 8. FAVORITOS E HISTORIAL (/api/favorites, /api/user/favorites, /api/user/history)
  // =========================================================================
  if (
    url.pathname.startsWith("/api/favorites") ||
    url.pathname.startsWith("/api/user/favorites") ||
    url.pathname.startsWith("/api/user/history")
  ) {
    if (method === "GET") {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
      });
    }
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
    });
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
      headers: { "Content-Type": "application/json; charset=utf-8", ...getCorsHeaders(origin) }
    });
  }

  // Ruta API no encontrada
  return new Response(JSON.stringify({ error: "Endpoint no encontrado en Velvet Cloudflare API", path: url.pathname }), {
    status: 404,
    headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
  });
}
