import { TreeView } from './treeView.js'
import { TextEditor } from './editors/textEditor.js'
import { ImageViewer } from './editors/imageViewer.js'
import { MarkdownEditor } from './editors/markdownEditor.js'
import { CSVEditor } from './editors/csvEditor.js'
import { PDFViewer } from './editors/pdfViewer.js'
import { DocxViewer } from './editors/docxViewer.js'

import * as api from './api.js'
import * as db from './db.js'

class PDriveApp {
  constructor() {
    this.activeFilePath = null
    this.activeEditor = null
    this.ctxTarget = null
    this.isOnline = false
    this._syncing = false
    this._syncRetryTimer = null
    this.pendingOpenPath = null
    this._deepLinkOpened = false
    this.favorites = new Set()

    this.initDOM()
    this.initPWA()
    this.initConnectivityTracking()
    this.initDeepLinks()
    this.loadFavorites()
    this.renderHomeView()
    this.initAuth()
  }

  // ----- DOM Setup --------------------------------------------------
  initDOM() {
    this.loginModal = document.getElementById('loginModal')
    this.loginInput = document.getElementById('loginInput')
    this.loginSubmit = document.getElementById('loginSubmit')
    this.loginError = document.getElementById('loginError')
    this.loginRemember = document.getElementById('loginRemember')

    this.serverModal = document.getElementById('serverModal')
    this.serverUrlInput = document.getElementById('serverUrlInput')
    this.serverSubmit = document.getElementById('serverSubmit')
    this.discoverBtn = document.getElementById('discoverBtn')
    this.discoverStatus = document.getElementById('discoverStatus')

    this.actionModal = document.getElementById('actionModal')
    this.actionTitle = document.getElementById('actionModalTitle')
    this.actionBody = document.getElementById('actionModalBody')
    this.actionFooter = document.getElementById('actionModalFooter')

    this.confirmModal = document.getElementById('confirmModal')
    this.confirmTitle = document.getElementById('confirmTitle')
    this.confirmMsg = document.getElementById('confirmMsg')
    this.confirmCancel = document.getElementById('confirmCancel')
    this.confirmOk = document.getElementById('confirmOk')

    this.sidebar = document.getElementById('sidebar')
    this.treeContainer = document.getElementById('treeContainer')
    this.editorContainer = document.getElementById('editorContainer')
    this.breadcrumbPath = document.getElementById('breadcrumbPath')
    this.toastEl = document.getElementById('toast')
    this.contextMenu = document.getElementById('contextMenu')

    this.fileDeleteBtn = document.getElementById('fileDeleteBtn')
    this.fileOfflineBtn = document.getElementById('fileOfflineBtn')
    this.fileCopyLinkBtn = document.getElementById('fileCopyLinkBtn')
    this.fileFavBtn = document.getElementById('fileFavBtn')
    this.homeView = document.getElementById('homeView')
    this.statusIndicator = document.getElementById('statusIndicator')

    document.getElementById('toggleMobileDrawer').addEventListener('click', () => {
      this.sidebar.classList.toggle('open')
    })

    // On mobile, tapping the main view closes the explorer drawer.
    this.editorContainer.addEventListener('click', () => {
      if (window.matchMedia('(max-width: 768px)').matches) {
        this.sidebar.classList.remove('open')
      }
    })

    document.getElementById('openServerSettingsBtn').addEventListener('click', () => {
      this.openServerSettings()
    })

    document.getElementById('brandHomeBtn').addEventListener('click', () => {
      this.showHome()
    })

    document.getElementById('lockAppBtn').addEventListener('click', () => {
      this.logout()
    })

    document.getElementById('closeServerModal').addEventListener('click', () => {
      this.serverModal.classList.add('hidden')
    })

    this.discoverBtn.addEventListener('click', () => this.handleDiscover())

    document.getElementById('closeActionModal').addEventListener('click', () => {
      this.actionModal.classList.add('hidden')
    })

    document.getElementById('treeNewFileBtn').addEventListener('click', () => this.showNewFileModal())
    document.getElementById('treeNewFolderBtn').addEventListener('click', () => this.showNewFolderModal())
    document.getElementById('treeUploadBtn').addEventListener('click', () => document.getElementById('hiddenFileInput').click())
    document.getElementById('treeRefreshBtn').addEventListener('click', () => this.loadTree())
    document.getElementById('hiddenFileInput').addEventListener('change', e => this.handleFileUpload(e))

    this.fileDeleteBtn.addEventListener('click', () => this.showDeleteModal())
    this.fileOfflineBtn.addEventListener('click', () => this.toggleActiveFileOffline())
    this.fileCopyLinkBtn.addEventListener('click', () => this.copyFileLink(this.activeFilePath))
    this.fileFavBtn.addEventListener('click', () => this.toggleFavorite(this.activeFilePath))
    document.getElementById('loginRemember').addEventListener('change', (e) => {
      document.getElementById('pinFieldGroup').classList.toggle('hidden', !e.target.checked)
    })

    this.contextMenu.querySelectorAll('.ctx-item').forEach(btn => {
      btn.addEventListener('click', e => {
        const action = e.currentTarget.getAttribute('data-action')
        this.hideContextMenu()
        this.handleContextAction(action)
      })
    })
    // Close the context menu when tapping/clicking anywhere outside it.
    // Uses pointerdown so it fires even when other handlers stop propagation
    // of the subsequent click event (e.g. tree node clicks).
    document.addEventListener('pointerdown', e => {
      if (this.contextMenu.classList.contains('hidden')) return
      if (this.contextMenu.contains(e.target)) return
      this.hideContextMenu()
    })

    this.serverUrlInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') this.serverSubmit.click()
    })
    this.loginInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') this.loginSubmit.click()
    })

    this.treeView = new TreeView(this.treeContainer, {
      onSelectFile: filePath => this.openFile(filePath),
      onContextMenu: (node, x, y) => this.showContextMenu(node, x, y),
      onMove: (path, newPath, isDir) => this.handleTreeMove(path, newPath, isDir),
      fetchChildren: async dirPath => {
        const data = await api.listFiles(dirPath)
        const node = this.treeView.getNodeByPath(this.treeView.treeData, dirPath)
        if (node) {
          node.children = data.files.map(f => ({
            name: f.name,
            path: f.path,
            isDirectory: f.isDirectory,
            size: f.size,
            children: f.isDirectory ? [] : null,
          }))
        }
      },
    })

    // Keyboard shortcuts
    window.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault()
        this.saveActiveFile()
      }
    })
  }

  initPWA() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js')
        .then(() => {})
        .catch(() => {})
    }
  }

  // ----- Deep Links --------------------------------------------------
  // Every document gets a stable URL. Two forms:
  //   /d/<path>  — manifest-less page: Firefox offers "Add to Home screen"
  //                (a URL shortcut) instead of "Install", so home-screen
  //                shortcuts keep the exact URL and open the right document.
  //   #/file/<path> — plain in-app route (browser nav, back/forward).
  initDeepLinks() {
    this.pendingOpenPath = this.routeFromURL()?.path || null
    window.addEventListener('hashchange', () => {
      const route = this.parseRoute()
      if (route && route.path !== this.activeFilePath) {
        this.openFile(route.path)
      }
    })
  }

  routeFromURL() {
    const path = window.location.pathname
    if (path.startsWith('/d/')) {
      const raw = decodeURIComponent(path.slice('/d/'.length))
      if (!raw) return null
      return { type: 'file', path: raw }
    }
    return this.parseRoute()
  }

  parseRoute() {
    const hash = window.location.hash || ''
    if (!hash.startsWith('#/file/')) return null
    const raw = hash.slice('#/file/'.length)
    if (!raw) return null
    try {
      const path = raw.split('/').map(s => decodeURIComponent(s)).join('/')
      return { type: 'file', path }
    } catch {
      return null
    }
  }

  encodeRoutePath(filePath) {
    return String(filePath).split('/').map(s => encodeURIComponent(s)).join('/')
  }

  setRoute(filePath) {
    // Stay on a /d/ deep link untouched: rewriting it would re-introduce the
    // manifest and break the URL-preserving "Add to Home screen" shortcut.
    if (window.location.pathname.startsWith('/d/')) return
    const hash = filePath
      ? '#/file/' + this.encodeRoutePath(filePath)
      : window.location.pathname
    history.replaceState(null, '', hash)
  }

  clearRoute() {
    history.replaceState(null, '',
      window.location.pathname.startsWith('/d/') ? '/' : window.location.pathname)
  }

  async maybeOpenDeepLink() {
    if (!this.pendingOpenPath || this._deepLinkOpened) return
    this._deepLinkOpened = true
    const path = this.pendingOpenPath
    this.pendingOpenPath = null
    if (!this.isOnline) {
      const cached = await db.getCachedFile(path)
      if (!cached) {
        this.showToast('This document is not available offline')
        return
      }
    }
    this.openFile(path)
  }

  async copyFileLink(filePath) {
    if (!filePath) return
    const url = window.location.origin + '/d/' + encodeURIComponent(filePath)
    try {
      await navigator.clipboard.writeText(url)
      this.showToast('Link copied')
    } catch {
      try {
        const ta = document.createElement('textarea')
        ta.value = url
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
        this.showToast('Link copied')
      } catch {
        this.showToast('Could not copy link')
      }
    }
  }

  // ----- Favorites ---------------------------------------------------
  loadFavorites() {
    this.favorites = new Set()
    try {
      const raw = localStorage.getItem('pdrive_favorites')
      if (raw) {
        const arr = JSON.parse(raw)
        if (Array.isArray(arr)) {
          for (const p of arr) {
            if (typeof p === 'string' && p) this.favorites.add(p)
          }
        }
      }
    } catch { /* ignore */ }
  }

  saveFavorites() {
    try {
      localStorage.setItem('pdrive_favorites', JSON.stringify([...this.favorites]))
    } catch { /* ignore */ }
  }

  isFavorited(filePath) {
    return this.favorites.has(filePath)
  }

  toggleFavorite(filePath) {
    if (!filePath) return
    if (this.favorites.has(filePath)) {
      this.favorites.delete(filePath)
      this.showToast('Removed from favorites')
    } else {
      this.favorites.add(filePath)
      this.showToast('Added to favorites')
    }
    this.saveFavorites()
    this.updateFavBtn()
    if (!this.activeFilePath) this.renderHomeView()
  }

  // Drop favorites for a deleted file/directory (and anything nested in it).
  removeFavoriteForPath(path, isDir) {
    let removed = false
    if (isDir) {
      const prefix = path.endsWith('/') ? path : path + '/'
      for (const p of [...this.favorites]) {
        if (p === path || p.startsWith(prefix)) {
          this.favorites.delete(p)
          removed = true
        }
      }
    } else if (this.favorites.has(path)) {
      this.favorites.delete(path)
      removed = true
    }
    if (removed) {
      this.saveFavorites()
      if (!this.activeFilePath) this.renderHomeView()
    }
  }

  // Rewrite favorites when a file/directory is renamed or moved.
  moveFavoritePath(oldPath, newPath, isDir) {
    const prefix = oldPath.endsWith('/') ? oldPath : oldPath + '/'
    let changed = false
    const updated = new Set()
    for (const p of this.favorites) {
      if (isDir && (p === oldPath || p.startsWith(prefix))) {
        updated.add(newPath + p.slice(oldPath.length))
        changed = true
      } else if (!isDir && p === oldPath) {
        updated.add(newPath)
        changed = true
      } else {
        updated.add(p)
      }
    }
    if (changed) {
      this.favorites = updated
      this.saveFavorites()
    }
  }

  updateFavBtn() {
    if (!this.fileFavBtn) return
    const fav = !!this.activeFilePath && this.isFavorited(this.activeFilePath)
    this.fileFavBtn.textContent = fav ? '★' : '☆'
    this.fileFavBtn.title = fav ? 'Remove from favorites' : 'Star this file'
  }

  updateCtxFav() {
    const el = document.getElementById('ctxFav')
    if (!el || !this.ctxTarget) return
    el.textContent = this.isFavorited(this.ctxTarget.path)
      ? '★ Remove from Favorites'
      : '⭐ Add to Favorites'
  }

  fileNameFromPath(filePath) {
    return String(filePath).split('/').filter(Boolean).pop() || filePath
  }

  fileIcon(filename) {
    const ext = filename.split('.').pop().toLowerCase()
    switch (ext) {
      case 'csv': return '📊'
      case 'md': return '📝'
      case 'png': case 'jpg': case 'jpeg': case 'gif': case 'svg': case 'webp': return '🖼️'
      case 'pdf': return '📕'
      case 'docx': return '📘'
      case 'js': case 'json': case 'html': case 'css': case 'py': return '⚡'
      default: return '📄'
    }
  }

  // Make sure the home view element exists in the DOM (openFile may have
  // replaced editorContainer's contents since it was last rendered).
  ensureHomeView() {
    if (!this.homeView || !this.editorContainer.contains(this.homeView)) {
      this.editorContainer.innerHTML = '<div class="welcome-screen" id="homeView"></div>'
      this.homeView = document.getElementById('homeView')
    }
    return this.homeView
  }

  renderHomeView() {
    this.ensureHomeView()
    if (!this.homeView) return
    const favs = [...this.favorites].sort((a, b) =>
      this.fileNameFromPath(a).localeCompare(this.fileNameFromPath(b)))

    let body
    if (favs.length === 0) {
      body = `<p class="home-empty">No starred files yet — star a document to pin it here.</p>`
    } else {
      body = `<div class="fav-grid">${favs.map(p => {
        const name = this.fileNameFromPath(p)
        const folder = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '/'
        return `
          <button class="fav-card" data-path="${this.escapeHTML(p).replace(/"/g, '&quot;')}">
            <span class="fav-icon">${this.fileIcon(name)}</span>
            <span class="fav-name">${this.escapeHTML(name)}</span>
            <span class="fav-folder">${this.escapeHTML(folder)}</span>
            <span class="fav-unstar" title="Remove from favorites">★</span>
          </button>`
      }).join('')}</div>`
    }

    this.homeView.innerHTML = `
      <div class="home-inner">
        <h2 class="home-title">⭐ Starred files</h2>
        ${body}
      </div>`

    this.homeView.querySelectorAll('.fav-card').forEach(card => {
      card.addEventListener('click', e => {
        e.stopPropagation()
        if (e.target.classList.contains('fav-unstar')) {
          const path = card.getAttribute('data-path')
          this.favorites.delete(path)
          this.saveFavorites()
          this.updateFavBtn()
          this.renderHomeView()
        } else {
          this.openFile(card.getAttribute('data-path'))
        }
      })
    })
  }

  // Reset the workspace to the "no active file" state and show favorites.
  showHome() {
    this.activeFilePath = null
    this.fileDeleteBtn.disabled = true
    this.fileOfflineBtn.disabled = true
    this.fileCopyLinkBtn.disabled = true
    this.fileFavBtn.disabled = true
    this.updateFavBtn()
    this.updateBreadcrumb('/')
    this.renderHomeView()
  }


  initConnectivityTracking() {
    window.addEventListener('online', () => this.checkConnectivityAndSync())
    window.addEventListener('offline', () => {
      this.isOnline = false
      this.updateStatusIndicator()
      this.loadOfflineTree()
      this.startSyncRetry()
    })
  }

  async checkConnectivityAndSync() {
    this.isOnline = await api.checkConnectivity()
    this.updateStatusIndicator()
    if (this.isOnline) {
      await this.syncOfflineChanges()
      await this.loadTree()
      this.maybeOpenDeepLink()
      this.stopSyncRetry()
    } else {
      this.loadOfflineTree()
      this.maybeOpenDeepLink()
      if (!this.activeFilePath) this.renderHomeView()
      this.startSyncRetry()
    }
  }

  // Run once we're authenticated and the server is reachable.
  async syncAndReload() {
    this.isOnline = true
    this.updateStatusIndicator()
    // Render the file tree first so the UI isn't blank while offline
    // changes sync in the background.
    await this.loadTree()
    this.maybeOpenDeepLink()
    if (!this.activeFilePath) this.renderHomeView()
    this.syncOfflineChanges()
      .then(() => this.loadTree())
      .catch(() => {})
  }

  // Keep retrying in the background when the server is unreachable so
  // offline edits aren't stuck until the next network transition.
  startSyncRetry() {
    if (this._syncRetryTimer) return
    this._syncRetryTimer = setInterval(async () => {
      this.isOnline = await api.checkConnectivity()
      this.updateStatusIndicator()
      if (this.isOnline) {
        await this.syncOfflineChanges()
        await this.loadTree()
        this.stopSyncRetry()
      }
    }, 30000)
  }

  stopSyncRetry() {
    if (this._syncRetryTimer) {
      clearInterval(this._syncRetryTimer)
      this._syncRetryTimer = null
    }
  }

  updateStatusIndicator() {
    if (!this.statusIndicator) return
    if (this.isOnline) {
      this.statusIndicator.textContent = '🟢'
      this.statusIndicator.title = 'Connected'
    } else {
      this.statusIndicator.textContent = '🔴'
      this.statusIndicator.title = 'Offline'
    }
  }

  // ----- Auth Flow --------------------------------------------------
  async initAuth() {
    // Populate _serverUrl from storage first so the saved-password key
    // ('pdrive_pass_' + serverUrl) resolves to the same location it was saved.
    api.loadServerUrl()
    const saved = this.getSavedPassword()
    let triedSavedLogin = false

    // Auto-login with a saved (non-PIN) password so the unlock popup only
    // appears when nothing is remembered (or the password is PIN-protected).
    if (!api.getToken() && saved && !saved.pin) {
      triedSavedLogin = true
      try {
        await api.login(saved.data)
      } catch { /* handled below */ }
    }

    // Verify the token actually works. Tokens live only in server memory, so a
    // server restart invalidates every token. Without this check listFiles()
    // would 401 and the tree would silently stay empty.
    if (api.getToken()) {
      try {
        await api.listFiles('/')
        this.isOnline = true
        this.updateStatusIndicator()
        await this.syncAndReload()
        return
      } catch {
        // On 401 apiPost() clears the token. If it's still set, the server was
        // just unreachable — go straight to the offline fallback.
        if (api.getToken()) {
          return this.showOfflineFallback()
        }
        // Token was invalidated — fall through and re-login below.
      }
    }

    // Token missing or invalidated (e.g. server restart). Re-authenticate with
    // the saved password before resorting to the login screen.
    if (saved && !saved.pin && !triedSavedLogin) {
      try {
        await api.login(saved.data)
        this.isOnline = true
        this.updateStatusIndicator()
        await this.syncAndReload()
        return
      } catch { /* wrong password or unreachable — fall through */ }
    }

    return this.showOfflineFallback()
  }

  async showOfflineFallback() {
    this.isOnline = false
    this.updateStatusIndicator()
    const offlineFiles = await db.getAllOfflineFiles()
    if (offlineFiles.length > 0) {
      this.loadOfflineTree()
      this.maybeOpenDeepLink()
      if (!this.activeFilePath) this.renderHomeView()
    } else if (api.loadServerUrl()) {
      this.showLogin()
    } else {
      this.openServerSettings()
    }
  }

  openServerSettings() {
    this.serverUrlInput.value = api.getServerUrl() || 'http://'
    this.serverModal.classList.remove('hidden')
    this.serverUrlInput.focus()
    this.serverUrlInput.select()

    this.serverSubmit.onclick = () => {
      const url = this.serverUrlInput.value.trim()
      if (!url) return
      api.setServerUrl(url)
      this.serverModal.classList.add('hidden')
      api.loadToken()
      if (!api.getToken()) {
        this.showLogin()
      } else {
        this.syncAndReload()
      }
    }
  }

  async handleDiscover() {
    this.discoverBtn.disabled = true
    this.discoverStatus.textContent = 'Searching for PDrive server on the network...'
    this.discoverStatus.classList.remove('hidden')

    try {
      const servers = await api.discoverServers()
      if (servers.length > 0) {
        this.serverUrlInput.value = servers[0]
        this.discoverStatus.textContent = `Found server at ${servers[0]}`
        if (servers.length > 1) {
          this.discoverStatus.textContent += ` (+ ${servers.length - 1} more)`
        }
      } else {
        this.discoverStatus.textContent = 'No PDrive server found on the network'
      }
    } catch (err) {
      this.discoverStatus.textContent = 'Discovery failed: ' + err.message
    } finally {
      this.discoverBtn.disabled = false
    }
  }

  // ----- Password Save / Encrypt helpers ----------------------------
  getSavedPassword() {
    const candidates = [
      'pdrive_pass_' + api.getServerUrl(),
      'pdrive_pass_' + api.getServerUrl().replace(/\/+$/, ''),
      'pdrive_pass_',
    ].filter((v, i, a) => v && a.indexOf(v) === i)
    for (const key of candidates) {
      const raw = localStorage.getItem(key)
      if (!raw) continue
      try {
        const data = JSON.parse(raw)
        if (data.pin) return { pin: true, data: data }
        return { pin: false, data: atob(data) }
      } catch {
        // Legacy: raw base64 without JSON wrapper
        return { pin: false, data: atob(raw) }
      }
    }
    return null
  }

  clearSavedPassword() {
    const url = api.getServerUrl()
    localStorage.removeItem('pdrive_pass_' + url)
    localStorage.removeItem('pdrive_pass_' + url.replace(/\/+$/, ''))
    localStorage.removeItem('pdrive_pass_')
  }

  async savePassword(password, pin = null) {
    const key = 'pdrive_pass_' + api.getServerUrl()
    if (pin) {
      const encrypted = await this.encryptWithPin(password, pin)
      localStorage.setItem(key, JSON.stringify(encrypted))
    } else {
      localStorage.setItem(key, btoa(password))
    }
  }

  async encryptWithPin(password, pin) {
    const encoder = new TextEncoder()
    const salt = crypto.getRandomValues(new Uint8Array(16))
    const keyMaterial = await crypto.subtle.importKey(
      'raw', encoder.encode(pin), 'PBKDF2', false, ['deriveKey']
    )
    const key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt']
    )
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      encoder.encode(password)
    )
    return {
      salt: Array.from(salt).map(b => b.toString(16).padStart(2, '0')).join(''),
      iv: Array.from(iv).map(b => b.toString(16).padStart(2, '0')).join(''),
      data: Array.from(new Uint8Array(ciphertext)).map(b => b.toString(16).padStart(2, '0')).join(''),
    }
  }

  async decryptWithPin(encrypted, pin) {
    const encoder = new TextEncoder()
    const salt = new Uint8Array(encrypted.salt.match(/.{2}/g).map(b => parseInt(b, 16)))
    const iv = new Uint8Array(encrypted.iv.match(/.{2}/g).map(b => parseInt(b, 16)))
    const data = new Uint8Array(encrypted.data.match(/.{2}/g).map(b => parseInt(b, 16)))
    const keyMaterial = await crypto.subtle.importKey(
      'raw', encoder.encode(pin), 'PBKDF2', false, ['deriveKey']
    )
    const key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt']
    )
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data)
    return new TextDecoder().decode(plaintext)
  }

  showLogin() {
    const saved = this.getSavedPassword()
    const pwForm = document.getElementById('loginPasswordForm')
    const pinUnlock = document.getElementById('loginPinUnlock')

    this.loginError.classList.add('hidden')

    if (saved) {
      // Saved password exists
      if (saved.pin) {
        // PIN-protected — show PIN unlock
        pwForm.classList.add('hidden')
        pinUnlock.classList.remove('hidden')
        document.getElementById('loginPinUnlockInput').value = ''
        document.getElementById('loginPinUnlockInput').focus()
        this.loginModal.classList.remove('hidden')

        this.loginSubmit.onclick = async () => {
          const pin = document.getElementById('loginPinUnlockInput').value.trim()
          if (!pin) return
          try {
            const password = await this.decryptWithPin(saved.data, pin)
            await api.login(password)
            this.loginModal.classList.add('hidden')
            await this.syncAndReload()
          } catch (err) {
            this.loginError.textContent = err.message || 'Wrong PIN or login failed'
            this.loginError.classList.remove('hidden')
          }
        }
        document.getElementById('loginForgetBtn').onclick = () => {
          this.clearSavedPassword()
          this.showLogin()
        }
        document.getElementById('loginPinUnlockInput').onkeydown = e => {
          if (e.key === 'Enter') this.loginSubmit.click()
        }
      } else {
        // No PIN — auto-fill, let user edit and re-submit
        pwForm.classList.remove('hidden')
        pinUnlock.classList.add('hidden')
        document.getElementById('loginInput').value = saved.data
        document.getElementById('loginRemember').checked = true
        document.getElementById('pinFieldGroup').classList.add('hidden')
        this.loginModal.classList.remove('hidden')
        this.loginInput.focus()
        this.loginInput.select()

        this.loginSubmit.onclick = async () => {
          const pw = document.getElementById('loginInput').value.trim()
          if (!pw) return
          try {
            await api.login(pw)
            const remember = document.getElementById('loginRemember').checked
            if (remember) {
              const pin = document.getElementById('loginPinInput').value.trim()
              await this.savePassword(pw, pin || null)
            } else {
              this.clearSavedPassword()
            }
            this.loginModal.classList.add('hidden')
            await this.syncAndReload()
          } catch (err) {
            this.loginError.textContent = err.message || 'Login failed'
            this.loginError.classList.remove('hidden')
          }
        }
      }
    } else {
      // No saved password — show normal form
      pwForm.classList.remove('hidden')
      pinUnlock.classList.add('hidden')
      this.loginInput.value = ''
      this.loginRemember.checked = false
      document.getElementById('pinFieldGroup').classList.add('hidden')
      this.loginModal.classList.remove('hidden')
      this.loginInput.focus()

      this.loginSubmit.onclick = async () => {
        const pw = this.loginInput.value.trim()
        if (!pw) return
        try {
          await api.login(pw)
          const remember = this.loginRemember.checked
          if (remember) {
            const pin = document.getElementById('loginPinInput').value.trim()
            await this.savePassword(pw, pin || null)
          }
          this.loginModal.classList.add('hidden')
          await this.syncAndReload()
        } catch (err) {
          this.loginError.textContent = err.message || 'Login failed'
          this.loginError.classList.remove('hidden')
        }
      }
    }

  }

  logout() {
    this.stopSyncRetry()
    api.setToken('')
    this.activeFilePath = null
    this.clearRoute()
    this.updateFavBtn()
    this.editorContainer.innerHTML = '<div class="welcome-screen"><h2>Locked</h2></div>'
    this.showLogin()
  }

  // ----- File Tree --------------------------------------------------
  async loadTree() {
    try {
      const data = await api.listFiles('/')
      const rootNode = {
        path: '/',
        name: 'Root',
        isDirectory: true,
        children: (data.files || []).map(f => {
          const child = {
            name: f.name,
            path: f.path,
            isDirectory: f.isDirectory,
            size: f.size,
            children: f.isDirectory ? [] : null,
          }
          return child
        }),
      }
      // Merge offline markers into the tree
      const offlineFiles = await db.getAllOfflineFiles()
      const offlinePaths = new Set(offlineFiles.map(f => f.path))
      this._markOfflineInTree(rootNode, offlinePaths)
      this.treeView.setTreeData(rootNode)
    } catch (err) {
      this.showToast('Error loading tree: ' + err.message)
    }
  }

  _markOfflineInTree(node, offlinePaths) {
    if (!node.children) return
    for (const child of node.children) {
      if (!child.isDirectory && offlinePaths.has(child.path)) {
        child.offline = true
        // Check for pending actions on this file
        const cached = offlinePaths.has(child.path) ? { path: child.path } : null
        if (cached) {
          // We'll handle pending state in loadOfflineTree
        }
      }
      if (child.isDirectory) {
        this._markOfflineInTree(child, offlinePaths)
      }
    }
  }

  async loadOfflineTree() {
    const offlineFiles = await db.getAllOfflineFiles()
    const rootNode = { path: '/', name: 'Root', isDirectory: true, children: [] }
    const pendingActions = await db.getPendingActions()
    const pendingMap = {}
    for (const a of pendingActions) {
      pendingMap[a.path] = a.type
    }

    // Build tree from flat paths
    for (const f of offlineFiles) {
      const parts = f.path.split('/').filter(Boolean)
      let current = rootNode
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i]
        const isLast = i === parts.length - 1
        const partialPath = '/' + parts.slice(0, i + 1).join('/')
        if (isLast) {
          current.children.push({
            name: part,
            path: partialPath,
            isDirectory: false,
            children: null,
            offline: true,
            pendingAction: pendingMap[f.path] || null,
          })
        } else {
          let dir = current.children.find(c => c.isDirectory && c.name === part)
          if (!dir) {
            dir = { name: part, path: partialPath, isDirectory: true, children: [] }
            current.children.push(dir)
          }
          current = dir
        }
      }
    }
    this.treeView.setTreeData(rootNode)
  }

  // ----- Open / Edit Files ------------------------------------------
  async openFile(filePath) {
    this.activeFilePath = filePath
    this.updateBreadcrumb(filePath)
    this.setRoute(filePath)
    this.fileDeleteBtn.disabled = false
    this.fileOfflineBtn.disabled = false
    this.fileCopyLinkBtn.disabled = false
    this.fileFavBtn.disabled = false
    this.updateFavBtn()
    this.sidebar.classList.remove('open')
    // Set offline button label
    db.isMarkedOffline(filePath).then(offline => {
      this.fileOfflineBtn.textContent = offline ? 'Online Only' : 'Offline'
    })

    this.editorContainer.innerHTML = '<div class="welcome-screen"><h3>Loading file...</h3></div>'

    try {
      let fileData
      if (this.isOnline) {
        const cached = await db.getCachedFile(filePath)
        if (cached && cached.offline && !cached.synced) {
          // Unsynced local edits exist — show those until sync completes.
          fileData = {
            type: cached.contentType,
            mime: cached.mime,
            content: cached.content,
          }
        } else {
          fileData = await api.readFile(filePath)
          // Cache for offline if marked
          if (cached && cached.offline) {
            const size = fileData.content ? fileData.content.length : 0
            if (size < db.MAX_OFFLINE_SIZE) {
              await db.cacheFile(filePath, fileData.content, fileData.mtime, {
                mime: fileData.mime || 'text/plain',
                contentType: fileData.type || 'text',
                size,
              })
            }
          }
        }
      } else {
        const cached = await db.getCachedFile(filePath)
        if (!cached) {
          alert('This file is not available offline')
          return
        }
        fileData = {
          type: cached.contentType,
          mime: cached.mime,
          content: cached.content,
        }
      }

      const ext = filePath.split('.').pop().toLowerCase()
      const content = fileData.content

      if (fileData.type === 'too_large' || fileData.size > 12 * 1024 * 1024) {
        const fileName = filePath.split('/').pop() || filePath
        this.editorContainer.innerHTML = `
          <div class="welcome-screen">
            <div class="welcome-card" style="text-align:center">
              <h3>📄 ${this.escapeHTML(fileName)}</h3>
              <p style="color:var(--text-muted);margin-top:12px">
                This file is too large to display (${(fileData.size / 1024 / 1024).toFixed(1)} MB).
                <br>Max display size: 12 MB.
              </p>
            </div>
          </div>
        `
        return
      }

      if (fileData.type === 'image') {
        const viewer = new ImageViewer(this.editorContainer, (base64Data, encoding) => this.saveFile(base64Data, encoding || 'base64'))
        viewer.render(content, fileData.mime, filePath.split('/').pop())
        this.activeEditor = viewer
      } else if (ext === 'csv') {
        const csvEd = new CSVEditor(this.editorContainer, csv => this.saveFile(csv), msg => this.showToast(msg))
        csvEd.render(content)
        this.activeEditor = csvEd
      } else if (ext === 'md') {
        const mdEd = new MarkdownEditor(this.editorContainer, md => this.saveFile(md))
        mdEd.render(content)
        this.activeEditor = mdEd
      } else if (ext === 'pdf') {
        const viewer = new PDFViewer(this.editorContainer, null)
        viewer.render(filePath)
        this.activeEditor = viewer
      } else if (ext === 'docx') {
        const viewer = new DocxViewer(this.editorContainer, null)
        viewer.render(filePath)
        this.activeEditor = viewer
      } else {
        const textEd = new TextEditor(this.editorContainer, text => this.saveFile(text))
        textEd.render(content, filePath)
        this.activeEditor = textEd
      }
    } catch (err) {
      alert('Failed to read file: ' + err.message)
    }
  }

  async saveFile(content, encoding) {
    if (!this.activeFilePath) return
    if (this.isOnline) {
      try {
        await api.writeFile(this.activeFilePath, content, encoding)
        // Update offline cache if this file is marked
        if (await db.isMarkedOffline(this.activeFilePath)) {
          const cached = await db.getCachedFile(this.activeFilePath)
          if (cached) {
            await db.cacheFile(this.activeFilePath, content, cached.serverMtime, {
              mime: cached.mime,
              contentType: cached.contentType,
              size: content.length,
            })
          }
        }
        this.showToast('File saved!')
      } catch (err) {
        alert('Save failed: ' + err.message)
      }
    } else {
      // Offline save — queue pending update
      try {
        await db.updateCachedContent(this.activeFilePath, content)
        await db.addPendingAction({ type: 'update', path: this.activeFilePath, content, encoding })
        this.showToast('Saved offline (will sync when connected)')
        this.loadOfflineTree()
      } catch (err) {
        alert('Offline save failed: ' + err.message)
      }
    }
  }

  saveActiveFile() {
    if (!this.activeEditor || !this.activeEditor.save) return
    this.activeEditor.save()
  }

  updateBreadcrumb(filePath) {
    const parts = filePath.split('/').filter(p => p)
    let html = '<span class="crumb">Root</span>'
    let current = ''
    for (const part of parts) {
      current += '/' + part
      html += ` <span class="crumb-sep">/</span> <span class="crumb">${this.escapeHTML(part)}</span>`
    }
    this.breadcrumbPath.innerHTML = html
  }

  // ----- Context Menu -----------------------------------------------
  async showContextMenu(node, x, y) {
    this.ctxTarget = node
    // Update offline toggle label
    const ctxOffline = document.getElementById('ctxOffline')
    if (ctxOffline && !node.isDirectory) {
      const isOffline = await db.isMarkedOffline(node.path)
      ctxOffline.textContent = isOffline ? '📥 Online Only' : '📥 Available Offline'
    }
    const ctxCopy = document.getElementById('ctxCopyLink')
    if (ctxCopy) ctxCopy.style.display = node.isDirectory ? 'none' : 'block'
    const ctxFav = document.getElementById('ctxFav')
    if (ctxFav) {
      ctxFav.style.display = node.isDirectory ? 'none' : 'block'
      ctxFav.textContent = this.isFavorited(node.path)
        ? '★ Remove from Favorites'
        : '⭐ Add to Favorites'
    }
    this.contextMenu.style.left = `${Math.min(x, window.innerWidth - 160)}px`
    this.contextMenu.style.top = `${Math.min(y, window.innerHeight - 120)}px`
    this.contextMenu.classList.remove('hidden')
  }

  hideContextMenu() {
    this.contextMenu.classList.add('hidden')
  }

  async handleContextAction(action) {
    if (!this.ctxTarget) return
    const node = this.ctxTarget
    const isDir = node.isDirectory

    if (action === 'open') {
      if (isDir) {
        const treeNode = this.treeView.getNodeByPath(this.treeView.treeData, node.path)
        if (treeNode) {
          this.treeView.expandedPaths.add(node.path)
          if (this.treeView.fetchChildren) await this.treeView.fetchChildren(node.path)
          this.treeView.activePath = node.path
          this.treeView.render()
        }
      } else {
        this.openFile(node.path)
      }
    } else if (action === 'rename') {
      this.showPrompt('Rename', node.name, async newName => {
        if (!newName || newName === node.name) return
        const parentDir = node.path.substring(0, node.path.lastIndexOf('/')) || '/'
        const newPath = parentDir === '/' ? `/${newName}` : `${parentDir}/${newName}`
        try {
          await api.moveItem(node.path, newPath)
          this.moveFavoritePath(node.path, newPath, isDir)
          if (this.activeFilePath === node.path) {
            this.activeFilePath = newPath
            this.updateBreadcrumb(newPath)
            this.setRoute(newPath)
            this.updateFavBtn()
          }
          await this.loadTree()
        } catch (err) {
          alert('Rename failed: ' + err.message)
        }
      })
    } else if (action === 'delete') {
      this.showConfirm('Delete', `Delete "${node.name}"?`, async () => {
        try {
          if (this.isOnline) {
            await api.deleteItem(node.path, isDir)
          } else {
            // Offline delete — queue pending action
            await db.addPendingAction({ type: 'delete', path: node.path })
            await db.unmarkOffline(node.path)
            this.showToast('Delete queued (will sync when connected)')
          }
          this.removeFavoriteForPath(node.path, isDir)
          if (this.activeFilePath === node.path) {
            this.clearRoute()
            this.showHome()
          }
          if (this.isOnline) {
            await this.loadTree()
          } else {
            await this.loadOfflineTree()
          }
        } catch (err) {
          alert('Delete failed: ' + err.message)
        }
      })
    } else if (action === 'fav') {
      if (!isDir) this.toggleFavorite(node.path)
    } else if (action === 'copylink') {
      if (!isDir) this.copyFileLink(node.path)
    } else if (action === 'offline') {
      try {
        const alreadyOffline = await db.isMarkedOffline(node.path)
        if (alreadyOffline) {
          await db.unmarkOffline(node.path)
          this.showToast('Removed from offline')
        } else {
          if (!this.isOnline) {
            alert('Cannot mark files for offline while offline — connect to the server first')
            return
          }
          const fileData = await api.readFile(node.path)
          const size = fileData.content ? fileData.content.length : 0
          if (size > db.MAX_OFFLINE_SIZE) {
            this.showToast('File too large for offline caching')
            return
          }
          await db.cacheFile(node.path, fileData.content, fileData.mtime, {
            mime: fileData.mime || 'text/plain',
            contentType: fileData.type || 'text',
            size,
          })
          this.showToast('Marked for offline')
        }
        if (this.isOnline) {
          await this.loadTree()
        } else {
          await this.loadOfflineTree()
        }
      } catch (err) {
        alert('Failed to toggle offline: ' + err.message)
      }
    }
  }

  async handleTreeMove(oldPath, newPath, isDir) {
    if (!this.isOnline) {
      alert('Cannot move while offline — connect to the server first')
      return
    }
    this.hideContextMenu()
    try {
      await api.moveItem(oldPath, newPath)
      this.showToast('Item moved')
      this.moveFavoritePath(oldPath, newPath, isDir)
      if (this.activeFilePath === oldPath) {
        this.activeFilePath = newPath
        this.updateBreadcrumb(newPath)
        this.setRoute(newPath)
        this.updateFavBtn()
      }
      await this.loadTree()
      // Expand the destination folder so the moved item is visible.
      const destDir = newPath.substring(0, newPath.lastIndexOf('/')) || '/'
      this.treeView.expandedPaths.add(destDir)
      const destNode = this.treeView.getNodeByPath(this.treeView.treeData, destDir)
      if (destNode && !(destNode.children && destNode.children.length)) {
        if (this.treeView.fetchChildren) await this.treeView.fetchChildren(destDir)
      }
      this.treeView.render()
    } catch (err) {
      alert('Move failed: ' + err.message)
    }
  }

  // ----- File Operation Modals --------------------------------------
  showNewFileModal() {
    this.actionTitle.textContent = '📄 New File'
    this.actionBody.innerHTML = `
      <div class="input-group">
        <label>File path (relative to root)</label>
        <input type="text" id="newFileInput" placeholder="e.g. notes/ideas.md" />
      </div>`
    this.actionFooter.innerHTML = `<button class="btn btn-primary" id="confirmNewFileBtn">Create File</button>`
    this.actionModal.classList.remove('hidden')
    document.getElementById('confirmNewFileBtn').onclick = async () => {
      const name = document.getElementById('newFileInput').value.trim()
      if (!name) return
      const target = name.startsWith('/') ? name : '/' + name
      try {
        await api.writeFile(target, '')
        this.actionModal.classList.add('hidden')
        this.showToast('File created')
        await this.loadTree()
        this.openFile(target)
      } catch (e) { alert('Failed: ' + e.message) }
    }
    setTimeout(() => document.getElementById('newFileInput')?.focus(), 100)
  }

  showNewFolderModal() {
    this.actionTitle.textContent = '📁 New Folder'
    this.actionBody.innerHTML = `
      <div class="input-group">
        <label>Folder path (relative to root)</label>
        <input type="text" id="newFolderInput" placeholder="e.g. projects/docs" />
      </div>`
    this.actionFooter.innerHTML = `<button class="btn btn-primary" id="confirmNewFolderBtn">Create Folder</button>`
    this.actionModal.classList.remove('hidden')
    document.getElementById('confirmNewFolderBtn').onclick = async () => {
      const name = document.getElementById('newFolderInput').value.trim()
      if (!name) return
      const target = name.startsWith('/') ? name : '/' + name
      try {
        await api.createFolder(target)
        this.actionModal.classList.add('hidden')
        this.showToast('Folder created')
        await this.loadTree()
      } catch (e) { alert('Failed: ' + e.message) }
    }
    setTimeout(() => document.getElementById('newFolderInput')?.focus(), 100)
  }

  async handleFileUpload(event) {
    const file = event.target.files[0]
    if (!file) return
    const targetPath = '/' + file.name
    try {
      this.showToast(`Uploading ${file.name}...`)
      await api.uploadFile(targetPath, file, pct => {
        this.showToast(`Uploading ${file.name}... ${Math.round(pct * 100)}%`)
      })
      this.showToast('Upload complete!')
      await this.loadTree()
    } catch (err) {
      alert('Upload failed: ' + err.message)
    }
    event.target.value = ''
  }

  showDeleteModal() {
    if (!this.activeFilePath) return
    this.showConfirm('Delete File', `Delete "${this.activeFilePath}"?`, async () => {
      try {
        await api.deleteItem(this.activeFilePath, false)
        this.showToast('File deleted')
        this.removeFavoriteForPath(this.activeFilePath, false)
        this.clearRoute()
        this.showHome()
        await this.loadTree()
      } catch (e) { alert('Delete failed: ' + e.message) }
    })
  }

  async toggleActiveFileOffline() {
    if (!this.activeFilePath) return
    const node = { path: this.activeFilePath }
    const alreadyOffline = await db.isMarkedOffline(node.path)
    if (alreadyOffline) {
      await db.unmarkOffline(node.path)
      this.showToast('Removed from offline')
      this.fileOfflineBtn.textContent = 'Offline'
    } else {
      if (!this.isOnline) {
        alert('Cannot mark files for offline while offline — connect to the server first')
        return
      }
      try {
        const fileData = await api.readFile(node.path)
        const size = fileData.content ? fileData.content.length : 0
        if (size > db.MAX_OFFLINE_SIZE) {
          this.showToast('File too large for offline caching')
          return
        }
        await db.cacheFile(node.path, fileData.content, fileData.mtime, {
          mime: fileData.mime || 'text/plain',
          contentType: fileData.type || 'text',
          size,
        })
        this.showToast('Marked for offline')
        this.fileOfflineBtn.textContent = 'Online Only'
      } catch (err) {
        alert('Failed to mark for offline: ' + err.message)
      }
    }
    if (this.isOnline) {
      await this.loadTree()
    } else {
      await this.loadOfflineTree()
    }
  }

  showPrompt(title, defaultVal, callback) {
    document.getElementById('promptModalTitle').textContent = title
    const input = document.getElementById('promptInput')
    input.value = defaultVal || ''
    document.getElementById('promptModal').classList.remove('hidden')
    input.focus()

    const finish = () => {
      document.getElementById('promptModal').classList.add('hidden')
      callback(input.value.trim())
    }
    document.getElementById('promptOk').onclick = finish
    document.getElementById('promptCancel').onclick = () => {
      document.getElementById('promptModal').classList.add('hidden')
    }
    input.onkeydown = e => { if (e.key === 'Enter') finish() }
  }

  showConfirm(title, msg, callback) {
    this.confirmTitle.textContent = title
    this.confirmMsg.textContent = msg
    this.confirmModal.classList.remove('hidden')

    this.confirmOk.onclick = () => {
      this.confirmModal.classList.add('hidden')
      callback()
    }
    this.confirmCancel.onclick = () => {
      this.confirmModal.classList.add('hidden')
    }
  }

  async syncOfflineChanges() {
    if (this._syncing) return
    this._syncing = true
    try {
      const pending = await db.getPendingActions()
      if (pending.length > 0) {
        this.showToast(`Syncing ${pending.length} offline change(s)...`)

        for (const action of pending) {
          try {
            if (action.type === 'create' || action.type === 'update') {
              // Check for conflicts on update
              if (action.type === 'update') {
                try {
                  const serverData = await api.readFile(action.path)
                  const cached = await db.getCachedFile(action.path)
                  if (cached && serverData.mtime > cached.serverMtime) {
                    // Server has changes — conflict
                    const resolution = await this.showConflictModal(action.path)
                    if (resolution === 'keep') {
                      // Save as copy
                      const conflictedPath = action.path.replace(/(\.\w+)?$/, '.conflicted$1')
                      await api.writeFile(conflictedPath, action.content, action.encoding)
                      this.showToast(`Saved as ${conflictedPath}`)
                    }
                    // If 'accept', just update local cache with server version
                    if (cached) {
                      await db.cacheFile(action.path, serverData.content, serverData.mtime, {
                        mime: serverData.mime || 'text/plain',
                        contentType: serverData.type || 'text',
                      })
                    }
                    await db.removePendingAction(action.id)
                    continue
                  }
                } catch {
                  // Server file doesn't exist or error — still try to write
                }
              }
              await api.writeFile(action.path, action.content || '', action.encoding)
              // The push succeeded — mark the cache synced so it's not overwritten.
              const cached = await db.getCachedFile(action.path)
              if (cached && cached.offline) {
                await db.markSynced(action.path)
              }
            } else if (action.type === 'delete') {
              try {
                // Check if server has modifications
                const serverData = await api.readFile(action.path)
                const cached = await db.getCachedFile(action.path)
                if (cached && serverData.mtime > cached.serverMtime) {
                  const resolution = await this.showConflictModal(action.path, true)
                  if (resolution === 'keep') {
                    await api.deleteItem(action.path, false)
                  }
                  // If 'accept', don't delete — server version wins
                  if (cached) {
                    await db.cacheFile(action.path, serverData.content, serverData.mtime, {
                      mime: serverData.mime || 'text/plain',
                      contentType: serverData.type || 'text',
                    })
                  }
                  await db.removePendingAction(action.id)
                  continue
                }
              } catch {
                // File doesn't exist on server — delete is a no-op
              }
              await api.deleteItem(action.path, false)
            }
            await db.removePendingAction(action.id)
          } catch (err) {
            this.showToast(`Sync failed for ${action.path}: ${err.message}`)
          }
        }

        this.showToast('Sync complete!')
      }

      // Reconcile the offline cache against the server (deleted / modified files).
      await this.reconcileOfflineCache()
    } finally {
      this._syncing = false
    }
  }

  async reconcileOfflineCache() {
    const offlineFiles = await db.getAllOfflineFiles()
    if (offlineFiles.length === 0) return

    const manifest = {}
    for (const f of offlineFiles) manifest[f.path] = f.serverMtime || 0

    let result
    try {
      result = await api.syncFiles(manifest)
    } catch (err) {
      return
    }

    const pending = await db.getPendingActions()
    const pendingPaths = new Set(pending.map(a => a.path))

    // Files deleted on the server while cached offline — ask the user.
    for (const path of result.deleted || []) {
      if (pendingPaths.has(path)) continue
      const cached = await db.getCachedFile(path)
      if (!cached) continue
      const remove = await this.showConfirmAsync(
        'Deleted on Server',
        `"${path}" was deleted on the server.\n\nRemove it from this device?`,
        'Remove',
        'Keep'
      )
      if (remove) {
        await db.unmarkOffline(path)
        this.removeFavoriteForPath(path, false)
        if (this.activeFilePath === path) {
          this.clearRoute()
          this.showHome()
        }
        this.showToast('Removed from device')
      }
    }

    // Files modified on the server — silent refresh unless local edits exist.
    for (const m of result.modified || []) {
      const cached = await db.getCachedFile(m.path)
      if (!cached || !cached.offline) continue
      if (m.size > db.MAX_OFFLINE_SIZE) continue

      if (cached.synced) {
        // No local edits — silently update the cache to the server version.
        try {
          const data = await api.readFile(m.path)
          if (data.type === 'too_large') continue
          await db.cacheFile(m.path, data.content, data.mtime, {
            mime: data.mime || 'text/plain',
            contentType: data.type || 'text',
            size: m.size,
          })
        } catch { /* skip */ }
      } else {
        // Local edits exist — prompt for conflict resolution.
        const resolution = await this.showConflictModal(m.path)
        if (resolution === 'keep') {
          const conflictedPath = m.path.replace(/(\.\w+)?$/, '.conflicted$1')
          try {
            await api.writeFile(conflictedPath, cached.content)
            this.showToast(`Saved as ${conflictedPath}`)
          } catch { /* ignore */ }
        }
        try {
          const data = await api.readFile(m.path)
          if (data.type !== 'too_large') {
            await db.cacheFile(m.path, data.content, data.mtime, {
              mime: data.mime || 'text/plain',
              contentType: data.type || 'text',
              size: m.size,
            })
          }
        } catch { /* skip */ }
        for (const a of pending) {
          if (a.path === m.path) await db.removePendingAction(a.id)
        }
      }
    }
  }

  showConfirmAsync(title, msg, okLabel, cancelLabel) {
    return new Promise((resolve) => {
      this.confirmTitle.textContent = title
      this.confirmMsg.textContent = msg
      this.confirmOk.textContent = okLabel || 'OK'
      this.confirmCancel.textContent = cancelLabel || 'Cancel'
      const btn3 = document.getElementById('confirmThird')
      if (btn3) btn3.style.display = 'none'
      this.confirmOk.onclick = () => {
        this.confirmModal.classList.add('hidden')
        resolve(true)
      }
      this.confirmCancel.onclick = () => {
        this.confirmModal.classList.add('hidden')
        resolve(false)
      }
      this.confirmModal.classList.remove('hidden')
    })
  }

  showConflictModal(filePath, isDelete = false) {
    return new Promise((resolve) => {
      const msg = isDelete
        ? `"${filePath}" was modified on both your device and the server.\n\nKeep your delete, or accept the server version?`
        : `"${filePath}" was modified on both your device and the server.\n\nKeep your changes as a copy, or accept the server version?`

      this.showConfirm3(
        'Sync Conflict',
        msg,
        isDelete ? 'Delete Anyway' : 'Keep Mine as Copy',
        'Accept Server Version',
        (choice) => resolve(choice),
      )
    })
  }

  showConfirm3(title, msg, btn1Label, btn2Label, callback) {
    this.confirmTitle.textContent = title
    this.confirmMsg.textContent = msg
    this.confirmOk.textContent = btn1Label
    this.confirmOk.style.display = 'inline-block'

    // Create or show third button
    let btn3 = document.getElementById('confirmThird')
    if (!btn3) {
      btn3 = document.createElement('button')
      btn3.id = 'confirmThird'
      btn3.className = 'btn btn-outline'
      btn3.style.marginLeft = '8px'
      this.confirmModal.querySelector('.modal-footer').appendChild(btn3)
    }
    btn3.textContent = btn2Label
    btn3.style.display = 'inline-block'

    this.confirmCancel.textContent = 'Cancel'
    this.confirmModal.classList.remove('hidden')

    this.confirmOk.onclick = () => {
      this.confirmModal.classList.add('hidden')
      callback('keep')
    }
    btn3.onclick = () => {
      this.confirmModal.classList.add('hidden')
      callback('accept')
    }
    this.confirmCancel.onclick = () => {
      this.confirmModal.classList.add('hidden')
      callback('accept')
    }
  }

  // ----- Toast ------------------------------------------------------
  showToast(message) {
    this.toastEl.textContent = message
    this.toastEl.classList.remove('hidden')
    clearTimeout(this._toastTimer)
    this._toastTimer = setTimeout(() => {
      this.toastEl.classList.add('hidden')
    }, 3000)
  }

  escapeHTML(str) {
    if (!str) return ''
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
  }
}

window.addEventListener('DOMContentLoaded', () => {
  window.app = new PDriveApp()
})
