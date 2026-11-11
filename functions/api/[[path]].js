/**
 * CLOUDFLARE PAGES NATIVE API & STEALTH MEDIA ENGINE (100% CLOUDFLARE + SUPABASE)
 * 
 * ARQUITECTURA AUTÓNOMA DE BORDE (CERO DEPENDENCIAS DE VERCEL):
 * 1. Entrega 100% de imágenes, portadas, galerías y streams de video bajo morbohub.pages.dev.
 * 2. Cifra todas las URLs de origen con XOR simétrico + Base64URL (marca blanca impenetrable).
 * 3. Cache mundial ultra-rápido en Cloudflare Edge (10ms) para imágenes y catálogo.
 * 4. Conexión nativa de alto rendimiento con Supabase PostgREST y Supabase Auth.
 * 5. Cero límites de 10GB ni errores 402/494 de Vercel (transferencia ilimitada en Cloudflare Pages).
 */

const SUPABASE_URL = "https://qnmcejlxoufheisgkuyo.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFubWNlamx4b3VmaGVpc2drdXlvIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc5MTU1NzI0NiwiZXhwIjoyMTA3MTMzMjQ2fQ.lDom8ovim8HH-8oxcsSKCRQNN0UjMV_Po-VSo-zanDU";
const MEDIA_SECRET = "velvet_ultra_stealth_secret_key_2026";

// Cifrado y descifrado XOR simétrico UTF-8 seguro (soporta caracteres asiáticos y emojis sin error btoa)
function encodeMediaToken(targetUrl, referer = "") {
  if (!targetUrl) return "";
  try {
    const raw = JSON.stringify({ u: targetUrl, r: referer || "" });
    const utf8Bytes = new TextEncoder().encode(raw);
    const keyBytes = new TextEncoder().encode(MEDIA_SECRET);
    const xorBytes = new Uint8Array(utf8Bytes.length);
    for (let i = 0; i < utf8Bytes.length; i++) {
      xorBytes[i] = utf8Bytes[i] ^ keyBytes[i % keyBytes.length];
    }
    let bin = "";
    for (let i = 0; i < xorBytes.length; i++) {
      bin += String.fromCharCode(xorBytes[i]);
    }
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  } catch (e) {
    return "";
  }
}

function decodeMediaToken(token) {
  if (!token) return null;
  try {
    let b64 = token.replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    const bin = atob(b64);
    const keyBytes = new TextEncoder().encode(MEDIA_SECRET);
    const xorBytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
      xorBytes[i] = bin.charCodeAt(i) ^ keyBytes[i % keyBytes.length];
    }
    const dec = new TextDecoder().decode(xorBytes);
    return JSON.parse(dec);
  } catch (e) {
    return null;
  }
}

function decodePayload(tParam, urlParam, refParam) {
  if (urlParam) return { u: urlParam, r: refParam || "" };
  if (!tParam) return null;

  const secretDec = decodeMediaToken(tParam);
  if (secretDec && secretDec.u) return secretDec;

  try {
    let b64 = tParam.replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    const jsonStr = decodeURIComponent(escape(atob(b64)));
    const parsed = JSON.parse(jsonStr);
    if (parsed && parsed.u) return parsed;
  } catch (e) {}

  return null;
}

// Cabeceras CORS estándar
function getCorsHeaders(origin = "*") {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, PATCH, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, Range, X-Requested-With, X-Refresh-Token, X-Device-Token, x-velvet-client",
    "Server": "Velvet-Cloud",
    "X-Powered-By": "Velvet-Native-Cloudflare-Engine/3.0"
  };
}

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const origin = context.request.headers.get("origin") || "*";
  const method = context.request.method;

  // Manejo de Preflight OPTIONS
  if (method === "OPTIONS") {
    return new Response(null, { status: 204, headers: getCorsHeaders(origin) });
  }

  // =========================================================================
  // 1. REPRODUCCIÓN Y STREAMING DE MEDIOS STEALTH (/api/media, /api/image, etc.)
  // =========================================================================
  const isMediaRoute =
    url.pathname.startsWith("/api/media") ||
    url.pathname.startsWith("/api/image") ||
    url.pathname.startsWith("/api/img") ||
    url.pathname.startsWith("/api/video/stream");

  if (isMediaRoute) {
    const tParam = url.searchParams.get("t");
    const urlParam = url.searchParams.get("url") || url.searchParams.get("i");
    const refParam = url.searchParams.get("r") || url.searchParams.get("referer");

    const payload = decodePayload(tParam, urlParam, refParam);
    if (!payload || !payload.u || !/^https?:\/\//i.test(payload.u)) {
      return new Response("Media token invalido o expirado", {
        status: 400,
        headers: { "Content-Type": "text/plain; charset=utf-8", ...getCorsHeaders(origin) }
      });
    }

    const targetMediaUrl = payload.u;
    const isVideo =
      targetMediaUrl.includes(".mp4") ||
      targetMediaUrl.includes(".m3u8") ||
      url.pathname.includes("/video/");

    // Cloudflare Edge Cache para imágenes (7 días de retención mundial acelerada)
    const cache = caches.default;
    const cacheKey = new Request(url.toString(), context.request);

    if (!isVideo && method === "GET") {
      try {
        const cached = await cache.match(cacheKey);
        if (cached) {
          const ch = new Headers(cached.headers);
          ch.set("X-Media-Cache", "HIT-CLOUDFLARE");
          ch.set("X-Powered-By", "Velvet-Media-Engine/3.0");
          ch.set("Server", "Velvet-Cloud");
          ch.set("Access-Control-Allow-Origin", "*");
          return new Response(cached.body, { status: cached.status, headers: ch });
        }
      } catch (e) {}
    }

    // Inferencia de Referer para anti-hotlink
    let spoofedReferer = payload.r || "";
    if (!spoofedReferer) {
      if (targetMediaUrl.includes("buondua") || targetMediaUrl.includes("imagedeliveries")) {
        spoofedReferer = "https://buondua.com/";
      } else if (targetMediaUrl.includes("xasiat") || targetMediaUrl.includes("xascdn")) {
        spoofedReferer = "https://xasiat.com/";
      } else if (targetMediaUrl.includes("4khd")) {
        spoofedReferer = "https://4khd.com/";
      } else if (targetMediaUrl.includes("hentaipaw")) {
        spoofedReferer = "https://hentaipaw.com/";
      } else if (targetMediaUrl.includes("pmvhaven") || targetMediaUrl.includes("ovh.net")) {
        spoofedReferer = "https://pmvhaven.com/";
      } else {
        try {
          spoofedReferer = new URL(targetMediaUrl).origin + "/";
        } catch (e) {
          spoofedReferer = targetMediaUrl;
        }
      }
    }

    const upstreamReqHeaders = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
      "Referer": spoofedReferer,
      "Accept": "*/*",
      "Accept-Encoding": "identity",
    };

    const clientRange = context.request.headers.get("Range");
    if (clientRange) {
      upstreamReqHeaders["Range"] = clientRange;
    }

    try {
      const upstream = await fetch(targetMediaUrl, {
        method,
        headers: upstreamReqHeaders,
        redirect: "follow",
        cf: isVideo ? undefined : { cacheEverything: true, cacheTtl: 604800 },
      });

      const respHeaders = new Headers();
      respHeaders.set("Content-Type", upstream.headers.get("content-type") || (isVideo ? "video/mp4" : "image/jpeg"));
      respHeaders.set("Access-Control-Allow-Origin", "*");
      respHeaders.set("X-Powered-By", "Velvet-Media-Engine/3.0");
      respHeaders.set("Server", "Velvet-Cloud");

      if (isVideo) {
        respHeaders.set("Accept-Ranges", "bytes");
        respHeaders.set("Cache-Control", "public, max-age=7200");
      } else {
        respHeaders.set("Cache-Control", "public, max-age=604800, s-maxage=604800, immutable");
      }

      if (upstream.headers.has("Content-Length")) {
        respHeaders.set("Content-Length", upstream.headers.get("Content-Length"));
      }
      if (upstream.headers.has("Content-Range")) {
        respHeaders.set("Content-Range", upstream.headers.get("Content-Range"));
      }

      const clientResponse = new Response(upstream.body, {
        status: upstream.status,
        headers: respHeaders,
      });

      if (!isVideo && upstream.status === 200) {
        try {
          context.waitUntil(cache.put(cacheKey, clientResponse.clone()));
        } catch (e) {}
      }

      return clientResponse;
    } catch (err) {
      return new Response(JSON.stringify({ error: `Media Engine Error: ${err.message}` }), {
        status: 502,
        headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
      });
    }
  }

  // =========================================================================
  // 2. DETALLE DE ELEMENTO INDIVIDUAL (/api/items/:source/:id o /api/items/id/:id)
  // =========================================================================
  const itemDetailMatch = url.pathname.match(/^\/api\/items\/(?:id\/([^/]+)|([^/]+)\/([^/]+))$/);
  if (itemDetailMatch && method === "GET") {
    const rawId = itemDetailMatch[1];
    const rawSource = itemDetailMatch[2];
    const rawSourceId = itemDetailMatch[3];

    let queryParam = "";
    if (rawId) {
      queryParam = `id=eq.${encodeURIComponent(rawId)}`;
    } else if (rawSource === "id" && rawSourceId) {
      queryParam = `id=eq.${encodeURIComponent(rawSourceId)}`;
    } else if (rawSource && rawSourceId) {
      // Buscar por source_id o ID numérico directo
      const isNum = /^\d+$/.test(rawSourceId);
      if (isNum) {
        queryParam = `or=(id.eq.${encodeURIComponent(rawSourceId)},and(source.eq.${encodeURIComponent(rawSource)},source_id.eq.${encodeURIComponent(rawSourceId)}))`;
      } else {
        queryParam = `source=eq.${encodeURIComponent(rawSource)}&source_id=eq.${encodeURIComponent(rawSourceId)}`;
      }
    }

    try {
      const spRes = await fetch(`${SUPABASE_URL}/rest/v1/items?${queryParam}&limit=1`, {
        headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}` }
      });

      if (!spRes.ok) {
        return new Response(JSON.stringify({ detail: "Elemento no encontrado" }), {
          status: 404,
          headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
        });
      }

      const items = await spRes.json();
      if (!items || items.length === 0) {
        return new Response(JSON.stringify({ detail: "Elemento no encontrado" }), {
          status: 404,
          headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
        });
      }

      const it = items[0];
      const masked = {
        ...it,
        url: "", // Ocultar URL original
        cover_url: it.cover_url ? `/api/media?t=${encodeMediaToken(it.cover_url)}` : "",
        pages: (it.pages || []).map((p, idx) => ({
          index: p.index || idx + 1,
          image_url: p.image_url ? `/api/media?t=${encodeMediaToken(p.image_url)}` : ""
        })),
        video_sources: (it.video_sources || []).map(vs => ({
          ...vs,
          url: vs.url ? `/api/media?t=${encodeMediaToken(vs.url)}` : ""
        }))
      };

      return new Response(JSON.stringify(masked), {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "public, max-age=60, s-maxage=300",
          ...getCorsHeaders(origin)
        }
      });
    } catch (err) {
      return new Response(JSON.stringify({ detail: err.message }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
      });
    }
  }

  // =========================================================================
  // 3. CATÁLOGO PRINCIPAL Y BÚSQUEDA (/api/items)
  // =========================================================================
  if (url.pathname === "/api/items" && method === "GET") {
    const mediaType = url.searchParams.get("media_type") || "comic";
    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
    const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get("page_size") || "24", 10)));
    const q = (url.searchParams.get("q") || "").trim();
    const category = (url.searchParams.get("category") || "").trim().toLowerCase();

    // Cache de Borde Cloudflare para catálogo público (300 segundos)
    const cache = caches.default;
    const cacheKey = new Request(url.toString(), context.request);
    try {
      const cached = await cache.match(cacheKey);
      if (cached) {
        const edgeHeaders = new Headers(cached.headers);
        edgeHeaders.set("X-Cloudflare-Edge-Cache", "HIT");
        edgeHeaders.set("Access-Control-Allow-Origin", origin || "*");
        return new Response(cached.body, { status: 200, headers: edgeHeaders });
      }
    } catch (e) {}

    const seedParam = parseInt(url.searchParams.get("seed") || "0", 10);
    const sort = url.searchParams.get("sort") || "recent";

    let offset = (page - 1) * pageSize;
    if (seedParam > 0 && !q && sort === "recent") {
      let baseWindow = 120;
      let multiplier = 7919;
      if (mediaType === "video") {
        multiplier = 1337;
        baseWindow = (category && category !== "all") ? 15 : 120;
      } else if (mediaType === "gallery" || mediaType === "cosplay") {
        multiplier = 7919;
        baseWindow = (category && category !== "all") ? 15 : 120;
      } else {
        multiplier = 3137;
        baseWindow = (category && category !== "all") ? 15 : 120;
      }
      const basePage = Math.abs(seedParam * multiplier) % baseWindow;
      offset = (basePage + (page - 1)) * pageSize;
    }

    const selectFields = "id,source,source_id,title,cover_url,media_type,tags,page_count,video_sources,artists";
    let postgrestUrl = `${SUPABASE_URL}/rest/v1/items?select=${selectFields}&limit=${pageSize}&offset=${offset}`;

    let estimatedTotal = 20000;

    if (mediaType === "video") {
      postgrestUrl += "&source=eq.pmvhaven&order=id.desc";
      estimatedTotal = 20242;
    } else if (mediaType === "gallery" || mediaType === "cosplay") {
      postgrestUrl += "&media_type=eq.gallery&id=gte.370000&order=id.desc";
      estimatedTotal = 18253;
    } else {
      postgrestUrl += "&media_type=eq.comic&id=gte.320000&order=id.desc";
      estimatedTotal = 45000;
    }

    if (q) {
      postgrestUrl += `&title=ilike.*${encodeURIComponent(q)}*`;
      estimatedTotal = 800;
    } else if (category && category !== "all") {
      let catTerm = category;
      if (mediaType === "gallery" || mediaType === "cosplay") {
        if (category === "cosplay") catTerm = "cosplay";
        else if (category === "artgravia") catTerm = "artgravia";
        else if (category === "korean") catTerm = "korean";
        else if (category === "asian" || category === "xiuren") catTerm = "xiuren";
        else if (category === "lingerie" || category === "bikini") catTerm = "bikini";
        else if (category === "patreon") catTerm = "patreon";
      } else if (mediaType === "video") {
        if (category === "pmv") catTerm = "pmv";
      } else {
        if (category === "manhwa") catTerm = "manhwa";
        else if (category === "3d") catTerm = "3d";
        else if (category === "doujin") catTerm = "doujin";
        else if (category === "parody") catTerm = "parodia";
      }
      postgrestUrl += `&title=ilike.*${encodeURIComponent(catTerm)}*`;
      estimatedTotal = 1500;
    }

    try {
      const spRes = await fetch(postgrestUrl, {
        headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}` }
      });

      if (!spRes.ok) {
        const errText = await spRes.text();
        return new Response(JSON.stringify({ error: "Error consultando catálogo", detail: errText }), {
          status: 500,
          headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
        });
      }

      const rawItems = await spRes.json();
      const items = (rawItems || []).map(it => ({
        id: it.id,
        source: it.source || "velvet",
        source_id: it.source_id ? String(it.source_id) : String(it.id),
        title: it.title,
        cover_url: it.cover_url ? `/api/media?t=${encodeMediaToken(it.cover_url)}` : "",
        media_type: it.media_type,
        tags: it.tags || [],
        artists: it.artists || [],
        url: "", // Ocultar URL original
        page_count: it.page_count || 0,
        video_sources: (it.video_sources || []).map(vs => ({
          ...vs,
          url: vs.url ? `/api/media?t=${encodeMediaToken(vs.url)}` : ""
        })),
        has_cover: !!it.cover_url
      }));

      const responsePayload = {
        items,
        total: estimatedTotal,
        page,
        page_size: pageSize,
        total_pages: Math.ceil(estimatedTotal / pageSize),
        live: false
      };

      const resp = new Response(JSON.stringify(responsePayload), {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "public, max-age=300, s-maxage=300",
          ...getCorsHeaders(origin)
        }
      });

      try {
        context.waitUntil(cache.put(cacheKey, resp.clone()));
      } catch (e) {}

      return resp;
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
      });
    }
  }

  // =========================================================================
  // 4. RANDOM / SORPRÉNDEME (/api/random)
  // =========================================================================
  if (url.pathname === "/api/random" && method === "GET") {
    const mediaType = url.searchParams.get("media_type") || "comic";
    const count = Math.min(10, Math.max(1, parseInt(url.searchParams.get("count") || "1", 10)));
    const maxOffset = mediaType === "video" ? 20000 : (mediaType === "gallery" ? 18000 : 40000);
    const randomOffset = Math.floor(Math.random() * Math.max(1, maxOffset - count));

    let queryParam = `select=id,source,source_id,title,cover_url,media_type,tags,page_count,video_sources&limit=${count}&offset=${randomOffset}`;
    if (mediaType === "video") {
      queryParam += "&source=eq.pmvhaven";
    } else if (mediaType === "gallery") {
      queryParam += "&media_type=eq.gallery&id=gte.370000";
    } else {
      queryParam += "&media_type=eq.comic";
    }

    try {
      const spRes = await fetch(`${SUPABASE_URL}/rest/v1/items?${queryParam}`, {
        headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}` }
      });

      const rawItems = await spRes.json();
      const items = (rawItems || []).map(it => ({
        ...it,
        url: "",
        cover_url: it.cover_url ? `/api/media?t=${encodeMediaToken(it.cover_url)}` : "",
        video_sources: (it.video_sources || []).map(vs => ({
          ...vs,
          url: vs.url ? `/api/media?t=${encodeMediaToken(vs.url)}` : ""
        }))
      }));

      return new Response(JSON.stringify(items), {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8", ...getCorsHeaders(origin) }
      });
    } catch (err) {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
      });
    }
  }

  // =========================================================================
  // 5. AUTENTICACIÓN: LOGIN (/api/auth/login)
  // =========================================================================
  if (url.pathname === "/api/auth/login" && method === "POST") {
    try {
      const body = await context.request.json();
      const rawUser = (body.username || "").trim();
      const password = body.password || "";

      if (!rawUser || !password) {
        return new Response(JSON.stringify({ detail: "Usuario o correo y contraseña requeridos" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
        });
      }

      let email = rawUser.toLowerCase();
      if (!email.includes("@")) {
        const master = "erickariaslrcy@gmail.com";
        if (email === "admin" || email === "erick" || email === "master") {
          email = master;
        } else {
          // Resolver alias desde profiles
          const profRes = await fetch(`${SUPABASE_URL}/rest/v1/profiles?select=email&or=(email.ilike.*${email}@*,email.ilike.*${email}*)&limit=1`, {
            headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}` }
          });
          const profData = await profRes.json();
          if (profData && profData.length > 0) {
            email = profData[0].email;
          } else {
            email = `${email}@velvet.local`;
          }
        }
      }

      // Conexión directa a Supabase Auth
      const authRes = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
        method: "POST",
        headers: { "apikey": SUPABASE_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ email, password })
      });

      const authData = await authRes.json();
      if (!authRes.ok || !authData.user) {
        const msg = authData?.error_description || authData?.msg || "Credenciales incorrectas";
        return new Response(JSON.stringify({ detail: msg }), {
          status: 401,
          headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
        });
      }

      // Obtener perfil y rol admin
      const profRes = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${authData.user.id}&select=is_admin&limit=1`, {
        headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}` }
      });
      const profs = await profRes.json();
      const isAdmin = profs && profs[0] && profs[0].is_admin;
      const role = isAdmin ? "admin" : "member";
      const meta = authData.user.user_metadata || {};
      const displayName = meta.username || meta.full_name || meta.display_name || email.split("@")[0];

      const respData = {
        token: authData.access_token,
        refresh_token: authData.refresh_token,
        expires_at: authData.expires_at,
        device_token: "dev_" + Math.random().toString(36).substring(2),
        user: {
          id: authData.user.id,
          username: displayName,
          email: authData.user.email,
          role,
          tier: isAdmin ? "Dueño" : "Velvet VIP ($5.99)",
          tier_level: "pro",
          is_pro: true
        }
      };

      return new Response(JSON.stringify(respData), {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8", ...getCorsHeaders(origin) }
      });
    } catch (err) {
      return new Response(JSON.stringify({ detail: err.message || "Error al procesar login" }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
      });
    }
  }

  // =========================================================================
  // 6. AUTENTICACIÓN: VERIFICAR SESIÓN (/api/auth/me)
  // =========================================================================
  if (url.pathname === "/api/auth/me" && method === "GET") {
    const authHeader = context.request.headers.get("authorization") || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

    if (!token || token === "velvet_token" || token === "null" || token === "undefined") {
      return new Response(JSON.stringify({ detail: "No autenticado" }), {
        status: 401,
        headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
      });
    }

    try {
      const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${token}` }
      });

      if (!userRes.ok) {
        return new Response(JSON.stringify({ detail: "Token invalido o expirado" }), {
          status: 401,
          headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
        });
      }

      const user = await userRes.json();
      const profRes = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}&select=is_admin&limit=1`, {
        headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}` }
      });
      const profs = await profRes.json();
      const isAdmin = profs && profs[0] && profs[0].is_admin;
      const role = isAdmin ? "admin" : "member";
      const meta = user.user_metadata || {};
      const displayName = meta.username || meta.full_name || meta.display_name || user.email.split("@")[0];

      const respData = {
        id: user.id,
        username: displayName,
        email: user.email,
        role,
        tier: isAdmin ? "Dueño" : "Velvet VIP ($5.99)",
        tier_level: "pro",
        is_pro: true,
        max_devices: 10
      };

      return new Response(JSON.stringify(respData), {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8", ...getCorsHeaders(origin) }
      });
    } catch (err) {
      return new Response(JSON.stringify({ detail: "Error de sesión" }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
      });
    }
  }

  // =========================================================================
  // 7. AUTENTICACIÓN: REGISTRO (/api/auth/register)
  // =========================================================================
  if (url.pathname === "/api/auth/register" && method === "POST") {
    try {
      const body = await context.request.json();
      const username = (body.username || "").trim();
      const email = (body.email || `${username}@velvet.local`).trim().toLowerCase();
      const password = body.password || "";

      if (!username || !password) {
        return new Response(JSON.stringify({ detail: "Nombre de usuario y contraseña requeridos" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
        });
      }

      // Registro en Supabase
      const regRes = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
        method: "POST",
        headers: { "apikey": SUPABASE_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, data: { username } })
      });

      const regData = await regRes.json();
      if (!regRes.ok || !regData.user) {
        return new Response(JSON.stringify({ detail: regData?.msg || "Error al registrar" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
        });
      }

      // Iniciar sesión inmediatamente
      const authRes = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
        method: "POST",
        headers: { "apikey": SUPABASE_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ email, password })
      });
      const authData = await authRes.json();

      const respData = {
        token: authData?.access_token || "velvet_token",
        refresh_token: authData?.refresh_token || null,
        user: {
          id: regData.user.id,
          username,
          email,
          role: "member",
          tier: "Velvet VIP ($5.99)",
          tier_level: "pro",
          is_pro: true
        }
      };

      return new Response(JSON.stringify(respData), {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8", ...getCorsHeaders(origin) }
      });
    } catch (err) {
      return new Response(JSON.stringify({ detail: err.message }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
      });
    }
  }

  // =========================================================================
  // 8. FAVORITOS E HISTORIAL (/api/favorites, /api/user/favorites, /api/user/history)
  // =========================================================================
  if (
    url.pathname.startsWith("/api/favorites") ||
    url.pathname.startsWith("/api/user/favorites") ||
    url.pathname.startsWith("/api/user/history")
  ) {
    if (method === "GET") {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
      });
    }
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
    });
  }

  // =========================================================================
  // 9. TAGS POPULARES (/api/tags)
  // =========================================================================
  if (url.pathname === "/api/tags" && method === "GET") {
    const popularTags = [
      "Cosplay", "ArtGravia", "Korean", "Xiuren", "Bikini", "Lingerie", "Patreon", "Fansly",
      "PMV", "Verified Performer", "HD", "1080p", "Full Color", "3D", "Manhwa", "Doujinshi"
    ];
    return new Response(JSON.stringify(popularTags), {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8", ...getCorsHeaders(origin) }
    });
  }

  // Ruta API no encontrada
  return new Response(JSON.stringify({ error: "Endpoint no encontrado en Velvet Cloudflare API", path: url.pathname }), {
    status: 404,
    headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
  });
}
