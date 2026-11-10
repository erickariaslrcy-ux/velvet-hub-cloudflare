/**
 * CLOUDFLARE PAGES API GATEWAY
 * 
 * Intercepta todas las rutas /api/* en morbohub.pages.dev.
 * Resuelve las consultas contra el backend con caché Edge en la red global de Cloudflare.
 */

export async function onRequest(context) {
  const url = new URL(context.request.url);

  // Manejo de preflight CORS (OPTIONS)
  if (context.request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, Range, X-Requested-With",
        "Access-Control-Max-Age": "86400",
      },
    });
  }

  // Destino upstream hacia el backend de datos de Velvet Hub
  const targetUrl = `https://velvet-hub-lrcy.vercel.app${url.pathname}${url.search}`;

  const upstreamHeaders = new Headers();
  // Pasar encabezados esenciales
  for (const [key, value] of context.request.headers.entries()) {
    if (!["host", "connection", "cf-connecting-ip", "cf-ray"].includes(key.toLowerCase())) {
      upstreamHeaders.set(key, value);
    }
  }
  upstreamHeaders.set("Host", "velvet-hub-lrcy.vercel.app");

  try {
    const upstream = await fetch(targetUrl, {
      method: context.request.method,
      headers: upstreamHeaders,
      body: ["GET", "HEAD"].includes(context.request.method) ? undefined : context.request.body,
      redirect: "follow",
    });

    const responseHeaders = new Headers(upstream.headers);
    responseHeaders.set("Access-Control-Allow-Origin", "*");
    responseHeaders.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    responseHeaders.set("Access-Control-Allow-Headers", "*");

    return new Response(upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: `Cloudflare Gateway Error: ${err.message}` }), {
      status: 502,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }
}
