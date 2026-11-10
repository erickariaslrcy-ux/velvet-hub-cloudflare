import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { likeTerm } from "@/lib/search";

export const runtime = "nodejs";

// In-memory cache for fast count lookups (TTL 3 minutes)
const countCache = new Map<string, { total: number; totalPages: number; timestamp: number }>();
const CACHE_TTL_MS = 3 * 60 * 1000;

const SELECT_FIELDS = "id,source,source_id,title,cover_url,media_type,tags,page_count,video_sources,url,artists";

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const mediaType = sp.get("media_type") || "comic";
  const isVideo = mediaType === "video";
  const isGallery = mediaType === "gallery" || mediaType === "cosplay";
  const q = (sp.get("q") || "").trim();
  const page = Math.max(1, parseInt(sp.get("page") || "1", 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(sp.get("page_size") || "24", 10) || 24));
  const sort = sp.get("sort") || "recent";
  const tag = sp.get("tag") || "";
  const category = (sp.get("category") || "").trim().toLowerCase();
  const seedParam = parseInt(sp.get("seed") || "0", 10);

  const cacheKey = `${mediaType}_${category}_${tag}_${q ? q.toLowerCase() : ""}`;
  const cachedCount = countCache.get(cacheKey);
  const now = Date.now();
  const hasValidCachedCount = cachedCount && now - cachedCount.timestamp < CACHE_TTL_MS;

  const admin = createAdminClient();

  // Use estimated count only when searching with q or filtering by category/tag to avoid slow sequential scans
  const needsCount = !hasValidCachedCount && (q || (category && category !== "all") || tag);
  let query = admin
    .from("items")
    .select(SELECT_FIELDS, needsCount ? { count: "estimated" } : {});

  // 1. Separación estricta entre Cómics, Videos y Galerías/Cosplay
  if (isVideo) {
    if (category && category !== "all" && seedParam > 0 && !q) {
      const catOffset = Math.floor(((seedParam * 1337) % 1000) / 1000 * 80000);
      const targetCatId = Math.max(42110, 304214 - catOffset);
      query = query.eq("media_type", "video").lte("id", targetCatId);
    } else {
      query = query.eq("media_type", "video").lte("id", 304214);
    }
  } else if (isGallery) {
    query = query.eq("media_type", "gallery").gte("id", 370000);
    if (!q.toLowerCase().includes("leak") && category !== "leak" && category !== "patreon") {
      query = query.neq("source", "leakgallery");
    }
  } else {
    query = query.in("media_type", ["comic", "manga_chapter"]);
  }

  // 2. Filtro de Categoría por sub-género
  if (category && category !== "all") {
    if (isGallery) {
      if (category === "cosplay") {
        query = query.or("search_text.ilike.%cosplay%,tags.cs.{Cosplay},tags.cs.{cosplay}");
      } else if (category === "artgravia") {
        query = query.or("search_text.ilike.%artgravia%,search_text.ilike.%djawa%,tags.cs.{ArtGravia},tags.cs.{DJAWA}");
      } else if (category === "korean") {
        query = query.or("search_text.ilike.%korean%,search_text.ilike.%korea%,search_text.ilike.%kang in-kyung%,tags.cs.{Korean}");
      } else if (category === "asian" || category === "xiuren") {
        query = query.or("search_text.ilike.%xiuren%,search_text.ilike.%chinese%,search_text.ilike.%mfstar%,search_text.ilike.%asian%");
      } else if (category === "lingerie" || category === "bikini") {
        query = query.or("search_text.ilike.%lingerie%,search_text.ilike.%bikini%,search_text.ilike.%swimsuit%");
      } else if (category === "patreon") {
        query = query.or("search_text.ilike.%patreon%,search_text.ilike.%fansly%,search_text.ilike.%gumroad%");
      } else {
        query = query.ilike("search_text", likeTerm(category));
      }
    } else if (!isVideo) {
      if (category === "manhwa") {
        query = query.or("media_type.eq.manga_chapter,tags.cs.{Manhwa},tags.cs.{Webtoon},tags.cs.{Coreano}");
      } else if (category === "3d") {
        query = query.or("tags.cs.{3D},tags.cs.{3D CGI},tags.cs.{CGI},tags.cs.{Western Comic}");
      } else if (category === "doujin") {
        query = query.or("tags.cs.{Doujinshi},tags.cs.{Manga},tags.cs.{Hentai}");
      } else if (category === "parody" || category === "toon") {
        query = query.or("tags.cs.{Parodia},tags.cs.{Parody},tags.cs.{Cartoon}");
      } else if (category === "western") {
        query = query.or("tags.cs.{Western Comic},tags.cs.{Full Color},tags.cs.{Español}");
      } else {
        query = query.contains("tags", [category]);
      }
    } else {
      if (category === "pmv") {
        query = query.or("search_text.ilike.%pmv%,search_text.ilike.%edit%,search_text.ilike.%music%,search_text.ilike.%amv%");
      } else if (category === "milf") {
        query = query.or("search_text.ilike.%milf%,search_text.ilike.%mature%,search_text.ilike.%mom%,search_text.ilike.%madura%");
      } else if (category === "amateur") {
        query = query.or("search_text.ilike.%amateur%,search_text.ilike.%casero%,search_text.ilike.%homemade%,search_text.ilike.%real%");
      } else if (category === "anal") {
        query = query.or("search_text.ilike.%anal%,search_text.ilike.%dp%,search_text.ilike.%double%");
      } else if (category === "pov") {
        query = query.or("search_text.ilike.%pov%,search_text.ilike.%point of view%");
      } else if (category === "group") {
        query = query.or("search_text.ilike.%trio%,search_text.ilike.%threesome%,search_text.ilike.%group%,search_text.ilike.%orgy%,search_text.ilike.%gangbang%");
      } else if (category === "tits") {
        query = query.or("search_text.ilike.%tit%,search_text.ilike.%boob%,search_text.ilike.%busty%,search_text.ilike.%melon%");
      } else if (category === "blondes") {
        query = query.or("search_text.ilike.%blonde%,search_text.ilike.%rubia%");
      } else if (category === "brunettes") {
        query = query.or("search_text.ilike.%brunette%,search_text.ilike.%latina%,search_text.ilike.%morena%");
      } else if (category === "russians") {
        query = query.or("search_text.ilike.%russian%,search_text.ilike.%rusa%,search_text.ilike.%european%");
      } else if (category === "hd") {
        query = query.or("search_text.ilike.%1080p%,search_text.ilike.%hd%,search_text.ilike.%4k%");
      } else {
        query = query.ilike("search_text", likeTerm(category));
      }
    }
  }

  // 3. Búsqueda por texto (anti inyección y normalizado)
  if (q) {
    for (const word of q.split(/\s+/).filter(Boolean).slice(0, 4)) {
      query = query.ilike("search_text", likeTerm(word));
    }
  }

  // 4. Filtro por etiqueta
  if (tag) {
    query = query.contains("tags", [tag]);
  }

  // 5. Ordenamiento ultra-rápido indexado por ID
  if (sort === "title") {
    query = query.order("title", { ascending: true });
  } else if (sort === "pages") {
    query = query.order("page_count", { ascending: false });
  } else {
    query = query.order("id", { ascending: false });
  }

  let data: any[] | null = null;
  let count: number | null = null;
  let total = hasValidCachedCount ? cachedCount.total : 0;
  let totalPages = hasValidCachedCount ? cachedCount.totalPages : 1;

  // Algoritmo de Variedad Multi-Banda para Videos (Feed Dinámico, Diverso y No Monótono)
  // Mezcla en paralelo múltiples bandas de fuentes (PMVHaven, RedPorn, AnyPorn, PornOne, AlotPorn, PornHD)
  // asegurando que cada visita muestre contenido fresco y variado a lo largo de los 116,000+ videos.
  const isVideoVaried = isVideo && !q && (!category || category === "all") && !tag && (sort === "recent" || sort === "discover" || sort === "random");

  if (isVideoVaried) {
    try {
      const seedNum = seedParam || 42;
      const VIDEO_BANDS = [
        { minId: 260000, maxId: 304214 }, // PMVHaven & recientes
        { minId: 200000, maxId: 260000 }, // RedPorn & AnyPorn High
        { minId: 130000, maxId: 200000 }, // PornOne & RedPorn Mid
        { minId: 42110,  maxId: 130000 }  // AlotPorn, PornHD, DampLips
      ];

      const perBand = Math.ceil(pageSize / VIDEO_BANDS.length);
      const bandPromises = VIDEO_BANDS.map((band, idx) => {
        const span = band.maxId - band.minId;
        const pseudoRand = ((seedNum * 179 + idx * 7919) % 1000) / 1000;
        const baseOffset = Math.floor(pseudoRand * (span * 0.7));
        const pageAdvance = (page - 1) * perBand * 8;
        let targetMaxId = band.maxId - baseOffset - pageAdvance;
        if (targetMaxId < band.minId + perBand * 2) {
          targetMaxId = band.maxId - ((band.minId + perBand * 2 - targetMaxId) % span);
        }

        return admin
          .from("items")
          .select(SELECT_FIELDS)
          .eq("media_type", "video")
          .lte("id", targetMaxId)
          .order("id", { ascending: false })
          .limit(perBand);
      });

      const results = await Promise.all(bandPromises);
      const interleaved: any[] = [];
      const seen = new Set<number>();

      for (let i = 0; i < perBand; i++) {
        for (let b = 0; b < results.length; b++) {
          const rows = results[b].data || [];
          if (i < rows.length && !seen.has(rows[i].id)) {
            seen.add(rows[i].id);
            interleaved.push(rows[i]);
          }
        }
      }

      if (interleaved.length > 0) {
        data = interleaved.slice(0, pageSize);
        total = 166086;
        totalPages = Math.ceil(total / pageSize);
      }
    } catch (err) {
      console.warn("[ITEMS API] Error en video varied interleaving:", err);
    }
  }

  // Algoritmo de Variedad para Cosplay / Galerías (Seed-Based Page-Window Pagination)
  // Genera un punto de inicio aleatorio por sesión/seed pero pagina limpiamente con OFFSET,
  // garantizando contenido fresco y variado en cada visita o mezcla SIN DUPLICADOS entre páginas.
  const isGalleryVaried = isGallery && !q && (!category || category === "all") && !tag && (sort === "recent" || sort === "discover" || sort === "random");

  if (isGalleryVaried && !data) {
    const seedNum = seedParam || Math.floor(Math.random() * 900000) + 100000;
    // 250 ventanas de páginas diferentes (~6,000 sets de cosplay variados)
    const basePage = (seedNum * 7919) % 250;
    const effectivePage = basePage + page;
    const from = (effectivePage - 1) * pageSize;
    const to = from + pageSize - 1;

    try {
      let galQuery = admin
        .from("items")
        .select(SELECT_FIELDS)
        .eq("media_type", "gallery")
        .gte("id", 370000)
        .order("id", { ascending: false });

      // Probabilidad ultra-baja de 0.05 (5%) de mostrar a lo sumo 1 post de leakgallery por página
      const allowOneLeak = ((seedNum * 17 + page * 31) % 100) < 5;
      if (!allowOneLeak) {
        galQuery = galQuery.neq("source", "leakgallery");
      }

      const galRes = await galQuery.range(from, to);

      if (!galRes.error && galRes.data && galRes.data.length > 0) {
        let finalGalData = galRes.data;
        if (allowOneLeak) {
          let leakCount = 0;
          finalGalData = finalGalData.filter((it: any) => {
            if (it.source === "leakgallery") {
              leakCount++;
              return leakCount <= 1; // Máximo 1 por página con 5% de probabilidad
            }
            return true;
          });
        }

        data = finalGalData;
        total = 14001;
        totalPages = Math.ceil(total / pageSize);
      }
    } catch (err) {
      console.warn("[ITEMS API] Error en gallery seeded window pagination:", err);
    }
  }

  // Algoritmo de Variedad para Cómics y Mangas (Seed-Based Page-Window Pagination)
  // Genera un punto de inicio aleatorio por sesión/seed pero pagina limpiamente con OFFSET,
  // garantizando contenido fresco y variado en cada visita o mezcla SIN DUPLICADOS entre páginas.
  const isComicVaried = !isVideo && !isGallery && !q && (!category || category === "all") && !tag && (sort === "recent" || sort === "discover" || sort === "random");

  if (isComicVaried && !data) {
    const seedNum = seedParam || 42;
    // Hasta 600 ventanas de páginas diferentes (~14,400 cómics variados de la base de datos)
    const basePage = (seedNum * 1337) % 600;
    const effectivePage = basePage + page;
    const from = (effectivePage - 1) * pageSize;
    const to = from + pageSize - 1;

    try {
      const comicRes = await admin
        .from("items")
        .select(SELECT_FIELDS)
        .in("media_type", ["comic", "manga_chapter"])
        .order("id", { ascending: false })
        .range(from, to);

      if (!comicRes.error && comicRes.data && comicRes.data.length > 0) {
        data = comicRes.data;
        total = 105490;
        totalPages = Math.ceil(total / pageSize);
      }
    } catch (err) {
      console.warn("[ITEMS API] Error en comic seeded window pagination:", err);
    }
  }

  // Optimización Keyset / Index Seek para saltos de página profundos (evita timeouts por escanear 130,000+ filas con OFFSET)
  const isDeepSeek = !data && page > 50 && !q && (!category || category === "all") && !tag && sort === "recent";

  if (isDeepSeek) {
    const isVid = isVideo;
    const isGal = isGallery;
    const totalEstimated = isVid ? 166086 : (isGal ? 14001 : 105490);
    const totalP = Math.ceil(totalEstimated / pageSize);
    const fraction = Math.min(0.999, Math.max(0, (page - 1) / totalP));
    let targetMaxId = isVid
      ? Math.round(304214 - fraction * (304214 - 1869))
      : (isGal
          ? Math.round(393914 - fraction * (393914 - 374461))
          : Math.round(374460 - fraction * 374460));

    // Ajuste de gap para videos (IDs 16758 a 42109 corresponden a cómics)
    if (isVid && targetMaxId <= 42109 && targetMaxId >= 16758) {
      targetMaxId = 16758;
    }

    let seekQuery = admin
      .from("items")
      .select(SELECT_FIELDS)
      .lte("id", targetMaxId)
      .order("id", { ascending: false })
      .limit(pageSize);

    if (isVid) {
      seekQuery = seekQuery.eq("media_type", "video");
    } else if (isGal) {
      seekQuery = seekQuery.eq("media_type", "gallery").gte("id", 374461);
    } else {
      seekQuery = seekQuery.in("media_type", ["comic", "manga_chapter"]);
    }

    const seekRes = await seekQuery;
    if (!seekRes.error && seekRes.data && seekRes.data.length > 0) {
      data = seekRes.data;
      total = totalEstimated;
      totalPages = totalP;
    }
  }

  // Si no fue seek profundo o si el seek no devolvió filas, ejecutar con rango
  if (!data) {
    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;
    const res = await query.range(from, to);

    if (res.error) {
      // Rescate resiliente si PostgreSQL cancela por timeout en offset alto
      if (res.error.message.includes("timeout") || res.error.message.includes("canceling statement")) {
        console.warn(`[ITEMS API] Timeout en página ${page}, activando rescate resiliente`);
        let fallbackQuery = admin
          .from("items")
          .select(SELECT_FIELDS)
          .order("id", { ascending: false })
          .limit(pageSize);

        if (isVideo) {
          fallbackQuery = fallbackQuery.eq("media_type", "video").lte("id", 304214);
        } else if (isGallery) {
          fallbackQuery = fallbackQuery.eq("media_type", "gallery").gte("id", 370000);
        } else {
          fallbackQuery = fallbackQuery.in("media_type", ["comic", "manga_chapter"]);
        }

        const fbRes = await fallbackQuery;
        if (!fbRes.error && fbRes.data) {
          data = fbRes.data;
          total = isVideo ? 166086 : (isGallery ? 14001 : 105490);
          totalPages = Math.ceil(total / pageSize);
        } else {
          return NextResponse.json({ error: res.error.message }, { status: 500 });
        }
      } else {
        return NextResponse.json({ error: res.error.message }, { status: 500 });
      }
    } else {
      data = res.data;
      count = res.count;
      if (!isDeepSeek) {
        if (hasValidCachedCount) {
          total = cachedCount.total;
          totalPages = cachedCount.totalPages;
        } else if (isGallery) {
          total = (count && count > 0) ? count : 14001;
          totalPages = Math.max(1, Math.ceil(total / pageSize));
        } else if (isVideo) {
          total = (count && count > 0) ? count : 166086;
          totalPages = Math.max(1, Math.ceil(total / pageSize));
        } else {
          total = (count && count > 0) ? count : 105490;
          totalPages = Math.max(1, Math.ceil(total / pageSize));
        }
      }
    }
  }

  // Guardar en caché el conteo si fue calculado
  if (!hasValidCachedCount && total > 0) {
    countCache.set(cacheKey, { total, totalPages, timestamp: now });
  }

  const items = (data || []).map((it: any) => {
    let fastCover = it.cover_url || `/api/img?i=${it.id}`;

    return {
      id: it.id,
      source: it.source || "velvet",
      source_id: it.source_id ? String(it.source_id) : String(it.id),
      title: it.title,
      cover_url: fastCover,
      media_type: it.media_type,
      tags: it.tags || [],
      artists: it.artists || [],
      url: it.url || "",
      page_count: it.page_count || 0,
      video_sources: it.video_sources || [],
      has_cover: !!it.cover_url,
    };
  });

  return NextResponse.json(
    {
      items,
      total,
      page,
      page_size: pageSize,
      total_pages: totalPages,
      live: false,
    },
    {
      headers: {
        "Cache-Control": "public, max-age=60, s-maxage=300, stale-while-revalidate=600",
      },
    }
  );
}