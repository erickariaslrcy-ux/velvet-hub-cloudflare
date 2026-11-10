import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth-user";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

    const admin = createAdminClient();
    const { data: profile } = await admin
      .from("profiles")
      .select("is_admin")
      .eq("id", user.id)
      .maybeSingle();

    if (!profile?.is_admin) {
      return NextResponse.json({ error: "Solo la cuenta maestra" }, { status: 403 });
    }

    const [profilesRes, keysRes, usedKeysRes, favsRes] = await Promise.all([
      admin.from("profiles").select("id", { count: "exact", head: true }),
      admin.from("invite_keys").select("code", { count: "exact", head: true }).eq("revoked", false).is("used_at", null),
      admin.from("invite_keys").select("code", { count: "exact", head: true }).not("used_at", "is", null),
      admin.from("favorites").select("item_id", { count: "exact", head: true }),
    ]);

    return NextResponse.json({
      total_users: profilesRes.count || 0,
      available_keys: keysRes.count || 0,
      used_keys: usedKeysRes.count || 0,
      total_favorites: favsRes.count || 0,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
