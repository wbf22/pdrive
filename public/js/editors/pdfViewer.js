import { downloadFile } from '../api.js';
import { attachPinchZoom } from '../pinchZoom.js';
import { initFullscreenButton } from '../fullscreen.js';

export class PDFViewer {
  constructor(container, onSave) {
    this.container = container;
    this.onSave = onSave;
    this.pdfDoc = null;
    this.pageNum = 1;
    this.pageRendering = false;
    this.renderPending = null;
    this.renderedScale = 1.0;
    this.scale = 1.0;
    this.filePath = '';
  }

  async render(filePath) {
    this.filePath = filePath;
    this.pageNum = 1;
    this.scale = 1.0;
    this.renderedScale = 1.0;

    this.container.innerHTML = `
      <div class="pdf-viewer-wrapper">
        <div class="pdf-toolbar">
          <span class="file-path-badge">${this.escapeHTML(filePath)}</span>
          <div class="pdf-controls">
            <button class="btn btn-sm" id="pdfPrev" title="Previous Page">◀</button>
            <span class="pdf-page-info">
              Page <input type="number" id="pdfPageInput" value="1" min="1" class="pdf-page-input" />
              / <span id="pdfPageCount">—</span>
            </span>
            <button class="btn btn-sm" id="pdfNext" title="Next Page">▶</button>
            <span class="toolbar-divider"></span>
            <button class="btn btn-sm" id="pdfZoomOut" title="Zoom Out">−</button>
            <span id="pdfZoomLabel" class="pdf-zoom-label">100%</span>
            <button class="btn btn-sm" id="pdfZoomIn" title="Zoom In">+</button>
            <span class="toolbar-divider"></span>
            <button class="btn btn-sm btn-outline" id="pdfFullscreenBtn" title="Fullscreen">⛶ Fullscreen</button>
            <button class="btn btn-sm btn-outline" id="pdfDownloadBtn" title="Download PDF">⬇ Download</button>
          </div>
        </div>
        <div class="pdf-loading" id="pdfLoading">Loading PDF…</div>
        <div class="pdf-page-container" id="pdfPageContainer">
          <canvas id="pdfCanvas" class="pdf-page-canvas"></canvas>
        </div>
      </div>
    `;

    this.pageContainerEl = document.getElementById('pdfPageContainer');
    this.canvas = document.getElementById('pdfCanvas');

    try {
      const response = await downloadFile(filePath);
      const arrayBuffer = await response.arrayBuffer();

      pdfjsLib.GlobalWorkerOptions.workerSrc = '/lib/pdf.worker.min.js';

      const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
      this.pdfDoc = await loadingTask.promise;

      document.getElementById('pdfLoading').style.display = 'none';
      document.getElementById('pdfPageCount').textContent = this.pdfDoc.numPages;
      document.getElementById('pdfPageInput').max = this.pdfDoc.numPages;

      await this.renderPage(this.pageNum);

      document.getElementById('pdfPrev').addEventListener('click', () => this.onPrevPage());
      document.getElementById('pdfNext').addEventListener('click', () => this.onNextPage());
      document.getElementById('pdfPageInput').addEventListener('change', (e) => {
        const num = parseInt(e.target.value, 10);
        if (num >= 1 && num <= this.pdfDoc.numPages) {
          this.goToPage(num);
        } else {
          e.target.value = this.pageNum;
        }
      });
      document.getElementById('pdfZoomIn').addEventListener('click', () => this.onZoomIn());
      document.getElementById('pdfZoomOut').addEventListener('click', () => this.onZoomOut());
      document.getElementById('pdfDownloadBtn').addEventListener('click', () => this.onDownload());
      this._detachFs = initFullscreenButton(
        document.getElementById('pdfFullscreenBtn'),
        this.container.querySelector('.pdf-viewer-wrapper')
      );

      document.addEventListener('keydown', this._keyHandler = (e) => {
        if (e.key === 'ArrowLeft' || e.key === 'PageUp') this.onPrevPage();
        if (e.key === 'ArrowRight' || e.key === 'PageDown') this.onNextPage();
      });

      const pageContainer = this.pageContainerEl;
      pageContainer.addEventListener('wheel', this._wheelHandler = (e) => {
        if (!e.ctrlKey) return;
        e.preventDefault();
        if (e.deltaY < 0) this.onZoomIn(e.clientX, e.clientY);
        else this.onZoomOut(e.clientX, e.clientY);
      }, { passive: false });

      // Two-finger pinch to zoom, anchored at the pinch midpoint
      this._detachPinch = attachPinchZoom(pageContainer, {
        getZoom: () => this.scale,
        onPinch: (zoom, midX, midY) => {
          this.zoomTo(Math.min(3, Math.max(0.25, zoom)), midX, midY);
        }
      });
    } catch (err) {
      const el = document.getElementById('pdfLoading');
      el.textContent = 'Failed to load PDF: ' + err.message;
      el.style.color = 'var(--error-color, #f38ba8)';
    }
  }

  // Capture the page coordinate currently under the given screen point.
  // `this.scale` is the displayed scale, which matches getBoundingClientRect
  // even while a CSS transform is active (transform-origin 0 0).
  captureAnchor(clientX, clientY) {
    const container = this.pageContainerEl;
    const rect = container.getBoundingClientRect();
    const canvasRect = this.canvas.getBoundingClientRect();
    const s = this.scale || 1;
    const canvasX = canvasRect.left - rect.left + container.scrollLeft;
    const canvasY = canvasRect.top - rect.top + container.scrollTop;
    return {
      px: (clientX - rect.left - canvasX + container.scrollLeft) / s,
      py: (clientY - rect.top - canvasY + container.scrollTop) / s,
      clientX,
      clientY,
    };
  }

  // Scroll so the captured page coordinate stays under the same screen point.
  applyAnchor(anchor) {
    const container = this.pageContainerEl;
    const rect = container.getBoundingClientRect();
    const canvasRect = this.canvas.getBoundingClientRect();
    const s = this.scale || 1;
    const canvasX = canvasRect.left - rect.left + container.scrollLeft;
    const canvasY = canvasRect.top - rect.top + container.scrollTop;
    container.scrollLeft = rect.left + canvasX + anchor.px * s - anchor.clientX;
    container.scrollTop = rect.top + canvasY + anchor.py * s - anchor.clientY;
  }

  // Update the displayed scale immediately via a CSS transform on the canvas,
  // so zooming doesn't clear and re-rasterize the page on every step.
  applyScaleTransform() {
    const ratio = this.renderedScale ? this.scale / this.renderedScale : 1;
    this.canvas.style.transformOrigin = '0 0';
    this.canvas.style.transform = Math.abs(ratio - 1) < 0.001 ? '' : `scale(${ratio})`;
  }

  // Common path for every zoom input: re-anchor around the given screen point,
  // apply the CSS transform, and queue a single crisp re-render when idle.
  zoomTo(newScale, clientX, clientY) {
    const clamped = Math.min(3, Math.max(0.25, newScale));
    if (Math.abs(clamped - this.scale) < 0.001) return;
    this._lastAnchorX = clientX;
    this._lastAnchorY = clientY;
    const anchor = this.captureAnchor(clientX, clientY);
    this.scale = clamped;
    this.updateZoomLabel();
    this.applyScaleTransform();
    this.applyAnchor(anchor);
    this.scheduleFinalRender();
  }

  scheduleFinalRender() {
    clearTimeout(this._zoomTimer);
    this._zoomTimer = setTimeout(() => this.finalizeZoom(), 150);
  }

  finalizeZoom() {
    clearTimeout(this._zoomTimer);
    if (Math.abs(this.scale - this.renderedScale) < 0.001) return;
    const anchor = this.captureAnchor(this._lastAnchorX, this._lastAnchorY);
    this.canvas.style.transform = '';
    this.requestRender(() => this.applyAnchor(anchor));
  }

  // Render the current page, coalescing rapid scale changes into a single
  // final render and invoking `onDone` after the latest one completes.
  requestRender(onDone) {
    return new Promise((resolve) => {
      const done = () => { if (onDone) onDone(); resolve(); };
      if (this.pageRendering) {
        this.renderPending = done;
        return;
      }
      this.renderPage(this.pageNum).then(done);
    });
  }

  async renderPage(num) {
    if (this.pageRendering) return;
    this.pageRendering = true;
    const renderScale = this.scale;

    try {
      const page = await this.pdfDoc.getPage(num);
      const viewport = page.getViewport({ scale: renderScale });

      const canvas = this.canvas;
      canvas.height = viewport.height;
      canvas.width = viewport.width;

      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      await page.render({ canvasContext: ctx, viewport }).promise;
      this.renderedScale = renderScale;
      this.canvas.style.transform = '';
    } finally {
      this.pageRendering = false;
      if (this.renderPending) {
        const cb = this.renderPending;
        this.renderPending = null;
        this.requestRender(cb);
      }
    }
  }

  goToPage(num) {
    if (!this.pdfDoc) return;
    if (num < 1) num = 1;
    if (num > this.pdfDoc.numPages) num = this.pdfDoc.numPages;
    if (num === this.pageNum) return;
    this.pageNum = num;
    document.getElementById('pdfPageInput').value = num;
    clearTimeout(this._zoomTimer);
    this.canvas.style.transform = '';
    this.renderPending = null;
    const container = this.pageContainerEl;
    container.scrollTop = 0;
    container.scrollLeft = 0;
    this.requestRender().then(() => {
      container.scrollTop = 0;
      container.scrollLeft = 0;
    });
  }

  onPrevPage() {
    this.goToPage(this.pageNum - 1);
  }

  onNextPage() {
    this.goToPage(this.pageNum + 1);
  }

  viewportCenter() {
    const rect = this.pageContainerEl.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }

  onZoomIn(clientX, clientY) {
    const center = this.viewportCenter();
    this.zoomTo(this.scale + 0.25, clientX ?? center.x, clientY ?? center.y);
  }

  onZoomOut(clientX, clientY) {
    const center = this.viewportCenter();
    this.zoomTo(this.scale - 0.25, clientX ?? center.x, clientY ?? center.y);
  }

  updateZoomLabel() {
    document.getElementById('pdfZoomLabel').textContent = Math.round(this.scale * 100) + '%';
  }

  async onDownload() {
    try {
      const response = await downloadFile(this.filePath);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = this.filePath.split('/').pop() || 'document.pdf';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (err) {
      console.error('Download failed:', err);
    }
  }

  save() {
    // PDF viewer is read-only
  }

  destroy() {
    clearTimeout(this._zoomTimer);
    if (this._detachFs) {
      this._detachFs();
    }
    if (this._keyHandler) {
      document.removeEventListener('keydown', this._keyHandler);
    }
    if (this._wheelHandler) {
      const el = this.pageContainerEl;
      if (el) el.removeEventListener('wheel', this._wheelHandler);
    }
    if (this._detachPinch) {
      this._detachPinch();
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
