import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const MEDIA_SECRET = "velvet_ultra_stealth_secret_key_2026";

function decodeStealthToken(token: string): { url: string; referer?: string } | null {
  try {
    let b64 = token.replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4 !== 0) b64 += "=";
    const buf = Buffer.from(b64, "base64");

    // 1. Try direct JSON
    try {
      const jsonStr = buf.toString("utf-8");
      const data = JSON.parse(jsonStr);
      if (data && data.u) return { url: data.u, referer: data.r || undefined };
    } catch {}

    // 2. Try XOR decryption
    const keyBuf = Buffer.from(MEDIA_SECRET, "utf-8");
    const decrypted = Buffer.alloc(buf.length);
    for (let i = 0; i < buf.length; i++) {
      decrypted[i] = buf[i] ^ keyBuf[i % keyBuf.length];
    }
    const decStr = decrypted.toString("utf-8");
    const data = JSON.parse(decStr);
    if (data && data.u) return { url: data.u, referer: data.r || undefined };
    return null;
  } catch {
    return null;
  }
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      "Access-Control-Allow-Headers": "Range, Accept, Content-Type, Authorization",
      "Access-Control-Max-Age": "86400",
    },
  });
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const token = sp.get("t");
  let targetUrl = sp.get("url");
  let referer = sp.get("referer") || undefined;

  if (token) {
    const decoded = decodeStealthToken(token);
    if (decoded?.url) {
      targetUrl = decoded.url;
      if (decoded.referer) referer = decoded.referer;
    }
  }

  if (!targetUrl || !/^https?:\/\//i.test(targetUrl)) {
    return new NextResponse("Token o URL de video inválida", { status: 400 });
  }

  // Corrección automática de PMVHaven si la URL apunta a la carpeta S3 sin playlist
  if (/pmvhavencloud[^\s]+\/[a-f0-9]{24}$/.test(targetUrl)) {
    targetUrl = `${targetUrl.replace(/\/+$/, "")}/master.m3u8`;
  }

  // Si hay un Worker de Cloudflare configurado, desviar hacia él (ancho de banda ilimitado)
  const cfWorker = process.env.NEXT_PUBLIC_CF_WORKER_URL;
  if (cfWorker) {
    const workerUrl = `${cfWorker.replace(/\/+$/, "")}/?url=${encodeURIComponent(targetUrl)}${referer ? `&referer=${encodeURIComponent(referer)}` : ""}`;
    return NextResponse.redirect(workerUrl, 307);
  }

  const isM3u8 =
    targetUrl.includes(".m3u8") ||
    targetUrl.includes("media=hls") ||
    targetUrl.includes("media%3Dhls") ||
    targetUrl.includes("__TPL_");

  // CASO 1: Para videos MP4 directos, hacemos REDIRECCIÓN 307 DIRECTA
  // Esto consume 0 bytes de ancho de banda en Vercel (el navegador del usuario lo reproduce directo del CDN)
  if (!isM3u8) {
    const res = NextResponse.redirect(targetUrl, 307);
    res.headers.set("Access-Control-Allow-Origin", "*");
    res.headers.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    res.headers.set("Cache-Control", "public, max-age=86400, s-maxage=604800, immutable");
    return res;
  }

  // CASO 2: Para listas HLS M3U8, solo descargamos el archivo de texto del índice (~500 bytes)
  // Reescribimos los enlaces a rutas absolutas para que los segmentos (.ts) se descarguen DIRECTO del CDN origen sin pasar por Vercel.
  try {
    const upstream = await fetch(targetUrl, {
      headers: {
        "User-Agent": UA,
        Accept: "*/*",
        ...(referer ? { Referer: referer } : {}),
      },
      redirect: "follow",
    });

    const status = upstream.status;
    if (status >= 400) {
      return new NextResponse(`Error de conexión upstream (${status})`, {
        status,
        headers: { "Access-Control-Allow-Origin": "*" },
      });
    }

    const responseHeaders = new Headers();
    responseHeaders.set("Access-Control-Allow-Origin", "*");
    responseHeaders.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    responseHeaders.set("Access-Control-Allow-Headers", "Range, Accept, Content-Type");
    responseHeaders.set("Content-Type", "application/vnd.apple.mpegurl");
    responseHeaders.set("Cache-Control", "public, max-age=3600");

    const rawM3u8 = await upstream.text();
    const targetObj = new URL(targetUrl);
    const origin = targetObj.origin;
    const basePath = targetUrl.substring(0, targetUrl.lastIndexOf("/") + 1);

    const lines = rawM3u8.split("\n");
    const rewritten = lines
      .map((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) return line;
        if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
          return trimmed;
        }
        if (trimmed.startsWith("/")) {
          return `${origin}${trimmed}`;
        }
        return `${basePath}${trimmed}`;
      })
      .join("\n");

    return new NextResponse(rewritten, {
      status: 200,
      headers: responseHeaders,
    });
  } catch (err: any) {
    return new NextResponse(`Error conectando con el stream: ${err.message}`, {
      status: 502,
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  }
}
