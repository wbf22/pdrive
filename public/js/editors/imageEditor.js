/**
 * Image Editor Component
 * Supports drawing, line thickness, color picker, fill tool, selection copy/paste, undo/redo, zoom/pan.
 * Optimized for mobile touch and desktop mouse interactions.
 */

export class ImageEditor {
  constructor(container, options = {}) {
    this.container = container;
    this.onSave = options.onSave || null;
    this.onClose = options.onClose || null;

    // State
    this.tool = 'draw'; // 'draw', 'fill', 'select', 'pan'
    this.lineColor = '#ff0000';
    this.lineThickness = 5;
    this.zoom = 1.0;
    this.panX = 0;
    this.panY = 0;

    // Undo / Redo
    this.undoStack = [];
    this.redoStack = [];
    this.maxStackSize = 30;

    // Selection & Clipboard
    this.selection = null; // { x, y, width, height }
    this.clipboard = null; // ImageData
    this.pasteLayer = null; // { canvas, x, y }

    // Interaction flags
    this.isDrawing = false;
    this.isPanning = false;
    this.isSelecting = false;
    this.isPinching = false;
    this.isDraggingPaste = false;
    this.lastX = 0;
    this.lastY = 0;
    this.lastPanX = 0;
    this.lastPanY = 0;
    this.pinchStartDist = 0;
    this.pinchStartZoom = 1.0;

    this.handleKeyDown = this.handleKeyDown.bind(this);
  }

  render(base64Data, mimeType, fileName) {
    this.mimeType = mimeType || 'image/png';
    this.fileName = fileName || 'Untitled';
    this.base64Data = base64Data;

    this.container.innerHTML = `
      <div class="image-editor-wrapper">
        <div class="image-editor-toolbar">
          <div class="editor-tools-group">
            <span class="file-path-badge" style="margin-right: 4px;">✏️ ${this.escapeHTML(this.fileName)}</span>
            <button class="btn btn-sm btn-outline tool-btn active" data-tool="draw" title="Draw Tool">✏️ Draw</button>
            <button class="btn btn-sm btn-outline tool-btn" data-tool="fill" title="Fill Tool">🪣 Fill</button>
            <button class="btn btn-sm btn-outline tool-btn" data-tool="select" title="Select Tool">✂️ Select</button>
            <button class="btn btn-sm btn-outline tool-btn" data-tool="pan" title="Pan Tool">✋ Pan</button>
          </div>

          <div class="editor-tools-group">
            <input type="color" id="editorColorPicker" class="color-picker-input" value="#ff0000" title="Line Color" />
            <div class="color-swatches" style="display: flex; gap: 4px;">
              <button class="btn btn-sm color-swatch" data-color="#ff0000" style="background:#ff0000;width:22px;height:22px;padding:0;border-radius:50%;border:1px solid #fff;" title="Red"></button>
              <button class="btn btn-sm color-swatch" data-color="#00ff00" style="background:#00ff00;width:22px;height:22px;padding:0;border-radius:50%;border:1px solid #fff;" title="Green"></button>
              <button class="btn btn-sm color-swatch" data-color="#0080ff" style="background:#0080ff;width:22px;height:22px;padding:0;border-radius:50%;border:1px solid #fff;" title="Blue"></button>
              <button class="btn btn-sm color-swatch" data-color="#ffff00" style="background:#ffff00;width:22px;height:22px;padding:0;border-radius:50%;border:1px solid #fff;" title="Yellow"></button>
              <button class="btn btn-sm color-swatch" data-color="#ffffff" style="background:#ffffff;width:22px;height:22px;padding:0;border-radius:50%;border:1px solid #aaa;" title="White"></button>
              <button class="btn btn-sm color-swatch" data-color="#000000" style="background:#000000;width:22px;height:22px;padding:0;border-radius:50%;border:1px solid #fff;" title="Black"></button>
            </div>
            <label style="display:flex;align-items:center;gap:4px;margin-left:4px;font-size:12px;">
              <span>Size:</span>
              <input type="range" id="editorThicknessRange" min="1" max="50" value="5" style="width:70px" />
              <span id="thicknessVal" style="min-width:28px;">5px</span>
            </label>
          </div>

          <div class="editor-tools-group">
            <button class="btn btn-sm btn-outline" id="editorUndoBtn" title="Undo (Ctrl+Z)" disabled>↩️ Undo</button>
            <button class="btn btn-sm btn-outline" id="editorRedoBtn" title="Redo (Ctrl+Y)" disabled>↪️ Redo</button>
            <button class="btn btn-sm btn-outline" id="editorCopyBtn" title="Copy Selection (Ctrl+C)" disabled>📋 Copy</button>
            <button class="btn btn-sm btn-outline" id="editorPasteBtn" title="Paste Selection (Ctrl+V)" disabled>📥 Paste</button>
          </div>

          <div class="editor-tools-group">
            <button class="btn btn-sm" id="editorZoomOut">-</button>
            <span class="zoom-label" id="editorZoomLabel" style="min-width:48px;text-align:center;display:inline-block;">100%</span>
            <button class="btn btn-sm" id="editorZoomIn">+</button>
            <button class="btn btn-sm" id="editorZoomReset">Reset</button>
          </div>

          <div class="editor-tools-group">
            <button class="btn btn-sm btn-outline" id="editorCloseBtn" title="Exit Editor">❌ Close</button>
            <button class="btn btn-sm btn-primary" id="editorSaveBtn" title="Save Changes (Ctrl+S)">💾 Save</button>
          </div>
        </div>

        <div class="image-editor-viewport" id="editorViewport">
          <div class="canvas-container" id="canvasContainer">
            <canvas id="editorCanvas"></canvas>
            <div class="selection-box hidden" id="selectionBox"></div>
            <div id="pasteLayerContainer"></div>
          </div>
        </div>
      </div>
    `;

    this.viewport = this.container.querySelector('#editorViewport');
    this.canvasContainer = this.container.querySelector('#canvasContainer');
    this.canvas = this.container.querySelector('#editorCanvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.selectionBox = this.container.querySelector('#selectionBox');
    this.pasteLayerContainer = this.container.querySelector('#pasteLayerContainer');

    this.initListeners();

    // Load image onto canvas
    const img = new Image();
    img.onload = () => {
      this.canvas.width = img.width || 800;
      this.canvas.height = img.height || 600;
      this.ctx.drawImage(img, 0, 0);

      // Initialize undo stack
      this.pushUndoState();

      // Fit zoom to viewport
      this.fitToViewport();
    };
    img.src = `data:${this.mimeType};base64,${this.base64Data}`;
  }

  initListeners() {
    // Tool switching
    this.container.querySelectorAll('.tool-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        this.setTool(e.currentTarget.getAttribute('data-tool'));
      });
    });

    // Color picker
    const colorPicker = this.container.querySelector('#editorColorPicker');
    colorPicker.addEventListener('input', (e) => {
      this.lineColor = e.target.value;
    });

    this.container.querySelectorAll('.color-swatch').forEach(btn => {
      btn.addEventListener('click', (e) => {
        this.lineColor = e.currentTarget.getAttribute('data-color');
        colorPicker.value = this.lineColor;
      });
    });

    // Thickness
    const thicknessRange = this.container.querySelector('#editorThicknessRange');
    const thicknessVal = this.container.querySelector('#thicknessVal');
    thicknessRange.addEventListener('input', (e) => {
      this.lineThickness = parseInt(e.target.value, 10);
      thicknessVal.textContent = `${this.lineThickness}px`;
    });

    // Undo / Redo buttons
    this.container.querySelector('#editorUndoBtn').addEventListener('click', () => this.undo());
    this.container.querySelector('#editorRedoBtn').addEventListener('click', () => this.redo());

    // Copy / Paste buttons
    this.container.querySelector('#editorCopyBtn').addEventListener('click', () => this.copySelection());
    this.container.querySelector('#editorPasteBtn').addEventListener('click', () => this.pasteSelection());

    // Zoom buttons
    this.container.querySelector('#editorZoomIn').addEventListener('click', () => this.changeZoom(1.2));
    this.container.querySelector('#editorZoomOut').addEventListener('click', () => this.changeZoom(1 / 1.2));
    this.container.querySelector('#editorZoomReset').addEventListener('click', () => this.fitToViewport());

    // Close & Save
    this.container.querySelector('#editorCloseBtn').addEventListener('click', () => {
      this.cleanup();
      if (this.onClose) this.onClose();
    });
    this.container.querySelector('#editorSaveBtn').addEventListener('click', () => this.save());

    // Keyboard shortcuts
    window.addEventListener('keydown', this.handleKeyDown);

    // Mouse wheel zoom
    this.viewport.addEventListener('wheel', (e) => {
      e.preventDefault();
      const zoomFactor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      this.changeZoomAround(zoomFactor, e.clientX, e.clientY);
    }, { passive: false });

    // Mouse Event Listeners
    this.viewport.addEventListener('mousedown', (e) => this.handleMouseDown(e));
    window.addEventListener('mousemove', (e) => this.handleMouseMove(e));
    window.addEventListener('mouseup', (e) => this.handleMouseUp(e));

    // Touch Event Listeners for Mobile
    this.viewport.addEventListener('touchstart', (e) => this.handleTouchStart(e), { passive: false });
    this.viewport.addEventListener('touchmove', (e) => this.handleTouchMove(e), { passive: false });
    this.viewport.addEventListener('touchend', (e) => this.handleTouchEnd(e), { passive: false });
    this.viewport.addEventListener('touchcancel', (e) => this.handleTouchEnd(e), { passive: false });
  }

  cleanup() {
    window.removeEventListener('keydown', this.handleKeyDown);
  }

  handleKeyDown(e) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
      e.preventDefault();
      if (e.shiftKey) {
        this.redo();
      } else {
        this.undo();
      }
    } else if ((e.ctrlKey || e.metaKey) && e.key === 'y') {
      e.preventDefault();
      this.redo();
    } else if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
      if (this.selection) {
        e.preventDefault();
        this.copySelection();
      }
    } else if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
      if (this.clipboard) {
        e.preventDefault();
        this.pasteSelection();
      }
    } else if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      this.save();
    } else if (e.key === 'Escape') {
      if (this.pasteLayer) {
        this.discardPaste();
      } else if (this.selection) {
        this.clearSelection();
      }
    }
  }

  setTool(newTool) {
    if (this.pasteLayer) {
      this.commitPaste();
    }
    this.tool = newTool;
    this.container.querySelectorAll('.tool-btn').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-tool') === newTool);
    });
    if (newTool !== 'select') {
      this.clearSelection();
    }
  }

  fitToViewport() {
    const vpRect = this.viewport.getBoundingClientRect();
    if (!vpRect.width || !vpRect.height || !this.canvas.width || !this.canvas.height) return;
    const scaleX = (vpRect.width - 40) / this.canvas.width;
    const scaleY = (vpRect.height - 40) / this.canvas.height;
    this.zoom = Math.min(1.0, scaleX, scaleY);
    if (this.zoom <= 0) this.zoom = 1.0;
    this.panX = (vpRect.width - this.canvas.width * this.zoom) / 2;
    this.panY = (vpRect.height - this.canvas.height * this.zoom) / 2;
    this.applyTransform();
  }

  changeZoom(factor) {
    const vpRect = this.viewport.getBoundingClientRect();
    const centerX = vpRect.left + vpRect.width / 2;
    const centerY = vpRect.top + vpRect.height / 2;
    this.changeZoomAround(factor, centerX, centerY);
  }

  changeZoomAround(factor, clientX, clientY) {
    const oldZoom = this.zoom;
    const newZoom = Math.min(20, Math.max(0.1, oldZoom * factor));
    if (newZoom === oldZoom) return;

    const vpRect = this.viewport.getBoundingClientRect();
    const relX = clientX - vpRect.left - this.panX;
    const relY = clientY - vpRect.top - this.panY;

    this.panX -= relX * (newZoom / oldZoom - 1);
    this.panY -= relY * (newZoom / oldZoom - 1);
    this.zoom = newZoom;
    this.applyTransform();
  }

  applyTransform() {
    this.canvasContainer.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.zoom})`;
    const zoomLabel = this.container.querySelector('#editorZoomLabel');
    if (zoomLabel) {
      zoomLabel.textContent = `${Math.round(this.zoom * 100)}%`;
    }
  }

  getCanvasCoords(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const scaleX = this.canvas.width / rect.width;
    const scaleY = this.canvas.height / rect.height;
    const x = (clientX - rect.left) * scaleX;
    const y = (clientY - rect.top) * scaleY;
    return {
      x: Math.max(0, Math.min(this.canvas.width, x)),
      y: Math.max(0, Math.min(this.canvas.height, y))
    };
  }

  // ----- Mouse & Touch Interaction Handlers -----
  handleMouseDown(e) {
    if (e.button !== 0 && e.button !== 1) return;
    if (this.pasteLayer) {
      // If clicking outside floating paste layer, commit paste
      if (!this.pasteLayer.element.contains(e.target)) {
        this.commitPaste();
      } else {
        return;
      }
    }

    const coords = this.getCanvasCoords(e.clientX, e.clientY);
    const isMiddleClick = (e.button === 1);
    const isSpaceHeld = (e.spaceKey || e.code === 'Space' || e.key === ' ');

    if (this.tool === 'pan' || isMiddleClick || isSpaceHeld) {
      this.isPanning = true;
      this.lastPanX = e.clientX;
      this.lastPanY = e.clientY;
      this.viewport.style.cursor = 'grabbing';
      return;
    }

    if (this.tool === 'draw') {
      this.isDrawing = true;
      this.lastX = coords.x;
      this.lastY = coords.y;
      this.ctx.beginPath();
      this.ctx.arc(this.lastX, this.lastY, this.lineThickness / 2, 0, Math.PI * 2);
      this.ctx.fillStyle = this.lineColor;
      this.ctx.fill();
    } else if (this.tool === 'fill') {
      this.floodFill(Math.floor(coords.x), Math.floor(coords.y), this.lineColor);
    } else if (this.tool === 'select') {
      this.isSelecting = true;
      this.selectStartX = coords.x;
      this.selectStartY = coords.y;
      this.updateSelectionBox(coords.x, coords.y, coords.x, coords.y);
    }
  }

  handleMouseMove(e) {
    if (this.isPanning) {
      const dx = e.clientX - this.lastPanX;
      const dy = e.clientY - this.lastPanY;
      this.lastPanX = e.clientX;
      this.lastPanY = e.clientY;
      this.panX += dx;
      this.panY += dy;
      this.applyTransform();
      return;
    }

    if (this.isDrawing) {
      const coords = this.getCanvasCoords(e.clientX, e.clientY);
      this.ctx.beginPath();
      this.ctx.moveTo(this.lastX, this.lastY);
      this.ctx.lineTo(coords.x, coords.y);
      this.ctx.strokeStyle = this.lineColor;
      this.ctx.lineWidth = this.lineThickness;
      this.ctx.lineCap = 'round';
      this.ctx.lineJoin = 'round';
      this.ctx.stroke();
      this.lastX = coords.x;
      this.lastY = coords.y;
    } else if (this.isSelecting) {
      const coords = this.getCanvasCoords(e.clientX, e.clientY);
      this.updateSelectionBox(this.selectStartX, this.selectStartY, coords.x, coords.y);
    }
  }

  handleMouseUp(e) {
    if (this.isPanning) {
      this.isPanning = false;
      this.viewport.style.cursor = 'default';
    }
    if (this.isDrawing) {
      this.isDrawing = false;
      this.pushUndoState();
    }
    if (this.isSelecting) {
      this.isSelecting = false;
      const coords = this.getCanvasCoords(e.clientX, e.clientY);
      this.finalizeSelection(this.selectStartX, this.selectStartY, coords.x, coords.y);
    }
  }

  handleTouchStart(e) {
    e.preventDefault();
    if (e.touches.length === 2) {
      // Two finger pinch to zoom and pan
      this.isPinching = true;
      this.isDrawing = false;
      this.isPanning = false;
      this.isSelecting = false;
      const t0 = e.touches[0];
      const t1 = e.touches[1];
      this.pinchStartDist = Math.hypot(t0.clientX - t1.clientX, t0.clientY - t1.clientY);
      this.pinchStartZoom = this.zoom;
      this.lastPanX = (t0.clientX + t1.clientX) / 2;
      this.lastPanY = (t0.clientY + t1.clientY) / 2;
      return;
    }

    if (e.touches.length === 1) {
      const touch = e.touches[0];
      this.handleMouseDown({
        button: 0,
        clientX: touch.clientX,
        clientY: touch.clientY,
        target: touch.target
      });
    }
  }

  handleTouchMove(e) {
    e.preventDefault();
    if (this.isPinching && e.touches.length === 2) {
      const t0 = e.touches[0];
      const t1 = e.touches[1];
      const dist = Math.hypot(t0.clientX - t1.clientX, t0.clientY - t1.clientY);
      const midX = (t0.clientX + t1.clientX) / 2;
      const midY = (t0.clientY + t1.clientY) / 2;

      // Pan
      const dx = midX - this.lastPanX;
      const dy = midY - this.lastPanY;
      this.lastPanX = midX;
      this.lastPanY = midY;
      this.panX += dx;
      this.panY += dy;

      // Zoom
      if (this.pinchStartDist > 0) {
        const zoomFactor = dist / this.pinchStartDist;
        const newZoom = Math.min(20, Math.max(0.1, this.pinchStartZoom * zoomFactor));
        this.zoom = newZoom;
      }
      this.applyTransform();
      return;
    }

    if (e.touches.length === 1) {
      const touch = e.touches[0];
      this.handleMouseMove({
        clientX: touch.clientX,
        clientY: touch.clientY
      });
    }
  }

  handleTouchEnd(e) {
    e.preventDefault();
    if (e.touches.length < 2 && this.isPinching) {
      this.isPinching = false;
    }
    if (e.touches.length === 0) {
      this.handleMouseUp({
        clientX: this.lastPanX || 0,
        clientY: this.lastPanY || 0
      });
    }
  }

  // ----- Flood Fill Tool -----
  floodFill(startX, startY, hexColor) {
    const w = this.canvas.width;
    const h = this.canvas.height;
    if (startX < 0 || startX >= w || startY < 0 || startY >= h) return;

    const imgData = this.ctx.getImageData(0, 0, w, h);
    const data = imgData.data;
    const targetIdx = (startY * w + startX) * 4;
    const targetR = data[targetIdx];
    const targetG = data[targetIdx + 1];
    const targetB = data[targetIdx + 2];
    const targetA = data[targetIdx + 3];

    const rgb = this.hexToRgb(hexColor);
    const fillR = rgb.r;
    const fillG = rgb.g;
    const fillB = rgb.b;
    const fillA = 255;

    // If target color is already fill color, return
    if (targetR === fillR && targetG === fillG && targetB === fillB && targetA === fillA) return;

    const tolerance = 15;
    const colorMatch = (idx) => {
      return Math.abs(data[idx] - targetR) <= tolerance &&
             Math.abs(data[idx + 1] - targetG) <= tolerance &&
             Math.abs(data[idx + 2] - targetB) <= tolerance &&
             Math.abs(data[idx + 3] - targetA) <= tolerance;
    };

    const setColor = (idx) => {
      data[idx] = fillR;
      data[idx + 1] = fillG;
      data[idx + 2] = fillB;
      data[idx + 3] = fillA;
    };

    const visited = new Uint8Array(w * h);
    const stack = [[startX, startY]];

    while (stack.length > 0) {
      const [x, y] = stack.pop();
      let pixelPos = y * w + x;
      let idx = pixelPos * 4;

      if (visited[pixelPos] || !colorMatch(idx)) continue;

      // Scan left
      let lx = x;
      while (lx > 0 && !visited[pixelPos - 1] && colorMatch(idx - 4)) {
        lx--;
        pixelPos--;
        idx -= 4;
      }

      // Scan right
      let rx = lx;
      let spanAbove = false;
      let spanBelow = false;

      while (rx < w && !visited[pixelPos] && colorMatch(idx)) {
        setColor(idx);
        visited[pixelPos] = 1;

        // Check above
        if (y > 0) {
          const abovePos = (y - 1) * w + rx;
          const aboveIdx = abovePos * 4;
          if (!visited[abovePos] && colorMatch(aboveIdx)) {
            if (!spanAbove) {
              stack.push([rx, y - 1]);
              spanAbove = true;
            }
          } else {
            spanAbove = false;
          }
        }

        // Check below
        if (y < h - 1) {
          const belowPos = (y + 1) * w + rx;
          const belowIdx = belowPos * 4;
          if (!visited[belowPos] && colorMatch(belowIdx)) {
            if (!spanBelow) {
              stack.push([rx, y + 1]);
              spanBelow = true;
            }
          } else {
            spanBelow = false;
          }
        }

        rx++;
        pixelPos++;
        idx += 4;
      }
    }

    this.ctx.putImageData(imgData, 0, 0);
    this.pushUndoState();
  }

  hexToRgb(hex) {
    const clean = hex.replace('#', '');
    const bigint = parseInt(clean, 16);
    return {
      r: (bigint >> 16) & 255,
      g: (bigint >> 8) & 255,
      b: bigint & 255
    };
  }

  // ----- Selection & Copy/Paste -----
  updateSelectionBox(x1, y1, x2, y2) {
    const left = Math.min(x1, x2);
    const top = Math.min(y1, y2);
    const width = Math.abs(x2 - x1);
    const height = Math.abs(y2 - y1);

    this.selectionBox.style.left = `${left}px`;
    this.selectionBox.style.top = `${top}px`;
    this.selectionBox.style.width = `${width}px`;
    this.selectionBox.style.height = `${height}px`;
    this.selectionBox.classList.remove('hidden');
  }

  finalizeSelection(x1, y1, x2, y2) {
    const left = Math.max(0, Math.min(this.canvas.width, Math.min(x1, x2)));
    const top = Math.max(0, Math.min(this.canvas.height, Math.min(y1, y2)));
    const width = Math.min(this.canvas.width - left, Math.abs(x2 - x1));
    const height = Math.min(this.canvas.height - top, Math.abs(y2 - y1));

    if (width > 2 && height > 2) {
      this.selection = { x: left, y: top, width, height };
      this.container.querySelector('#editorCopyBtn').disabled = false;
    } else {
      this.clearSelection();
    }
  }

  clearSelection() {
    this.selection = null;
    this.selectionBox.classList.add('hidden');
    this.container.querySelector('#editorCopyBtn').disabled = true;
  }

  copySelection() {
    if (!this.selection) return;
    this.clipboard = this.ctx.getImageData(
      Math.floor(this.selection.x),
      Math.floor(this.selection.y),
      Math.floor(this.selection.width),
      Math.floor(this.selection.height)
    );
    this.container.querySelector('#editorPasteBtn').disabled = false;
    this.showToast('Selection copied!');
  }

  pasteSelection() {
    if (!this.clipboard) return;
    if (this.pasteLayer) {
      this.commitPaste();
    }

    // Place floating paste layer near center of viewport or selection
    let pasteX = 20;
    let pasteY = 20;
    if (this.selection) {
      pasteX = Math.min(this.canvas.width - this.clipboard.width, this.selection.x + 20);
      pasteY = Math.min(this.canvas.height - this.clipboard.height, this.selection.y + 20);
    } else {
      const vpRect = this.viewport.getBoundingClientRect();
      const center = this.getCanvasCoords(vpRect.left + vpRect.width / 2, vpRect.top + vpRect.height / 2);
      pasteX = Math.max(0, Math.min(this.canvas.width - this.clipboard.width, center.x - this.clipboard.width / 2));
      pasteY = Math.max(0, Math.min(this.canvas.height - this.clipboard.height, center.y - this.clipboard.height / 2));
    }

    const pasteCanvas = document.createElement('canvas');
    pasteCanvas.width = this.clipboard.width;
    pasteCanvas.height = this.clipboard.height;
    pasteCanvas.getContext('2d').putImageData(this.clipboard, 0, 0);
    pasteCanvas.className = 'paste-canvas-layer';

    const wrapper = document.createElement('div');
    wrapper.className = 'paste-layer-wrapper';
    wrapper.style.position = 'absolute';
    wrapper.style.left = `${pasteX}px`;
    wrapper.style.top = `${pasteY}px`;
    wrapper.style.zIndex = '10';

    // Toolbar for paste layer
    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'paste-actions';
    actionsDiv.style.position = 'absolute';
    actionsDiv.style.top = '-32px';
    actionsDiv.style.left = '0';
    actionsDiv.style.display = 'flex';
    actionsDiv.style.gap = '4px';
    actionsDiv.style.background = '#1e1e2e';
    actionsDiv.style.padding = '2px 6px';
    actionsDiv.style.borderRadius = '4px';
    actionsDiv.style.border = '1px solid #313244';
    actionsDiv.style.zIndex = '20';
    actionsDiv.innerHTML = `
      <button class="btn btn-sm btn-success" id="pasteCommitBtn" style="padding: 2px 6px; font-size: 11px;">✓ Apply</button>
      <button class="btn btn-sm btn-danger" id="pasteDiscardBtn" style="padding: 2px 6px; font-size: 11px;">✕ Discard</button>
    `;

    wrapper.appendChild(pasteCanvas);
    wrapper.appendChild(actionsDiv);
    this.pasteLayerContainer.appendChild(wrapper);

    this.pasteLayer = {
      element: wrapper,
      canvas: pasteCanvas,
      x: pasteX,
      y: pasteY
    };

    // Make paste layer draggable
    let isDragging = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let startLeft = pasteX;
    let startTop = pasteY;

    const onDragStart = (clientX, clientY) => {
      isDragging = true;
      dragStartX = clientX;
      dragStartY = clientY;
      startLeft = this.pasteLayer.x;
      startTop = this.pasteLayer.y;
    };

    const onDragMove = (clientX, clientY) => {
      if (!isDragging) return;
      const dx = (clientX - dragStartX) / this.zoom;
      const dy = (clientY - dragStartY) / this.zoom;
      this.pasteLayer.x = startLeft + dx;
      this.pasteLayer.y = startTop + dy;
      wrapper.style.left = `${this.pasteLayer.x}px`;
      wrapper.style.top = `${this.pasteLayer.y}px`;
    };

    const onDragEnd = () => {
      isDragging = false;
    };

    pasteCanvas.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      onDragStart(e.clientX, e.clientY);
    });
    window.addEventListener('mousemove', (e) => onDragMove(e.clientX, e.clientY));
    window.addEventListener('mouseup', () => onDragEnd());

    pasteCanvas.addEventListener('touchstart', (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (e.touches.length === 1) {
        onDragStart(e.touches[0].clientX, e.touches[0].clientY);
      }
    }, { passive: false });
    window.addEventListener('touchmove', (e) => {
      if (isDragging && e.touches.length === 1) {
        onDragMove(e.touches[0].clientX, e.touches[0].clientY);
      }
    }, { passive: false });
    window.addEventListener('touchend', () => onDragEnd(), { passive: false });

    wrapper.querySelector('#pasteCommitBtn').addEventListener('click', (e) => {
      e.stopPropagation();
      this.commitPaste();
    });
    wrapper.querySelector('#pasteDiscardBtn').addEventListener('click', (e) => {
      e.stopPropagation();
      this.discardPaste();
    });
  }

  commitPaste() {
    if (!this.pasteLayer) return;
    this.ctx.drawImage(this.pasteLayer.canvas, Math.round(this.pasteLayer.x), Math.round(this.pasteLayer.y));
    this.pasteLayerContainer.innerHTML = '';
    this.pasteLayer = null;
    this.pushUndoState();
    this.showToast('Pasted image applied!');
  }

  discardPaste() {
    if (!this.pasteLayer) return;
    this.pasteLayerContainer.innerHTML = '';
    this.pasteLayer = null;
  }

  // ----- Undo / Redo Stack -----
  pushUndoState() {
    const imgData = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
    this.undoStack.push(imgData);
    if (this.undoStack.length > this.maxStackSize) {
      this.undoStack.shift();
    }
    this.redoStack = [];
    this.updateUndoRedoButtons();
  }

  undo() {
    if (this.undoStack.length <= 1) return;
    if (this.pasteLayer) {
      this.discardPaste();
    }
    const current = this.undoStack.pop();
    this.redoStack.push(current);
    const prev = this.undoStack[this.undoStack.length - 1];
    this.ctx.putImageData(prev, 0, 0);
    this.updateUndoRedoButtons();
  }

  redo() {
    if (this.redoStack.length === 0) return;
    if (this.pasteLayer) {
      this.discardPaste();
    }
    const next = this.redoStack.pop();
    this.undoStack.push(next);
    this.ctx.putImageData(next, 0, 0);
    this.updateUndoRedoButtons();
  }

  updateUndoRedoButtons() {
    const undoBtn = this.container.querySelector('#editorUndoBtn');
    const redoBtn = this.container.querySelector('#editorRedoBtn');
    if (undoBtn) undoBtn.disabled = (this.undoStack.length <= 1);
    if (redoBtn) redoBtn.disabled = (this.redoStack.length === 0);
  }

  exportBase64() {
    if (this.pasteLayer) {
      this.commitPaste();
    }
    const dataUrl = this.canvas.toDataURL(this.mimeType || 'image/png');
    if (dataUrl.includes(',')) {
      return dataUrl.substring(dataUrl.indexOf(',') + 1);
    }
    return dataUrl;
  }

  save() {
    if (this.onSave) {
      const newBase64 = this.exportBase64();
      this.base64Data = newBase64;
      this.onSave(newBase64);
    }
  }

  showToast(msg) {
    const toast = document.getElementById('toast');
    if (toast) {
      toast.textContent = msg;
      toast.classList.remove('hidden');
      setTimeout(() => toast.classList.add('hidden'), 2500);
    }
  }

  escapeHTML(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
}
