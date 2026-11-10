import { NextRequest, NextResponse } from "next/server";
import { getUser } from "@/lib/supabase/server";

export async function POST(req: NextRequest) {
  const { supabase, user } = await getUser();
  if (!user) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  const { item_id, favorite } = await req.json().catch(() => ({}));
  const id = Number(item_id);
  if (!Number.isInteger(id)) return NextResponse.json({ error: "Ítem inválido" }, { status: 400 });

  if (favorite) {
    const { error } = await supabase.from("favorites").upsert({ user_id: user.id, item_id: id });
    if (error) return NextResponse.json({ error: "No se pudo guardar" }, { status: 400 });
  } else {
    const { error } = await supabase.from("favorites").delete().eq("user_id", user.id).eq("item_id", id);
    if (error) return NextResponse.json({ error: "No se pudo quitar" }, { status: 400 });
  }
  return NextResponse.json({ ok: true, favorite: !!favorite });
}
