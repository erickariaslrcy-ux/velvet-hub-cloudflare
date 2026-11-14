import fs from "fs";
import path from "path";
import { NextResponse, type NextRequest } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string[] }> }
) {
  const { slug } = await params;
  const fullPath = "/" + (slug ? slug.join("/") : "");

  // 1. Redirecciones permanentes 301 para rutas legadas
  if (fullPath === "/favoritos") {
    return NextResponse.redirect(new URL("/boveda/favoritos", request.url), 301);
  }
  if (fullPath === "/historial") {
    return NextResponse.redirect(new URL("/boveda/historial", request.url), 301);
  }
  if (fullPath.startsWith("/video/")) {
    return NextResponse.redirect(new URL(`/v/${fullPath.slice(7)}`, request.url), 301);
  }
  if (fullPath.startsWith("/comic/")) {
    return NextResponse.redirect(new URL(`/c/${fullPath.slice(7)}`, request.url), 301);
  }
  if (fullPath.startsWith("/gallery/") || fullPath.startsWith("/galeria/")) {
    const slashIdx = fullPath.indexOf("/", 1);
    return NextResponse.redirect(new URL(`/g/${fullPath.slice(slashIdx + 1)}`, request.url), 301);
  }

  // 2. Comprobar si la ruta pertenece al esquema canónico de VELVET HUB SPA
  const isSpaRoute =
    fullPath === "/videos" ||
    fullPath === "/comics" ||
    fullPath === "/cosplay" ||
    fullPath.startsWith("/v/") ||
    fullPath.startsWith("/c/") ||
    fullPath.startsWith("/g/") ||
    fullPath === "/boveda" ||
    fullPath.startsWith("/boveda/") ||
    fullPath === "/cuenta" ||
    fullPath === "/acceso";

  if (isSpaRoute) {
    try {
      const filePath = path.join(process.cwd(), "public", "index.html");
      const html = fs.readFileSync(filePath, "utf-8");

      const headers: Record<string, string> = {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache, no-store, must-revalidate",
      };

      // Cabeceras de privacidad y no-indexación para vistas de usuario
      const isPrivate =
        fullPath.startsWith("/boveda") ||
        fullPath === "/cuenta" ||
        fullPath === "/acceso";

      if (isPrivate) {
        headers["X-Robots-Tag"] = "noindex, nofollow";
        headers["Cache-Control"] = "private, no-cache, no-store, must-revalidate";
      }

      return new NextResponse(html, {
        status: 200,
        headers,
      });
    } catch (err) {
      console.error("[ROUTE CATCH-ALL] Error al leer index.html:", err);
      return new NextResponse("Error interno cargando Velvet Hub", { status: 500 });
    }
  }

  // 3. Si la ruta no existe, devolver la página 404 de marca con estado HTTP 404
  try {
    const filePath404 = path.join(process.cwd(), "public", "404.html");
    const html404 = fs.readFileSync(filePath404, "utf-8");
    return new NextResponse(html404, {
      status: 404,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache, no-store, must-revalidate",
      },
    });
  } catch {
    return new NextResponse("404 — Página no encontrada • Velvet Hub", { status: 404 });
  }
}
