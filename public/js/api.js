const CHUNK_SIZE = 5 * 1024 * 1024

let _serverUrl = ''
let _authToken = ''

export function setServerUrl(url) {
  _serverUrl = url.replace(/\/+$/, '')
  localStorage.setItem('pdrive_server_url', _serverUrl)
}

export function getServerUrl() {
  return _serverUrl
}

export function setToken(token) {
  _authToken = token
  if (token) {
    sessionStorage.setItem('pdrive_auth_token', token)
  } else {
    sessionStorage.removeItem('pdrive_auth_token')
  }
}

export function getToken() {
  return _authToken
}

export function loadServerUrl() {
  _serverUrl = localStorage.getItem('pdrive_server_url') || ''
  return _serverUrl
}

export function loadToken() {
  _authToken = sessionStorage.getItem('pdrive_auth_token') || ''
  return _authToken
}

function headers(extra = {}) {
  const h = { ...extra }
  if (_authToken) {
    h['Authorization'] = `Bearer ${_authToken}`
  }
  return h
}

async function apiPost(endpoint, body) {
  const res = await fetch(`${_serverUrl}${endpoint}`, {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const data = await res.json()
  if (!res.ok) {
    if (res.status === 401) {
      setToken('')
      throw new Error('Unauthorized')
    }
    throw new Error(data.error || `Request failed (${res.status})`)
  }
  return data
}

export async function login(password) {
  const res = await fetch(`${_serverUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || 'Login failed')
  setToken(data.token)
  return data
}

export async function listFiles(path = '/') {
  return apiPost('/api/files/list', { path })
}

export async function readFile(path) {
  return apiPost('/api/files/read', { path })
}

export async function writeFile(path, content) {
  return apiPost('/api/files/write', { path, content })
}

export async function createFolder(path) {
  return apiPost('/api/files/mkdir', { path })
}

export async function deleteItem(path, isDirectory) {
  return apiPost('/api/files/delete', { path, isDirectory })
}

export async function moveItem(oldPath, newPath) {
  return apiPost('/api/files/move', { oldPath, newPath })
}

export async function uploadFile(filePath, file, onProgress) {
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE)
  const uploadId = crypto.randomUUID()
  const nameB64 = btoa(unescape(encodeURIComponent(filePath)))

  for (let i = 0; i < totalChunks; i++) {
    const start = i * CHUNK_SIZE
    const end = Math.min(start + CHUNK_SIZE, file.size)
    const chunk = file.slice(start, end)

    const res = await fetch(`${_serverUrl}/api/files/upload`, {
      method: 'POST',
      headers: headers({
        'Content-Type': 'application/octet-stream',
        'X-Upload-Id': uploadId,
        'X-Chunk-Index': String(i),
        'X-Total-Chunks': String(totalChunks),
        'X-File-Name': nameB64,
      }),
      body: chunk,
    })

    const data = await res.json()
    if (!res.ok) {
      if (res.status === 401) { setToken(''); throw new Error('Unauthorized') }
      throw new Error(data.error || `Upload failed at chunk ${i}`)
    }

    if (onProgress) {
      onProgress((i + 1) / totalChunks)
    }
  }

  return { success: true, path: filePath }
}

export async function downloadFile(path) {
  const url = `${_serverUrl}/api/files/download?path=${encodeURIComponent(path)}`
  const res = await fetch(url, {
    headers: headers(),
  })
  if (!res.ok) {
    if (res.status === 401) { setToken(''); throw new Error('Unauthorized') }
    throw new Error(`Download failed (${res.status})`)
  }
  return res
}

export async function healthCheck() {
  const res = await fetch(`${_serverUrl}/api/health`)
  if (!res.ok) throw new Error('Server unreachable')
  return res.json()
}

export async function checkConnectivity(timeoutMs = 2000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${_serverUrl}/api/health`, { signal: controller.signal })
    if (!res.ok) return false
    const data = await res.json()
    return data.server === 'pdrive'
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

export async function discoverServers(timeoutMs = 2000) {
  const ports = [8080, 8081, 9090, 3000, 5000, 8000, 80]
  const results = await Promise.allSettled(ports.map(async port => {
    const url = `http://pdrive.local:${port}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(`${url}/api/health`, { signal: controller.signal })
      if (!res.ok) throw new Error('no')
      const data = await res.json()
      if (data.server !== 'pdrive') throw new Error('not pdrive')
      return url
    } finally {
      clearTimeout(timer)
    }
  }))
  return results
    .filter(r => r.status === 'fulfilled')
    .map(r => r.value)
}
