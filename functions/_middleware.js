/**
 * CLOUDFLARE PAGES EDGE MIDDLEWARE (VELVET HUB SPA + REAL CANONICAL URLS)
 * 
 * Garantiza:
 * 1. Rewrite transparente con HTTP 200 del shell SPA (index.html) para todas las rutas dinámicas válidas:
 *    - / (Inicio)
 *    - /v/:id-slug (Videos)
 *    - /c/:id-slug y /c/:id-slug/leer (Cómics y Lector)
 *    - /g/:id-slug (Galerías / Cosplay)
 *    - /videos, /comics, /cosplay (Catálogos y paginación)
 *    - /boveda, /boveda/favoritos, /boveda/historial, /cuenta, /acceso (Bóveda y cuenta)
 * 2. Bypass total para /api/* hacia functions/api/[[path]].js
 * 3. Bypass para activos estáticos (.js, .css, .png, .jpg, .svg, .woff2, etc.)
 * 4. Redirecciones 301 permanentes para rutas legadas (/video/*, /comic/*, /gallery/*, etc.)
 * 5. Cabeceras de seguridad y privacidad (noindex + Cache-Control: private, no-store para bóveda/cuenta)
 * 6. Rutas inexistentes pasan a 404.html estático con la identidad de marca
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

  // 4. Identificar si la ruta corresponde a una vista válida de la SPA
  const isSpaRoute =
    path === '/' ||
    path === '/videos' ||
    path === '/comics' ||
    path === '/cosplay' ||
    path.startsWith('/v/') ||
    path.startsWith('/c/') ||
    path.startsWith('/g/') ||
    path === '/boveda' ||
    path.startsWith('/boveda/') ||
    path === '/cuenta' ||
    path === '/acceso';

  if (isSpaRoute) {
    try {
      // Solicitar el shell en la raíz '/' a env.ASSETS (evita el redirect 308 de /index.html en Cloudflare)
      const rootUrl = new URL('/', request.url);
      let assetRes = await env.ASSETS.fetch(new Request(rootUrl.toString(), {
        method: 'GET',
        headers: {
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        }
      }));

      // Si env.ASSETS devuelve un 3xx, seguir la redirección
      if (assetRes.status >= 300 && assetRes.status < 400) {
        const loc = assetRes.headers.get('Location') || '/';
        const redirUrl = new URL(loc, request.url);
        assetRes = await env.ASSETS.fetch(new Request(redirUrl.toString(), { method: 'GET' }));
      }

      if (assetRes && (assetRes.ok || assetRes.status === 200)) {
        const responseHeaders = new Headers(assetRes.headers);
        responseHeaders.set('Content-Type', 'text/html; charset=utf-8');

        // Páginas privadas: noindex, nofollow, private, no-store
        const isPrivate = path.startsWith('/boveda') || path === '/cuenta' || path === '/acceso';
        if (isPrivate) {
          responseHeaders.set('X-Robots-Tag', 'noindex, nofollow');
          responseHeaders.set('Cache-Control', 'private, no-cache, no-store, must-revalidate');
        }

        return new Response(assetRes.body, {
          status: 200,
          headers: responseHeaders
        });
      }
    } catch (err) {
      console.error('[PAGES_MIDDLEWARE] Error fetching root shell asset:', err);
    }
  }

  // 5. Rutas no reconocidas: continuar para que Cloudflare Pages sirva 404.html con estado 404
  return next();
}
