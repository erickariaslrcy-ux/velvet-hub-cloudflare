import { NextRequest, NextResponse } from "next/server";
import { getUser, isAdmin } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

export async function GET() {
  const { user } = await getUser();
  if (!user || !(await isAdmin())) return NextResponse.json({ error: "Solo la cuenta maestra" }, { status: 403 });
  const admin = createAdminClient();
  const { data, error } = await admin.auth.admin.listUsers({ perPage: 1000 });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({
    users: data.users.map((u) => ({
      id: u.id,
      email: u.email,
      created_at: u.created_at,
      last_sign_in_at: u.last_sign_in_at,
      banned_until: (u as { banned_until?: string }).banned_until ?? null,
    })),
  });
}

// Bloquear o desbloquear el acceso de un usuario (no se puede a uno mismo).
export async function PATCH(req: NextRequest) {
  const { user } = await getUser();
  if (!user || !(await isAdmin())) return NextResponse.json({ error: "Solo la cuenta maestra" }, { status: 403 });
  const { id, banned } = await req.json().catch(() => ({}));
  if (!id || id === user.id) return NextResponse.json({ error: "Usuario inválido" }, { status: 400 });
  const admin = createAdminClient();
  const { error } = await admin.auth.admin.updateUserById(id, { ban_duration: banned ? "876000h" : "none" });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
