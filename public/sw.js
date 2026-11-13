// Velvet Hub Ultra-Fast Service Worker (Cloudflare Pages v10)
const CACHE_VERSION = 'v10-velvet-turbo';
const STATIC_CACHE = `velvet-static-${CACHE_VERSION}`;
const API_CACHE = `velvet-api-${CACHE_VERSION}`;
const IMAGE_CACHE = `velvet-images-${CACHE_VERSION}`;
const MAX_CACHED_IMAGES = 400;

const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/velvet_logo.png'
];

const BRAND_FALLBACK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 400" width="100%" height="100%"><rect width="100%" height="100%" fill="#0f071e"/><radialGradient id="g" cx="50%" cy="45%" r="60%"><stop offset="0%" stop-color="#2a0d3f"/><stop offset="100%" stop-color="#0a0414"/></radialGradient><rect width="100%" height="100%" fill="url(#g)"/><circle cx="150" cy="180" r="32" fill="none" stroke="#ff2d95" stroke-width="2" stroke-dasharray="5 4"/><path d="M142 166 L164 180 L142 194 Z" fill="#ff2d95"/><text x="150" y="240" text-anchor="middle" fill="#c4b5fd" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif" font-size="11" font-weight="700" letter-spacing="2">VELVET HUB</text></svg>`;

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

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => cache.addAll(STATIC_ASSETS).catch(() => {}))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys
          .filter((key) => !key.endsWith(CACHE_VERSION))
          .map((key) => caches.delete(key))
      );
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

  // 1. Exclusiones críticas: streaming de video, range requests, auth, admin, APIs privadas
  if (
    url.pathname.startsWith('/api/video/stream') ||
    url.pathname.startsWith('/api/auth') ||
    url.pathname.startsWith('/api/admin') ||
    url.pathname.startsWith('/api/user') ||
    url.pathname.startsWith('/api/favorites') ||
    req.headers.has('range') ||
    req.headers.has('authorization')
  ) {
    return;
  }

  // 2. Navegación HTML SPA: Network-First con fallback a Shell Cache
  const isNavigation = req.mode === 'navigate' || url.pathname === '/' || url.pathname.endsWith('.html');
  if (isNavigation) {
    event.respondWith(
      fetch(req)
        .then((networkResp) => {
          if (networkResp && networkResp.status === 200) {
            const clone = networkResp.clone();
            caches.open(STATIC_CACHE).then((cache) => cache.put(req, clone));
          }
          return networkResp;
        })
        .catch(() => caches.match('/index.html').then((res) => res || caches.match(req)))
    );
    return;
  }

  // 3. Fuentes e Iconos estáticos: Cache-First
  const isFontOrIcon =
    url.hostname.includes('fonts.gstatic.com') ||
    url.hostname.includes('fonts.googleapis.com') ||
    url.hostname.includes('cdnjs.cloudflare.com') ||
    url.pathname.endsWith('.woff2') ||
    url.pathname.endsWith('.woff') ||
    url.pathname === '/velvet_logo.png' ||
    url.pathname === '/manifest.json';

  if (isFontOrIcon) {
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req).then((resp) => {
          if (resp && resp.status === 200) {
            const clone = resp.clone();
            caches.open(STATIC_CACHE).then((c) => c.put(req, clone));
          }
          return resp;
        }).catch(() => new Response('', { status: 404 }));
      })
    );
    return;
  }

  // 4. Caché de Imágenes: Stale-While-Revalidate con Fallback SVG de marca (CERO cuadros negros)
  const isImageReq =
    (url.pathname.startsWith('/api/media') && !url.searchParams.get('t')?.includes('mp4')) ||
    url.pathname.startsWith('/api/image') ||
    url.pathname.startsWith('/api/img') ||
    req.destination === 'image';

  if (isImageReq) {
    event.respondWith(
      caches.open(IMAGE_CACHE).then(async (cache) => {
        const cached = await cache.match(req);

        // Disparar revalidación o fetch con timeout de 8 segundos
        const fetchPromise = (async () => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 8000);
          try {
            const networkResp = await fetch(req, { signal: controller.signal });
            clearTimeout(timer);
            if (networkResp && networkResp.status === 200) {
              const cType = networkResp.headers.get('content-type') || '';
              if (!cType.includes('video') && !cType.includes('mpegurl')) {
                cache.put(req, networkResp.clone());
                trimLruCache(IMAGE_CACHE, MAX_CACHED_IMAGES);
              }
            }
            return networkResp;
          } catch (err) {
            clearTimeout(timer);
            return null;
          }
        })();

        // Si ya está en caché, responder de inmediato (< 5ms) y revalidar en segundo plano
        if (cached) {
          event.waitUntil(fetchPromise);
          return cached;
        }

        // Si es la primera vez, esperar la red con fallback SVG de marca si falla
        const netRes = await fetchPromise;
        if (netRes && (netRes.status === 200 || netRes.status === 304)) {
          return netRes;
        }

        // Fallback visual garantizado: nunca pantalla negra
        return getFallbackImageResponse();
      })
    );
    return;
  }

  // 5. Catálogo de Datos (/api/items, /api/tags): Stale-While-Revalidate
  const isCatalogApi = url.pathname.startsWith('/api/items') || url.pathname.startsWith('/api/tags');
  if (isCatalogApi) {
    event.respondWith(
      caches.open(API_CACHE).then(async (cache) => {
        const cached = await cache.match(req);
        const fetchPromise = fetch(req)
          .then((networkResp) => {
            if (networkResp && networkResp.status === 200) {
              cache.put(req, networkResp.clone());
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
