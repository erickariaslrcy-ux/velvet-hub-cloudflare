import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
const MEDIA_SECRET = "velvet_ultra_stealth_secret_key_2026";

function decodeMediaToken(token: string): { url: string; referer?: string } | null {
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
      "Access-Control-Allow-Headers": "Range, Content-Type, Accept, Authorization",
      "Access-Control-Max-Age": "86400",
    },
  });
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const token = sp.get("t");
  let targetUrl = sp.get("url") || sp.get("i");
  let referer = sp.get("referer") || sp.get("r") || undefined;

  if (token) {
    const decoded = decodeMediaToken(token);
    if (decoded?.url) {
      targetUrl = decoded.url;
      if (decoded.referer) referer = decoded.referer;
    }
  }

  if (!targetUrl || !/^https?:\/\//i.test(targetUrl)) {
    return new NextResponse("Token o URL de medio inválida", {
      status: 400,
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  }

  // PMVHaven auto-fix
  if (/pmvhavencloud[^\s]+\/[a-f0-9]{24}$/.test(targetUrl)) {
    targetUrl = `${targetUrl.replace(/\/+$/, "")}/master.m3u8`;
  }

  const isVideo =
    targetUrl.includes(".mp4") ||
    targetUrl.includes(".m3u8") ||
    targetUrl.includes("media=hls") ||
    targetUrl.includes("media%3Dhls") ||
    targetUrl.includes("__TPL_");

  const upstreamHeaders: Record<string, string> = {
    "User-Agent": UA,
    Accept: "*/*",
  };

  if (referer) {
    upstreamHeaders["Referer"] = referer;
  } else {
    try {
      upstreamHeaders["Referer"] = new URL(targetUrl).origin + "/";
    } catch {}
  }

  const clientRange = req.headers.get("range");
  if (clientRange) {
    upstreamHeaders["Range"] = clientRange;
  }

  try {
    const upstream = await fetch(targetUrl, {
      headers: upstreamHeaders,
      redirect: "follow",
    });

    const respHeaders = new Headers();
    respHeaders.set("Access-Control-Allow-Origin", "*");
    respHeaders.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    respHeaders.set("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges");

    const ct = upstream.headers.get("content-type") || (isVideo ? "video/mp4" : "image/jpeg");
    respHeaders.set("Content-Type", ct);

    if (isVideo) {
      respHeaders.set("Accept-Ranges", "bytes");
      respHeaders.set("Cache-Control", "public, max-age=7200");
    } else {
      respHeaders.set("Cache-Control", "public, max-age=604800, immutable");
    }

    if (upstream.headers.has("Content-Length")) {
      respHeaders.set("Content-Length", upstream.headers.get("Content-Length")!);
    }
    if (upstream.headers.has("Content-Range")) {
      respHeaders.set("Content-Range", upstream.headers.get("Content-Range")!);
    }

    // Reescritura M3U8 para resolver chunks relativos
    const isM3u8 =
      targetUrl.includes(".m3u8") ||
      (upstream.headers.get("content-type") || "").toLowerCase().includes("mpegurl");

    if (isM3u8 && upstream.ok) {
      try {
        const manifestText = await upstream.text();
        const lastSlash = targetUrl.lastIndexOf("/");
        const baseUrl = lastSlash !== -1 ? targetUrl.substring(0, lastSlash + 1) : targetUrl + "/";
        const origin = new URL(targetUrl).origin;

        const lines = manifestText.split("\n");
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
            return `${baseUrl}${trimmed}`;
          })
          .join("\n");

        respHeaders.set("Content-Type", "application/vnd.apple.mpegurl; charset=utf-8");
        return new NextResponse(rewritten, { status: 200, headers: respHeaders });
      } catch (err) {
        // Fallback al stream normal si falla el parseo
      }
    }

    return new NextResponse(upstream.body, {
      status: upstream.status,
      headers: respHeaders,
    });
  } catch (err: any) {
    return new NextResponse(`Error conectando con el stream: ${err.message}`, {
      status: 502,
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  }
}
