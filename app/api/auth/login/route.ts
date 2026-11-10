import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { createAdminClient } from "@/lib/supabase/admin";
import { registerOrTouchDevice } from "@/lib/devices";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const rawUsername = (body.username || "").trim();
    const password = body.password || "";

    if (!rawUsername || !password) {
      return NextResponse.json({ detail: "Usuario o correo y contraseña requeridos" }, { status: 400 });
    }

    let email = rawUsername.toLowerCase();
    const admin = createAdminClient();

    // Si el usuario no ingresó un correo con '@'
    if (!email.includes("@")) {
      const masterEmail = (process.env.MASTER_EMAIL || "erickariaslrcy@gmail.com").toLowerCase().trim();
      if (email === "admin" || email === "master" || email === "erick") {
        email = masterEmail;
      } else {
        // Buscar en profiles por coincidencia exacta o prefijo de email
        const { data: matchedProfiles } = await admin
          .from("profiles")
          .select("email")
          .or(`email.ilike.${email}@%,email.ilike.${email}%`)
          .limit(5);

        if (matchedProfiles && matchedProfiles.length > 0) {
          // Priorizar coincidencia exacta antes de la arroba
          const exact = matchedProfiles.find((p) => p.email.toLowerCase().startsWith(`${email}@`));
          email = exact ? exact.email : matchedProfiles[0].email;
        } else {
          // Buscar en metadata de auth.users si alguien tiene este username
          try {
            const { data: userList } = await admin.auth.admin.listUsers({ perPage: 200 });
            const found = userList?.users?.find((u) => {
              const meta = u.user_metadata || {};
              const uName = (meta.username || meta.full_name || meta.display_name || "").toLowerCase();
              return uName === email || (u.email && u.email.toLowerCase().startsWith(email));
            });
            if (found?.email) {
              email = found.email;
            } else {
              email = `${email}@velvet.local`;
            }
          } catch {
            email = `${email}@velvet.local`;
          }
        }
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
      const msg =
        authError?.message === "Invalid login credentials"
          ? "Credenciales incorrectas. Si tu cuenta es de Patreon, inicia sesión con 'Acceder con Patreon VIP'."
          : authError?.message || "Credenciales incorrectas";
      return NextResponse.json({ detail: msg }, { status: 401 });
    }

    const { data: profile } = await admin
      .from("profiles")
      .select("is_admin")
      .eq("id", authData.user.id)
      .maybeSingle();

    const role = profile?.is_admin ? "admin" : "member";
    const meta = authData.user.user_metadata || {};
    const displayName =
      meta.username ||
      meta.full_name ||
      meta.display_name ||
      (authData.user.email ? authData.user.email.split("@")[0] : rawUsername);

    // Registrar o actualizar dispositivo (soporte de hasta 10 dispositivos sin expulsión)
    const deviceToken =
      body.device_token ||
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
      device_token: deviceToken,
      user: {
        id: authData.user.id,
        username: displayName,
        email: authData.user.email,
        role,
        tier: meta.tier || (role === "admin" ? "Dueño" : "Velvet VIP ($5.99)"),
        tier_level: "pro",
        is_pro: true,
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
