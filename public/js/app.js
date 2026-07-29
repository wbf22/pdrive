import { TreeView } from './treeView.js'
import { TextEditor } from './editors/textEditor.js'
import { ImageViewer } from './editors/imageViewer.js'
import { MarkdownEditor } from './editors/markdownEditor.js'
import { CSVEditor } from './editors/csvEditor.js'

import * as api from './api.js'

class PDriveApp {
  constructor() {
    this.activeFilePath = null
    this.activeEditor = null
    this.ctxTarget = null

    this.initDOM()
    this.initPWA()
    this.initAuth()
  }

  // ----- DOM Setup --------------------------------------------------
  initDOM() {
    this.loginModal = document.getElementById('loginModal')
    this.loginInput = document.getElementById('loginInput')
    this.loginSubmit = document.getElementById('loginSubmit')
    this.loginError = document.getElementById('loginError')

    this.serverModal = document.getElementById('serverModal')
    this.serverUrlInput = document.getElementById('serverUrlInput')
    this.serverSubmit = document.getElementById('serverSubmit')

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

  // ----- Auth Flow --------------------------------------------------
  async initAuth() {
    const url = api.loadServerUrl()
    if (!url) {
      this.openServerSettings()
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
      this.loadTree()
    } catch {
      this.showLogin()
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

  showLogin() {
    this.loginInput.value = ''
    this.loginError.classList.add('hidden')
    this.loginModal.classList.remove('hidden')
    this.loginInput.focus()

    this.loginSubmit.onclick = async () => {
      const pw = this.loginInput.value.trim()
      if (!pw) return
      try {
        await api.login(pw)
        this.loginModal.classList.add('hidden')
        this.loadTree()
      } catch (err) {
        this.loginError.textContent = err.message || 'Login failed'
        this.loginError.classList.remove('hidden')
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
        children: (data.files || []).map(f => ({
          name: f.name,
          path: f.path,
          isDirectory: f.isDirectory,
          size: f.size,
          children: f.isDirectory ? [] : null,
        })),
      }
      this.treeView.setTreeData(rootNode)
    } catch (err) {
      this.showToast('Error loading tree: ' + err.message)
    }
  }

  // ----- Open / Edit Files ------------------------------------------
  async openFile(filePath) {
    this.activeFilePath = filePath
    this.updateBreadcrumb(filePath)
    this.fileMoveBtn.disabled = false
    this.fileDeleteBtn.disabled = false
    this.sidebar.classList.remove('open')

    this.editorContainer.innerHTML = '<div class="welcome-screen"><h3>Loading file...</h3></div>'

    try {
      const fileData = await api.readFile(filePath)
      const ext = filePath.split('.').pop().toLowerCase()

      if (fileData.type === 'image') {
        const viewer = new ImageViewer(this.editorContainer)
        viewer.render(fileData.content, fileData.mime, filePath.split('/').pop())
      } else if (ext === 'csv') {
        const csvEd = new CSVEditor(this.editorContainer, csv => this.saveFile(csv))
        csvEd.render(fileData.content)
        this.activeEditor = csvEd
      } else if (ext === 'md') {
        const mdEd = new MarkdownEditor(this.editorContainer, md => this.saveFile(md))
        mdEd.render(fileData.content)
        this.activeEditor = mdEd
      } else {
        const textEd = new TextEditor(this.editorContainer, text => this.saveFile(text))
        textEd.render(fileData.content, filePath)
        this.activeEditor = textEd
      }
    } catch (err) {
      alert('Failed to read file: ' + err.message)
    }
  }

  async saveFile(content) {
    if (!this.activeFilePath) return
    try {
      await api.writeFile(this.activeFilePath, content)
      this.showToast('File saved!')
    } catch (err) {
      alert('Save failed: ' + err.message)
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
  showContextMenu(node, x, y) {
    this.ctxTarget = node
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
          await api.deleteItem(node.path, isDir)
          if (this.activeFilePath === node.path) {
            this.activeFilePath = null
            this.fileMoveBtn.disabled = true
            this.fileDeleteBtn.disabled = true
            this.editorContainer.innerHTML = '<div class="welcome-screen"><h2>File Deleted</h2></div>'
          }
          await this.loadTree()
        } catch (err) {
          alert('Delete failed: ' + err.message)
        }
      })
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
        this.editorContainer.innerHTML = '<div class="welcome-screen"><h2>File Deleted</h2></div>'
        await this.loadTree()
      } catch (e) { alert('Delete failed: ' + e.message) }
    })
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
