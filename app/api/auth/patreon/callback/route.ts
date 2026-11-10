import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { createAdminClient } from "@/lib/supabase/admin";
import { exchangePatreonCode, fetchPatreonIdentity, MASTER_EMAIL } from "@/lib/patreon";
import { registerOrTouchDevice } from "@/lib/devices";
import crypto from "crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || "";
  const isLocal = host.includes("localhost") || host.includes("127.0.0.1");
  const configuredSite = process.env.NEXT_PUBLIC_SITE_URL || process.env.SITE_URL;

  const proto = req.headers.get("x-forwarded-proto") || (isLocal ? "http" : "https");

  let origin: string;
  if (!isLocal && configuredSite) {
    origin = configuredSite.replace(/\/+$/, "");
  } else {
    origin = host ? `${proto}://${host}` : req.nextUrl.origin;
  }
  const redirectUri = `${origin}/api/auth/patreon/callback`;

  const code = req.nextUrl.searchParams.get("code");
  const errorParam = req.nextUrl.searchParams.get("error");

  if (errorParam || !code) {
    return NextResponse.redirect(`${origin}/?auth_error=cancelado`);
  }

  try {
    // 1. Intercambiar código por tokens de Patreon
    const tokenData = await exchangePatreonCode(code, redirectUri);

    // 2. Obtener identidad y estado de mecenazgo
    const patreonUser = await fetchPatreonIdentity(tokenData.access_token);

    // 3. Validar si es mecenas activo (o creador del proyecto)
    if (!patreonUser.isActivePatron && !patreonUser.isCreator) {
      const errorMsg = encodeURIComponent(
        `Hola ${patreonUser.fullName}, tu cuenta de Patreon no tiene una membresía activa en Velvet Hub. ¡Únete a un nivel para ingresar!`
      );
      return NextResponse.redirect(`${origin}/?auth_error=inactive&msg=${errorMsg}`);
    }

    const admin = createAdminClient();
    const email = patreonUser.email || `patron_${patreonUser.id}@velvet.local`;

    // 4. Buscar o crear el usuario en Supabase Auth
    let targetUserId: string = "";
    const { data: existingProfiles } = await admin
      .from("profiles")
      .select("id, is_admin")
      .eq("email", email)
      .maybeSingle();

    if (existingProfiles) {
      targetUserId = existingProfiles.id;
      // Actualizar metadata del usuario
      await admin.auth.admin.updateUserById(targetUserId, {
        user_metadata: {
          full_name: patreonUser.fullName,
          patreon_id: patreonUser.id,
          patron_status: "active_patron",
          tier: patreonUser.tierTitle,
          tier_level: patreonUser.tierLevel,
          is_pro: patreonUser.isPro,
          max_devices: patreonUser.maxDevices,
          avatar_url: patreonUser.avatarUrl,
        },
      });
    } else {
      // Crear nuevo usuario en Supabase
      const { data: newUser, error: createError } = await admin.auth.admin.createUser({
        email,
        email_confirm: true,
        user_metadata: {
          full_name: patreonUser.fullName,
          patreon_id: patreonUser.id,
          patron_status: "active_patron",
          tier: patreonUser.tierTitle,
          tier_level: patreonUser.tierLevel,
          is_pro: patreonUser.isPro,
          max_devices: patreonUser.maxDevices,
          avatar_url: patreonUser.avatarUrl,
        },
      });

      if (createError || !newUser.user) {
        throw new Error(`Error creando usuario Supabase: ${createError?.message}`);
      }
      targetUserId = newUser.user.id;
    }

    // 5. Asignar rol admin si es el creador
    if (patreonUser.isCreator || email.toLowerCase() === MASTER_EMAIL) {
      await admin.from("profiles").update({ is_admin: true }).eq("id", targetUserId);
    }

    // 6. Control de dispositivos (hasta 10 dispositivos concurrentes)
    let deviceToken = req.cookies.get("velvet_device_token")?.value || "";
    if (!deviceToken) {
      deviceToken = "dev_" + crypto.randomBytes(16).toString("hex");
    }

    const userAgent = req.headers.get("user-agent") || "";
    await registerOrTouchDevice(admin, targetUserId, deviceToken, Math.max(10, patreonUser.maxDevices), userAgent);

    // 7. Generar sesión JWT de Supabase
    const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
      type: "magiclink",
      email,
    });

    if (linkErr || !linkData?.properties?.hashed_token) {
      throw new Error("No se pudo generar el enlace de autenticación.");
    }

    // Intercambiar hash por JWT válido
    const anon = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll: () => req.cookies.getAll(),
          setAll: () => {},
        },
      }
    );

    const { data: sessionData, error: sessionErr } = await anon.auth.verifyOtp({
      token_hash: linkData.properties.hashed_token,
      type: "magiclink",
    });

    if (sessionErr || !sessionData.session) {
      throw new Error(`Error obteniendo sesión: ${sessionErr?.message}`);
    }

    const jwtToken = sessionData.session.access_token;
    const refreshToken = sessionData.session.refresh_token || "";

    // 8. Responder con HTML de transición que guarda el token y redirige
    const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <title>Iniciando Velvet Hub con Patreon...</title>
  <style>
    body {
      background: #080312;
      color: #fff;
      font-family: system-ui, -apple-system, sans-serif;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
    }
    .spinner {
      width: 44px;
      height: 44px;
      border: 3px solid rgba(236,72,153,0.2);
      border-top-color: #ec4899;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      margin-bottom: 20px;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    h2 { font-size: 1.1rem; margin: 0 0 8px; font-weight: 700; }
    p { font-size: 0.85rem; color: #a855f7; margin: 0; }
  </style>
</head>
<body>
  <div class="spinner"></div>
  <h2>¡Autenticación con Patreon exitosa!</h2>
  <p>Conectando a Velvet Hub...</p>
  <script>
    try {
      localStorage.setItem('velvet_auth_token', '${jwtToken}');
      localStorage.setItem('velvet_refresh_token', '${refreshToken}');
      localStorage.setItem('velvet_device_token', '${deviceToken}');
      window.location.href = '/?patreon_login=success';
    } catch (e) {
      window.location.href = '/';
    }
  </script>
</body>
</html>`;

    const response = new NextResponse(html, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
      },
    });

    const THIRTY_DAYS = 30 * 24 * 60 * 60;
    if (refreshToken) {
      response.cookies.set("velvet_refresh_token", refreshToken, {
        path: "/",
        maxAge: THIRTY_DAYS,
        sameSite: "lax",
        secure: proto === "https",
        httpOnly: true,
      });
    }

    // Guardar cookie de dispositivo (vigente 1 año)
    response.cookies.set("velvet_device_token", deviceToken, {
      path: "/",
      maxAge: 365 * 24 * 60 * 60,
      sameSite: "lax",
      secure: proto === "https",
      httpOnly: false,
    });

    return response;
  } catch (err: any) {
    console.error("Error en callback de Patreon:", err);
    const msg = encodeURIComponent(err.message || "Error al autenticar con Patreon");
    return NextResponse.redirect(`${origin}/?auth_error=general&msg=${msg}`);
  }
}
