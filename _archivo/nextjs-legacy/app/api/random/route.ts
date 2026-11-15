import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const count = Math.min(30, Math.max(1, parseInt(sp.get("count") || "6", 10) || 6));
  const mediaType = sp.get("media_type") || "";

  const admin = createAdminClient();
  let query = admin.from("catalog").select("*");

  if (mediaType === "video") {
    query = query.eq("media_type", "video");
  } else if (mediaType === "comic") {
    query = query.in("media_type", ["comic", "manga_chapter"]);
  }

  // Obtenemos un bloque reciente y seleccionamos aleatoriamente
  const { data, error } = await query.order("id", { ascending: false }).limit(100);

  if (error || !data || data.length === 0) {
    return NextResponse.json({ items: [] });
  }

  const shuffled = [...data].sort(() => 0.5 - Math.random()).slice(0, count);

  const items = shuffled.map((it: any) => ({
    id: it.id,
    source: it.source_label || "velvet",
    source_id: String(it.id),
    title: it.title,
    cover_url: `/api/img?i=${it.id}`,
    media_type: it.media_type,
    tags: it.tags || [],
    page_count: it.page_count || 0,
    video_sources: it.video_sources || [],
    has_cover: it.has_cover,
  }));

  return NextResponse.json(count === 1 ? items[0] : { items });
}
