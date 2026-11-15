import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

async function resolveVideoSources(url: string): Promise<any[]> {
  if (!url || !/^https?:\/\//i.test(url)) return [];

  // 0. PMVHaven API
  if (url.includes("pmvhaven.com")) {
    const vidMatch = url.match(/[?&]v=([a-f0-9]{24})/i) || url.match(/\/([a-f0-9]{24})/i);
    if (vidMatch) {
      try {
        const pmvRes = await fetch(`https://pmvhaven.com/api/videos/${vidMatch[1]}`, {
          headers: { "User-Agent": UA, Accept: "application/json" },
          signal: AbortSignal.timeout(6000),
        });
        if (pmvRes.ok) {
          const pmvData = await pmvRes.json();
          const vData = pmvData?.data;
          if (vData) {
            const pmvStreams: any[] = [];
            if (vData.videoUrl) {
              pmvStreams.push({
                quality: "1080p HD",
                url: vData.videoUrl,
                format: "mp4",
              });
            }
            if (vData.hlsMasterPlaylistUrl) {
              pmvStreams.push({
                quality: "720p HD",
                url: vData.hlsMasterPlaylistUrl,
                format: "m3u8",
              });
            }
            if (pmvStreams.length > 0) return pmvStreams;
          }
        }
      } catch {}
    }
  }

  try {
    const cleanUrl = url.replace("es.anyporn.com", "anyporn.com");
    const res = await fetch(cleanUrl, {
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      signal: AbortSignal.timeout(7000),
      redirect: "follow",
    });
    if (!res.ok) return [];
    const html = await res.text();
    const streams: any[] = [];

    // Helper para detectar formato HLS
    const isHlsUrl = (u: string) =>
      u.includes(".m3u8") ||
      u.includes("media=hls") ||
      u.includes("media%3Dhls") ||
      u.includes("__TPL_");

    // Pattern 1: JS sources object (anyporn, etc.)
    const srcMatch = html.match(/const\s+sources\s*=\s*(\{.*?\});/s);
    if (srcMatch) {
      const found = [...srcMatch[1].matchAll(/(\d+)\s*:\s*['"]([^'"]+)['"]/g)];
      for (const f of found) {
        streams.push({ quality: `${f[1]}p`, url: f[2], format: isHlsUrl(f[2]) ? "m3u8" : "mp4" });
      }
    }

    // Pattern 1b: schema.org contentUrl (anyporn)
    const schemaMatch = html.match(/"contentUrl":\s*"([^"]+)"/);
    if (schemaMatch && !streams.some((s) => s.url === schemaMatch[1])) {
      const sUrl = schemaMatch[1];
      streams.push({ quality: "720p HD", url: sUrl, format: isHlsUrl(sUrl) ? "m3u8" : "mp4" });
    }

    // Pattern 2: <video> / <source> tags
    const sources = [...html.matchAll(/<source[^>]+src=["']([^"']+)["'][^>]*>/gi)];
    for (const sm of sources) {
      const src = sm[1];
      // Ignorar clips preview cortos si vienen de alotporn
      if (src.includes("preview") && url.includes("alotporn.com")) continue;

      let q = "1080p HD";
      const sizeMatch = sm[0].match(/size=["'](\d+)["']/i);
      const urlQMatch = src.match(/_(\d+p|\d{3,4})\.mp4/i);
      if (sizeMatch) {
        q = `${sizeMatch[1]}p`;
      } else if (urlQMatch) {
        q = urlQMatch[1].endsWith("p") ? urlQMatch[1] : `${urlQMatch[1]}p`;
      }

      if (!streams.some((s) => s.url === src)) {
        streams.push({ quality: q, url: src, format: isHlsUrl(src) ? "m3u8" : "mp4" });
      }
    }

    // Pattern 2b: JS video file configs (jwplayer, videojs, embed)
    const fileMatches = [...html.matchAll(/(?:file|video_url|source|stream_url)\s*:\s*["'](https?:\/\/[^"']+\.(?:mp4|m3u8)[^"']*)["']/gi)];
    for (const fm of fileMatches) {
      const fUrl = fm[1];
      if (fUrl.includes("preview") && url.includes("alotporn.com")) continue;
      if (!streams.some((s) => s.url === fUrl)) {
        streams.push({ quality: "1080p HD", url: fUrl, format: isHlsUrl(fUrl) ? "m3u8" : "mp4" });
      }
    }

    // Pattern 3: direct mp4 / m3u8 URLs
    if (streams.length === 0) {
      const mp4s = [...new Set(html.match(/https?:\/\/[^\s'"<>]+\.(?:mp4|m3u8)(?:\?[^\s'"<>]*)?/gi) || [])];
      for (const m of mp4s) {
        if (m.includes("&downloading")) continue;
        if (m.includes("preview") && url.includes("alotporn.com")) continue;
        const qMatch = m.match(/_(\d+)p/);
        const q = qMatch ? `${qMatch[1]}p` : "720p HD";
        if (!streams.some((s) => s.url === m)) {
          streams.push({ quality: q, url: m, format: isHlsUrl(m) ? "m3u8" : "mp4" });
        }
      }
    }

    // Pattern 4: video src attribute
    if (streams.length === 0) {
      const vidMatch = html.match(/<video[^>]+src=["']([^"']+)["']/i);
      if (vidMatch) {
        const vSrc = vidMatch[1];
        streams.push({ quality: "1080p HD", url: vSrc, format: isHlsUrl(vSrc) ? "m3u8" : "mp4" });
      }
    }

    return streams;
  } catch {
    return [];
  }
}


async function resolveGalleryPages(item: any): Promise<any[]> {
  const source = item.source || "";
  const url = item.url || "";
  const sourceId = item.source_id || "";
  const coverUrl = item.cover_url || "";
  let pageCount = Number(item.page_count) || 0;

  // Si pageCount no vino en la base de datos, extraerlo del título (ej: "(196 photos + 1 video)")
  if (pageCount <= 0 && item.title) {
    const titleMatch = item.title.match(/\((\d+)\s*photos?/i);
    if (titleMatch) {
      pageCount = parseInt(titleMatch[1], 10);
    }
  }
  if (pageCount <= 0) pageCount = 50;

  // 1. Buondua en CDN i2.buondua.com: deducción matemática inmediata ultra precisa
  if ((source === "buondua" || url.includes("buondua.com")) && coverUrl && coverUrl.includes("i2.buondua.com")) {
    const m = coverUrl.match(/^(https?:\/\/[^\/]+\/.*?-)(\d+)\.([a-z0-9]+)(\?.*)?$/i);
    if (m && pageCount > 0) {
      const basePrefix = m[1];
      const padLen = m[2].length;
      let ext = m[3].toLowerCase();
      // Las fotos fotográficas en i2.buondua.com siempre son jpeg (nunca gif)
      if (ext === "gif") ext = "jpeg";

      // Limpiar query params duplicados
      let token = "";
      if (coverUrl.includes("?")) {
        const parts = coverUrl.split("?").filter(Boolean);
        const lastPart = parts[parts.length - 1];
        token = `?${lastPart}`;
      }

      const pages: any[] = [];
      for (let i = 1; i <= pageCount; i++) {
        const numStr = String(i).padStart(padLen, "0");
        pages.push({
          index: i,
          image_url: `${basePrefix}${numStr}.${ext}${token}`,
          referer: url || `https://buondua.com/item-${sourceId}`,
        });
      }
      return pages;
    }
  }

  // 2. 4khd
  if (source === "4khd" || url.includes("4khd.com")) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "text/html,*/*" },
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) {
        const html = await res.text();
        let entry = html;
        const entryMatch = html.match(/<div[^>]*class="[^"]*(?:entry-content|wp-block-post-content)[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
        if (entryMatch) entry = entryMatch[1];
        if (entry.includes("wp-block-group")) {
          entry = entry.split("wp-block-group")[0];
        }
        const imgMatches = [...entry.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)];
        const photos: any[] = [];
        let idx = 1;
        for (const im of imgMatches) {
          const src = im[1];
          if (src && !src.includes("logo") && !src.includes("avatar")) {
            photos.push({ index: idx++, image_url: src, referer: url });
          }
        }
        if (photos.length > 0) return photos;
      }
    } catch (e) {}
  }

  // 3. xasiat
  if (source === "xasiat" || url.includes("xasiat.com")) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "text/html,*/*" },
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) {
        const html = await res.text();
        const getMatches = [...html.matchAll(/href=["'](\/get_image\/[^"']+)["']/gi)];
        const photos: any[] = [];
        let idx = 1;
        for (const gm of getMatches) {
          photos.push({ index: idx++, image_url: `https://xasiat.com${gm[1]}`, referer: url });
        }
        if (photos.length > 0) return photos;
      }
    } catch (e) {}
  }

  return [];
}

async function resolveComicPages(item: any): Promise<any[]> {
  const source = item.source || "";
  const coverUrl = item.cover_url || "";
  let pageCount = Number(item.page_count) || 0;
  const url = item.url || "";

  // 1. 3hentai: deducción matemática inmediata del CDN
  if (source === "3hentai" && coverUrl) {
    const m = coverUrl.match(/(https?:\/\/[^\/]+\/[^\/]+\/)thumb\.(?:jpg|webp|jpeg|png)/i);
    if (m && pageCount > 0) {
      const base = m[1];
      const extMatch = coverUrl.match(/\.([a-z0-9]+)$/i);
      const ext = extMatch ? extMatch[1] : "jpg";
      const pages = [];
      for (let i = 1; i <= pageCount; i++) {
        pages.push({ index: i, image_url: `${base}${i}.${ext}`, referer: url });
      }
      return pages;
    }
  }

  // 2. hentaipaw: resolución ULTRA HD original desde el visor de páginas
  if (source === "hentaipaw") {
    let sid = item.source_id;
    if (!sid && coverUrl) {
      const m = coverUrl.match(/imagedeliveries\.com\/(\d+)\//);
      if (m) sid = m[1];
    }
    if (sid) {
      // A. Consultar el visor de páginas para obtener los tokens de alta definición original
      try {
        const viewerUrl = `https://es.hentaipaw.com/viewer?articleId=${sid}&page=1`;
        const res = await fetch(viewerUrl, {
          headers: {
            "User-Agent": UA,
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            Referer: url || `https://es.hentaipaw.com/articles/${sid}`,
          },
          signal: AbortSignal.timeout(6500),
          redirect: "follow",
        });
        if (res.ok) {
          const html = await res.text();
          const re = new RegExp(`https://cdn\\.imagedeliveries\\.com/${sid}/[a-f0-9]{40}/(\\d+)\\.webp`, "gi");
          const matches = [...new Set(html.match(re) || [])];
          if (matches.length > 0) {
            matches.sort((a, b) => {
              const numA = parseInt(a.match(/\/(\d+)\.webp$/)?.[1] || "0", 10);
              const numB = parseInt(b.match(/\/(\d+)\.webp$/)?.[1] || "0", 10);
              return numA - numB;
            });
            return matches.map((u, idx) => ({
              index: idx + 1,
              image_url: u,
              referer: url || `https://es.hentaipaw.com/articles/${sid}`,
            }));
          }
        }
      } catch {}

      if (pageCount <= 0) {
        // B. Consultar la página del artículo para obtener la lista de páginas
        try {
          const articleUrl = url || `https://es.hentaipaw.com/articles/${sid}`;
          const res = await fetch(articleUrl, {
            headers: { "User-Agent": UA, Accept: "text/html,*/*" },
            signal: AbortSignal.timeout(5000),
            redirect: "follow",
          });
          if (res.ok) {
            const html = await res.text();
            const re = new RegExp(`${sid}/thumbnails/(\\d+)\\.webp`, "g");
            const matches = [...html.matchAll(re)].map((m) => parseInt(m[1], 10));
            if (matches.length > 0) {
              pageCount = Math.max(...matches);
            }
          }
        } catch {}
      }
    }
  }

  // 3. cartooncomixhd: extracción completa de todas las páginas de la carpeta UUID
  if (source === "cartooncomixhd" && (url || coverUrl)) {
    try {
      const comicUrl = url || `https://cartooncomixhd.com/${item.source_id}`;
      const res = await fetch(comicUrl, {
        headers: { "User-Agent": UA, Accept: "text/html,*/*" },
        signal: AbortSignal.timeout(6500),
        redirect: "follow",
      });
      if (res.ok) {
        const html = await res.text();
        const folderMatch = html.match(/https:\/\/image\.cartooncomixhd\.com\/\/files\/comics\/([0-9a-fA-F\-]{8,})\//);
        if (folderMatch) {
          const folderUuid = folderMatch[1];
          const pattern = new RegExp(`https://image\\.cartooncomixhd\\.com//files/comics/${folderUuid}/[^"'\\s<>\\\\]+?\\.webp`, "gi");
          const reTamano = /-\d+x\d+\.webp$/i;
          const matched: string[] = [];
          for (const u of (html.match(pattern) || [])) {
            const cleanU = u.split("?")[0];
            if (reTamano.test(cleanU)) continue;
            if (!matched.includes(cleanU)) matched.push(cleanU);
          }
          matched.sort((a, b) => {
            const numA = parseInt(a.match(/-(\d+)\.webp$/)?.[1] || "0", 10);
            const numB = parseInt(b.match(/-(\d+)\.webp$/)?.[1] || "0", 10);
            return numA - numB;
          });
          if (matched.length > 0) {
            return matched.map((u, idx) => ({
              index: idx + 1,
              image_url: u,
              referer: comicUrl,
            }));
          }
        }
      }
    } catch {}
  }

  // 4. WordPress / Blogs de cómics (melapelacomics, melapelocondibujos, vercomicporno, fotonovelasxxx, etc.)
  if (url && /^https?:\/\//i.test(url)) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "text/html,*/*" },
        signal: AbortSignal.timeout(6500),
        redirect: "follow",
      });
      if (res.ok) {
        const html = await res.text();
        const imgMatches = [...html.matchAll(/<img[^>]+(?:data-src|src)=["']([^"']+)["'][^>]*>/gi)];
        const urls: string[] = [];
        const adRegex = /(ACCESO-VIPS|HACERSE-VIP|ZONAVIP|CHAT-VIPS|portadavip|patrocinador|donar|promo|banner|logo|avatar|anuncio|unirse[-_]vip|acceso[-_]vip|hacerse[-_]vip)/i;
        for (const im of imgMatches) {
          const src = im[1].split("?")[0];
          if (!src || src.startsWith("data:") || adRegex.test(src)) continue;
          if (src.includes("/wp-content/uploads/") || /\.(webp|jpg|jpeg|png)$/i.test(src)) {
            if (!urls.includes(src)) urls.push(src);
          }
        }
        if (urls.length > 0) {
          return urls.map((u, idx) => ({ index: idx + 1, image_url: u, referer: url }));
        }
      }
    } catch {}
  }

  return [];
}

export async function GET(
  req: NextRequest,
  props: { params: Promise<{ slug?: string[] }> }
) {
  const { slug = [] } = await props.params;
  if (slug.length === 0) {
    return NextResponse.json({ error: "Parámetros no encontrados" }, { status: 400 });
  }

  const admin = createAdminClient();
  let itemData: any = null;

  // Caso 1: /api/items/id/{id} o /api/items/{id_numerico}
  if (
    (slug[0] === "id" && slug[1]) ||
    (slug.length === 1 && /^\d+$/.test(slug[0])) ||
    (slug.length === 1 && /^[vcg]-\d+$/.test(slug[0]))
  ) {
    const rawId = slug[0] === "id" ? slug[1] : slug[0].replace(/^[vcg]-/, "");
    const numId = parseInt(rawId, 10);
    if (!isNaN(numId)) {
      const { data, error } = await admin
        .from("items")
        .select("*")
        .eq("id", numId)
        .single();

      if (data && !error) {
        itemData = data;
      }
    }
  }

  // Caso 2: /api/items/{source}/{...source_id}
  if (!itemData) {
    const source = slug[0];
    const sourceId = slug.slice(1).join("/");

    const { data } = await admin
      .from("items")
      .select("*")
      .eq("source", source)
      .eq("source_id", sourceId)
      .maybeSingle();

    if (data) {
      itemData = data;
    } else if (/^\d+$/.test(sourceId)) {
      const { data: byId } = await admin
        .from("items")
        .select("*")
        .eq("id", parseInt(sourceId, 10))
        .maybeSingle();
      if (byId) itemData = byId;
    }
  }

  if (!itemData) {
    return NextResponse.json({ error: "Item no encontrado" }, { status: 404 });
  }

  // RESOLUCIÓN DINÁMICA BAJO DEMANDA (Cómics y Videos)
  let updated = false;

  if (itemData.media_type === "video") {
    // Autocorrección de PMVHaven para garantizar reproducción directa MP4 1080p nativa
    if (itemData.source === "pmvhaven") {
      const hasDirectMp4 =
        Array.isArray(itemData.video_sources) &&
        itemData.video_sources.some(
          (s: any) => s.url && s.url.endsWith(".mp4") && !s.url.includes("master.m3u8")
        );

      if (!hasDirectMp4 && itemData.source_id) {
        try {
          const pmvRes = await fetch(`https://pmvhaven.com/api/videos/${itemData.source_id}`, {
            headers: { "User-Agent": UA, Accept: "application/json" },
            signal: AbortSignal.timeout(4000),
          });
          if (pmvRes.ok) {
            const pmvJson = await pmvRes.json();
            const vidUrl = pmvJson?.data?.videoUrl;
            if (vidUrl) {
              itemData.video_sources = [
                {
                  quality: "1080p HD",
                  url: vidUrl,
                  format: "mp4",
                },
              ];
              updated = true;
            }
          }
        } catch {}
      }
    }

    if (!itemData.video_sources || itemData.video_sources.length === 0) {
      const streams = await resolveVideoSources(itemData.url);
      if (streams.length > 0) {
        itemData.video_sources = streams;
        updated = true;
      }
    }

    if (Array.isArray(itemData.video_sources) && itemData.video_sources.length > 0) {
      itemData.video_sources.sort((a: any, b: any) => {
        const aIsMp4 = (a.format === "mp4" || (a.url && a.url.includes(".mp4"))) ? 1 : 0;
        const bIsMp4 = (b.format === "mp4" || (b.url && b.url.includes(".mp4"))) ? 1 : 0;
        return bIsMp4 - aIsMp4;
      });
    }
  } else {
    const hasThumbnailsOnly =
      itemData.pages &&
      itemData.pages.length > 0 &&
      itemData.pages.some((p: any) => p.image_url && p.image_url.includes("/thumbnails/"));

    const isSinglePage = itemData.pages && itemData.pages.length <= 1;

    const isGallery = itemData.media_type === "gallery" || itemData.media_type === "cosplay";
    if (!itemData.pages || itemData.pages.length === 0 || hasThumbnailsOnly || isSinglePage) {
      const pages = isGallery ? await resolveGalleryPages(itemData) : await resolveComicPages(itemData);
      if (pages.length > 0) {
        itemData.pages = pages;
        itemData.page_count = pages.length;
        updated = true;
      }
    }
  }

  // Filtro definitivo anti-banners/anti-VIP: Ninguna página con propaganda VIP o banners pasará jamás
  if (Array.isArray(itemData.pages)) {
    const VIP_BANNER_REGEX = /(ACCESO-VIPS|HACERSE-VIP|ZONAVIP|CHAT-VIPS|portadavip|patrocinador|donar|promo|banner|logo|avatar|anuncio|unirse[-_]vip|acceso[-_]vip|hacerse[-_]vip)/i;
    const initialLen = itemData.pages.length;
    itemData.pages = itemData.pages.filter((p: any) => p && p.image_url && !VIP_BANNER_REGEX.test(p.image_url));
    itemData.pages.forEach((p: any, idx: number) => {
      p.index = idx + 1;
    });
    itemData.page_count = itemData.pages.length;
    if (itemData.pages.length !== initialLen) {
      updated = true;
    }
  }

  // Guardar en Supabase para que quede en caché ultra-rápida (1ms) en visitas futuras
  if (updated) {
    admin
      .from("items")
      .update({
        pages: itemData.pages || [],
        page_count: itemData.page_count || 0,
        video_sources: itemData.video_sources || [],
      })
      .eq("id", itemData.id)
      .then();
  }

  const hasPages = Array.isArray(itemData.pages) && itemData.pages.length > 0;
  return NextResponse.json(itemData, {
    headers: {
      "Cache-Control": hasPages
        ? "public, max-age=60, s-maxage=300, stale-while-revalidate=600"
        : "no-store, no-cache, must-revalidate",
    },
  });
}
