import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { createAdminClient } from "@/lib/supabase/admin";
import { registerOrTouchDevice } from "@/lib/devices";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const username = (body.username || "").trim();
    const password = body.password || "";
    const accessKey = (body.access_key || body.code || "").trim().toUpperCase();

    if (!username || !password || !accessKey) {
      return NextResponse.json(
        { detail: "Usuario, contraseña y llave VIP requeridos" },
        { status: 400 }
      );
    }

    if (username.length < 3) {
      return NextResponse.json(
        { detail: "El nombre de usuario debe tener al menos 3 caracteres" },
        { status: 400 }
      );
    }

    if (password.length < 6) {
      return NextResponse.json(
        { detail: "La contraseña debe tener al menos 6 caracteres" },
        { status: 400 }
      );
    }

    let email = body.email ? String(body.email).trim().toLowerCase() : "";
    if (!email) {
      if (username.includes("@")) {
        email = username.toLowerCase();
      } else {
        email = `${username.toLowerCase().replace(/[^a-z0-9_-]/g, "")}@velvet.local`;
      }
    }

    const admin = createAdminClient();

    // 1. Validar y reclamar llave VIP de invitación
    const { data: claimed, error: claimErr } = await admin.rpc("claim_invite_key", {
      p_code: accessKey,
      p_email: email,
    });

    if (claimErr || !claimed) {
      return NextResponse.json(
        { detail: "La llave de acceso VIP no existe, ya fue utilizada o ha expirado." },
        { status: 400 }
      );
    }

    // 2. Crear usuario en Supabase Auth
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        username,
        full_name: username,
        display_name: username,
        tier: "Velvet VIP ($5.99)",
        tier_level: "pro",
        is_pro: true,
        max_devices: 10,
        invite_key: accessKey,
      },
    });

    if (createErr || !created.user) {
      // Liberar la llave para que no quede quemada si el registro falla
      await admin
        .from("invite_keys")
        .update({ used_at: null, used_email: null })
        .eq("code", accessKey);

      const msg = /already|registered|exists/i.test(createErr?.message || "")
        ? "Ese usuario o correo ya está registrado. Por favor inicia sesión."
        : createErr?.message || "No se pudo crear la cuenta VIP.";
      return NextResponse.json({ detail: msg }, { status: 400 });
    }

    // 3. Vincular llave con el ID de usuario creado
    await admin.from("invite_keys").update({ used_by: created.user.id }).eq("code", accessKey);

    // 4. Asegurar perfil en la tabla profiles
    await admin
      .from("profiles")
      .upsert({ id: created.user.id, email, is_admin: false }, { onConflict: "id" });

    // 5. Iniciar sesión automáticamente y generar JWT y cookies
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

    const { data: authData } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    const session = authData?.session;
    const deviceToken = "dev_" + Math.random().toString(36).substring(2);
    const userAgent = req.headers.get("user-agent") || "";
    await registerOrTouchDevice(admin, created.user.id, deviceToken, 10, userAgent);

    const THIRTY_DAYS = 30 * 24 * 60 * 60;
    const response = NextResponse.json({
      token: session?.access_token || "velvet_token",
      refresh_token: session?.refresh_token || null,
      expires_at: session?.expires_at || null,
      device_token: deviceToken,
      user: {
        id: created.user.id,
        username,
        email,
        role: "member",
        tier: "Velvet VIP ($5.99)",
        tier_level: "pro",
        is_pro: true,
      },
    });

    // Guardar cookies de sesión
    cookieJar.forEach(({ name, value, options }) => {
      response.cookies.set(name, value, {
        ...options,
        path: "/",
        maxAge: THIRTY_DAYS,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
      });
    });

    if (session?.refresh_token) {
      response.cookies.set("velvet_refresh_token", session.refresh_token, {
        path: "/",
        maxAge: THIRTY_DAYS,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        httpOnly: true,
      });
    }

    response.cookies.set("velvet_device_token", deviceToken, {
      path: "/",
      maxAge: 365 * 24 * 60 * 60,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      httpOnly: false,
    });

    return response;
  } catch (err: any) {
    return NextResponse.json({ detail: err.message || "Error al procesar registro" }, { status: 500 });
  }
}
