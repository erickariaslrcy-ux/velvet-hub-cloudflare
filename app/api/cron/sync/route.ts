import { NextRequest, NextResponse } from "next/server";
import { scrapeRandom15 } from "@/lib/live-scraper";

export const runtime = "nodejs";

// Cron que se ejecuta cada 10 minutos para cargar 15 cómics aleatorios
// rotando 2 fuentes por vuelta sin ser detectado.
export async function GET(req: NextRequest) {
  try {
    const res = await scrapeRandom15();
    return NextResponse.json({
      ok: true,
      timestamp: new Date().toISOString(),
      sources: res.sources,
      comics_scraped: res.count,
    });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err.message || "Error en cron de scraping" },
      { status: 500 }
    );
  }
}
