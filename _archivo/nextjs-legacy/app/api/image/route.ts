import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Item, Page } from "@/lib/types";

export const runtime = "nodejs";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

function fallbackSvg(): NextResponse {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600" viewBox="0 0 400 600">
    <rect width="100%" height="100%" fill="#0a0512"/>
    <text x="200" y="300" font-family="system-ui, sans-serif" font-size="28" font-weight="900" fill="#ff2d55" text-anchor="middle">VELVET HUB</text>
  </svg>`;
  return new NextResponse(svg, {
    headers: {
      "Content-Type": "image/svg+xml",
      "Cache-Control": "public, max-age=86400, immutable",
    },
  });
}

function decodeStealthToken(token: string): { url: string; referer?: string } | null {
  try {
    let b64 = token.replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4 !== 0) b64 += "=";
    const jsonStr = Buffer.from(b64, "base64").toString("utf-8");
    const data = JSON.parse(jsonStr);
    return { url: data.u, referer: data.r || undefined };
  } catch {
    return null;
  }
}

// In-memory cache for fast item metadata lookups
interface CachedItemData {
  url?: string;
  cover_url?: string;
  pages: Page[];
  timestamp: number;
}
const itemDataCache = new Map<number, CachedItemData>();

async function getCachedItemData(id: number): Promise<CachedItemData | null> {
  const cached = itemDataCache.get(id);
  if (cached && Date.now() - cached.timestamp < 30 * 60 * 1000) {
    return cached;
  }
  const admin = createAdminClient();
  const { data } = await admin
    .from("items")
    .select("url,cover_url,pages")
    .eq("id", id)
    .single<Pick<Item, "url" | "cover_url" | "pages">>();
  if (!data) return null;
  const entry: CachedItemData = {
    url: data.url,
    cover_url: data.cover_url,
    pages: data.pages || [],
    timestamp: Date.now(),
  };
  if (itemDataCache.size > 800) {
    const first = itemDataCache.keys().next().value;
    if (first !== undefined) itemDataCache.delete(first);
  }
  itemDataCache.set(id, entry);
  return entry;
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const token = sp.get("t");
  let target = sp.get("url");
  let referer = sp.get("referer") || undefined;

  if (token) {
    const decoded = decodeStealthToken(token);
    if (decoded?.url) {
      target = decoded.url;
      if (decoded.referer) referer = decoded.referer;
    }
  }

  // Si target es una ruta interna como /api/img?i=123
  if (target && target.includes("/api/img")) {
    const m = target.match(/[?&]i=(\d+)/);
    if (m) {
      const internalId = parseInt(m[1], 10);
      const data = await getCachedItemData(internalId);
      if (data) {
        target = data.cover_url || (data.pages && data.pages[0]?.image_url);
        referer = data.url || undefined;
      }
    }
  }

  // Si se pasa por id directamente: /api/image?i=123&p=0
  const id = Number(sp.get("i"));
  const p = Number(sp.get("p") ?? "0");
  if (!target && Number.isInteger(id) && id > 0) {
    const data = await getCachedItemData(id);
    if (data) {
      referer = data.url || undefined;
      const pages: Page[] = data.pages ?? [];
      if (p === 0) {
        target = data.cover_url || pages[0]?.image_url;
      } else {
        const page = pages[p - 1];
        target = page?.image_url;
        if (page?.referer) referer = page.referer;
      }
    }
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
