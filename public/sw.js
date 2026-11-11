// Velvet Hub Ultra-Fast Turbo Service Worker (PC & Android Hardware-Accelerated Cache)
const CACHE_VERSION = 'v8-android-turbo';
const STATIC_CACHE = `velvet-static-${CACHE_VERSION}`;
const API_CACHE = `velvet-api-${CACHE_VERSION}`;
const IMAGE_CACHE = `velvet-images-${CACHE_VERSION}`;
const MAX_CACHED_IMAGES = 500;

const STATIC_ASSETS = [
  '/',
  '/manifest.json',
  '/velvet_logo.png'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => {
      return cache.addAll(STATIC_ASSETS).catch(() => {});
    })
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

// Ayudante para limitar el tamaño del caché de imágenes y no saturar el almacenamiento
async function trimCache(cacheName, maxItems) {
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

  // 1. Exclusiones críticas: streaming de video, peticiones de rango, auth, admin
  if (
    url.pathname.startsWith('/api/video/stream') ||
    url.pathname.startsWith('/api/auth') ||
    url.pathname.startsWith('/api/admin') ||
    req.headers.has('range')
  ) {
    return;
  }

  // 2. Navegación HTML (Páginas y Vistas): NETWORK FIRST con fallback a caché
  // Garantiza que cualquier actualización o solución se vea de inmediato al recargar
  const isNavigation = req.mode === 'navigate' ||
    url.pathname === '/' ||
    url.pathname.endsWith('.html') ||
    url.pathname.startsWith('/comic/') ||
    url.pathname.startsWith('/gallery/') ||
    url.pathname.startsWith('/video/');

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
        .catch(() => caches.match(req))
    );
    return;
  }

  // 3. Caché de Imágenes (/api/media, /api/image, /api/img, portadas y fotos): Cache First con revalidación en segundo plano
  const isImageReq =
    (url.pathname.startsWith('/api/media') && !url.searchParams.get('t')?.includes('mp4')) ||
    url.pathname.startsWith('/api/image') ||
    url.pathname.startsWith('/api/img') ||
    url.pathname.endsWith('.png') ||
    url.pathname.endsWith('.jpg') ||
    url.pathname.endsWith('.jpeg') ||
    url.pathname.endsWith('.webp') ||
    url.pathname.endsWith('.gif') ||
    req.destination === 'image';

  if (isImageReq) {
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) {
          return cached;
        }

        return fetch(req)
          .then((networkResp) => {
            if (networkResp && networkResp.status === 200) {
              const cType = networkResp.headers.get('content-type') || '';
              // Solo almacenar imágenes reales en IMAGE_CACHE (NUNCA streams ni archivos de video grandes)
              if (!cType.includes('video') && !cType.includes('mpegurl')) {
                const respClone = networkResp.clone();
                caches.open(IMAGE_CACHE).then((cache) => {
                  cache.put(req, respClone);
                  trimCache(IMAGE_CACHE, MAX_CACHED_IMAGES);
                });
              }
            }
            return networkResp;
          })
          .catch(() => {
            return new Response('', { status: 408 });
          });
      })
    );
    return;
  }

  // 4. API de Datos (/api/items, /api/tags): Stale-While-Revalidate ultra-rápido (0ms respuesta de caché con revalidación de fondo)
  const isApiReq = url.pathname.startsWith('/api/items') || url.pathname.startsWith('/api/tags');
  if (isApiReq) {
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

        // Si existe en caché local del Service Worker, devolverlo a 0ms sin esperar la red
        if (cached) {
          event.waitUntil(fetchPromise);
          return cached;
        }

        // Si es primera vez, esperar la respuesta de la red
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
