/**
 * CLOUDFLARE PAGES EDGE MIDDLEWARE (VELVET HUB SPA + REAL CANONICAL URLS)
 * 
 * Garantiza:
 * 1. Rewrite transparente con HTTP 200 del shell SPA (index.html) para todas las rutas dinámicas:
 *    - /v/:id-slug (Videos)
 *    - /c/:id-slug y /c/:id-slug/leer (Cómics y Lector)
 *    - /g/:id-slug (Galerías / Cosplay)
 *    - /videos, /comics, /cosplay (Catálogos y paginación)
 *    - /boveda/favoritos, /boveda/historial, /cuenta, /acceso (Bóveda y cuenta)
 * 2. Bypass total para /api/* hacia functions/api/[[path]].js
 * 3. Bypass para activos estáticos (.js, .css, .png, .jpg, .svg, .woff2, etc.)
 * 4. Redirecciones 301 permanentes para rutas legadas (/video/*, /comic/*, /gallery/*, etc.)
 */

export async function onRequest(context) {
  const { request, next, env } = context;
  const url = new URL(request.url);
  const path = url.pathname;

  // 1. Endpoints de API: delegar al router de functions/api/[[path]].js
  if (path.startsWith('/api/')) {
    return next();
  }

  // 2. Archivos estáticos físicos con extensión: delegar a Cloudflare Pages Assets
  if (/\.(?:js|css|png|jpg|jpeg|gif|webp|svg|ico|woff|woff2|ttf|eot|json|map|webmanifest|mp4|webm|txt|xml)$/i.test(path)) {
    return next();
  }

  // 3. Redirecciones 301 de URLs legadas hacia el esquema canónico
  if (path === '/favoritos') {
    return Response.redirect(new URL('/boveda/favoritos', request.url), 301);
  }
  if (path === '/historial') {
    return Response.redirect(new URL('/boveda/historial', request.url), 301);
  }
  if (path.startsWith('/video/')) {
    const rest = path.slice(7);
    return Response.redirect(new URL(`/v/${rest}`, request.url), 301);
  }
  if (path.startsWith('/comic/')) {
    const rest = path.slice(7);
    return Response.redirect(new URL(`/c/${rest}`, request.url), 301);
  }
  if (path.startsWith('/gallery/') || path.startsWith('/galeria/')) {
    const slashIdx = path.indexOf('/', 1);
    const rest = path.slice(slashIdx + 1);
    return Response.redirect(new URL(`/g/${rest}`, request.url), 301);
  }

  // 4. Rutas dinámicas de la SPA: servir el shell index.html con estado 200 OK
  try {
    const indexReq = new Request(new URL('/index.html', request.url), request);
    const assetRes = await env.ASSETS.fetch(indexReq);
    if (assetRes.ok) {
      return new Response(assetRes.body, {
        status: 200,
        headers: assetRes.headers
      });
    }
  } catch (err) {
    console.error('[PAGES_MIDDLEWARE] Error fetching index.html asset:', err);
  }

  return next();
}
