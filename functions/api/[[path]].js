/**
 * CLOUDFLARE PAGES API GATEWAY & STEALTH MEDIA ENGINE
 * 
 * 1. Entrega 100% de imágenes, portadas y videos bajo morbohub.pages.dev con marca blanca total.
 * 2. Cifra los enlaces upstream con XOR simétrico + Base64URL para ocultar completamente los sitios originales.
 * 3. Streaming inverso acelerado en el Edge de Cloudflare con caché mundial ultrarrápido (10ms).
 * 4. Infiere automáticamente la cabecera Referer correcta (Buondua, Xasiat, 4KHD, PMVHaven, etc.) para saltar anti-hotlink.
 * 5. Sanitiza en tiempo real los JSON de catálogo (/api/items) encriptando cover_url, video_sources y páginas,
 *    y eliminando URLs y referers de origen para que ningún usuario o competidor pueda ver los sitios scrapeados.
 * 6. BLINDAJE ANTI-494: Filtra y limpia cabeceras y cookies para que NUNCA ocurra REQUEST_HEADER_TOO_LARGE en Vercel.
 * 7. Transferencia de datos ilimitada a costo $0 en Cloudflare Pages, protegiendo al 100% la cuota de Vercel.
 */

const MEDIA_SECRET = "velvet_ultra_stealth_secret_key_2026";

function decodeMediaToken(token) {
  try {
    let b64 = token.replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    const binaryStr = atob(b64);
    let dec = "";
    for (let i = 0; i < binaryStr.length; i++) {
      dec += String.fromCharCode(binaryStr.charCodeAt(i) ^ MEDIA_SECRET.charCodeAt(i % MEDIA_SECRET.length));
    }
    return JSON.parse(dec);
  } catch (e) {
    return null;
  }
}

function encodeMediaToken(targetUrl, referer = "") {
  if (!targetUrl) return "";
  try {
    const raw = JSON.stringify({ u: targetUrl, r: referer || "" });
    let enc = "";
    for (let i = 0; i < raw.length; i++) {
      enc += String.fromCharCode(raw.charCodeAt(i) ^ MEDIA_SECRET.charCodeAt(i % MEDIA_SECRET.length));
    }
    return btoa(enc).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  } catch (e) {
    return btoa(JSON.stringify({ u: targetUrl, r: referer || "" })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
}

function decodePayload(tParam, urlParam, refParam) {
  if (urlParam) {
    return { u: urlParam, r: refParam || "" };
  }
  if (!tParam) return null;

  // 1. Intento con cifrado simétrico Velvet
  const secretDec = decodeMediaToken(tParam);
  if (secretDec && secretDec.u) return secretDec;

  // 2. Fallback estándar Base64
  try {
    let b64 = tParam.replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    const jsonStr = decodeURIComponent(escape(atob(b64)));
    const parsed = JSON.parse(jsonStr);
    if (parsed && parsed.u) return parsed;
  } catch (e) {}

  return null;
}

function sanitizeAndMaskJson(data) {
  if (!data || typeof data !== "object") return data;

  // Sanitización de lista de items (/api/items, /api/random)
  if (Array.isArray(data.items)) {
    for (const it of data.items) {
      it.url = ""; // Ocultar URL original del sitio scrapeado
      if (it.cover_url && !it.cover_url.startsWith("/api/media")) {
        it.cover_url = `/api/media?t=${encodeMediaToken(it.cover_url)}`;
      }
      if (Array.isArray(it.video_sources)) {
        for (const vs of it.video_sources) {
          if (vs.url && !vs.url.startsWith("/api/media")) {
            vs.url = `/api/media?t=${encodeMediaToken(vs.url)}`;
          }
        }
      }
    }
    return data;
  }

  // Si es un array directo de items (ej: /api/random)
  if (Array.isArray(data)) {
    for (const it of data) {
      if (it && typeof it === "object") {
        it.url = "";
        if (it.cover_url && !it.cover_url.startsWith("/api/media")) {
          it.cover_url = `/api/media?t=${encodeMediaToken(it.cover_url)}`;
        }
        if (Array.isArray(it.video_sources)) {
          for (const vs of it.video_sources) {
            if (vs.url && !vs.url.startsWith("/api/media")) {
              vs.url = `/api/media?t=${encodeMediaToken(vs.url)}`;
            }
          }
        }
      }
    }
    return data;
  }

  // Si es un item individual (/api/items/[...slug])
  if (data.id || data.title) {
    data.url = "";
    if (data.cover_url && !data.cover_url.startsWith("/api/media")) {
      data.cover_url = `/api/media?t=${encodeMediaToken(data.cover_url)}`;
    }
    if (Array.isArray(data.pages)) {
      for (const p of data.pages) {
        p.referer = ""; // Ocultar referer de origen
        if (p.image_url && !p.image_url.startsWith("/api/media")) {
          p.image_url = `/api/media?t=${encodeMediaToken(p.image_url)}`;
        }
      }
    }
    if (Array.isArray(data.video_sources)) {
      for (const vs of data.video_sources) {
        if (vs.url && !vs.url.startsWith("/api/media")) {
          vs.url = `/api/media?t=${encodeMediaToken(vs.url)}`;
        }
      }
    }
  }

  return data;
}

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const origin = context.request.headers.get("origin") || "";
  const method = context.request.method;

  // =========================================================================
  // 1. GESTOR DE MEDIOS STEALTH: Proxy Inverso y Streaming con Marca Blanca
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
        headers: { "Content-Type": "text/plain; charset=utf-8" }
      });
    }

    const targetMediaUrl = payload.u;
    const isVideo =
      targetMediaUrl.includes(".mp4") ||
      targetMediaUrl.includes(".m3u8") ||
      url.pathname.includes("/video/");

    // Cloudflare Edge Cache para imágenes (7 días de retención en 300+ centros de datos mundiales)
    const cache = caches.default;
    const cacheKey = new Request(url.toString(), context.request);

    if (!isVideo && method === "GET") {
      try {
        const cached = await cache.match(cacheKey);
        if (cached) {
          const ch = new Headers(cached.headers);
          ch.set("X-Media-Cache", "HIT-CLOUDFLARE");
          ch.set("X-Powered-By", "Velvet-Media-Engine/2.0");
          ch.set("Server", "Velvet-Cloud");
          ch.set("Access-Control-Allow-Origin", "*");
          return new Response(cached.body, { status: cached.status, headers: ch });
        }
      } catch (e) {}
    }

    // Inferencia automática de Referer según dominio de destino
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
      } else {
        try {
          spoofedReferer = new URL(targetMediaUrl).origin + "/";
        } catch (e) {
          spoofedReferer = targetMediaUrl;
        }
      }
    }

    // Cabeceras simuladas para saltar protección anti-hotlink del CDN original
    const upstreamReqHeaders = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
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
        cf: isVideo
          ? undefined
          : {
              cacheEverything: true,
              cacheTtl: 604800,
            },
      });

      const respHeaders = new Headers();
      respHeaders.set(
        "Content-Type",
        upstream.headers.get("content-type") || (isVideo ? "video/mp4" : "image/jpeg")
      );
      respHeaders.set("Access-Control-Allow-Origin", "*");
      respHeaders.set("X-Powered-By", "Velvet-Media-Engine/2.0");
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

      const clientResponse = new Response(upstream.body, {
        status: upstream.status,
        headers: respHeaders,
      });

      // Guardar en Edge Cache de Cloudflare si es imagen exitosa (200 OK)
      if (!isVideo && upstream.status === 200) {
        try {
          context.waitUntil(cache.put(cacheKey, clientResponse.clone()));
        } catch (e) {}
      }

      return clientResponse;
    } catch (err) {
      return new Response(
        JSON.stringify({ error: `Velvet Media Engine Error: ${err.message}` }),
        {
          status: 502,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "X-Powered-By": "Velvet-Media-Engine/2.0",
            "Server": "Velvet-Cloud"
          },
        }
      );
    }
  }

  // =========================================================================
  // 2. ENRUTADOR DE API DE DATOS (Catálogo, Auth, Tags, Random) CON SANITIZACIÓN STEALTH
  // =========================================================================
  const isAllowedOrigin =
    !origin ||
    origin.endsWith(".pages.dev") ||
    origin.endsWith(".vercel.app") ||
    origin.includes("localhost") ||
    origin.includes("127.0.0.1");

  if (method === "OPTIONS") {
    if (!isAllowedOrigin) return new Response(null, { status: 403 });
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": origin || "*",
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, PATCH, OPTIONS",
        "Access-Control-Allow-Headers":
          "Content-Type, Authorization, Range, X-Requested-With, X-Refresh-Token, X-Device-Token, x-cloudflare-token, x-velvet-client",
        "Access-Control-Max-Age": "86400",
      },
    });
  }

  // Bloquear scrapers externos no autorizados
  if (origin && !isAllowedOrigin) {
    return new Response(
      JSON.stringify({ error: "Acceso denegado: Dominio no autorizado para consumir Velvet API." }),
      { status: 403, headers: { "Content-Type": "application/json" } }
    );
  }

  // Caché de Borde Cloudflare para catálogo (0-10ms)
  const isCacheableCatalog =
    method === "GET" &&
    (url.pathname.startsWith("/api/items") ||
      url.pathname.startsWith("/api/tags") ||
      url.pathname.startsWith("/api/random"));

  const cache = caches.default;
  const cacheKey = new Request(url.toString(), context.request);

  if (isCacheableCatalog) {
    try {
      const cached = await cache.match(cacheKey);
      if (cached) {
        const edgeHeaders = new Headers(cached.headers);
        edgeHeaders.set("X-Cloudflare-Edge-Cache", "HIT");
        edgeHeaders.set("Access-Control-Allow-Origin", origin || "*");
        edgeHeaders.set("Server", "Velvet-Cloud");
        return new Response(cached.body, {
          status: cached.status,
          headers: edgeHeaders,
        });
      }
    } catch (e) {}
  }

  // Destino upstream hacia Vercel
  const targetUrl = `https://velvet-hub-lrcy.vercel.app${url.pathname}${url.search}`;
  const upstreamHeaders = new Headers();

  // BLINDAJE CRÍTICO ANTI-494 (REQUEST_HEADER_TOO_LARGE):
  // 1. Filtrar cabeceras internas pesadas de Cloudflare.
  // 2. Para catálogo (/api/items, /api/tags, /api/random), NUNCA reenviar Cookie a Vercel.
  // 3. Para cualquier otra ruta, si Cookie excede 1.5KB, conservar únicamente tokens velvet_.
  for (const [key, value] of context.request.headers.entries()) {
    const k = key.toLowerCase();
    if (["host", "cf-connecting-ip", "cf-ray", "cf-visitor", "cf-ipcountry", "x-real-ip"].includes(k)) {
      continue;
    }
    if (isCacheableCatalog && k === "cookie") {
      continue; // Rutas de catálogo son públicas: no necesitan cookies de sesión
    }
    if (k === "cookie") {
      if (value.length > 1500) {
        const essential = value
          .split(";")
          .map(c => c.trim())
          .filter(c => c.startsWith("velvet_"))
          .join("; ");
        if (essential.length > 0 && essential.length < 1500) {
          upstreamHeaders.set("cookie", essential);
        }
        continue;
      }
    }
    upstreamHeaders.set(key, value);
  }

  upstreamHeaders.set("host", "velvet-hub-lrcy.vercel.app");
  upstreamHeaders.set("x-forwarded-host", url.host);
  upstreamHeaders.set("x-velvet-client", "velvet-web-client-v2");

  try {
    const bodyBytes =
      ["GET", "HEAD"].includes(method) ? undefined : await context.request.arrayBuffer();

    const upstream = await fetch(targetUrl, {
      method,
      headers: upstreamHeaders,
      body: bodyBytes,
      redirect: "follow",
    });

    const responseHeaders = new Headers(upstream.headers);
    responseHeaders.set("Access-Control-Allow-Origin", origin || "*");
    responseHeaders.set("Access-Control-Allow-Credentials", "true");
    responseHeaders.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, PATCH, OPTIONS");
    responseHeaders.set("Access-Control-Allow-Headers", "*");
    responseHeaders.set("Server", "Velvet-Cloud");
    responseHeaders.set("X-Powered-By", "Velvet-Cloud-Gateway");

    if (typeof upstream.headers.getSetCookie === "function") {
      const cookies = upstream.headers.getSetCookie();
      if (cookies && cookies.length > 0) {
        responseHeaders.delete("Set-Cookie");
        cookies.forEach((cookie) => responseHeaders.append("Set-Cookie", cookie));
      }
    }

    // Sanitización y máscara stealth para endpoints de catálogo
    const contentType = upstream.headers.get("content-type") || "";
    if (isCacheableCatalog && upstream.status === 200 && contentType.includes("application/json")) {
      try {
        const rawJson = await upstream.json();
        const maskedJson = sanitizeAndMaskJson(rawJson);
        const jsonBody = JSON.stringify(maskedJson);

        responseHeaders.set("Cache-Control", "public, max-age=300, s-maxage=300");
        responseHeaders.set("Content-Type", "application/json; charset=utf-8");

        const transformedResponse = new Response(jsonBody, {
          status: 200,
          headers: responseHeaders,
        });

        try {
          context.waitUntil(cache.put(cacheKey, transformedResponse.clone()));
        } catch (e) {}

        return transformedResponse;
      } catch (jsonErr) {}
    }

    const response = new Response(upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    });

    return response;
  } catch (err) {
    return new Response(
      JSON.stringify({ error: `Cloudflare Gateway Error: ${err.message}` }),
      {
        status: 502,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": origin || "*",
          "Access-Control-Allow-Credentials": "true",
          "Server": "Velvet-Cloud"
        },
      }
    );
  }
}
