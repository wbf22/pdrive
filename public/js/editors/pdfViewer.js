import { downloadFile } from '../api.js';

export class PDFViewer {
  constructor(container, onSave) {
    this.container = container;
    this.onSave = onSave;
    this.pdfDoc = null;
    this.pageNum = 1;
    this.pageRendering = false;
    this.scale = 1.0;
    this.filePath = '';
  }

  async render(filePath) {
    this.filePath = filePath;
    this.pageNum = 1;
    this.scale = 1.0;

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
            <button class="btn btn-sm btn-outline" id="pdfDownloadBtn" title="Download PDF">⬇ Download</button>
          </div>
        </div>
        <div class="pdf-loading" id="pdfLoading">Loading PDF…</div>
        <div class="pdf-page-container" id="pdfPageContainer">
          <canvas id="pdfCanvas" class="pdf-page-canvas"></canvas>
        </div>
      </div>
    `;

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

      document.addEventListener('keydown', this._keyHandler = (e) => {
        if (e.key === 'ArrowLeft' || e.key === 'PageUp') this.onPrevPage();
        if (e.key === 'ArrowRight' || e.key === 'PageDown') this.onNextPage();
      });

      const pageContainer = document.getElementById('pdfPageContainer');
      pageContainer.addEventListener('wheel', this._wheelHandler = (e) => {
        if (!e.ctrlKey) return;
        e.preventDefault();
        if (e.deltaY < 0) this.onZoomIn();
        else this.onZoomOut();
      }, { passive: false });
    } catch (err) {
      const el = document.getElementById('pdfLoading');
      el.textContent = 'Failed to load PDF: ' + err.message;
      el.style.color = 'var(--error-color, #f38ba8)';
    }
  }

  async renderPage(num) {
    if (this.pageRendering) return;
    this.pageRendering = true;

    try {
      const page = await this.pdfDoc.getPage(num);
      const viewport = page.getViewport({ scale: this.scale });

      const canvas = document.getElementById('pdfCanvas');
      canvas.height = viewport.height;
      canvas.width = viewport.width;

      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      await page.render({ canvasContext: ctx, viewport }).promise;
    } finally {
      this.pageRendering = false;
    }
  }

  goToPage(num) {
    if (!this.pdfDoc) return;
    if (num < 1) num = 1;
    if (num > this.pdfDoc.numPages) num = this.pdfDoc.numPages;
    if (num === this.pageNum) return;
    this.pageNum = num;
    document.getElementById('pdfPageInput').value = num;
    this.renderPage(num);
  }

  onPrevPage() {
    this.goToPage(this.pageNum - 1);
  }

  onNextPage() {
    this.goToPage(this.pageNum + 1);
  }

  async onZoomIn() {
    this.scale = Math.min(3, +(this.scale + 0.25).toFixed(2));
    this.updateZoomLabel();
    if (this.pdfDoc) await this.renderPage(this.pageNum);
  }

  async onZoomOut() {
    this.scale = Math.max(0.25, +(this.scale - 0.25).toFixed(2));
    this.updateZoomLabel();
    if (this.pdfDoc) await this.renderPage(this.pageNum);
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
    if (this._keyHandler) {
      document.removeEventListener('keydown', this._keyHandler);
    }
    if (this._wheelHandler) {
      const el = document.getElementById('pdfPageContainer');
      if (el) el.removeEventListener('wheel', this._wheelHandler);
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
