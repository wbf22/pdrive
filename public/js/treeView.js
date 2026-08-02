export class TreeView {
  constructor(container, options = {}) {
    this.container = container
    this.onSelectFile = options.onSelectFile
    this.onContextMenu = options.onContextMenu
    this.fetchChildren = options.fetchChildren
    this.onMove = options.onMove
    this.expandedPaths = new Set(['/'])
    this.activePath = null
    this.treeData = { path: '/', name: 'Root', isDirectory: true, children: [] }

    // Drag & drop state
    this._dragCandidate = null
    this._dragActive = false
    this._longPressTimer = null
    this._ghost = null
    this._dropTarget = null
    this._suppressClick = false

    this.container.addEventListener('pointerdown', e => this._onPointerDown(e))
    document.addEventListener('pointermove', e => this._onPointerMove(e))
    document.addEventListener('pointerup', e => this._onPointerUp(e))
    document.addEventListener('pointercancel', e => this._onPointerUp(e))
  }

  _onPointerDown(e) {
    if (e.button !== undefined && e.button !== 0) return
    this._suppressClick = false
    const nodeEl = e.target.closest('.tree-node')
    if (!nodeEl) {
      this._cancelDrag()
      return
    }
    this._cancelLongPress()
    this._dragCandidate = {
      path: nodeEl.getAttribute('data-path'),
      isDir: nodeEl.getAttribute('data-isdir') === 'true',
      name: nodeEl.getAttribute('data-name'),
      el: nodeEl,
      startX: e.clientX,
      startY: e.clientY,
      lastY: e.clientY,
      pointerId: e.pointerId,
      isTouch: e.pointerType !== 'mouse',
      armed: e.pointerType === 'mouse',
      scrolled: false,
    }
    if (e.pointerType === 'mouse') {
      try { nodeEl.setPointerCapture(e.pointerId) } catch { /* ignore */ }
    } else {
      // Long-press arms a touch drag so quick swipes keep scrolling the tree.
      // Highlight the node once armed so it's clear a drag is ready.
      this._longPressTimer = setTimeout(() => {
        this._longPressTimer = null
        if (this._dragCandidate) {
          this._dragCandidate.armed = true
          this._dragCandidate.el.classList.add('drag-armed')
        }
      }, 800)
    }
  }

  _onPointerMove(e) {
    const c = this._dragCandidate
    if (!c || e.pointerId !== c.pointerId) return

    if (!this._dragActive) {
      if (!c.armed) {
        // Not yet armed — emulate vertical scroll so tree nodes stay scrollable
        // even though touch-action is disabled on them for drag support. Any
        // real movement here commits the gesture to scrolling, so the
        // long-press drag arm is cancelled.
        if (Math.hypot(e.clientX - c.startX, e.clientY - c.startY) > 3) {
          this._cancelLongPress()
        }
        const moveY = e.clientY - c.lastY
        c.lastY = e.clientY
        if (moveY !== 0) {
          this.container.scrollTop -= moveY
          c.scrolled = true
          e.preventDefault()
        }
        return
      }
      if (Math.hypot(e.clientX - c.startX, e.clientY - c.startY) < 6) return
      // Start the drag
      this._dragActive = true
      c.el.classList.remove('drag-armed')
      c.el.classList.add('dragging')
      this._ghost = document.createElement('div')
      this._ghost.className = 'tree-drag-ghost'
      this._ghost.textContent = (c.isDir ? '📁 ' : '📄 ') + c.name
      document.body.appendChild(this._ghost)
      e.preventDefault()
    } else {
      e.preventDefault()
    }
    this._updateGhost(e.clientX, e.clientY)
    this._updateDropTarget(e.clientX, e.clientY)
  }

  _onPointerUp(e) {
    const c = this._dragCandidate
    this._cancelLongPress()
    this._dragCandidate = null
    if (!c || e.pointerId !== c.pointerId) return

    if (this._dragActive) {
      e.preventDefault()
      this._dragActive = false
      c.el.classList.remove('dragging', 'drag-armed')
      if (this._ghost) {
        this._ghost.remove()
        this._ghost = null
      }
      const target = this._dropTarget
      const rootDrop = this.container.classList.contains('drop-root')
      this._clearDropTarget()
      let newPath = null
      if (target) {
        const targetPath = target.getAttribute('data-path')
        newPath = targetPath === '/' ? '/' + c.name : targetPath + '/' + c.name
      } else if (rootDrop) {
        // Dropped on the tree background — move back to the root folder.
        newPath = '/' + c.name
      }
      if (newPath && newPath !== c.path && this.onMove) {
        this.onMove(c.path, newPath, c.isDir)
      }
      this._suppressClick = true
    } else if (c.scrolled) {
      this._suppressClick = true
    } else if (c.armed && c.isTouch) {
      // Long-press released without dragging — open the context menu.
      // (Touch only; on desktop the context menu opens via right-click.)
      this._suppressClick = true
      if (this.onContextMenu) {
        this.onContextMenu({ path: c.path, name: c.name, isDirectory: c.isDir }, e.clientX, e.clientY)
      }
    }
    c.el.classList.remove('drag-armed')

    if (c.el.hasPointerCapture && c.el.hasPointerCapture(c.pointerId)) {
      try { c.el.releasePointerCapture(c.pointerId) } catch { /* ignore */ }
    }
  }

  _cancelDrag() {
    this._cancelLongPress()
    if (this._dragCandidate) {
      this._dragCandidate.el.classList.remove('drag-armed')
      if (this._dragActive) {
        this._dragActive = false
        this._dragCandidate.el.classList.remove('dragging')
      }
    }
    if (this._ghost) {
      this._ghost.remove()
      this._ghost = null
    }
    this._clearDropTarget()
    this._dragCandidate = null
  }

  _cancelLongPress() {
    if (this._longPressTimer) {
      clearTimeout(this._longPressTimer)
      this._longPressTimer = null
    }
  }

  _updateGhost(x, y) {
    if (!this._ghost) return
    this._ghost.style.left = (x + 12) + 'px'
    this._ghost.style.top = (y + 12) + 'px'
  }

  _updateDropTarget(x, y) {
    const el = document.elementFromPoint(x, y)
    const nodeEl = el ? el.closest('.tree-node') : null
    let valid = null
    if (nodeEl && this._isValidTarget(nodeEl)) valid = nodeEl
    if (valid !== this._dropTarget) {
      this._clearDropTarget()
      if (valid) {
        valid.classList.add('drop-target')
        this._dropTarget = valid
      }
    }
    // Empty space in the tree = root folder drop target.
    const inContainer = el && (el === this.container || this.container.contains(el))
    this.container.classList.toggle('drop-root', !valid && inContainer)
  }

  _clearDropTarget() {
    this.container.classList.remove('drop-root')
    if (this._dropTarget) {
      this._dropTarget.classList.remove('drop-target')
      this._dropTarget = null
    }
  }

  _isValidTarget(nodeEl) {
    const c = this._dragCandidate
    if (!c) return false
    if (nodeEl.getAttribute('data-isdir') !== 'true') return false
    const targetPath = nodeEl.getAttribute('data-path')
    if (targetPath === c.path) return false
    // Can't drop a folder into itself or one of its own subfolders.
    if (c.isDir && targetPath.startsWith(c.path + '/')) return false
    return true
  }

  setTreeData(data) {
    this.treeData = data
    this.render()
  }

  getNodeByPath(node, targetPath) {
    if (node.path === targetPath) return node
    if (node.children) {
      for (const child of node.children) {
        const found = this.getNodeByPath(child, targetPath)
        if (found) return found
      }
    }
    return null
  }

  async toggleExpand(nodePath) {
    if (this.expandedPaths.has(nodePath)) {
      this.expandedPaths.delete(nodePath)
    } else {
      this.expandedPaths.add(nodePath)
      if (this.fetchChildren) {
        await this.fetchChildren(nodePath)
      }
    }
    this.render()
  }

  refreshActiveHighlight() {
    const nodes = this.container.querySelectorAll('.tree-node')
    nodes.forEach(n => {
      n.classList.toggle('active', n.getAttribute('data-path') === this.activePath)
    })
  }

  render() {
    const children = this.treeData.children || []
    this.container.innerHTML = `<ul class="tree-root">${children.map(c => this._renderNode(c)).join('')}</ul>`

    this.container.querySelectorAll('.tree-node').forEach(nodeEl => {
      const path = nodeEl.getAttribute('data-path')
      const isDir = nodeEl.getAttribute('data-isdir') === 'true'

      const toggleIcon = nodeEl.querySelector('.tree-toggle')
      if (toggleIcon) {
        toggleIcon.addEventListener('click', e => {
          e.stopPropagation()
          this.toggleExpand(path)
        })
      }

      nodeEl.addEventListener('click', e => {
        if (this._suppressClick) {
          this._suppressClick = false
          setTimeout(() => { this._suppressClick = false }, 0)
          return
        }
        e.stopPropagation()
        this.activePath = path
        this.refreshActiveHighlight()
        if (isDir) {
          this.toggleExpand(path)
        } else {
          if (this.onSelectFile) this.onSelectFile(path)
        }
      })

      nodeEl.addEventListener('contextmenu', e => {
        e.preventDefault()
        e.stopPropagation()
        // On touch, long-press is handled by our own gesture logic (drag, or
        // the context menu on long-press release), so the native context menu
        // must not fire mid-gesture. Desktop right-click opens it as normal.
        if (this._dragCandidate && this._dragCandidate.isTouch) return
        if (this.onContextMenu) {
          this.onContextMenu({
            path,
            name: nodeEl.getAttribute('data-name'),
            isDirectory: isDir,
          }, e.clientX, e.clientY)
        }
      })
    })
  }

  _renderNode(node) {
    const isExpanded = this.expandedPaths.has(node.path)
    const isActive = this.activePath === node.path
    const isDir = node.isDirectory

    const icon = isDir
      ? (isExpanded ? '📂' : '📁')
      : this._getFileIcon(node.name)

    let badge = ''
    if (node.offline && !isDir) {
      badge = '<span class="tree-badge badge-offline" title="Available offline"></span>'
      if (node.pendingAction === 'update' || node.pendingAction === 'create') {
        badge = '<span class="tree-badge badge-pending" title="Pending upload"></span>'
      } else if (node.pendingAction === 'delete') {
        badge = '<span class="tree-badge badge-pending" title="Pending delete"></span>'
      } else if (node.pendingAction === 'conflict') {
        badge = '<span class="tree-badge badge-conflict" title="Sync conflict"></span>'
      }
    }

    let html = `
      <li class="tree-item">
        <div class="tree-node ${isActive ? 'active' : ''}"
             data-path="${node.path}"
             data-isdir="${isDir}"
             data-name="${this._escapeHTML(node.name)}">
          ${isDir
            ? `<span class="tree-toggle">${isExpanded ? '▼' : '►'}</span>`
            : '<span class="tree-spacer"></span>'}
          <span class="tree-icon">${icon}</span>
          <span class="tree-label">${this._escapeHTML(node.name)}</span>
          ${badge}
        </div>
    `

    if (isDir && isExpanded && node.children) {
      html += `<ul class="tree-children">`
      for (const child of node.children) {
        html += this._renderNode(child)
      }
      html += `</ul>`
    }

    html += `</li>`
    return html
  }

  _getFileIcon(filename) {
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

  _escapeHTML(str) {
    if (!str) return ''
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
  }
}
