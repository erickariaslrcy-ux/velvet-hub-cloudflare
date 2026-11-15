import { NextRequest, NextResponse } from "next/server";
import { searchLive } from "@/lib/live-scraper";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q") || "";
  if (!q.trim()) {
    return NextResponse.json({ items: [] });
  }

  try {
    const items = await searchLive(q);
    return NextResponse.json({
      ok: true,
      count: items.length,
      items,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || "Error en live search" }, { status: 500 });
  }
}
