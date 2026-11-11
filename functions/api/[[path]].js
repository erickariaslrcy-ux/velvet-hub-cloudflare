/**
 * CLOUDFLARE PAGES API GATEWAY CON CACHÉ DE BORDE ULTRA-RÁPIDO (0-10ms) Y PROTECCIÓN ANTI-SCRAPING
 */
export async function onRequest(context) {
  const url = new URL(context.request.url);
  const origin = context.request.headers.get("origin") || "";
  const method = context.request.method;

  // Verificación estricta de orígenes autorizados
  const isAllowedOrigin = !origin || 
    origin.endsWith(".pages.dev") || 
    origin.endsWith(".vercel.app") || 
    origin.includes("localhost") || 
    origin.includes("127.0.0.1");

  // Manejo de preflight CORS (OPTIONS)
  if (method === "OPTIONS") {
    if (!isAllowedOrigin) {
      return new Response(null, { status: 403 });
    }
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": origin || "*",
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, PATCH, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, Range, X-Requested-With, X-Refresh-Token, X-Device-Token, x-cloudflare-token, x-velvet-client",
        "Access-Control-Max-Age": "86400",
      },
    });
  }

  // Bloquear sitios de terceros que intenten robar o scrapear la API embebida
  if (origin && !isAllowedOrigin) {
    return new Response(JSON.stringify({ error: "Acceso denegado: Dominio no autorizado para consumir Velvet API." }), {
      status: 403,
      headers: { "Content-Type": "application/json" }
    });
  }

  // Rutas públicas que se benefician de Cache en el Edge de Cloudflare (0-10ms)
  const isCacheableCatalog = method === "GET" && (
    url.pathname.startsWith("/api/items") ||
    url.pathname.startsWith("/api/tags") ||
    url.pathname.startsWith("/api/random")
  );

  const cache = caches.default;
  const cacheKey = new Request(url.toString(), context.request);

  if (isCacheableCatalog) {
    try {
      const cachedResp = await cache.match(cacheKey);
      if (cachedResp) {
        const edgeHeaders = new Headers(cachedResp.headers);
        edgeHeaders.set("X-Edge-Cache", "HIT-CLOUDFLARE");
        if (origin) edgeHeaders.set("Access-Control-Allow-Origin", origin);
        return new Response(cachedResp.body, {
          status: cachedResp.status,
          headers: edgeHeaders,
        });
      }
    } catch (e) {
      // Ignorar fallo de cache y continuar upstream
    }
  }

  // Destino upstream hacia el backend en Vercel
  const targetUrl = `https://velvet-hub-lrcy.vercel.app${url.pathname}${url.search}`;
  const upstreamHeaders = new Headers();
  for (const [key, value] of context.request.headers.entries()) {
    if (!["host", "connection", "cf-connecting-ip", "cf-ray"].includes(key.toLowerCase())) {
      upstreamHeaders.set(key, value);
    }
  }
  upstreamHeaders.set("Host", "velvet-hub-lrcy.vercel.app");
  upstreamHeaders.set("x-velvet-client", "velvet-web-client-v2");

  try {
    const bodyBytes = ["GET", "HEAD"].includes(method) ? undefined : await context.request.arrayBuffer();
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

    // Preservar cookies devueltas por upstream
    if (typeof upstream.headers.getSetCookie === "function") {
      const cookies = upstream.headers.getSetCookie();
      if (cookies && cookies.length > 0) {
        responseHeaders.delete("Set-Cookie");
        for (const cookie of cookies) {
          responseHeaders.append("Set-Cookie", cookie);
        }
      }
    }

    const response = new Response(upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    });

    if (isCacheableCatalog && upstream.status === 200) {
      // Guardar en Edge Cache de Cloudflare por 5 minutos (300s)
      responseHeaders.set("Cache-Control", "public, max-age=300, s-maxage=300");
      try {
        context.waitUntil(cache.put(cacheKey, response.clone()));
      } catch (e) {}
    }

    return response;
  } catch (err) {
    return new Response(JSON.stringify({ error: `Cloudflare Gateway Error: ${err.message}` }), {
      status: 502,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": origin || "*",
        "Access-Control-Allow-Credentials": "true",
      },
    });
  }
}
