import { NextRequest, NextResponse } from "next/server";
import { getUser, isAdmin } from "@/lib/supabase/server";
import { newInviteCode } from "@/lib/keys";

async function guard() {
  const { supabase, user } = await getUser();
  if (!user || !(await isAdmin())) return null;
  return { supabase, user };
}

export async function GET() {
  const ctx = await guard();
  if (!ctx) return NextResponse.json({ error: "Solo la cuenta maestra" }, { status: 403 });
  const { data, error } = await ctx.supabase
    .from("invite_keys")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ keys: data });
}

export async function POST(req: NextRequest) {
  const ctx = await guard();
  if (!ctx) return NextResponse.json({ error: "Solo la cuenta maestra" }, { status: 403 });
  const body = await req.json().catch(() => ({}));
  const count = Math.min(Math.max(Number(body.count) || 1, 1), 50);
  const days = Number(body.days) || 0;
  const note = String(body.note || "").slice(0, 200);
  const expires_at = days > 0 ? new Date(Date.now() + days * 86400000).toISOString() : null;

  const rows = Array.from({ length: count }, () => ({
    code: newInviteCode(),
    note,
    created_by: ctx.user.id,
    expires_at,
  }));
  const { data, error } = await ctx.supabase.from("invite_keys").insert(rows).select("*");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ keys: data });
}

export async function DELETE(req: NextRequest) {
  const ctx = await guard();
  if (!ctx) return NextResponse.json({ error: "Solo la cuenta maestra" }, { status: 403 });
  const { code } = await req.json().catch(() => ({}));
  if (!code) return NextResponse.json({ error: "Falta la llave" }, { status: 400 });
  const { error } = await ctx.supabase.from("invite_keys").update({ revoked: true }).eq("code", code);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
