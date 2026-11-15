import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth-user";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

async function guard(req: NextRequest) {
  const user = await getAuthenticatedUser(req);
  if (!user) return null;
  const admin = createAdminClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("is_admin")
    .eq("id", user.id)
    .maybeSingle();

  if (!profile?.is_admin) return null;
  return { admin, user };
}

export async function GET(req: NextRequest) {
  const ctx = await guard(req);
  if (!ctx) return NextResponse.json({ error: "Solo la cuenta maestra" }, { status: 403 });
  const { data, error } = await ctx.admin.auth.admin.listUsers({ perPage: 1000 });
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
  const ctx = await guard(req);
  if (!ctx) return NextResponse.json({ error: "Solo la cuenta maestra" }, { status: 403 });
  const { id, banned } = await req.json().catch(() => ({}));
  if (!id || id === ctx.user.id) return NextResponse.json({ error: "Usuario inválido" }, { status: 400 });
  const { error } = await ctx.admin.auth.admin.updateUserById(id, { ban_duration: banned ? "876000h" : "none" });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
