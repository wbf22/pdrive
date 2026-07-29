import { TreeView } from './treeView.js'
import { TextEditor } from './editors/textEditor.js'
import { ImageViewer } from './editors/imageViewer.js'
import { MarkdownEditor } from './editors/markdownEditor.js'
import { CSVEditor } from './editors/csvEditor.js'

import * as api from './api.js'
import * as db from './db.js'

class PDriveApp {
  constructor() {
    this.activeFilePath = null
    this.activeEditor = null
    this.ctxTarget = null
    this.isOnline = false

    this.initDOM()
    this.initPWA()
    this.initConnectivityTracking()
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

    this.fileMoveBtn = document.getElementById('fileMoveBtn')
    this.fileDeleteBtn = document.getElementById('fileDeleteBtn')
    this.fileOfflineBtn = document.getElementById('fileOfflineBtn')
    this.statusIndicator = document.getElementById('statusIndicator')

    document.getElementById('toggleMobileDrawer').addEventListener('click', () => {
      this.sidebar.classList.toggle('open')
    })

    document.getElementById('openServerSettingsBtn').addEventListener('click', () => {
      this.openServerSettings()
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

    this.fileMoveBtn.addEventListener('click', () => this.showMoveModal())
    this.fileDeleteBtn.addEventListener('click', () => this.showDeleteModal())
    this.fileOfflineBtn.addEventListener('click', () => this.toggleActiveFileOffline())
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
    document.addEventListener('click', () => this.hideContextMenu())

    this.serverUrlInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') this.serverSubmit.click()
    })
    this.loginInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') this.loginSubmit.click()
    })

    this.treeView = new TreeView(this.treeContainer, {
      onSelectFile: filePath => this.openFile(filePath),
      onContextMenu: (node, x, y) => this.showContextMenu(node, x, y),
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

  initConnectivityTracking() {
    window.addEventListener('online', () => this.checkConnectivityAndSync())
    window.addEventListener('offline', () => {
      this.isOnline = false
      this.updateStatusIndicator()
      this.loadOfflineTree()
    })
  }

  async checkConnectivityAndSync() {
    this.isOnline = await api.checkConnectivity()
    this.updateStatusIndicator()
    if (this.isOnline) {
      await this.syncOfflineChanges()
      await this.loadTree()
    } else {
      this.loadOfflineTree()
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
    const url = api.loadServerUrl()
    if (!url) {
      // No saved URL — try same-origin (served from the Python server)
      try {
        await api.healthCheck()
        this.isOnline = true
        this.updateStatusIndicator()
        const token = api.loadToken()
        if (token) {
          this.loadTree()
        } else {
          this.showLogin()
        }
      } catch {
        this.isOnline = false
        this.updateStatusIndicator()
        const offlineFiles = await db.getAllOfflineFiles()
        if (offlineFiles.length > 0) {
          this.loadOfflineTree()
        } else {
          this.openServerSettings()
        }
      }
      return
    }

    const token = api.loadToken()
    if (!token) {
      this.showLogin()
      return
    }
    // Verify token is still valid
    try {
      await api.listFiles('/')
      this.isOnline = true
      this.updateStatusIndicator()
      this.loadTree()
    } catch {
      // Server unreachable — try offline mode
      this.isOnline = false
      this.updateStatusIndicator()
      const offlineFiles = await db.getAllOfflineFiles()
      if (offlineFiles.length > 0) {
        this.loadOfflineTree()
      } else {
        this.showLogin()
      }
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
        this.loadTree()
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
    const key = 'pdrive_pass_' + api.getServerUrl()
    const raw = localStorage.getItem(key)
    if (!raw) return null
    try {
      const data = JSON.parse(raw)
      if (data.pin) return { pin: true, data: data }
      return { pin: false, data: atob(data) }
    } catch {
      // Legacy: raw base64 without JSON wrapper
      return { pin: false, data: atob(raw) }
    }
  }

  clearSavedPassword() {
    const key = 'pdrive_pass_' + api.getServerUrl()
    localStorage.removeItem(key)
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
            this.loadTree()
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
        // No PIN — auto-fill and attempt login
        pwForm.classList.remove('hidden')
        pinUnlock.classList.add('hidden')
        document.getElementById('loginInput').value = saved.data
        document.getElementById('loginRemember').checked = true
        document.getElementById('pinFieldGroup').classList.add('hidden')
        this.loginModal.classList.remove('hidden')
        this.loginSubmit.focus()

        this.loginSubmit.onclick = async () => {
          try {
            await api.login(saved.data)
            this.loginModal.classList.add('hidden')
            this.loadTree()
          } catch (err) {
            // Saved password failed — show normal form
            this.showLogin()
            this.loginError.textContent = 'Saved password rejected — re-enter password'
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
          this.loadTree()
        } catch (err) {
          this.loginError.textContent = err.message || 'Login failed'
          this.loginError.classList.remove('hidden')
        }
      }
    }

  }

  logout() {
    api.setToken('')
    this.activeFilePath = null
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
    this.fileMoveBtn.disabled = false
    this.fileDeleteBtn.disabled = false
    this.fileOfflineBtn.disabled = false
    this.sidebar.classList.remove('open')
    // Set offline button label
    db.isMarkedOffline(filePath).then(offline => {
      this.fileOfflineBtn.textContent = offline ? 'Online Only' : 'Offline'
    })

    this.editorContainer.innerHTML = '<div class="welcome-screen"><h3>Loading file...</h3></div>'

    try {
      let fileData
      if (this.isOnline) {
        fileData = await api.readFile(filePath)
        // Cache for offline if marked
        if (await db.isMarkedOffline(filePath)) {
          const size = fileData.content ? fileData.content.length : 0
          if (size < db.MAX_OFFLINE_SIZE) {
            await db.cacheFile(filePath, fileData.content, fileData.mtime, {
              mime: fileData.mime || 'text/plain',
              contentType: fileData.type || 'text',
              size,
            })
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

      if (fileData.type === 'image') {
        const viewer = new ImageViewer(this.editorContainer, (base64Data, encoding) => this.saveFile(base64Data, encoding || 'base64'))
        viewer.render(content, fileData.mime, filePath.split('/').pop())
        this.activeEditor = viewer
      } else if (ext === 'csv') {
        const csvEd = new CSVEditor(this.editorContainer, csv => this.saveFile(csv))
        csvEd.render(content)
        this.activeEditor = csvEd
      } else if (ext === 'md') {
        const mdEd = new MarkdownEditor(this.editorContainer, md => this.saveFile(md))
        mdEd.render(content)
        this.activeEditor = mdEd
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
          if (this.activeFilePath === node.path) {
            this.activeFilePath = newPath
            this.updateBreadcrumb(newPath)
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
          if (this.activeFilePath === node.path) {
            this.activeFilePath = null
            this.fileMoveBtn.disabled = true
            this.fileDeleteBtn.disabled = true
            this.fileOfflineBtn.disabled = true
            this.editorContainer.innerHTML = '<div class="welcome-screen"><h2>File Deleted</h2></div>'
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

  showMoveModal() {
    if (!this.activeFilePath) return
    this.actionTitle.textContent = '🔀 Move / Rename'
    this.actionBody.innerHTML = `
      <div class="input-group">
        <label>New destination path</label>
        <input type="text" id="moveInput" value="${this.escapeHTML(this.activeFilePath)}" />
      </div>`
    this.actionFooter.innerHTML = `<button class="btn btn-primary" id="confirmMoveBtn">Move</button>`
    this.actionModal.classList.remove('hidden')
    document.getElementById('confirmMoveBtn').onclick = async () => {
      const newPath = document.getElementById('moveInput').value.trim()
      if (!newPath || newPath === this.activeFilePath) return
      try {
        await api.moveItem(this.activeFilePath, newPath)
        this.actionModal.classList.add('hidden')
        this.showToast('Item moved')
        this.activeFilePath = newPath
        this.updateBreadcrumb(newPath)
        await this.loadTree()
      } catch (e) { alert('Move failed: ' + e.message) }
    }
    setTimeout(() => document.getElementById('moveInput')?.focus(), 100)
  }

  showDeleteModal() {
    if (!this.activeFilePath) return
    this.showConfirm('Delete File', `Delete "${this.activeFilePath}"?`, async () => {
      try {
        await api.deleteItem(this.activeFilePath, false)
        this.showToast('File deleted')
        this.activeFilePath = null
        this.fileMoveBtn.disabled = true
        this.fileDeleteBtn.disabled = true
        this.fileOfflineBtn.disabled = true
        this.editorContainer.innerHTML = '<div class="welcome-screen"><h2>File Deleted</h2></div>'
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
    const pending = await db.getPendingActions()
    if (pending.length === 0) return

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
    await this.loadTree()
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
