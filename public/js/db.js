const DB_NAME = 'pdrive_offline'
const DB_VERSION = 1
export const MAX_OFFLINE_SIZE = 5 * 1024 * 1024

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = (event) => {
      const db = event.target.result
      if (!db.objectStoreNames.contains('files')) {
        const store = db.createObjectStore('files', { keyPath: 'path' })
        store.createIndex('offline', 'offline', { unique: false })
      }
      if (!db.objectStoreNames.contains('pending')) {
        db.createObjectStore('pending', { keyPath: 'id', autoIncrement: true })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function waitTx(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve
    tx.onerror = () => reject(tx.error)
  })
}

export async function cacheFile(path, content, serverMtime, meta = {}) {
  const db = await openDB()
  const tx = db.transaction('files', 'readwrite')
  tx.objectStore('files').put({
    path,
    content,
    serverMtime,
    localMtime: Date.now(),
    mime: meta.mime || 'text/plain',
    contentType: meta.contentType || 'text',
    size: meta.size || content.length,
    offline: true,
    synced: true,
    pendingAction: null,
    ...meta,
  })
  return waitTx(tx)
}

export async function getCachedFile(path) {
  const db = await openDB()
  const tx = db.transaction('files', 'readonly')
  const req = tx.objectStore('files').get(path)
  const result = await new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return result
}

export async function isMarkedOffline(path) {
  const file = await getCachedFile(path)
  return file ? file.offline : false
}

export async function getAllOfflineFiles() {
  const db = await openDB()
  const tx = db.transaction('files', 'readonly')
  const req = tx.objectStore('files').getAll()
  const results = await new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return results.filter(f => f.offline)
}

export async function unmarkOffline(path) {
  const existing = await getCachedFile(path)
  if (!existing) return
  const db = await openDB()
  const tx = db.transaction('files', 'readwrite')
  tx.objectStore('files').delete(path)
  return waitTx(tx)
}

export async function toggleOffline(path, content, serverMtime, meta) {
  const existing = await getCachedFile(path)
  if (existing && existing.offline) {
    const db = await openDB()
    const tx = db.transaction('files', 'readwrite')
    tx.objectStore('files').delete(path)
    return waitTx(tx)
  }
  return cacheFile(path, content, serverMtime, meta)
}

export async function updateCachedContent(path, content) {
  const db = await openDB()
  const tx = db.transaction('files', 'readwrite')
  const store = tx.objectStore('files')
  const existing = await new Promise((resolve, reject) => {
    const req = store.get(path)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  if (existing) {
    store.put({ ...existing, content, localMtime: Date.now(), synced: false, pendingAction: 'update' })
  }
  return waitTx(tx)
}

export async function markSynced(path, serverMtime) {
  const db = await openDB()
  const tx = db.transaction('files', 'readwrite')
  const store = tx.objectStore('files')
  const existing = await new Promise((resolve, reject) => {
    const req = store.get(path)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  if (!existing) return waitTx(tx)
  store.put({
    ...existing,
    serverMtime: serverMtime !== undefined ? serverMtime : existing.serverMtime,
    synced: true,
    pendingAction: null,
    localMtime: Date.now(),
  })
  return waitTx(tx)
}

export async function addPendingAction(action) {
  const db = await openDB()
  const tx = db.transaction('pending', 'readwrite')
  tx.objectStore('pending').add({ ...action, createdAt: Date.now() })
  return waitTx(tx)
}

export async function getPendingActions() {
  const db = await openDB()
  const tx = db.transaction('pending', 'readonly')
  const req = tx.objectStore('pending').getAll()
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export async function removePendingAction(id) {
  const db = await openDB()
  const tx = db.transaction('pending', 'readwrite')
  tx.objectStore('pending').delete(id)
  return waitTx(tx)
}

