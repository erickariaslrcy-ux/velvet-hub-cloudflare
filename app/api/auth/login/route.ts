import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { createAdminClient } from "@/lib/supabase/admin";
import { registerOrTouchDevice } from "@/lib/devices";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const username = (body.username || "").trim();
    const password = body.password || "";

    if (!username || !password) {
      return NextResponse.json({ detail: "Usuario y contraseña requeridos" }, { status: 400 });
    }

    let email = username.toLowerCase();
    const admin = createAdminClient();

    if (!email.includes("@")) {
      const { data: matchedProfile } = await admin
        .from("profiles")
        .select("email")
        .ilike("email", `${username}@%`)
        .maybeSingle();

      if (matchedProfile?.email) {
        email = matchedProfile.email;
      } else {
        email = `${username}@velvet.local`;
      }
    }

    const cookieJar: { name: string; value: string; options: any }[] = [];
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() {
            return req.cookies.getAll();
          },
          setAll(toSet) {
            toSet.forEach((item) => cookieJar.push(item));
          },
        },
      }
    );

    const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (authError || !authData.user) {
      return NextResponse.json(
        { detail: authError?.message || "Credenciales incorrectas" },
        { status: 401 }
      );
    }

    const { data: profile } = await admin
      .from("profiles")
      .select("is_admin")
      .eq("id", authData.user.id)
      .maybeSingle();

    const role = profile?.is_admin ? "admin" : "member";
    const displayName = authData.user.email ? authData.user.email.split("@")[0] : username;

    // Registrar o actualizar dispositivo (soporte de hasta 10 dispositivos sin expulsión)
    const deviceToken =
      req.headers.get("x-device-token") ||
      req.cookies.get("velvet_device_token")?.value ||
      "dev_" + Math.random().toString(36).substring(2);
    const userAgent = req.headers.get("user-agent") || "";
    await registerOrTouchDevice(admin, authData.user.id, deviceToken, 10, userAgent);

    const session = authData.session;
    const response = NextResponse.json({
      token: session?.access_token || "velvet_token",
      refresh_token: session?.refresh_token || null,
      expires_at: session?.expires_at || null,
      user: {
        id: authData.user.id,
        username: displayName,
        email: authData.user.email,
        role,
      },
    });

    const THIRTY_DAYS = 30 * 24 * 60 * 60;

    // Persistir cookies de sesión de Supabase por 30 días
    cookieJar.forEach(({ name, value, options }) => {
      response.cookies.set(name, value, {
        ...options,
        path: "/",
        maxAge: THIRTY_DAYS,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
      });
    });

    // Guardar refresh token en cookie segura por 30 días
    if (session?.refresh_token) {
      response.cookies.set("velvet_refresh_token", session.refresh_token, {
        path: "/",
        maxAge: THIRTY_DAYS,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        httpOnly: true,
      });
    }

    // Guardar device token por 1 año
    response.cookies.set("velvet_device_token", deviceToken, {
      path: "/",
      maxAge: 365 * 24 * 60 * 60,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      httpOnly: false,
    });

    return response;
  } catch (err: any) {
    return NextResponse.json({ detail: err.message || "Error al procesar login" }, { status: 500 });
  }
}
