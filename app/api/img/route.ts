import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Item, Page } from "@/lib/types";

export const runtime = "nodejs";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

function fallbackSvg(title = "Velvet"): NextResponse {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600" viewBox="0 0 400 600">
    <defs>
      <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#180b22"/>
        <stop offset="50%" stop-color="#0c0714"/>
        <stop offset="100%" stop-color="#050308"/>
      </linearGradient>
      <linearGradient id="glow" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stop-color="#ff2d55"/>
        <stop offset="100%" stop-color="#9333ea"/>
      </linearGradient>
    </defs>
    <rect width="100%" height="100%" fill="url(#bg)"/>
    <circle cx="200" cy="260" r="70" fill="none" stroke="url(#glow)" stroke-width="3" opacity="0.4"/>
    <text x="200" y="275" font-family="system-ui, sans-serif" font-size="44" font-weight="900" fill="url(#glow)" text-anchor="middle">VIP</text>
    <text x="200" y="340" font-family="system-ui, sans-serif" font-size="16" font-weight="700" fill="#ffffff" opacity="0.8" text-anchor="middle">VELVET HUB</text>
    <text x="200" y="365" font-family="system-ui, sans-serif" font-size="12" fill="#ffffff" opacity="0.4" text-anchor="middle">PORTADA DIGITAL</text>
  </svg>`;
  return new NextResponse(svg, {
    headers: {
      "Content-Type": "image/svg+xml",
      "Cache-Control": "public, max-age=86400, s-maxage=604800, immutable",
    },
  });
}

// In-memory cache for fast item metadata lookups (eliminates 99% of Supabase database queries)
interface CachedItemData {
  url?: string;
  cover_url?: string;
  pages: Page[];
  chapters?: any[];
  timestamp: number;
}
const itemDataCache = new Map<number, CachedItemData>();

// /api/img?i=<id>&p=<página, 0 = portada>&c=<capítulo opcional>
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const id = Number(sp.get("i"));
  const p = Number(sp.get("p") ?? "0");
  const c = sp.get("c");
  if (!Number.isInteger(id) || !Number.isInteger(p) || p < 0) {
    return fallbackSvg();
  }

  let itemData = itemDataCache.get(id);
  if (!itemData || Date.now() - itemData.timestamp > 30 * 60 * 1000) {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("items")
      .select("url,cover_url,pages,chapters")
      .eq("id", id)
      .single<Pick<Item, "url" | "cover_url" | "pages" | "chapters">>();
    if (error || !data) {
      return fallbackSvg();
    }

    itemData = {
      url: data.url,
      cover_url: data.cover_url,
      pages: data.pages || [],
      chapters: data.chapters || [],
      timestamp: Date.now(),
    };

    if (itemDataCache.size > 800) {
      const firstKey = itemDataCache.keys().next().value;
      if (firstKey !== undefined) itemDataCache.delete(firstKey);
    }
    itemDataCache.set(id, itemData);
  }

  let referer: string | undefined = itemData.url || undefined;
  const pages: Page[] = c !== null ? itemData.chapters?.[Number(c)]?.pages ?? [] : itemData.pages ?? [];

  let target: string | undefined;
  if (p === 0) {
    target = itemData.cover_url || pages[0]?.image_url || itemData.chapters?.[0]?.pages?.[0]?.image_url;
  } else {
    const page = pages[p - 1];
    target = page?.image_url;
    if (page?.referer) referer = page.referer;
  }

  if (!target || !/^https?:\/\//i.test(target)) {
    return fallbackSvg();
  }

  // Si hay un Worker de Cloudflare configurado, desviar hacia él
  const cfWorker = process.env.NEXT_PUBLIC_CF_WORKER_URL;
  if (cfWorker) {
    const workerUrl = `${cfWorker.replace(/\/+$/, "")}/?url=${encodeURIComponent(target)}${referer ? `&referer=${encodeURIComponent(referer)}` : ""}`;
    return NextResponse.redirect(workerUrl, 307);
  }

  // Redirección 307 Directa: El navegador del usuario descarga la imagen directamente del CDN
  // Consumo de transferencia para Vercel = 0 BYTES.
  const res = NextResponse.redirect(target, 307);
  res.headers.set("Access-Control-Allow-Origin", "*");
  res.headers.set("Cache-Control", "public, max-age=86400, s-maxage=604800, immutable");
  return res;
}
