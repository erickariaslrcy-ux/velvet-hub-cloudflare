import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { createAdminClient } from "@/lib/supabase/admin";
import { registerOrTouchDevice } from "@/lib/devices";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    const authHeader = req.headers.get("authorization") || "";
    const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    const refreshToken =
      req.headers.get("x-refresh-token") ||
      req.cookies.get("velvet_refresh_token")?.value ||
      null;

    const admin = createAdminClient();
    let user = null;
    let newAccessToken: string | null = null;
    let newRefreshToken: string | null = null;

    if (bearerToken && bearerToken !== "velvet_token" && bearerToken !== "null" && bearerToken !== "undefined") {
      try {
        const { data } = await admin.auth.getUser(bearerToken);
        user = data?.user || null;
      } catch {}
    }

    // Si el token expiró pero hay refresh token, renovar automáticamente
    if (!user && refreshToken) {
      try {
        const { data: refData, error: refErr } = await admin.auth.refreshSession({
          refresh_token: refreshToken,
        });
        if (!refErr && refData?.user && refData.session) {
          user = refData.user;
          newAccessToken = refData.session.access_token;
          newRefreshToken = refData.session.refresh_token;
        }
      } catch {}
    }

    // Si aún no hay usuario, comprobar cookies de sesión de Supabase
    if (!user) {
      const supabase = createServerClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        {
          cookies: {
            getAll() {
              return req.cookies.getAll();
            },
            setAll() {},
          },
        }
      );
      const { data } = await supabase.auth.getUser();
      user = data?.user || null;
      if (user) {
        try {
          const { data: sData } = await supabase.auth.getSession();
          if (sData?.session) {
            newAccessToken = sData.session.access_token;
            newRefreshToken = sData.session.refresh_token;
          }
        } catch {}
      }
    }

    if (!user) {
      return NextResponse.json({ detail: "No autenticado" }, { status: 401 });
    }

    const { data: profile } = await admin
      .from("profiles")
      .select("is_admin")
      .eq("id", user.id)
      .maybeSingle();

    const role = profile?.is_admin ? "admin" : "member";

    // Registrar o actualizar dispositivo activo (soporte de hasta 10 dispositivos)
    const deviceToken =
      req.headers.get("x-device-token") ||
      req.cookies.get("velvet_device_token")?.value ||
      "dev_" + Math.random().toString(36).substring(2);
    const userAgent = req.headers.get("user-agent") || "";
    await registerOrTouchDevice(admin, user.id, deviceToken, 10, userAgent);

    const meta = user.user_metadata || {};
    const displayName =
      meta.username ||
      meta.full_name ||
      meta.display_name ||
      (user.email ? user.email.split("@")[0] : "Usuario VIP");
    const isAdmin = role === "admin";
    const isPro = true;
    const tierLevel = "pro";

    const THIRTY_DAYS = 30 * 24 * 60 * 60;
    const res = NextResponse.json({
      id: user.id,
      username: displayName,
      email: user.email,
      role,
      tier: meta.tier || (isAdmin ? "Dueño" : "Velvet VIP ($5.99)"),
      tier_level: tierLevel,
      is_pro: isPro,
      max_devices: 10,
      patreon_id: meta.patreon_id || null,
      avatar: meta.avatar_url || null,
      device_token: deviceToken,
      new_token: newAccessToken,
      new_refresh_token: newRefreshToken,
    });

    if (newRefreshToken) {
      res.cookies.set("velvet_refresh_token", newRefreshToken, {
        path: "/",
        maxAge: THIRTY_DAYS,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        httpOnly: true,
      });
    }

    res.cookies.set("velvet_device_token", deviceToken, {
      path: "/",
      maxAge: 365 * 24 * 60 * 60,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      httpOnly: false,
    });

    return res;
  } catch (err: any) {
    return NextResponse.json({ detail: "Error de sesión" }, { status: 500 });
  }
}
