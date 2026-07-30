export class TreeView {
  constructor(container, options = {}) {
    this.container = container
    this.onSelectFile = options.onSelectFile
    this.onContextMenu = options.onContextMenu
    this.fetchChildren = options.fetchChildren
    this.expandedPaths = new Set(['/'])
    this.activePath = null
    this.treeData = { path: '/', name: 'Root', isDirectory: true, children: [] }
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
    this.container.innerHTML = `<ul class="tree-root">${this._renderNode(this.treeData)}</ul>`

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
