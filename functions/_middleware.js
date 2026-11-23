const CANONICAL_ORIGIN = "https://www.morbohub.com";

function isPagesDevHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  return host === "morbohub.pages.dev" || host.endsWith(".morbohub.pages.dev");
}

function isSpaNavigation(pathname) {
  const p = pathname.toLowerCase();
  if (p === "/" || p === "/index.html") return false;
  if (p.startsWith("/api/")) return false;
  if (/\.[a-zA-Z0-9]+$/.test(p)) return false;
  return (
    p === "/videos" ||
    p === "/comics" ||
    p === "/cosplay" ||
    p === "/juegos" ||
    p === "/games" ||
    p === "/cuenta" ||
    p === "/acceso" ||
    p === "/perfil" ||
    p.startsWith("/c/") ||
    p.startsWith("/v/") ||
    p.startsWith("/g/") ||
    p.startsWith("/j/") ||
    p.startsWith("/comic/") ||
    p.startsWith("/video/") ||
    p.startsWith("/gallery/") ||
    p.startsWith("/galeria/") ||
    p.startsWith("/juego/") ||
    p.startsWith("/game/") ||
    p.startsWith("/boveda")
  );
}

export async function onRequest(context) {
  const current = new URL(context.request.url);
  if (isPagesDevHost(current.hostname)) {
    const dest = new URL(current.pathname + current.search, CANONICAL_ORIGIN);
    return Response.redirect(dest.toString(), 301);
  }

  // Fast-path para rutas SPA de la aplicación (cómics, videos, galerías, juegos, bóveda)
  if (isSpaNavigation(current.pathname) && context.env && context.env.ASSETS && typeof context.env.ASSETS.fetch === "function") {
    const indexReq = new Request(new URL("/index.html", context.request.url), context.request);
    return context.env.ASSETS.fetch(indexReq);
  }

  const response = await context.next();

  // Si Cloudflare devolvió 404 para una ruta sin extensión (navegación SPA directa), servir /index.html
  if (response.status === 404 && !current.pathname.startsWith("/api/")) {
    const hasExt = /\.[a-zA-Z0-9]+$/.test(current.pathname);
    if (!hasExt && context.env && context.env.ASSETS && typeof context.env.ASSETS.fetch === "function") {
      const indexReq = new Request(new URL("/index.html", context.request.url), context.request);
      return context.env.ASSETS.fetch(indexReq);
    }
  }

  return response;
}
