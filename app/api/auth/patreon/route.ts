import { NextRequest, NextResponse } from "next/server";
import { getPatreonOAuthUrl } from "@/lib/patreon";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    // Determinar la URL oficial registrada en Patreon (o dinámica en localhost)
    const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || "";
    const isLocal = host.includes("localhost") || host.includes("127.0.0.1");
    const configuredSite = process.env.NEXT_PUBLIC_SITE_URL || process.env.SITE_URL;

    let origin: string;
    if (!isLocal && configuredSite) {
      origin = configuredSite.replace(/\/+$/, "");
    } else {
      const proto = req.headers.get("x-forwarded-proto") || (isLocal ? "http" : "https");
      origin = host ? `${proto}://${host}` : req.nextUrl.origin;
    }

    const redirectUri = `${origin}/api/auth/patreon/callback`;
    const patreonAuthUrl = getPatreonOAuthUrl(redirectUri);

    return NextResponse.redirect(patreonAuthUrl);
  } catch (err: any) {
    return NextResponse.json({ error: err.message || "Error al iniciar OAuth con Patreon" }, { status: 500 });
  }
}
