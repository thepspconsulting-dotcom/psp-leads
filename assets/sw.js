/* PSP Lead Capture — Service Worker
 * Offline-first cache for shell + assets.
 * Strategy:
 *   - Pre-cache app shell on install
 *   - Cache-first for same-origin static assets
 *   - Network-first for Google Apps Script sync POSTs (so syncs always go through)
 *   - Stale-while-revalidate for Tesseract.js CDN files
 */
const CACHE_VERSION = 'psp-v1.0.0';
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;

const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './assets/logo.png',
  './assets/team.jpg',
  './assets/recruitment.pdf',
  './assets/consulting.pdf',
  './assets/icon-192.png',
  './assets/icon-512.png',
  './assets/icon-180.png',
  './assets/icon-maskable-512.png',
  // Tesseract CDN — pre-cached for offline OCR
  'https://cdn.jsdelivr.net/npm/tesseract.js@5.0.5/dist/tesseract.min.js',
  'https://cdn.jsdelivr.net/npm/tesseract.js@5.0.5/dist/worker.min.js',
  'https://cdn.jsdelivr.net/npm/tesseract.js-core@5.0.0/tesseract-core.wasm.js',
  'https://tessdata.projectnaptha.com/4.0.0/eng.traineddata.gz',
  // SheetJS for Excel export
  'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => {
      // Best-effort: don't fail install if a CDN url is temporarily down
      return Promise.allSettled(
        SHELL_ASSETS.map((u) =>
          cache.add(u).catch((e) => console.warn('[SW] skip cache', u, e.message))
        )
      );
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => !k.startsWith(CACHE_VERSION)).map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Apps Script sync: always go to network (don't cache POSTs)
  if (url.hostname.includes('script.google.com')) {
    return; // let it pass through
  }

  // Only handle GET
  if (req.method !== 'GET') return;

  // Tesseract / SheetJS CDN — stale-while-revalidate
  if (
    url.hostname === 'cdn.jsdelivr.net' ||
    url.hostname === 'tessdata.projectnaptha.com'
  ) {
    event.respondWith(staleWhileRevalidate(req));
    return;
  }

  // Same-origin: cache-first
  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirst(req));
  }
});

async function cacheFirst(req) {
  const cached = await caches.match(req);
  if (cached) return cached;
  try {
    const fresh = await fetch(req);
    if (fresh && fresh.status === 200) {
      const cache = await caches.open(STATIC_CACHE);
      cache.put(req, fresh.clone());
    }
    return fresh;
  } catch (e) {
    // Offline + not cached
    if (req.mode === 'navigate') {
      return caches.match('./index.html');
    }
    throw e;
  }
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(req);
  const fetchPromise = fetch(req)
    .then((response) => {
      if (response && response.status === 200) {
        cache.put(req, response.clone());
      }
      return response;
    })
    .catch(() => cached);
  return cached || fetchPromise;
}

// Listen for messages from the page (e.g., manual sync trigger)
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
