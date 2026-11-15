import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Crea una cuenta solo si la llave de invitación es válida y no se ha usado.
export async function POST(req: NextRequest) {
  let body: { code?: string; email?: string; password?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Solicitud inválida" }, { status: 400 });
  }
  const code = (body.code || "").trim().toUpperCase();
  const email = (body.email || "").trim().toLowerCase();
  const password = body.password || "";

  if (!code || !EMAIL_RE.test(email)) {
    return NextResponse.json({ error: "Llave o correo inválidos" }, { status: 400 });
  }
  if (password.length < 8) {
    return NextResponse.json({ error: "La contraseña debe tener al menos 8 caracteres" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: claimed, error: claimErr } = await admin.rpc("claim_invite_key", { p_code: code, p_email: email });
  if (claimErr || !claimed) {
    return NextResponse.json({ error: "La llave no existe, ya se usó o expiró" }, { status: 400 });
  }

  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (createErr || !created.user) {
    // Devolver la llave para que pueda usarse de nuevo.
    await admin.from("invite_keys").update({ used_at: null, used_email: null }).eq("code", code);
    const msg = /already|registered|exists/i.test(createErr?.message || "")
      ? "Ese correo ya tiene una cuenta"
      : "No se pudo crear la cuenta";
    return NextResponse.json({ error: msg }, { status: 400 });
  }

  await admin.from("invite_keys").update({ used_by: created.user.id }).eq("code", code);
  return NextResponse.json({ ok: true });
}
