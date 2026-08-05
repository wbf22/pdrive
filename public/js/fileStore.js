import * as api from './api.js'
import * as db from './db.js'

let onlineProvider = () => true

export function configure({ isOnline }) {
  if (typeof isOnline === 'function') onlineProvider = isOnline
}

const isOnline = () => onlineProvider()

export function base64ToArrayBuffer(b64) {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer
}

export async function readCached(path) {
  return db.getCachedFile(path)
}

export async function isMarkedOffline(path) {
  return db.isMarkedOffline(path)
}

export async function unmarkOffline(path) {
  return db.unmarkOffline(path)
}

// Read file content, choosing server vs offline cache automatically.
// opts.fromServer forces a network read (used by sync/conflict checks).
export async function readFile(path, { fromServer = false } = {}) {
  const cached = await db.getCachedFile(path)

  if (fromServer) {
    return { ...(await api.readFile(path)), source: 'server' }
  }

  if (!isOnline()) {
    if (!cached) throw new Error('This file is not available offline')
    return toFileData(cached)
  }

  // Pending local edits win until they've synced.
  if (cached && cached.offline && !cached.synced) {
    return toFileData(cached)
  }

  const data = await api.readFile(path)
  if (cached && cached.offline && data.type !== 'too_large') {
    await refreshCache(path, cached, data)
  }
  return { ...data, source: 'server' }
}

function toFileData(cached) {
  return {
    content: cached.content,
    mime: cached.mime,
    type: cached.contentType,
    size: cached.size,
    mtime: cached.serverMtime,
    source: 'cache',
  }
}

async function refreshCache(path, cached, data) {
  const size = data.content ? data.content.length : 0
  if (size >= db.MAX_OFFLINE_SIZE) return
  await db.cacheFile(path, data.content, data.mtime, {
    mime: data.mime || cached.mime || 'text/plain',
    contentType: data.type || cached.contentType || 'text',
    size,
  })
}

// Raw download for binary viewers / Download buttons. Returns a Response so
// callers can use r.arrayBuffer()/r.blob() whether online or offline.
export async function downloadFile(path) {
  if (isOnline()) return api.downloadFile(path)
  const cached = await db.getCachedFile(path)
  if (!cached) throw new Error('This file is not available offline')
  const mime = cached.mime || 'application/octet-stream'
  let blob
  if (cached.contentType === 'binary' || cached.contentType === 'image') {
    blob = new Blob([new Uint8Array(base64ToArrayBuffer(cached.content))], { type: mime })
  } else {
    blob = new Blob([cached.content], { type: mime })
  }
  return new Response(blob, { status: 200, headers: { 'Content-Type': mime } })
}

// List a directory. Online: server listing annotated with offline markers.
// Offline: the directory's entries derived from the offline cache.
export async function listFiles(path = '/') {
  if (isOnline()) {
    const data = await api.listFiles(path)
    const markers = await getMarkers()
    const files = (data.files || []).map(f => {
      if (!f.isDirectory && markers.has(f.path)) {
        f.offline = true
        f.pendingAction = markers.get(f.path) || null
      }
      return f
    })
    return { path: data.path || path, files }
  }
  return listOfflineDir(path)
}

async function getMarkers() {
  const offlineFiles = await db.getAllOfflineFiles()
  const pending = await db.getPendingActions()
  const markers = new Map()
  for (const f of offlineFiles) markers.set(f.path, '')
  for (const a of pending) if (markers.has(a.path)) markers.set(a.path, a.type)
  return markers
}

async function listOfflineDir(path) {
  const offlineFiles = await db.getAllOfflineFiles()
  const pending = await db.getPendingActions()
  const pendingMap = {}
  for (const a of pending) pendingMap[a.path] = a.type

  const prefix = path === '/' ? '' : path
  const entries = new Map()
  for (const f of offlineFiles) {
    if (!f.path.startsWith(prefix + '/')) continue
    const rest = f.path.slice(prefix.length).replace(/^\/+/, '')
    const parts = rest.split('/')
    const name = parts[0]
    if (parts.length === 1) {
      if (!entries.has(name)) {
        entries.set(name, {
          name,
          path: f.path,
          isDirectory: false,
          size: f.size || 0,
          mtime: f.serverMtime || 0,
          offline: true,
          pendingAction: pendingMap[f.path] || null,
        })
      }
    } else if (!entries.has(name)) {
      entries.set(name, {
        name,
        path: prefix ? prefix + '/' + name : '/' + name,
        isDirectory: true,
        size: 0,
        mtime: null,
      })
    }
  }
  return { path, files: [...entries.values()] }
}

// Save file content. Online: push to server and refresh the offline cache if
// marked. Offline: queue a pending update.
export async function writeFile(path, content, encoding) {
  if (isOnline()) {
    await api.writeFile(path, content, encoding)
    const cached = await db.getCachedFile(path)
    if (cached && cached.offline) {
      await db.cacheFile(path, content, cached.serverMtime, {
        mime: cached.mime || 'text/plain',
        contentType: cached.contentType || 'text',
        size: content ? content.length : 0,
      })
    }
    return { queued: false }
  }
  await db.updateCachedContent(path, content)
  await db.addPendingAction({ type: 'update', path, content, encoding })
  return { queued: true }
}

// Delete a file/folder. Online: hit the server. Offline: queue a pending delete.
export async function deleteFile(path, isDir) {
  if (isOnline()) {
    await api.deleteItem(path, isDir)
    return { queued: false }
  }
  await db.addPendingAction({ type: 'delete', path })
  await db.unmarkOffline(path)
  return { queued: true }
}

// Cache a file for offline use. Requires a connection.
export async function markOffline(path) {
  if (!isOnline()) {
    throw new Error('Cannot mark files for offline while offline — connect to the server first')
  }
  const data = await api.readFile(path)
  if (data.type === 'too_large') {
    throw new Error('File too large for offline caching')
  }
  const size = data.content ? data.content.length : 0
  if (size > db.MAX_OFFLINE_SIZE) {
    throw new Error('File too large for offline caching')
  }
  await db.cacheFile(path, data.content, data.mtime, {
    mime: data.mime || 'text/plain',
    contentType: data.type || 'text',
    size,
  })
}
