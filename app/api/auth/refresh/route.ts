import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const refreshToken =
      body.refresh_token ||
      req.headers.get("x-refresh-token") ||
      req.cookies.get("velvet_refresh_token")?.value ||
      null;

    if (!refreshToken) {
      return NextResponse.json({ detail: "Token de actualización no provisto" }, { status: 400 });
    }

    const admin = createAdminClient();
    const { data, error } = await admin.auth.refreshSession({ refresh_token: refreshToken });

    if (error || !data.session || !data.user) {
      return NextResponse.json({ detail: error?.message || "Sesión expirada" }, { status: 401 });
    }

    const THIRTY_DAYS = 30 * 24 * 60 * 60;
    const response = NextResponse.json({
      token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      expires_at: data.session.expires_at,
      user: {
        id: data.user.id,
        email: data.user.email,
        username: data.user.user_metadata?.full_name || data.user.email?.split("@")[0] || "Usuario VIP",
      },
    });

    response.cookies.set("velvet_refresh_token", data.session.refresh_token, {
      path: "/",
      maxAge: THIRTY_DAYS,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      httpOnly: true,
    });

    return response;
  } catch (err: any) {
    return NextResponse.json({ detail: err.message || "Error al refrescar sesión" }, { status: 500 });
  }
}
