import { createAdminClient } from "@/lib/supabase/admin";
import { itemMatchesQuery } from "@/lib/search";
import type { Page } from "@/lib/types";

export const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

export interface ScrapedItem {
  source: string;
  source_id: string;
  url: string;
  title: string;
  cover_url: string;
  media_type?: string;
  language?: string;
  tags?: string[];
  artists?: string[];
  page_count?: number;
  pages?: Page[];
  status?: string;
}

const WP_SITES: Record<string, string> = {
  comicsparaadultos: "https://comicsparaadultos.com",
  fotonovelasxxx: "https://fotonovelasxxx.com",
  melapelocondibujos: "https://melapelocondibujos.com",
  melapelacomics: "https://melapelacomics.com",
  comicspornoxxx: "https://comicspornoxxx.com",
};

/**
 * Busca cómics en vivo consultando los sitios web directamente.
 * Filtra estrictamente para que SOLO se devuelvan cómics que coincidan con la búsqueda.
 */
export async function searchLive(query: string): Promise<any[]> {
  const q = query.trim();
  if (!q) return [];

  const tasks: Promise<ScrapedItem[]>[] = [
    search3Hentai(q),
    searchWordPress("comicsparaadultos", WP_SITES.comicsparaadultos, q),
    searchWordPress("fotonovelasxxx", WP_SITES.fotonovelasxxx, q),
    searchWordPress("melapelocondibujos", WP_SITES.melapelocondibujos, q),
    searchWordPress("melapelacomics", WP_SITES.melapelacomics, q),
    searchWordPress("comicspornoxxx", WP_SITES.comicspornoxxx, q),
    searchCartoonComix(q),
    searchPornoComic(q),
    searchComics18("comics18_net", "https://comics18.net", q),
    searchComics18("comics18_org", "https://comics18.org", q),
    searchVerComicsPorno(q),
  ];

  const results = await Promise.allSettled(tasks);
  const items: ScrapedItem[] = [];

  for (const r of results) {
    if (r.status === "fulfilled" && Array.isArray(r.value)) {
      items.push(...r.value);
    }
  }

  // Filtrar estrictamente: SOLO ítems donde el título o tags coincidan con la búsqueda
  const strictlyMatching = items.filter((it) => itemMatchesQuery(it, q));

  // Guardar en Supabase para que queden persistidos con ID asignado
  if (strictlyMatching.length > 0) {
    try {
      const saved = await saveScrapedItems(strictlyMatching);
      return saved.filter((it) => itemMatchesQuery(it, q));
    } catch (err) {
      console.error("[live-scraper] Error guardando búsqueda en BD:", err);
    }
  }

  return strictlyMatching;
}

/**
 * Extrae cómics de 3hentai
 */
async function search3Hentai(q: string): Promise<ScrapedItem[]> {
  const url = `https://3hentai.net/search?q=${encodeURIComponent(q)}`;
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "text/html" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return [];
  const html = await res.text();

  const items: ScrapedItem[] = [];
  const regex =
    /<a href="(https:\/\/3hentai\.net\/d\/(\d+))" class="cover">[\s\S]*?<img[^>]+(?:data-src|src)="([^"]+)"[\s\S]*?<div class="title">([^<]+)<\/div>/gi;

  for (const m of html.matchAll(regex)) {
    const comicUrl = m[1];
    const sid = m[2];
    const cover = m[3];
    const title = cleanText(m[4]);
    if (title && sid) {
      items.push({
        source: "3hentai",
        source_id: sid,
        url: comicUrl,
        title,
        cover_url: cover,
        language: "es",
        tags: ["doujinshi", "manga"],
      });
    }
  }
  return items.slice(0, 10);
}

/**
 * Extrae cómics de sitios WordPress vía REST API
 */
async function searchWordPress(source: string, baseUrl: string, q: string): Promise<ScrapedItem[]> {
  const url = `${baseUrl}/wp-json/wp/v2/posts?search=${encodeURIComponent(q)}&per_page=8&_embed=1`;
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return [];
  const posts = (await res.json()) as any[];
  if (!Array.isArray(posts)) return [];

  const items: ScrapedItem[] = [];
  for (const p of posts) {
    const rawTitle = p.title?.rendered || "";
    const title = cleanText(rawTitle);
    const link = p.link || "";
    const sid = String(p.id || p.slug);
    let cover = "";

    // Intentar extraer portada del thumbnail embedido o del contenido
    const feat = p._embedded?.["wp:featuredmedia"]?.[0]?.source_url;
    if (feat) {
      cover = feat;
    } else {
      const match = (p.content?.rendered || "").match(/<img[^>]+src="([^"]+)"/i);
      if (match) cover = match[1];
    }

    if (title && link) {
      items.push({
        source,
        source_id: sid,
        url: link,
        title,
        cover_url: cover,
        language: "es",
        tags: ["comic"],
      });
    }
  }
  return items;
}

/**
 * Extrae cómics de CartoonComixHD
 */
async function searchCartoonComix(q: string): Promise<ScrapedItem[]> {
  const url = `https://cartooncomixhd.com/busqueda?filter=${encodeURIComponent(q)}`;
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "text/html" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return [];
  const html = await res.text();

  const items: ScrapedItem[] = [];
  const regex =
    /<a[^>]+href="(\/([^"'\s>]+))"[^>]*>[\s\S]*?<img[^>]+(?:data-src|src)="([^"]+)"[\s\S]*?<h\d[^>]*>([\s\S]*?)<\/h\d>/gi;
  for (const m of html.matchAll(regex)) {
    const slug = m[2];
    if (slug.includes("busqueda") || slug.includes("mas-vistos") || slug.includes("categoria") || slug.includes("favicon"))
      continue;
    let cover = m[3];
    if (cover.includes("_next/image?url=")) {
      const match = cover.match(/url=([^&]+)/);
      if (match) cover = decodeURIComponent(match[1]);
    }
    const title = cleanText(m[4].replace(/<[^>]+>/g, ""));
    if (title && slug) {
      items.push({
        source: "cartooncomixhd",
        source_id: slug,
        url: `https://cartooncomixhd.com/${slug}`,
        title,
        cover_url: cover,
        language: "es",
        tags: ["cartoon"],
      });
    }
  }
  return items.slice(0, 15);
}

/**
 * Extrae cómics de PornoComic
 */
async function searchPornoComic(q: string): Promise<ScrapedItem[]> {
  const url = `https://pornocomic.org/?s=${encodeURIComponent(q)}`;
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "text/html" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return [];
  const html = await res.text();

  const items: ScrapedItem[] = [];
  const map = new Map<string, { url: string; source_id: string; cover_url: string; title: string }>();

  const regex = /<a[^>]+href="(https:\/\/pornocomic\.org\/([a-z0-9\-]+)\/)"[^>]*>([\s\S]*?)<\/a>/gi;
  for (const m of html.matchAll(regex)) {
    const link = m[1];
    const slug = m[2];
    if (slug === "category" || slug === "tag" || slug === "page" || slug === "post-sitemap") continue;

    if (!map.has(slug)) {
      map.set(slug, { url: link, source_id: slug, cover_url: "", title: "" });
    }
    const entry = map.get(slug)!;
    const imgMatch = m[3].match(/<img[^>]+(?:data-src|src)="([^"]+)"/i);
    if (imgMatch && !entry.cover_url) {
      entry.cover_url = imgMatch[1].replace(/-\d+x\d+(?=\.(?:jpe?g|png|webp))/i, "");
    }
    const txt = cleanText(m[3].replace(/<[^>]+>/g, ""));
    if (txt && !entry.title) {
      entry.title = txt;
    }
  }

  for (const v of map.values()) {
    if (v.title && v.cover_url) {
      items.push({
        source: "pornocomic",
        source_id: v.source_id,
        url: v.url,
        title: v.title,
        cover_url: v.cover_url,
        language: "es",
        tags: ["comic"],
      });
    }
  }
  return items.slice(0, 15);
}

/**
 * Extrae cómics de Comics18
 */
async function searchComics18(source: string, baseUrl: string, q: string): Promise<ScrapedItem[]> {
  const url = `${baseUrl}/?s=${encodeURIComponent(q)}`;
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "text/html" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return [];
  const html = await res.text();

  const items: ScrapedItem[] = [];
  const regex =
    /<article[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[\s\S]*?<img[^>]+(?:data-src|src)="([^"]+)"[\s\S]*?<p[^>]*class="entry-title"[^>]*>([\s\S]*?)<\/p>/gi;

  for (const m of html.matchAll(regex)) {
    const link = m[1];
    const cover = m[2];
    const title = cleanText(m[3].replace(/<[^>]+>/g, ""));
    const slug = link.replace(/\/+$/, "").split("/").pop() || "";
    if (title && slug) {
      items.push({
        source,
        source_id: slug,
        url: link,
        title,
        cover_url: cover,
        language: "es",
        tags: ["manga", "comic"],
      });
    }
  }
  return items.slice(0, 15);
}

/**
 * Extrae cómics de VerComicsPorno
 */
async function searchVerComicsPorno(q: string): Promise<ScrapedItem[]> {
  const url = `https://vercomicsporno.xxx/?s=${encodeURIComponent(q)}`;
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "text/html" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return [];
  const html = await res.text();

  const items: ScrapedItem[] = [];
  const map = new Map<string, { url: string; source_id: string; cover_url: string; title: string }>();

  const regex = /<a[^>]+href="(https:\/\/vercomicsporno\.xxx\/([a-z0-9\-]+)\/)"[^>]*>([\s\S]*?)<\/a>/gi;
  for (const m of html.matchAll(regex)) {
    const link = m[1];
    const slug = m[2];
    if (slug === "category" || slug === "tag" || slug === "page") continue;

    if (!map.has(slug)) {
      map.set(slug, { url: link, source_id: slug, cover_url: "", title: "" });
    }
    const entry = map.get(slug)!;
    const imgMatch = m[3].match(/<img[^>]+(?:data-src|src)="([^"]+)"/i);
    if (imgMatch && !entry.cover_url) {
      entry.cover_url = imgMatch[1].replace(/-\d+x\d+(?=\.(?:jpe?g|png|webp))/i, "");
    }
    const txt = cleanText(m[3].replace(/<[^>]+>/g, ""));
    if (txt && !entry.title) {
      entry.title = txt;
    }
  }

  for (const v of map.values()) {
    if (v.title && v.cover_url) {
      items.push({
        source: "vercomicsporno",
        source_id: v.source_id,
        url: v.url,
        title: v.title,
        cover_url: v.cover_url,
        language: "es",
        tags: ["comic"],
      });
    }
  }
  return items.slice(0, 15);
}

/**
 * Scrapea los detalles y páginas de un cómic si no los tiene guardados.
 */
export async function scrapeItemPages(
  source: string,
  url: string,
  sourceId: string
): Promise<Page[]> {
  if (!url) return [];
  const pages: Page[] = [];

  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html" },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return [];
    const html = await res.text();

    if (source === "3hentai") {
      const thumbRegex = new RegExp(
        `<a[^>]*href="https:\\/\\/3hentai\\.net\\/d\\/${sourceId}\\/(\\d+)"[^>]*>[\\s\\S]*?<img[^>]*data-src="([^"]+)"`,
        "g"
      );
      for (const m of html.matchAll(thumbRegex)) {
        const idx = parseInt(m[1]);
        const thumbUrl = m[2];
        const fullUrl = thumbUrl
          .replace(/t\.(jpg|png|webp)/i, ".$1")
          .replace(/thumb\.(jpg|png|webp)/i, "1.$1");
        pages.push({ index: idx, image_url: fullUrl, referer: url });
      }
      pages.sort((a, b) => a.index - b.index);
    } else if (source === "cartooncomixhd") {
      const regex =
        /https:\/\/image\.cartooncomixhd\.com\/+files\/comics\/[0-9a-fA-F\-]{8,}\/[^"'\s<>\\]+?\.(?:webp|jpg|jpeg|png)/gi;
      let idx = 1;
      const seen = new Set<string>();
      for (const m of html.matchAll(regex)) {
        if (!seen.has(m[0])) {
          seen.add(m[0]);
          pages.push({ index: idx++, image_url: m[0], referer: url });
        }
      }
    } else {
      // Extractor universal de páginas para WordPress y lectores HTML
      const imgRegex = /<img[^>]+(?:data-src|data-lazy-src|data-original|src)="([^"]+)"[^>]*>/gi;
      let idx = 1;
      const seen = new Set<string>();
      for (const m of html.matchAll(imgRegex)) {
        const src = m[1];
        const low = src.toLowerCase();
        if (
          (low.includes(".jpg") || low.includes(".jpeg") || low.includes(".png") || low.includes(".webp")) &&
          !low.includes("avatar") &&
          !low.includes("logo") &&
          !low.includes("banner") &&
          !low.includes("icon") &&
          !low.includes("emoji") &&
          !low.includes("-150x") &&
          !low.includes("-100x") &&
          !low.includes("pixel.wp.com") &&
          !low.includes("gravatar")
        ) {
          const cleanSrc = src.replace(/-\d+x\d+(?=\.(?:jpe?g|png|webp))/i, "");
          if (!seen.has(cleanSrc)) {
            seen.add(cleanSrc);
            pages.push({ index: idx++, image_url: cleanSrc, referer: url });
          }
        }
      }
    }
  } catch (err) {
    console.error(`[live-scraper] Error extrayendo páginas para ${source}:${url}:`, err);
  }

  return pages;
}

/**
 * Scrapea los 20 cómics más recientes de 4 fuentes principales (80 cómics en total)
 * y los guarda en la base de datos Supabase.
 * Así se mantiene el pool permanentemente lleno y actualizado, y cada recarga
 * del usuario puede elegir 20 al azar sin tener que re-scrapear constantemente.
 */
export async function replenishPoolFrom4Sites(): Promise<{ count: number; sources: string[] }> {
  const sites = [
    { id: "comicsparaadultos", fn: () => fetchLatestWP("comicsparaadultos", WP_SITES.comicsparaadultos, 20) },
    { id: "fotonovelasxxx", fn: () => fetchLatestWP("fotonovelasxxx", WP_SITES.fotonovelasxxx, 20) },
    { id: "melapelacomics", fn: () => fetchLatestWP("melapelacomics", WP_SITES.melapelacomics, 20) },
    { id: "melapelocondibujos", fn: () => fetchLatestWP("melapelocondibujos", WP_SITES.melapelocondibujos, 20) },
  ];

  const results = await Promise.allSettled(sites.map((s) => s.fn()));
  const collected: ScrapedItem[] = [];

  for (const r of results) {
    if (r.status === "fulfilled" && Array.isArray(r.value)) {
      collected.push(...r.value);
    }
  }

  if (collected.length > 0) {
    try {
      await saveScrapedItems(collected);
    } catch (e) {
      console.error("[live-scraper] Error al guardar novedades en el pool:", e);
    }
  }

  return {
    count: collected.length,
    sources: sites.map((s) => s.id),
  };
}

async function fetchLatestWP(source: string, baseUrl: string, perPage = 20): Promise<ScrapedItem[]> {
  const url = `${baseUrl}/wp-json/wp/v2/posts?per_page=${perPage}&_embed=1`;
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(9000),
  });
  if (!res.ok) return [];
  const posts = (await res.json()) as any[];
  if (!Array.isArray(posts)) return [];

  const items: ScrapedItem[] = [];
  for (const p of posts) {
    const rawTitle = p.title?.rendered || "";
    const title = cleanText(rawTitle);
    const link = p.link || "";
    const sid = String(p.id || p.slug);
    let cover = "";

    const feat = p._embedded?.["wp:featuredmedia"]?.[0]?.source_url;
    if (feat) {
      cover = feat;
    } else {
      const match = (p.content?.rendered || "").match(/<img[^>]+src="([^"]+)"/i);
      if (match) cover = match[1];
    }

    if (title && link) {
      items.push({
        source,
        source_id: sid,
        url: link,
        title,
        cover_url: cover,
        language: "es",
        tags: ["comic"],
      });
    }
  }
  return items;
}

let lastPoolReplenish = 0;

/**
 * Obtiene 20 cómics al azar del pool persistido en Supabase.
 * En cada recarga o visita, el usuario ve 20 cómics completamente diferentes.
 * Si han pasado más de 25 minutos, dispara la recolección de las 4 fuentes en segundo plano.
 */
export async function getRandom20FromPool(supabase: any) {
  // Disparar recolección en segundo plano si han pasado más de 25 minutos
  const now = Date.now();
  if (now - lastPoolReplenish > 25 * 60 * 1000) {
    lastPoolReplenish = now;
    replenishPoolFrom4Sites().catch((e) =>
      console.error("[live-scraper] Fallo en background replenishment:", e)
    );
  }

  // Obtener IDs de la base de datos
  const { data: idRows, error: idErr } = await supabase.from("items").select("id");
  if (idErr || !idRows || idRows.length === 0) {
    // Si no hay ítems, intentar recargar directamente
    await replenishPoolFrom4Sites();
    const { data: retryRows } = await supabase.from("items").select("id");
    if (!retryRows || retryRows.length === 0) return [];
    const retryShuffled = retryRows.sort(() => 0.5 - Math.random());
    const retryIds = retryShuffled.slice(0, 20).map((r: { id: number }) => r.id);
    const { data: retryItems } = await supabase
      .from("catalog")
      .select("id,source_label,media_type,title,language,tags,artists,page_count,has_cover,search_text,scraped_at")
      .in("id", retryIds);
    return (retryItems ?? []).sort(() => 0.5 - Math.random());
  }

  // Barajar y elegir 20 IDs al azar
  const shuffled = idRows.sort(() => 0.5 - Math.random());
  const selectedIds = shuffled.slice(0, 20).map((r: { id: number }) => r.id);

  // Consultar esos 20 cómics completos de la vista catalog
  const { data: items, error: itemErr } = await supabase
    .from("catalog")
    .select("id,source_label,media_type,title,language,tags,artists,page_count,has_cover,search_text,scraped_at")
    .in("id", selectedIds);

  if (itemErr || !items) {
    return [];
  }

  return items.sort(() => 0.5 - Math.random());
}

/**
 * Scrapea 15 cómics aleatorios rotando entre 2 fuentes para el cron cada 10 minutos.
 */
export async function scrapeRandom15(): Promise<{ count: number; sources: string[] }> {
  const sourcesPool = [
    { id: "3hentai", fn: () => fetchRandom3Hentai() },
    { id: "comicsparaadultos", fn: () => fetchRandomWP("comicsparaadultos", WP_SITES.comicsparaadultos) },
    { id: "fotonovelasxxx", fn: () => fetchRandomWP("fotonovelasxxx", WP_SITES.fotonovelasxxx) },
    { id: "melapelocondibujos", fn: () => fetchRandomWP("melapelocondibujos", WP_SITES.melapelocondibujos) },
    { id: "cartooncomixhd", fn: () => fetchRandomCartoonComix() },
    { id: "pornocomic", fn: () => fetchRandomPornoComic() },
  ];

  // Elegir 2 fuentes aleatorias
  const shuffled = sourcesPool.sort(() => 0.5 - Math.random());
  const selected = shuffled.slice(0, 2);

  const collected: ScrapedItem[] = [];
  for (const s of selected) {
    try {
      const items = await s.fn();
      collected.push(...items.slice(0, 8)); // ~8 por fuente = 15-16 cómics
    } catch (e) {
      console.error(`[live-scraper] Falló scraping aleatorio de ${s.id}:`, e);
    }
  }

  if (collected.length > 0) {
    await saveScrapedItems(collected);
  }

  return {
    count: collected.length,
    sources: selected.map((s) => s.id),
  };
}

async function fetchRandom3Hentai(): Promise<ScrapedItem[]> {
  const page = Math.floor(Math.random() * 50) + 1;
  const url = `https://3hentai.net/language/spanish/${page}`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) return [];
  const html = await res.text();
  const items: ScrapedItem[] = [];
  const regex =
    /<a href="(https:\/\/3hentai\.net\/d\/(\d+))" class="cover">[\s\S]*?<img[^>]+(?:data-src|src)="([^"]+)"[\s\S]*?<div class="title">([^<]+)<\/div>/gi;

  for (const m of html.matchAll(regex)) {
    const title = cleanText(m[4]);
    if (title) {
      items.push({
        source: "3hentai",
        source_id: m[2],
        url: m[1],
        title,
        cover_url: m[3],
        language: "es",
        tags: ["doujinshi", "manga"],
      });
    }
  }
  return items;
}

async function fetchRandomWP(source: string, baseUrl: string): Promise<ScrapedItem[]> {
  const page = Math.floor(Math.random() * 20) + 1;
  const url = `${baseUrl}/wp-json/wp/v2/posts?page=${page}&per_page=8&_embed=1`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) return [];
  const posts = (await res.json()) as any[];
  if (!Array.isArray(posts)) return [];

  const items: ScrapedItem[] = [];
  for (const p of posts) {
    const title = cleanText(p.title?.rendered || "");
    const link = p.link || "";
    const sid = String(p.id || p.slug);
    let cover = p._embedded?.["wp:featuredmedia"]?.[0]?.source_url || "";
    if (!cover) {
      const match = (p.content?.rendered || "").match(/<img[^>]+src="([^"]+)"/i);
      if (match) cover = match[1];
    }
    if (title && link) {
      items.push({
        source,
        source_id: sid,
        url: link,
        title,
        cover_url: cover,
        language: "es",
        tags: ["comic"],
      });
    }
  }
  return items;
}

async function fetchRandomCartoonComix(): Promise<ScrapedItem[]> {
  const page = Math.floor(Math.random() * 10) + 1;
  const url = `https://cartooncomixhd.com/?page=${page}`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) return [];
  const html = await res.text();
  const items: ScrapedItem[] = [];
  const regex =
    /<a[^>]+href="(\/comic\/([^"]+))"[^>]*>[\s\S]*?<img[^>]+(?:data-src|src)="([^"]+)"[\s\S]*?<h2[^>]*>([^<]+)<\/h2>/gi;
  for (const m of html.matchAll(regex)) {
    const title = cleanText(m[4]);
    if (title) {
      items.push({
        source: "cartooncomixhd",
        source_id: m[2],
        url: `https://cartooncomixhd.com${m[1]}`,
        title,
        cover_url: m[3],
        language: "es",
        tags: ["cartoon"],
      });
    }
  }
  return items;
}

async function fetchRandomPornoComic(): Promise<ScrapedItem[]> {
  const page = Math.floor(Math.random() * 15) + 1;
  const url = `https://pornocomic.org/page/${page}/`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) return [];
  const html = await res.text();
  const items: ScrapedItem[] = [];
  const regex =
    /<article[^>]*>[\s\S]*?<a href="([^"]+)"[^>]*>[\s\S]*?<img[^>]+(?:data-src|src)="([^"]+)"[\s\S]*?<h2[^>]*class="entry-title"[^>]*><a[^>]*>([^<]+)<\/a><\/h2>/gi;
  for (const m of html.matchAll(regex)) {
    const link = m[1];
    const title = cleanText(m[3]);
    const slug = link.replace(/\/+$/, "").split("/").pop() || "";
    if (title && slug) {
      items.push({
        source: "pornocomic",
        source_id: slug,
        url: link,
        title,
        cover_url: m[2],
        language: "es",
        tags: ["comic"],
      });
    }
  }
  return items;
}

/**
 * Guarda los ítems en Supabase con status='verified'
 */
export async function saveScrapedItems(items: ScrapedItem[]): Promise<any[]> {
  if (items.length === 0) return [];
  const admin = createAdminClient();

  const rows = items.map((it) => ({
    source: it.source,
    source_id: it.source_id,
    url: it.url,
    title: it.title,
    cover_url: it.cover_url || "",
    language: it.language || "es",
    media_type: it.media_type || "comic",
    tags: it.tags || [],
    artists: it.artists || [],
    page_count: it.page_count || it.pages?.length || 0,
    pages: it.pages || [],
    status: "verified",
    real_people: false,
  }));

  const { data, error } = await admin
    .from("items")
    .upsert(rows, { onConflict: "source,source_id", ignoreDuplicates: false })
    .select("id,source,source_id,title,cover_url,page_count,tags,media_type");

  if (error) {
    console.error("[live-scraper] Error upserting to Supabase:", error);
    return [];
  }

  return (data ?? []).map((row) => ({
    id: row.id,
    source_label: row.source,
    media_type: row.media_type || "comic",
    title: row.title,
    tags: row.tags || [],
    page_count: row.page_count || 0,
    has_cover: !!row.cover_url,
    cover_url: row.cover_url,
  }));
}

function cleanText(txt: string): string {
  if (!txt) return "";
  return txt
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(dec))
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#039;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}
