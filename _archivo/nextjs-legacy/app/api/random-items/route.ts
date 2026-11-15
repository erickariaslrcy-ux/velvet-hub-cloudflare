import { NextResponse } from "next/server";
import { getUser } from "@/lib/supabase/server";
import { getRandom20FromPool } from "@/lib/live-scraper";

export const runtime = "nodejs";

export async function GET() {
  try {
    const { supabase } = await getUser();
    const items = await getRandom20FromPool(supabase);
    return NextResponse.json({
      ok: true,
      items,
      count: items.length,
    });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err.message || "Error al obtener cómics al azar" },
      { status: 500 }
    );
  }
}
