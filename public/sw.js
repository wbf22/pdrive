const VERSION = 'pdrive-v13'
const CACHE_NAME = `pdrive-${VERSION}`

// App shell precached on install so the first offline load works.
// New app files don't need to be added here — they're cached on first use.
const APP_SHELL = [
  '/',
  '/index.html',
  '/styles.css',
  '/manifest.json',
  '/lib/pdf.min.js',
  '/lib/pdf.worker.min.js',
  '/lib/mammoth.browser.min.js',
  '/js/api.js',
  '/js/app.js',
  '/js/db.js',
  '/js/treeView.js',
  '/js/pinchZoom.js',
  '/js/fullscreen.js',
  '/js/editors/textEditor.js',
  '/js/editors/imageViewer.js',
  '/js/editors/imageEditor.js',
  '/js/editors/markdownEditor.js',
  '/js/editors/csvEditor.js',
  '/js/editors/pdfViewer.js',
  '/js/editors/docxViewer.js',
  '/icons/android-chrome-192x192.png',
  '/icons/android-chrome-512x512.png',
  '/icons/apple-touch-icon.png',
  '/icons/favicon-16x16.png',
  '/icons/favicon-32x32.png',
  '/icons/favicon.ico',
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => Promise.allSettled(APP_SHELL.map(url => cache.add(url))))
      .then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

const isSameOrigin = (url) => url.startsWith(self.location.origin)
const isApiRequest = (url) => url.includes('/api/')

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET' || !isSameOrigin(request.url)) return
  // API calls are dynamic and token-scoped — never cache, always network.
  if (isApiRequest(request.url)) return

  // Page navigations: network-first, cached fallback.
  // Opens the app online → always gets the latest HTML.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.status === 200) {
            const copy = response.clone()
            caches.open(CACHE_NAME).then(cache => cache.put(request, copy))
          }
          return response
        })
        .catch(() => caches.match(request).then(r => r || caches.match('/index.html')))
    )
    return
  }

  // Static assets: stale-while-revalidate.
  // Serve from cache instantly, refresh it from the network in the background.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response && response.status === 200 && response.type === 'basic') {
            const copy = response.clone()
            caches.open(CACHE_NAME).then(cache => cache.put(request, copy))
          }
          return response
        })
        .catch(() => cached)
      return cached || network
    })
  )
})
