import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get("url") || "https://anyporn.com/701244/";
  const uaType = req.nextUrl.searchParams.get("ua") || "iphone";
  
  const UA_IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
  const UA_CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
  
  const headers: Record<string, string> = {
    "User-Agent": uaType === "iphone" ? UA_IPHONE : UA_CHROME,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
    "Referer": "https://www.google.com/",
    "Cache-Control": "no-cache",
  };

  try {
    const res = await fetch(url, {
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(8000),
    });

    const status = res.status;
    const text = await res.text();
    const hasSources = text.includes("const sources");
    const mp4Matches = text.match(/https?:\/\/[^\s'"<>]+\.mp4(?:\?[^\s'"<>]*)?/gi) || [];

    return NextResponse.json({
      status,
      finalUrl: res.url,
      hasSources,
      htmlLength: text.length,
      mp4Count: mp4Matches.length,
      sampleMp4: mp4Matches[0] || null,
      title: text.match(/<title>(.*?)<\/title>/i)?.[1] || null,
      bodyPreview: text.slice(0, 300),
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
