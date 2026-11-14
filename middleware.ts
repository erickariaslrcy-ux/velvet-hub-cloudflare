import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// ============================================================================
// 1. CONFIGURACIÓN Y MEMORIA DE SEGURIDAD EN EL BORDE (EDGE)
// ============================================================================

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

// Registro en memoria por IP para frenar scrapers y ataques en tiempo real
const rateLimits = new Map<string, RateLimitEntry>();

// Limpieza periódica para mantener memoria limpia en el Edge
function cleanExpiredLimits(now: number) {
  if (rateLimits.size > 2000) {
    for (const [key, val] of rateLimits.entries()) {
      if (now > val.resetAt) rateLimits.delete(key);
    }
  }
}

function getClientIp(req: NextRequest): string {
  const cfIp = req.headers.get("cf-connecting-ip");
  if (cfIp) return cfIp.trim();
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  const realIp = req.headers.get("x-real-ip");
  if (realIp) return realIp.trim();
  return "127.0.0.1";
}

// Umbrales lógicos diferenciados por tipo de recurso
function checkRateLimit(
  ip: string,
  category: "auth" | "data_api" | "media" | "pages"
): boolean {
  const now = Date.now();
  cleanExpiredLimits(now);

  const limits = {
    // 30 intentos cada 30 segundos para login/registro
    auth: { max: 30, windowMs: 30_000 },
    // 120 peticiones cada 10 segundos para navegación fluida
    data_api: { max: 120, windowMs: 10_000 },
    // 300 peticiones cada 10 segundos para cómics e imágenes
    media: { max: 300, windowMs: 10_000 },
    // 60 visitas cada 10 segundos para páginas HTML generales
    pages: { max: 60, windowMs: 10_000 },
  }[category];

  const key = `${category}:${ip}`;
  const record = rateLimits.get(key);

  if (!record || now > record.resetAt) {
    rateLimits.set(key, { count: 1, resetAt: now + limits.windowMs });
    return true;
  }

  if (record.count >= limits.max) {
    return false;
  }

  record.count++;
  return true;
}

function setCorsHeaders(res: NextResponse, req: NextRequest) {
  const origin = req.headers.get("origin") || "*";
  res.headers.set("Access-Control-Allow-Origin", origin);
  res.headers.set("Access-Control-Allow-Credentials", "true");
  res.headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, PATCH, OPTIONS");
  res.headers.set(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, Range, X-Requested-With, X-Refresh-Token, X-Device-Token, x-cloudflare-token"
  );
}

// User-Agents típicos de scrapers que no son navegadores reales
const KNOWN_SCRAPER_BOTS = [
  "python-requests",
  "aiohttp",
  "httpx",
  "scrapy",
  "curl/",
  "wget/",
  "go-http-client",
  "java/",
  "postmanruntime",
  "headlesschrome",
  "puppeteer",
];

const PUBLIC_PATHS = [
  "/",
  "/video",
  "/comic",
  "/gallery",
  "/galeria",
  "/watch",
  "/read",
  "/login",
  "/registro",
  "/favoritos",
  "/api/items",
  "/api/image",
  "/api/img",
  "/api/video/stream",
  "/api/media",
  "/api/random",
  "/api/random-items",
  "/api/live-search",
  "/api/tags",
  "/api/auth",
  "/api/debug",
  "/api/redeem",
  "/api/favorites",
  "/api/user/favorites",
  "/api/user/favorites/sync",
  "/api/user/history",
  "/velvet",
  "/velvet.html",
  "/velvet_logo.png",
  "/robots.txt",
  "/manifest.json",
  "/sw.js",
];

// ============================================================================
// 2. MIDDLEWARE PRINCIPAL
// ============================================================================

export async function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname;
  const isApiRoute = path.startsWith("/api/");

  // --------------------------------------------------------------------------
  // A. PREFLIGHT CORS (OPTIONS) PARA COMPATIBILIDAD CON CLOUDFLARE PAGES Y PWA
  // --------------------------------------------------------------------------
  if (request.method === "OPTIONS") {
    const preflight = new NextResponse(null, { status: 204 });
    setCorsHeaders(preflight, request);
    return preflight;
  }

  let response = NextResponse.next({ request });
  const rawUrl = request.url || "";
  const rawSearch = request.nextUrl.search || "";
  const clientIp = getClientIp(request);
  const userAgent = (request.headers.get("user-agent") || "").toLowerCase();

  // --------------------------------------------------------------------------
  // B. CORTAFUEGOS DE BORDE: Anti Inyecciones (SQLi, XSS, Path Traversal)
  // --------------------------------------------------------------------------
  let decodedSearch = rawSearch;
  let decodedUrl = rawUrl;
  try {
    decodedSearch = decodeURIComponent(rawSearch).replace(/\+/g, " ");
    decodedUrl = decodeURIComponent(rawUrl).replace(/\+/g, " ");
  } catch {}

  const maliciousPattern = /(<script|javascript:|UNION[\s+]+SELECT|DROP[\s+]+TABLE|ALTER[\s+]+TABLE|--|\.\.\/|\.\.\\)/i;

  if (
    maliciousPattern.test(rawSearch) ||
    maliciousPattern.test(decodedSearch) ||
    maliciousPattern.test(path) ||
    maliciousPattern.test(decodedUrl)
  ) {
    const blockedRes = new NextResponse("Acceso bloqueado por Cortafuegos Velvet Anti-Inyección", {
      status: 403,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
    if (isApiRoute) setCorsHeaders(blockedRes, request);
    return blockedRes;
  }

  // --------------------------------------------------------------------------
  // C. ORIGIN SHIELD: TOKEN PORTADOR (BEARER TOKEN) DE CLOUDFLARE
  // --------------------------------------------------------------------------
  const cfBearerSecret = process.env.CLOUDFLARE_BEARER_TOKEN;
  const isExcludedFromCfSecret =
    path.startsWith("/api/auth/patreon/callback") ||
    path.startsWith("/api/cron/");

  if (cfBearerSecret && isApiRoute && !isExcludedFromCfSecret) {
    const authHeader = request.headers.get("authorization") || "";
    const cfCustomHeader = request.headers.get("x-cloudflare-token") || "";
    const expectedBearer = `Bearer ${cfBearerSecret}`;

    if (authHeader !== expectedBearer && cfCustomHeader !== cfBearerSecret) {
      const deniedRes = NextResponse.json(
        {
          error: "Acceso denegado: Petición directa al origen no autorizada. Debe pasar por el proxy de Cloudflare.",
        },
        { status: 403 }
      );
      setCorsHeaders(deniedRes, request);
      return deniedRes;
    }
  }

  // --------------------------------------------------------------------------
  // D. DETECCIÓN Y FILTRO SILENCIOSO DE SCRAPERS AUTOMATIZADOS (User-Agent)
  // --------------------------------------------------------------------------
  if (isApiRoute && KNOWN_SCRAPER_BOTS.some((bot) => userAgent.includes(bot))) {
    const scraperRes = NextResponse.json(
      { error: "Herramienta automatizada no permitida." },
      { status: 403 }
    );
    setCorsHeaders(scraperRes, request);
    return scraperRes;
  }

  // --------------------------------------------------------------------------
  // E. RATE LIMITING INTELIGENTE Y DIFERENCIADO POR TIPO DE SOLICITUD
  // --------------------------------------------------------------------------
  let category: "auth" | "data_api" | "media" | "pages" = "pages";

  if (path === "/api/auth/me" || path === "/api/auth/refresh") {
    category = "data_api"; // Verificación de sesión no sufre rate limiting agresivo
  } else if (
    path.startsWith("/api/auth") ||
    path.startsWith("/api/redeem") ||
    path === "/login" ||
    path === "/registro"
  ) {
    category = "auth";
  } else if (
    path.startsWith("/api/img") ||
    path.startsWith("/api/image") ||
    path.startsWith("/api/video/stream") ||
    path.startsWith("/api/media")
  ) {
    category = "media";
  } else if (isApiRoute) {
    category = "data_api";
  }

  const allowed = checkRateLimit(clientIp, category);
  if (!allowed) {
    if (isApiRoute) {
      const rateRes = NextResponse.json(
        {
          error: "Límite de solicitudes temporal excedido. Por favor espera unos momentos.",
          ip: clientIp,
        },
        {
          status: 429,
          headers: {
            "Retry-After": "5",
            "Content-Type": "application/json",
          },
        }
      );
      setCorsHeaders(rateRes, request);
      return rateRes;
    } else {
      return new NextResponse(
        "Demasiadas solicitudes simultáneas. Por favor espera unos segundos.",
        { status: 429, headers: { "Content-Type": "text/plain; charset=utf-8" } }
      );
    }
  }

  // --------------------------------------------------------------------------
  // F. SUPABASE AUTH SESSION REFRESH
  // --------------------------------------------------------------------------
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(toSet) {
          toSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          toSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        },
      },
    }
  );

  const { data } = await supabase.auth.getUser();

  let user = data.user;
  if (!user && isApiRoute) {
    const authHeader = request.headers.get("authorization") || "";
    if (authHeader.startsWith("Bearer ") && authHeader.slice(7) !== "velvet_token" && authHeader.slice(7) !== "null") {
      user = { id: "bearer_provided" } as any;
    }
  }

  const isPublic = PUBLIC_PATHS.some((p) => path === p || path.startsWith(p + "/"));

  if (!user && !isPublic) {
    if (isApiRoute) {
      const unauthRes = NextResponse.json({ error: "No autorizado" }, { status: 401 });
      setCorsHeaders(unauthRes, request);
      return unauthRes;
    }
    const url = request.nextUrl.clone();
    url.pathname = "/";
    url.search = "";
    return NextResponse.redirect(url);
  }

  if (user && (path === "/login" || path === "/registro")) {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    url.search = "";
    return NextResponse.redirect(url);
  }

  if (isApiRoute) {
    setCorsHeaders(response, request);
  }

  return response;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|velvet_logo.png|robots.txt|manifest.json|sw.js).*)",
  ],
};
