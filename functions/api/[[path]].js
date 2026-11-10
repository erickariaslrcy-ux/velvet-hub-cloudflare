/**
 * CLOUDFLARE PAGES API GATEWAY
 * 
 * Intercepta todas las rutas /api/* en Cloudflare Pages.
 * Resuelve las consultas contra el backend de Vercel con soporte completo de CORS y Cookies.
 */

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const origin = context.request.headers.get("origin") || "*";

  // Manejo de preflight CORS (OPTIONS)
  if (context.request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, PATCH, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, Range, X-Requested-With, X-Refresh-Token, X-Device-Token, x-cloudflare-token",
        "Access-Control-Max-Age": "86400",
      },
    });
  }

  // Destino upstream hacia el backend de datos en Vercel
  const targetUrl = `https://velvet-hub-lrcy.vercel.app${url.pathname}${url.search}`;

  const upstreamHeaders = new Headers();
  for (const [key, value] of context.request.headers.entries()) {
    if (!["host", "connection", "cf-connecting-ip", "cf-ray"].includes(key.toLowerCase())) {
      upstreamHeaders.set(key, value);
    }
  }
  upstreamHeaders.set("Host", "velvet-hub-lrcy.vercel.app");

  try {
    const bodyBytes = ["GET", "HEAD"].includes(context.request.method)
      ? undefined
      : await context.request.arrayBuffer();

    const upstream = await fetch(targetUrl, {
      method: context.request.method,
      headers: upstreamHeaders,
      body: bodyBytes,
      redirect: "follow",
    });

    const responseHeaders = new Headers(upstream.headers);
    responseHeaders.set("Access-Control-Allow-Origin", origin);
    responseHeaders.set("Access-Control-Allow-Credentials", "true");
    responseHeaders.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, PATCH, OPTIONS");
    responseHeaders.set("Access-Control-Allow-Headers", "*");

    // Preservar múltiples cookies devueltas por upstream
    if (typeof upstream.headers.getSetCookie === "function") {
      const cookies = upstream.headers.getSetCookie();
      if (cookies && cookies.length > 0) {
        responseHeaders.delete("Set-Cookie");
        for (const cookie of cookies) {
          responseHeaders.append("Set-Cookie", cookie);
        }
      }
    }

    return new Response(upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: `Cloudflare Gateway Error: ${err.message}` }), {
      status: 502,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Credentials": "true",
      },
    });
  }
}
