const CACHE_NAME = 'pdrive-v11'
const ASSETS_TO_CACHE = [
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
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS_TO_CACHE))
  )
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.map(k => { if (k !== CACHE_NAME) return caches.delete(k) }))
    )
  )
  self.clients.claim()
})

self.addEventListener('fetch', (event) => {
  if (event.request.url.startsWith(self.location.origin)) {
    event.respondWith(
      caches.match(event.request).then(cached =>
        cached || fetch(event.request)
      )
    )
  }
})
