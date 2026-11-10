// Velvet Hub Ultra-Fast Turbo Service Worker (PC & Android Hardware-Accelerated Cache)
const STATIC_CACHE = 'velvet-static-v2';
const API_CACHE = 'velvet-api-v2';
const IMAGE_CACHE = 'velvet-images-v2';
const MAX_CACHED_IMAGES = 450;

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
          .filter((key) => ![STATIC_CACHE, API_CACHE, IMAGE_CACHE].includes(key))
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

  // 1. Exclusiones críticas: streaming de video, auth, admin
  if (
    url.pathname.startsWith('/api/video/stream') ||
    url.pathname.startsWith('/api/auth') ||
    url.pathname.startsWith('/api/admin')
  ) {
    return;
  }

  // 2. Caché de Imágenes (/api/image, /api/img, portadas y páginas de cómic): Cache First con fallback y guardado en segundo plano
  const isImageReq =
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
          // Devolver instantáneo desde caché local (0ms)
          return cached;
        }

        // Si no está en caché, descargar de la red y guardar copia
        return fetch(req)
          .then((networkResp) => {
            if (networkResp && networkResp.status === 200) {
              const respClone = networkResp.clone();
              caches.open(IMAGE_CACHE).then((cache) => {
                cache.put(req, respClone);
                trimCache(IMAGE_CACHE, MAX_CACHED_IMAGES);
              });
            }
            return networkResp;
          })
          .catch(() => {
            // Si falla la red y no hay caché, retornar fallback transparente si existe
            return caches.match('/velvet_logo.png');
          });
      })
    );
    return;
  }

  // 3. Caché de Datos API (/api/items, /api/tags, /api/random): Stale-While-Revalidate a 0ms
  const isApiReq = url.pathname.startsWith('/api/items') || url.pathname.startsWith('/api/tags');
  if (isApiReq) {
    event.respondWith(
      caches.open(API_CACHE).then((cache) => {
        return cache.match(req).then((cached) => {
          const fetchPromise = fetch(req)
            .then((networkResp) => {
              if (networkResp && networkResp.status === 200) {
                cache.put(req, networkResp.clone());
              }
              return networkResp;
            })
            .catch(() => cached);

          // Si hay respuesta previa en caché, devolverla a 0 milisegundos mientras la red se actualiza en segundo plano
          return cached || fetchPromise;
        });
      })
    );
    return;
  }

  // 4. Recursos Estáticos de la App Shell (HTML, JS, CSS, Fuentes): Stale-While-Revalidate
  if (
    url.pathname === '/' ||
    url.pathname.startsWith('/_next/static') ||
    url.pathname.endsWith('.woff2') ||
    url.hostname.includes('cdnjs.cloudflare.com') ||
    url.hostname.includes('fonts.googleapis.com') ||
    url.hostname.includes('fonts.gstatic.com')
  ) {
    event.respondWith(
      caches.match(req).then((cached) => {
        const fetchPromise = fetch(req)
          .then((networkResp) => {
            if (networkResp && networkResp.status === 200) {
              const clone = networkResp.clone();
              caches.open(STATIC_CACHE).then((cache) => {
                cache.put(req, clone);
              });
            }
            return networkResp;
          })
          .catch(() => cached);

        return cached || fetchPromise;
      })
    );
    return;
  }
});
