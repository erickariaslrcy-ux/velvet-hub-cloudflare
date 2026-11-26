// Velvet Hub Ultra-Fast Service Worker (Cloudflare Pages - Fast Cache & Worker Budget)
const CACHE_VERSION = 'v41-tiktok-stealth';
const STATIC_CACHE = `velvet-static-${CACHE_VERSION}`;
const API_CACHE = `velvet-api-${CACHE_VERSION}`;
const COVER_CACHE = `velvet-covers-${CACHE_VERSION}`;
const IMAGE_CACHE = `velvet-images-${CACHE_VERSION}`;
const MAX_CACHED_COVERS = 1500;
const MAX_CACHED_IMAGES = 1500;
const MEDIA_INFLIGHT = new Map();

const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/favicon.ico',
  '/favicon-32x32.png',
  '/favicon-16x16.png',
  '/apple-touch-icon.png',
  '/icon-192.png',
  '/icon-512.png',
  '/velvet_logo.png',
  '/css/tailwind.css?v=3.17.0',
  '/css/pagination.css?v=3.10.0',
  '/js/video-session.js?v=3.10.0',
  '/js/personal-data.js?v=3.10.0',
  '/js/store.js?v=3.10.0',
  '/js/router.js?v=3.10.0',
  '/js/vault.js?v=3.10.0',
  '/js/pagination.js?v=3.10.0',
  '/js/image-loader.js?v=3.10.0',
  '/js/tiktok-feed.js?v=3.17.0'
];

const BRAND_FALLBACK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 400" width="100%" height="100%"><rect width="100%" height="100%" fill="#0f071e"/><radialGradient id="g" cx="50%" cy="45%" r="60%"><stop offset="0%" stop-color="#2a0d3f"/><stop offset="100%" stop-color="#0a0414"/></radialGradient><rect width="100%" height="100%" fill="url(#g)"/><circle cx="150" cy="168" r="28" fill="none" stroke="#ff2d95" stroke-width="2"/><text x="150" y="176" text-anchor="middle" fill="#ff2d95" font-family="Georgia,serif" font-size="22" font-weight="700">M</text><text x="150" y="230" text-anchor="middle" fill="#c4b5fd" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif" font-size="11" font-weight="700" letter-spacing="2">MORBO HUB</text></svg>`;

function getFallbackImageResponse() {
  return new Response(BRAND_FALLBACK_SVG, {
    status: 200,
    headers: {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=86400',
      'X-Velvet-Fallback': 'true'
    }
  });
}

function isUsableCoverResponse(resp) {
  if (!resp || resp.status !== 200) return false;
  if (resp.headers.get('X-Velvet-Fallback') === 'true') return false;
  const cType = (resp.headers.get('content-type') || '').toLowerCase();
  if (!cType.includes('image/')) return false;
  if (cType.includes('svg')) return false;
  if (cType.includes('text/html') || cType.includes('application/json') || cType.includes('text/plain')) return false;
  return true;
}

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => cache.addAll(STATIC_ASSETS).catch(() => {}))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(async (keys) => {
      await Promise.all(
        keys
          .filter((key) => !key.endsWith(CACHE_VERSION))
          .map((key) => caches.delete(key))
      );
      // Por si una portada fallida (SVG de reserva, 403 o HTML) quedó
      // guardada con el nombre de caché nuevo.
      for (const cacheName of [COVER_CACHE, IMAGE_CACHE]) {
        const mediaCache = await caches.open(cacheName);
        const mediaKeys = await mediaCache.keys();
        await Promise.all(mediaKeys.map(async (key) => {
          const cached = await mediaCache.match(key);
          if (!isUsableCoverResponse(cached)) await mediaCache.delete(key);
        }));
      }
    }).then(() => self.clients.claim())
  );
});

async function trimLruCache(cacheName, maxItems) {
  try {
    const cache = await caches.open(cacheName);
    const keys = await cache.keys();
    if (keys.length > maxItems) {
      const deleteCount = keys.length - maxItems;
      for (let i = 0; i < deleteCount; i++) {
        await cache.delete(keys[i]);
      }
    }
  } catch (e) {}
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Nunca interceptar recursos de terceros (CDNs de fuentes, FontAwesome, Ruffle, streaming externo):
  // dejar que el navegador y su caché HTTP nativa los resuelvan sin convertirse en 404/CORS opacos.
  if (url.origin !== self.location.origin) {
    return;
  }

  // 1. Exclusiones críticas: streaming de video, range requests, auth, admin, APIs privadas y catálogo paginado
  if (
    url.pathname.startsWith('/api/items') ||
    url.pathname.startsWith('/api/shorts') ||
    url.pathname.startsWith('/api/media') ||
    url.pathname.startsWith('/api/video/stream') ||
    url.pathname.startsWith('/api/auth') ||
    url.pathname.startsWith('/api/admin') ||
    url.pathname.startsWith('/api/user') ||
    url.pathname.startsWith('/api/favorites') ||
    url.pathname.startsWith('/api/history') ||
    url.pathname.startsWith('/api/preferences') ||
    url.pathname.startsWith('/api/sync') ||
    url.pathname.startsWith('/api/redeem') ||
    req.destination === 'video' ||
    req.destination === 'audio' ||
    req.headers.has('range') ||
    req.headers.has('authorization')
  ) {
    return;
  }

  // 2. Navegación HTML SPA: Network-First con fallback a Shell Cache (solo clave normalizada para no inflar caché)
  const isNavigation = req.mode === 'navigate' || url.pathname === '/' || url.pathname.endsWith('.html');
  if (isNavigation) {
    event.respondWith(
      fetch(req)
        .then((networkResp) => {
          if (networkResp && networkResp.status === 200) {
            const clone = networkResp.clone();
            const isShell = url.pathname === '/' || url.pathname === '/index.html';
            caches.open(STATIC_CACHE).then((cache) => {
              cache.put(isShell ? '/' : req.url.split('?')[0], clone).catch(() => {});
            });
          }
          return networkResp;
        })
        .catch(() => caches.match('/index.html').then((res) => res || caches.match('/') || caches.match(req)))
    );
    return;
  }

  // 3. Activos estáticos versionados locales (/js/, /css/, logos, manifest)
  const isLocalStatic =
    url.pathname.startsWith('/js/') ||
    url.pathname.startsWith('/css/') ||
    url.pathname === '/velvet_logo.png' ||
    url.pathname === '/manifest.json' ||
    url.pathname === '/favicon.ico' ||
    /^\/(?:apple-touch-icon|icon-\d+|favicon-\d+x\d+)\.png$/.test(url.pathname);

  if (isLocalStatic) {
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req).then((resp) => {
          if (resp && resp.status === 200) {
            const clone = resp.clone();
            caches.open(STATIC_CACHE).then((c) => c.put(req, clone).catch(() => {}));
          }
          return resp;
        }).catch(() => fetch(req));
      })
    );
    return;
  }

  // 4. Caché de Imágenes: solo peticiones reales de imagen (nunca Fetch/XHR de playlists .m3u8 ni segmentos .ts)
  const isImageReq =
    req.destination === 'image' ||
    url.pathname.startsWith('/api/image') ||
    url.pathname.startsWith('/api/img');

  if (isImageReq) {
    const isCoverVariant = url.pathname.startsWith('/api/media') && (url.searchParams.has('w') || url.searchParams.get('cov') === '1');
    const targetCacheName = isCoverVariant ? COVER_CACHE : IMAGE_CACHE;
    const targetMaxItems = isCoverVariant ? MAX_CACHED_COVERS : MAX_CACHED_IMAGES;
    const inflightKey = req.url;

    event.respondWith(
      caches.open(targetCacheName).then(async (cache) => {
        const cached = await cache.match(req);

        // Cache-first: una portada ya vista no vuelve a salir a la red.
        // SVG de reserva, 403 y HTML cacheados no cuentan como portada.
        if (cached && !isUsableCoverResponse(cached)) {
          try { await cache.delete(req); } catch (e) {}
        } else if (cached) return cached;

        let sharedPromise = MEDIA_INFLIGHT.get(inflightKey);
        if (!sharedPromise) {
          sharedPromise = (async () => {
            // Solo reintentar una vez ante caídas de red o 5xx reales; nunca repetir 4xx ni upstream-rejected
            for (let attempt = 0; attempt < 2; attempt++) {
              const controller = new AbortController();
              const timer = setTimeout(() => controller.abort(), attempt === 0 ? 7500 : 12000);
              try {
                const networkResp = await fetch(req, { signal: controller.signal });
                clearTimeout(timer);
                const cType = (networkResp && networkResp.headers.get('content-type') || '').toLowerCase();
                const isHtml = cType.includes('text/html') || cType.includes('application/json');
                if (networkResp && networkResp.status === 200 && !isHtml && cType.includes('image') && !cType.includes('video') && !cType.includes('mpegurl')) {
                  cache.put(req, networkResp.clone()).catch(() => {});
                  trimLruCache(targetCacheName, targetMaxItems);
                }
                if (networkResp && !isHtml && (networkResp.status === 200 || networkResp.status === 304 || networkResp.status === 206)) {
                  return networkResp;
                }
                if (networkResp && ((networkResp.status >= 400 && networkResp.status < 500) || networkResp.headers.get('X-Velvet-Media') === 'upstream-rejected')) {
                  break;
                }
              } catch (err) {
                clearTimeout(timer);
              }
            }
            return null;
          })();
          MEDIA_INFLIGHT.set(inflightKey, sharedPromise);
        }

        try {
          const netRes = await sharedPromise;
          if (netRes && (netRes.status === 200 || netRes.status === 304 || netRes.status === 206)) {
            return netRes.clone();
          }
        } finally {
          if (MEDIA_INFLIGHT.get(inflightKey) === sharedPromise) {
            MEDIA_INFLIGHT.delete(inflightKey);
          }
        }

        // 502 para que el onerror de la tarjeta elija cámara, libro o play.
        return new Response('', {
          status: 502,
          headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }
        });
      })
    );
    return;
  }

  // 5. Catálogo de Etiquetas (/api/tags): Cache-First fresco por 6h, luego SWR (catálogo /api/items pasa directo a red/borde)
  const isCatalogApi = url.pathname.startsWith('/api/tags');
  if (isCatalogApi) {
    event.respondWith(
      caches.open(API_CACHE).then(async (cache) => {
        const cached = await cache.match(req);
        const cachedAt = cached ? Number(cached.headers.get('X-SW-Cached-At') || 0) : 0;
        if (cached && cachedAt && (Date.now() - cachedAt) < 21600000) {
          return cached;
        }
        const fetchPromise = fetch(req)
          .then((networkResp) => {
            if (networkResp && networkResp.status === 200) {
              const hdrs = new Headers(networkResp.headers);
              hdrs.set('X-SW-Cached-At', String(Date.now()));
              const stamped = new Response(networkResp.clone().body, {
                status: networkResp.status,
                statusText: networkResp.statusText,
                headers: hdrs
              });
              cache.put(req, stamped);
            }
            return networkResp;
          })
          .catch(() => null);

        if (cached) {
          event.waitUntil(fetchPromise);
          return cached;
        }

        const networkResp = await fetchPromise;
        return networkResp || new Response(JSON.stringify({ error: 'Offline', items: [] }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' }
        });
      })
    );
    return;
  }
});
