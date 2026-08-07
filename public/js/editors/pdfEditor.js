import { loadScript } from '../lazyLoad.js';
import { base64ToArrayBuffer, uint8ArrayToBase64 } from '../fileStore.js';

const PDF_META_MARKER = '%%PDRIVE-ITEMS%%';

function utf8Encode(str) {
  return new TextEncoder().encode(str);
}

function utf8Decode(bytes) {
  return new TextDecoder().decode(bytes);
}

// Embed a metadata JSON payload appended after the last %%EOF. Trailing bytes
// after the final EOF trailer are ignored by PDF readers/renderers, so this
// keeps the file portable and usable offline.
function embedMetadata(bytes, payload) {
  const doc = new Uint8Array(bytes);
  let b64 = '';
  try {
    b64 = uint8ArrayToBase64(utf8Encode(JSON.stringify(payload)));
  } catch (err) {
    console.warn('Could not encode PDF metadata:', err);
    return bytes;
  }

  // Locate the last %%EOF and truncate so we re-emit our own trailer.
  const eof = utf8Encode('%%EOF');
  let lastEof = -1;
  for (let i = 0; i + eof.length <= doc.length; i++) {
    let m = true;
    for (let j = 0; j < eof.length; j++) {
      if (doc[i + j] !== eof[j]) { m = false; break; }
    }
    if (m) lastEof = i;
  }
  const head = lastEof >= 0 ? doc.subarray(0, lastEof) : doc;

  const markerLine = utf8Encode('\n' + PDF_META_MARKER + b64 + '\n%%EOF');
  const out = new Uint8Array(head.length + markerLine.length);
  out.set(head, 0);
  out.set(markerLine, head.length);
  return out;
}

// Extract the embedded metadata payload from a PDF saved by the editor, plus
// the remaining bytes (a valid, trailer-terminated PDF).
function extractMetadata(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const marker = utf8Encode(PDF_META_MARKER);
  let idx = -1;
  for (let i = 0; i <= bytes.length - marker.length; i++) {
    let m = true;
    for (let j = 0; j < marker.length; j++) {
      if (bytes[i + j] !== marker[j]) { m = false; break; }
    }
    if (m) { idx = i; break; }
  }

  if (idx < 0) return { buffer: arrayBuffer, payload: null };

  const cleanBytes = bytes.subarray(0, idx);

  // Base64 payload sits between the marker and the trailing %%EOF.
  let j = idx + marker.length;
  let payload = '';
  while (j < bytes.length && bytes[j] !== 37) { // '%'
    payload += String.fromCharCode(bytes[j]);
    j++;
  }

  let data = null;
  try {
    const raw = atob(payload);
    const out = new Uint8Array(raw.length);
    for (let k = 0; k < raw.length; k++) out[k] = raw.charCodeAt(k);
    data = JSON.parse(utf8Decode(out));
  } catch (err) {
    console.warn('Could not decode PDF metadata:', err);
    data = null;
  }

  return { buffer: cleanBytes.buffer, payload: data };
}

// Serialize the live pageItems into a JSON-safe structure (drop live image
// buffers but keep dataUrl so images re-render after reopen).
function serializeItems(pageItems) {
  const serializable = {};
  for (const [pKey, list] of Object.entries(pageItems || {})) {
    serializable[pKey] = (list || []).map(it => {
      const c = {};
      for (const k of ['id', 'type', 'text', 'fontName', 'fontSize', 'color', 'x', 'y', 'width', 'height',
        'rows', 'cols', 'data', 'headerBgColor', 'borderColor', 'colWidth', 'rowHeight',
        'strokeColor', 'fillColor', 'strokeWidth', 'mimeType', 'dataUrl']) {
        if (it[k] !== undefined) c[k] = it[k];
      }
      return c;
    });
  }
  return serializable;
}

// Rehydrate pageItems from serialized metadata.
function deserializeItems(pages) {
  const out = {};
  for (const [pKey, list] of Object.entries(pages || {})) {
    out[pKey] = (list || []).map(it => ({ ...it }));
  }
  return out;
}

function mapFontName(fontName) {
  const name = (fontName || '').toLowerCase().replace(/^\w+\d+_[a-z0-9]+/i, '');
  if (name.includes('times')) return 'Times-Roman';
  if (name.includes('courier')) return 'Courier';
  return 'Helvetica';
}

export class PDFEditor {
  constructor(container, options = {}) {
    this.container = container;
    this.onSave = options.onSave || null;
    this.onClose = options.onClose || null;
    this.onToast = options.onToast || ((msg) => console.log(msg));

    this.filePath = '';
    this.pdfDocLib = null;
    this.pdfDocJs = null;
    this.pageNum = 1;
    this.scale = 1.0;
    this.pageItems = {}; // Map: pageNum -> Array of items
    this.selectedItem = null;
    this.activeTool = 'select'; // 'select', 'text', 'image', 'table', 'rect', 'line'

    this._dragState = null;
  }

  async render(filePath, base64Content) {
    this.filePath = filePath || 'Untitled.pdf';
    this.pageNum = 1;
    this.scale = 1.0;
    this.selectedItem = null;

    this.container.innerHTML = `
      <div class="pdf-viewer-wrapper" style="display:flex;flex-direction:column;height:100%;">
        <div class="pdf-toolbar" style="gap:8px;">
          <span class="file-path-badge">✏️ Editing: ${this.escapeHTML(this.filePath)}</span>
          <div class="pdf-controls">
            <button class="btn btn-sm btn-outline tool-btn active" data-tool="select" title="Select Tool">✋ Select</button>
            <button class="btn btn-sm btn-outline tool-btn" data-tool="text" title="Add Text">📝 + Text</button>
            <button class="btn btn-sm btn-outline tool-btn" data-tool="image" title="Add Image">🖼️ + Image</button>
            <button class="btn btn-sm btn-outline tool-btn" data-tool="table" title="Add Table">📊 + Table</button>
            <button class="btn btn-sm btn-outline tool-btn" data-tool="rect" title="Add Rectangle">⬜ + Rect</button>
            <button class="btn btn-sm btn-outline tool-btn" data-tool="line" title="Add Line">➖ + Line</button>
            <span class="toolbar-divider"></span>
            <button class="btn btn-sm" id="pdfEdAddPage" title="Add Blank Page">➕ Page</button>
            <button class="btn btn-sm" id="pdfEdDelPage" title="Delete Current Page">🗑️ Page</button>
            <span class="toolbar-divider"></span>
            <button class="btn btn-sm" id="pdfEdPrev" title="Previous Page">◀</button>
            <span class="pdf-page-info">
              Page <input type="number" id="pdfEdPageInput" value="1" min="1" class="pdf-page-input" />
              / <span id="pdfEdPageCount">—</span>
            </span>
            <button class="btn btn-sm" id="pdfEdNext" title="Next Page">▶</button>
            <span class="toolbar-divider"></span>
            <button class="btn btn-sm" id="pdfEdZoomOut" title="Zoom Out">−</button>
            <span id="pdfEdZoomLabel" class="pdf-zoom-label">100%</span>
            <button class="btn btn-sm" id="pdfEdZoomIn" title="Zoom In">+</button>
            <span class="toolbar-divider"></span>
            <button class="btn btn-sm btn-outline" id="pdfEdCloseBtn">❌ Close</button>
            <button class="btn btn-sm btn-primary" id="pdfEdSaveBtn">💾 Save PDF</button>
          </div>
        </div>

        <div class="pdf-toolbar hidden" id="pdfEdPropToolbar" style="background:var(--bg-dark);border-bottom:1px solid var(--border-color);padding:6px 16px;min-height:38px;"></div>

        <div class="pdf-loading" id="pdfEdLoading">Loading PDF Editor…</div>

        <div class="pdf-page-container" id="pdfEdPageContainer" style="flex:1;overflow:auto;position:relative;display:flex;justify-content:center;padding:16px;">
          <div id="pdfEdCanvasWrapper" style="position:relative;display:inline-block;box-shadow:0 4px 16px rgba(0,0,0,0.3);">
            <canvas id="pdfEditorBgCanvas" class="pdf-page-canvas" style="display:block;"></canvas>
            <div id="pdfEditorOverlay" style="position:absolute;top:0;left:0;width:100%;height:100%;overflow:hidden;"></div>
          </div>
        </div>
      </div>
      <input type="file" id="pdfEdImgInput" class="hidden" accept="image/png,image/jpeg,image/webp" />

      <!-- Table Edit Modal -->
      <div class="modal-overlay hidden" id="tableEditModal">
        <div class="modal-card large">
          <div class="modal-header">
            <h3>📊 Edit Table Data</h3>
            <button class="close-btn" id="closeTableEditModal">&times;</button>
          </div>
          <div class="modal-body" id="tableEditModalBody" style="overflow:auto;max-height:60vh;"></div>
          <div class="modal-footer">
            <button class="btn btn-primary" id="saveTableEditBtn">Apply</button>
          </div>
        </div>
      </div>
    `;

    try {
      await Promise.all([
        loadScript('/lib/pdf.min.js'),
        loadScript('/lib/pdf-lib.min.js')
      ]);

      const rawArrayBuffer = base64Content ? base64ToArrayBuffer(base64Content) : new ArrayBuffer(0);
      const extracted = extractMetadata(rawArrayBuffer);

      // If this PDF was edited before, metadata carries the clean (pre-bake)
      // PDF plus the items. Use those so the canvas shows the base page and the
      // items render as a single, editable overlay (no double text).
      let baseBuffer = extracted.buffer;
      const useEmbedded = extracted.payload && extracted.payload.clean && extracted.payload.items;
      if (useEmbedded) {
        baseBuffer = base64ToArrayBuffer(extracted.payload.clean);
      }
      pdfjsLib.GlobalWorkerOptions.workerSrc = '/lib/pdf.worker.min.js';

      this.pdfDocLib = await window.PDFLib.PDFDocument.load(baseBuffer);
      this.pdfDocJs = await pdfjsLib.getDocument({ data: baseBuffer.slice(0) }).promise;

      if (useEmbedded) {
        this.pageItems = deserializeItems(extracted.payload.items);
      } else {
        await this.reconstructTextItems();
      }

      document.getElementById('pdfEdLoading').style.display = 'none';
      document.getElementById('pdfEdPageCount').textContent = this.pdfDocLib.getPageCount();
      document.getElementById('pdfEdPageInput').max = this.pdfDocLib.getPageCount();

      this.bindToolbarEvents();

      await this.renderCurrentPage();
    } catch (err) {
      const loadingEl = document.getElementById('pdfEdLoading');
      if (loadingEl) {
        loadingEl.textContent = 'Failed to load PDF in Editor: ' + err.message;
        loadingEl.style.color = 'var(--error-color, #f38ba8)';
      }
    }
  }

  bindToolbarEvents() {
    this.container.querySelectorAll('.tool-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const tool = e.currentTarget.getAttribute('data-tool');
        this.setTool(tool);
      });
    });

    document.getElementById('pdfEdPrev').addEventListener('click', () => this.goToPage(this.pageNum - 1));
    document.getElementById('pdfEdNext').addEventListener('click', () => this.goToPage(this.pageNum + 1));
    document.getElementById('pdfEdPageInput').addEventListener('change', (e) => {
      const num = parseInt(e.target.value, 10);
      if (num >= 1 && num <= this.pdfDocLib.getPageCount()) {
        this.goToPage(num);
      } else {
        e.target.value = this.pageNum;
      }
    });

    document.getElementById('pdfEdZoomIn').addEventListener('click', () => {
      this.scale = Math.min(3.0, this.scale + 0.25);
      this.updateZoomLabel();
      this.renderCurrentPage();
    });
    document.getElementById('pdfEdZoomOut').addEventListener('click', () => {
      this.scale = Math.max(0.25, this.scale - 0.25);
      this.updateZoomLabel();
      this.renderCurrentPage();
    });

    document.getElementById('pdfEdAddPage').addEventListener('click', () => this.addBlankPage());
    document.getElementById('pdfEdDelPage').addEventListener('click', () => this.deleteCurrentPage());

    document.getElementById('pdfEdCloseBtn').addEventListener('click', () => {
      if (this.onClose) this.onClose();
    });
    document.getElementById('pdfEdSaveBtn').addEventListener('click', () => this.save());

    document.getElementById('pdfEdImgInput').addEventListener('change', (e) => this.handleImageUpload(e));

    document.getElementById('closeTableEditModal').addEventListener('click', () => {
      document.getElementById('tableEditModal').classList.add('hidden');
    });

    const overlay = document.getElementById('pdfEditorOverlay');
    overlay.addEventListener('pointerdown', (e) => this.handleOverlayPointerDown(e));
    window.addEventListener('pointermove', (e) => this.handleOverlayPointerMove(e));
    window.addEventListener('pointerup', (e) => this.handleOverlayPointerUp(e));
  }

  setTool(tool) {
    this.activeTool = tool;
    this.container.querySelectorAll('.tool-btn').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-tool') === tool);
    });

    if (tool === 'text') {
      this.addItem({
        id: 'item_' + Date.now(),
        type: 'text',
        text: 'New Text',
        fontName: 'Helvetica',
        fontSize: 16,
        color: '#000000',
        x: 50,
        y: 50,
        width: 160,
        height: 30
      });
      this.setTool('select');
    } else if (tool === 'image') {
      document.getElementById('pdfEdImgInput').click();
      this.setTool('select');
    } else if (tool === 'table') {
      this.addItem({
        id: 'item_' + Date.now(),
        type: 'table',
        rows: 3,
        cols: 3,
        data: [
          ['Header 1', 'Header 2', 'Header 3'],
          ['Data 1', 'Data 2', 'Data 3'],
          ['Data 4', 'Data 5', 'Data 6']
        ],
        x: 50,
        y: 80,
        width: 300,
        height: 90,
        fontSize: 12,
        headerBgColor: '#e2e8f0',
        borderColor: '#333333',
        colWidth: 100,
        rowHeight: 28
      });
      this.setTool('select');
    } else if (tool === 'rect') {
      this.addItem({
        id: 'item_' + Date.now(),
        type: 'rect',
        x: 60,
        y: 60,
        width: 140,
        height: 80,
        strokeColor: '#000000',
        fillColor: '#transparent',
        strokeWidth: 2
      });
      this.setTool('select');
    } else if (tool === 'line') {
      this.addItem({
        id: 'item_' + Date.now(),
        type: 'line',
        x: 60,
        y: 60,
        width: 150,
        height: 0,
        strokeColor: '#000000',
        strokeWidth: 2
      });
      this.setTool('select');
    }
  }

  async handleImageUpload(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (evt) => {
      const arrayBuf = evt.target.result;
      const bytes = new Uint8Array(arrayBuf);
      const mimeType = file.type === 'image/jpeg' || file.type === 'image/jpg' ? 'image/jpeg' : 'image/png';
      this.addItem({
        id: 'item_' + Date.now(),
        type: 'image',
        imageBytes: bytes,
        mimeType: mimeType,
        dataUrl: `data:${mimeType};base64,${uint8ArrayToBase64(bytes)}`,
        x: 60,
        y: 60,
        width: 180,
        height: 120
      });
    };
    reader.readAsArrayBuffer(file);
    e.target.value = '';
  }

  addItem(item) {
    if (!this.pageItems[this.pageNum]) {
      this.pageItems[this.pageNum] = [];
    }
    this.pageItems[this.pageNum].push(item);
    this.selectItem(item);
    this.renderOverlayItems();
  }

  selectItem(item) {
    this.selectedItem = item;
    this.renderOverlayItems();
    this.updatePropertyToolbar();
  }

  updatePropertyToolbar() {
    const propBar = document.getElementById('pdfEdPropToolbar');
    if (!this.selectedItem) {
      propBar.classList.add('hidden');
      propBar.innerHTML = '';
      return;
    }
    propBar.classList.remove('hidden');

    const item = this.selectedItem;
    if (item.type === 'text') {
      propBar.innerHTML = `
        <div style="display:flex;flex-wrap:wrap;align-items:center;gap:12px;width:100%;">
          <span style="font-weight:bold;font-size:13px;">Text Item</span>
          <label style="display:flex;align-items:center;gap:4px;font-size:13px;">
            Content:
            <input type="text" id="propTextVal" class="form-input" style="width:200px;padding:4px;" value="${this.escapeHTML(item.text || '')}" />
          </label>
          <label style="display:flex;align-items:center;gap:4px;font-size:13px;">
            Font:
            <select id="propFontVal" class="form-input" style="padding:4px;">
              <option value="Helvetica" ${item.fontName === 'Helvetica' ? 'selected' : ''}>Helvetica</option>
              <option value="Helvetica-Bold" ${item.fontName === 'Helvetica-Bold' ? 'selected' : ''}>Helvetica Bold</option>
              <option value="Times-Roman" ${item.fontName === 'Times-Roman' ? 'selected' : ''}>Times Roman</option>
              <option value="Times-Bold" ${item.fontName === 'Times-Bold' ? 'selected' : ''}>Times Bold</option>
              <option value="Courier" ${item.fontName === 'Courier' ? 'selected' : ''}>Courier</option>
              <option value="Courier-Bold" ${item.fontName === 'Courier-Bold' ? 'selected' : ''}>Courier Bold</option>
            </select>
          </label>
          <label style="display:flex;align-items:center;gap:4px;font-size:13px;">
            Size:
            <input type="number" id="propFontSizeVal" value="${item.fontSize || 16}" min="6" max="120" class="form-input" style="width:60px;padding:4px;" />
          </label>
          <label style="display:flex;align-items:center;gap:4px;font-size:13px;">
            Color:
            <input type="color" id="propColorVal" value="${item.color || '#000000'}" />
          </label>
          <button class="btn btn-sm btn-danger" id="propDeleteBtn" style="margin-left:auto;">🗑️ Delete Item</button>
        </div>
      `;

      document.getElementById('propTextVal').addEventListener('input', (e) => {
        item.text = e.target.value;
        this.renderOverlayItems();
      });
      document.getElementById('propFontVal').addEventListener('change', (e) => {
        item.fontName = e.target.value;
        this.renderOverlayItems();
      });
      document.getElementById('propFontSizeVal').addEventListener('change', (e) => {
        item.fontSize = parseInt(e.target.value, 10) || 16;
        this.renderOverlayItems();
      });
      document.getElementById('propColorVal').addEventListener('input', (e) => {
        item.color = e.target.value;
        this.renderOverlayItems();
      });
    } else if (item.type === 'image') {
      propBar.innerHTML = `
        <div style="display:flex;flex-wrap:wrap;align-items:center;gap:12px;width:100%;">
          <span style="font-weight:bold;font-size:13px;">Image Item</span>
          <label style="display:flex;align-items:center;gap:4px;font-size:13px;">
            Width:
            <input type="number" id="propImgWidth" value="${Math.round(item.width)}" min="10" max="1000" class="form-input" style="width:70px;padding:4px;" />
          </label>
          <label style="display:flex;align-items:center;gap:4px;font-size:13px;">
            Height:
            <input type="number" id="propImgHeight" value="${Math.round(item.height)}" min="10" max="1000" class="form-input" style="width:70px;padding:4px;" />
          </label>
          <button class="btn btn-sm btn-danger" id="propDeleteBtn" style="margin-left:auto;">🗑️ Delete Item</button>
        </div>
      `;
      document.getElementById('propImgWidth').addEventListener('change', (e) => {
        item.width = parseInt(e.target.value, 10) || item.width;
        this.renderOverlayItems();
      });
      document.getElementById('propImgHeight').addEventListener('change', (e) => {
        item.height = parseInt(e.target.value, 10) || item.height;
        this.renderOverlayItems();
      });
    } else if (item.type === 'table') {
      propBar.innerHTML = `
        <div style="display:flex;flex-wrap:wrap;align-items:center;gap:12px;width:100%;">
          <span style="font-weight:bold;font-size:13px;">Table Item</span>
          <label style="display:flex;align-items:center;gap:4px;font-size:13px;">
            Rows:
            <input type="number" id="propTblRows" value="${item.rows}" min="1" max="25" class="form-input" style="width:60px;padding:4px;" />
          </label>
          <label style="display:flex;align-items:center;gap:4px;font-size:13px;">
            Cols:
            <input type="number" id="propTblCols" value="${item.cols}" min="1" max="15" class="form-input" style="width:60px;padding:4px;" />
          </label>
          <button class="btn btn-sm btn-outline" id="propTblEditCells">✏️ Edit Cells</button>
          <label style="display:flex;align-items:center;gap:4px;font-size:13px;">
            Header Bg:
            <input type="color" id="propTblBg" value="${item.headerBgColor || '#e2e8f0'}" />
          </label>
          <label style="display:flex;align-items:center;gap:4px;font-size:13px;">
            Border:
            <input type="color" id="propTblBorder" value="${item.borderColor || '#333333'}" />
          </label>
          <button class="btn btn-sm btn-danger" id="propDeleteBtn" style="margin-left:auto;">🗑️ Delete Item</button>
        </div>
      `;
      document.getElementById('propTblRows').addEventListener('change', (e) => {
        const rows = Math.max(1, parseInt(e.target.value, 10) || 1);
        item.rows = rows;
        item.height = rows * (item.rowHeight || 28);
        while (item.data.length < rows) {
          item.data.push(new Array(item.cols).fill(''));
        }
        this.renderOverlayItems();
      });
      document.getElementById('propTblCols').addEventListener('change', (e) => {
        const cols = Math.max(1, parseInt(e.target.value, 10) || 1);
        item.cols = cols;
        item.width = cols * (item.colWidth || 100);
        item.data.forEach(row => {
          while (row.length < cols) row.push('');
        });
        this.renderOverlayItems();
      });
      document.getElementById('propTblEditCells').addEventListener('click', () => this.openTableEditModal(item));
      document.getElementById('propTblBg').addEventListener('input', (e) => {
        item.headerBgColor = e.target.value;
        this.renderOverlayItems();
      });
      document.getElementById('propTblBorder').addEventListener('input', (e) => {
        item.borderColor = e.target.value;
        this.renderOverlayItems();
      });
    } else if (item.type === 'rect' || item.type === 'line') {
      propBar.innerHTML = `
        <div style="display:flex;flex-wrap:wrap;align-items:center;gap:12px;width:100%;">
          <span style="font-weight:bold;font-size:13px;">${item.type === 'rect' ? 'Rectangle' : 'Line'} Item</span>
          <label style="display:flex;align-items:center;gap:4px;font-size:13px;">
            Stroke:
            <input type="color" id="propStrokeColor" value="${item.strokeColor || '#000000'}" />
          </label>
          ${item.type === 'rect' ? `
            <label style="display:flex;align-items:center;gap:4px;font-size:13px;">
              Fill:
              <input type="color" id="propFillColor" value="${item.fillColor && item.fillColor !== '#transparent' ? item.fillColor : '#ffffff'}" />
            </label>
          ` : ''}
          <label style="display:flex;align-items:center;gap:4px;font-size:13px;">
            Width:
            <input type="number" id="propStrokeW" value="${item.strokeWidth || 2}" min="1" max="20" class="form-input" style="width:60px;padding:4px;" />
          </label>
          <button class="btn btn-sm btn-danger" id="propDeleteBtn" style="margin-left:auto;">🗑️ Delete Item</button>
        </div>
      `;
      document.getElementById('propStrokeColor').addEventListener('input', (e) => {
        item.strokeColor = e.target.value;
        this.renderOverlayItems();
      });
      if (document.getElementById('propFillColor')) {
        document.getElementById('propFillColor').addEventListener('input', (e) => {
          item.fillColor = e.target.value;
          this.renderOverlayItems();
        });
      }
      document.getElementById('propStrokeW').addEventListener('change', (e) => {
        item.strokeWidth = parseInt(e.target.value, 10) || 2;
        this.renderOverlayItems();
      });
    }

    const delBtn = document.getElementById('propDeleteBtn');
    if (delBtn) {
      delBtn.addEventListener('click', () => {
        const items = this.pageItems[this.pageNum] || [];
        this.pageItems[this.pageNum] = items.filter(i => i !== item);
        this.selectedItem = null;
        this.renderOverlayItems();
        this.updatePropertyToolbar();
      });
    }
  }

  openTableEditModal(item) {
    const modal = document.getElementById('tableEditModal');
    const body = document.getElementById('tableEditModalBody');
    let html = `<table style="width:100%;border-collapse:collapse;">`;
    for (let r = 0; r < item.rows; r++) {
      html += `<tr>`;
      for (let c = 0; c < item.cols; c++) {
        const val = (item.data && item.data[r] && item.data[r][c]) ? item.data[r][c] : '';
        const bg = r === 0 ? 'background:rgba(255,255,255,0.08);font-weight:bold;' : '';
        html += `<td style="border:1px solid var(--border-color);padding:4px;${bg}">
          <input type="text" class="form-input table-cell-input" data-row="${r}" data-col="${c}" value="${this.escapeHTML(val)}" style="width:100%;" />
        </td>`;
      }
      html += `</tr>`;
    }
    html += `</table>`;
    body.innerHTML = html;
    modal.classList.remove('hidden');

    document.getElementById('saveTableEditBtn').onclick = () => {
      const inputs = body.querySelectorAll('.table-cell-input');
      inputs.forEach(inp => {
        const r = parseInt(inp.getAttribute('data-row'), 10);
        const c = parseInt(inp.getAttribute('data-col'), 10);
        if (!item.data[r]) item.data[r] = [];
        item.data[r][c] = inp.value;
      });
      modal.classList.add('hidden');
      this.renderOverlayItems();
    };
  }

  updateZoomLabel() {
    const label = document.getElementById('pdfEdZoomLabel');
    if (label) label.textContent = Math.round(this.scale * 100) + '%';
  }

  async goToPage(num) {
    if (!this.pdfDocLib) return;
    const maxPage = this.pdfDocLib.getPageCount();
    if (num < 1) num = 1;
    if (num > maxPage) num = maxPage;
    if (num === this.pageNum) return;
    this.pageNum = num;
    document.getElementById('pdfEdPageInput').value = num;
    this.selectedItem = null;
    this.updatePropertyToolbar();
    await this.renderCurrentPage();
  }

  async addBlankPage() {
    if (!this.pdfDocLib) return;
    this.pdfDocLib.addPage();
    const bytes = await this.pdfDocLib.save();
    this.pdfDocJs = await pdfjsLib.getDocument({ data: bytes.slice(0) }).promise;
    document.getElementById('pdfEdPageCount').textContent = this.pdfDocLib.getPageCount();
    document.getElementById('pdfEdPageInput').max = this.pdfDocLib.getPageCount();
    this.goToPage(this.pdfDocLib.getPageCount());
  }

  async deleteCurrentPage() {
    if (!this.pdfDocLib) return;
    if (this.pdfDocLib.getPageCount() <= 1) {
      this.onToast('Cannot delete the only page of the PDF.');
      return;
    }
    this.pdfDocLib.removePage(this.pageNum - 1);
    delete this.pageItems[this.pageNum];

    // Shift items on subsequent pages down by 1
    const newPageItems = {};
    for (const [pStr, items] of Object.entries(this.pageItems)) {
      const p = parseInt(pStr, 10);
      if (p < this.pageNum) newPageItems[p] = items;
      else if (p > this.pageNum) newPageItems[p - 1] = items;
    }
    this.pageItems = newPageItems;

    const bytes = await this.pdfDocLib.save();
    this.pdfDocJs = await pdfjsLib.getDocument({ data: bytes.slice(0) }).promise;
    document.getElementById('pdfEdPageCount').textContent = this.pdfDocLib.getPageCount();
    document.getElementById('pdfEdPageInput').max = this.pdfDocLib.getPageCount();
    if (this.pageNum > this.pdfDocLib.getPageCount()) {
      this.pageNum = this.pdfDocLib.getPageCount();
    }
    document.getElementById('pdfEdPageInput').value = this.pageNum;
    this.selectedItem = null;
    this.updatePropertyToolbar();
    await this.renderCurrentPage();
  }

  async renderCurrentPage() {
    if (!this.pdfDocJs) return;
    const page = await this.pdfDocJs.getPage(this.pageNum);
    const viewport = page.getViewport({ scale: this.scale });

    const canvas = document.getElementById('pdfEditorBgCanvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;

    const overlay = document.getElementById('pdfEditorOverlay');
    overlay.style.width = viewport.width + 'px';
    overlay.style.height = viewport.height + 'px';

    this.renderOverlayItems();
  }

  // Build editable text items for every page's existing text so that text which
  // was baked into the PDF (e.g. after a previous save) becomes editable again.
  // pdf.js reports glyph positions from the bottom-left origin in PDF units; we
  // convert to the editor's top-left, unscaled coordinate space.
  async reconstructTextItems() {
    if (!this.pdfDocJs) return;
    this.pageItems = {};
    try {
      for (let p = 1; p <= this.pdfDocJs.numPages; p++) {
        const page = await this.pdfDocJs.getPage(p);
        const viewport = page.getViewport({ scale: 1 });
        const pageH = viewport.height;
        const lines = [];

        const textContent = await page.getTextContent();
        for (const it of textContent.items || []) {
          if (!it.str) continue;
          const tx = it.transform ? it.transform[4] : 0;
          const ty = it.transform ? it.transform[5] : 0;
          const fSize = it.height || it.transform[0] || 16;
          lines.push({
            id: 'item_' + Date.now() + '_' + p + '_' + lines.length,
            type: 'text',
            text: it.str,
            fontName: mapFontName(it.fontName),
            fontSize: fSize,
            color: '#000000',
            x: tx,
            y: pageH - ty - fSize,
            width: Math.max(60, it.width || (it.str.length * fSize * 0.6)),
            height: fSize
          });
        }

        if (lines.length) {
          this.pageItems[p] = lines;
        }
      }
    } catch (err) {
      console.warn('Could not reconstruct PDF text items:', err);
    }
  }

  renderOverlayItems() {
    const overlay = document.getElementById('pdfEditorOverlay');
    if (!overlay) return;
    overlay.innerHTML = '';

    const items = this.pageItems[this.pageNum] || [];
    items.forEach(item => {
      const el = document.createElement('div');
      el.className = 'pdf-editor-item' + (item === this.selectedItem ? ' selected' : '');
      el.style.position = 'absolute';
      el.style.left = (item.x * this.scale) + 'px';
      el.style.top = (item.y * this.scale) + 'px';
      el.style.cursor = 'move';
      el.style.userSelect = 'none';
      el.style.boxSizing = 'border-box';
      if (item === this.selectedItem) {
        el.style.border = '2px dashed var(--accent-color, #89b4fa)';
      }

      if (item.type === 'text') {
        el.style.fontFamily = this.getFontFamilyCSS(item.fontName);
        el.style.fontSize = ((item.fontSize || 16) * this.scale) + 'px';
        el.style.color = item.color || '#000000';
        el.style.padding = '2px 6px';
        el.style.whiteSpace = 'pre-wrap';
        el.textContent = item.text || '';
      } else if (item.type === 'image') {
        el.style.width = (item.width * this.scale) + 'px';
        el.style.height = (item.height * this.scale) + 'px';
        const img = document.createElement('img');
        img.src = item.dataUrl;
        img.style.width = '100%';
        img.style.height = '100%';
        img.style.display = 'block';
        img.draggable = false;
        el.appendChild(img);
      } else if (item.type === 'table') {
        el.style.width = (item.width * this.scale) + 'px';
        el.style.height = (item.height * this.scale) + 'px';
        const tbl = document.createElement('table');
        tbl.style.width = '100%';
        tbl.style.height = '100%';
        tbl.style.borderCollapse = 'collapse';
        tbl.style.fontSize = ((item.fontSize || 12) * this.scale) + 'px';
        tbl.style.backgroundColor = 'rgba(255,255,255,0.7)';

        for (let r = 0; r < item.rows; r++) {
          const tr = document.createElement('tr');
          for (let c = 0; c < item.cols; c++) {
            const td = document.createElement('td');
            td.style.border = '1px solid ' + (item.borderColor || '#333333');
            td.style.padding = (4 * this.scale) + 'px';
            td.style.color = '#000000';
            if (r === 0) {
              td.style.backgroundColor = item.headerBgColor || '#e2e8f0';
              td.style.fontWeight = 'bold';
            }
            td.textContent = (item.data && item.data[r] && item.data[r][c]) ? item.data[r][c] : '';
            tr.appendChild(td);
          }
          tbl.appendChild(tr);
        }
        el.appendChild(tbl);
      } else if (item.type === 'rect') {
        el.style.width = (item.width * this.scale) + 'px';
        el.style.height = (item.height * this.scale) + 'px';
        el.style.border = `${item.strokeWidth || 2}px solid ${item.strokeColor || '#000000'}`;
        if (item.fillColor && item.fillColor !== '#transparent') {
          el.style.backgroundColor = item.fillColor;
        }
      } else if (item.type === 'line') {
        el.style.width = (item.width * this.scale) + 'px';
        el.style.height = '8px';
        el.innerHTML = `<div style="width:100%;height:${item.strokeWidth || 2}px;background:${item.strokeColor || '#000000'};margin-top:3px;"></div>`;
      }

      // Resize handle for selected item
      if (item === this.selectedItem && item.type !== 'text') {
        const handle = document.createElement('div');
        handle.style.position = 'absolute';
        handle.style.right = '-6px';
        handle.style.bottom = '-6px';
        handle.style.width = '14px';
        handle.style.height = '14px';
        handle.style.backgroundColor = 'var(--accent-color, #89b4fa)';
        handle.style.border = '1px solid #fff';
        handle.style.cursor = 'nwse-resize';
        handle.addEventListener('pointerdown', (e) => {
          e.stopPropagation();
          this.startResize(item, e);
        });
        el.appendChild(handle);
      }

      el.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        this.selectItem(item);
        this.startDrag(item, e);
      });

      overlay.appendChild(el);
    });
  }

  getFontFamilyCSS(fontName) {
    if (fontName && fontName.includes('Courier')) return 'monospace';
    if (fontName && fontName.includes('Times')) return 'serif';
    return 'sans-serif';
  }

  startDrag(item, e) {
    this._dragState = {
      type: 'move',
      item: item,
      startX: e.clientX,
      startY: e.clientY,
      origX: item.x,
      origY: item.y
    };
  }

  startResize(item, e) {
    this._dragState = {
      type: 'resize',
      item: item,
      startX: e.clientX,
      startY: e.clientY,
      origWidth: item.width,
      origHeight: item.height
    };
  }

  handleOverlayPointerDown(e) {
    if (e.target.id === 'pdfEditorOverlay') {
      this.selectItem(null);
    }
  }

  handleOverlayPointerMove(e) {
    if (!this._dragState) return;
    const ds = this._dragState;
    const dx = (e.clientX - ds.startX) / this.scale;
    const dy = (e.clientY - ds.startY) / this.scale;

    if (ds.type === 'move') {
      ds.item.x = Math.max(0, ds.origX + dx);
      ds.item.y = Math.max(0, ds.origY + dy);
    } else if (ds.type === 'resize') {
      ds.item.width = Math.max(20, ds.origWidth + dx);
      if (ds.item.type !== 'line') {
        ds.item.height = Math.max(20, ds.origHeight + dy);
      }
    }
    this.renderOverlayItems();
  }

  handleOverlayPointerUp(e) {
    if (this._dragState) {
      this._dragState = null;
    }
  }

  hexToRgb(hex) {
    let clean = (hex || '#000000').replace('#', '');
    if (clean.length === 3) {
      clean = clean[0]+clean[0] + clean[1]+clean[1] + clean[2]+clean[2];
    }
    const num = parseInt(clean, 16);
    return {
      r: ((num >> 16) & 255) / 255,
      g: ((num >> 8) & 255) / 255,
      b: (num & 255) / 255
    };
  }

  async save() {
    try {
      const PDFLib = window.PDFLib;

      // The live document stays clean (base page + nothing baked). Capturing it
      // now lets us embed a clean copy + the items so reopening restores a
      // single editable layer (no text rendered twice).
      const cleanBytes = await this.pdfDocLib.save();
      const cleanU8 = new Uint8Array(cleanBytes);

      // Bake items into a throwaway document so the in-memory doc is untouched.
      const bakeDoc = await PDFLib.PDFDocument.load(cleanU8);
      const bakePages = bakeDoc.getPages();

      for (const [pageIndexStr, items] of Object.entries(this.pageItems)) {
        const pageIdx = parseInt(pageIndexStr, 10);
        if (pageIdx < 1 || pageIdx > bakePages.length) continue;
        const page = bakePages[pageIdx - 1];
        const pageH = page.getHeight();

        for (const item of items) {
          if (item.type === 'text') {
            let stdFont = PDFLib.StandardFonts.Helvetica;
            if (item.fontName === 'Helvetica-Bold') stdFont = PDFLib.StandardFonts.HelveticaBold;
            else if (item.fontName === 'Times-Roman') stdFont = PDFLib.StandardFonts.TimesRoman;
            else if (item.fontName === 'Times-Bold') stdFont = PDFLib.StandardFonts.TimesRomanBold;
            else if (item.fontName === 'Courier') stdFont = PDFLib.StandardFonts.Courier;
            else if (item.fontName === 'Courier-Bold') stdFont = PDFLib.StandardFonts.CourierBold;
            const font = await bakeDoc.embedFont(stdFont);
            const rgb = this.hexToRgb(item.color || '#000000');
            const lines = (item.text || '').split('\n');
            const fSize = item.fontSize || 16;
            const lineH = fSize * 1.2;
            for (let i = 0; i < lines.length; i++) {
              const line = lines[i];
              const pdfY = pageH - item.y - fSize - i * lineH;
              page.drawText(line, {
                x: item.x,
                y: pdfY,
                size: fSize,
                font: font,
                color: PDFLib.rgb(rgb.r, rgb.g, rgb.b)
              });
            }
          } else if (item.type === 'image') {
            let embeddedImg;
            if (item.mimeType === 'image/jpeg') {
              embeddedImg = await bakeDoc.embedJpg(item.imageBytes);
            } else {
              embeddedImg = await bakeDoc.embedPng(item.imageBytes);
            }
            const pdfY = pageH - item.y - item.height;
            page.drawImage(embeddedImg, {
              x: item.x,
              y: pdfY,
              width: item.width,
              height: item.height
            });
          } else if (item.type === 'table') {
            const rowH = item.rowHeight || 28;
            const colW = item.colWidth || 100;
            const stdFont = await bakeDoc.embedFont(PDFLib.StandardFonts.Helvetica);
            const stdFontBold = await bakeDoc.embedFont(PDFLib.StandardFonts.HelveticaBold);
            const borderRgb = this.hexToRgb(item.borderColor || '#333333');

            for (let r = 0; r < item.rows; r++) {
              for (let c = 0; c < item.cols; c++) {
                const cx = item.x + c * colW;
                const cy = item.y + r * rowH;
                const pdfY = pageH - cy - rowH;
                if (r === 0 && item.headerBgColor) {
                  const bg = this.hexToRgb(item.headerBgColor);
                  page.drawRectangle({
                    x: cx,
                    y: pdfY,
                    width: colW,
                    height: rowH,
                    color: PDFLib.rgb(bg.r, bg.g, bg.b)
                  });
                }
                page.drawRectangle({
                  x: cx,
                  y: pdfY,
                  width: colW,
                  height: rowH,
                  borderColor: PDFLib.rgb(borderRgb.r, borderRgb.g, borderRgb.b),
                  borderWidth: 1
                });

                const cellText = (item.data && item.data[r] && item.data[r][c]) ? String(item.data[r][c]) : '';
                if (cellText) {
                  const fSize = item.fontSize || 12;
                  page.drawText(cellText, {
                    x: cx + 6,
                    y: pdfY + rowH - fSize - 6,
                    size: fSize,
                    font: r === 0 ? stdFontBold : stdFont,
                    color: PDFLib.rgb(0, 0, 0)
                  });
                }
              }
            }
          } else if (item.type === 'rect') {
            const pdfY = pageH - item.y - item.height;
            const strokeRgb = this.hexToRgb(item.strokeColor || '#000000');
            const opts = {
              x: item.x,
              y: pdfY,
              width: item.width,
              height: item.height,
              borderColor: PDFLib.rgb(strokeRgb.r, strokeRgb.g, strokeRgb.b),
              borderWidth: item.strokeWidth || 2
            };
            if (item.fillColor && item.fillColor !== '#transparent') {
              const fillRgb = this.hexToRgb(item.fillColor);
              opts.color = PDFLib.rgb(fillRgb.r, fillRgb.g, fillRgb.b);
            }
            page.drawRectangle(opts);
          } else if (item.type === 'line') {
            const pdfY = pageH - item.y;
            const strokeRgb = this.hexToRgb(item.strokeColor || '#000000');
            page.drawLine({
              start: { x: item.x, y: pdfY },
              end: { x: item.x + item.width, y: pdfY },
              thickness: item.strokeWidth || 2,
              color: PDFLib.rgb(strokeRgb.r, strokeRgb.g, strokeRgb.b)
            });
          }
        }
      }

      const savedBytes = await bakeDoc.save();
      const payload = {
        version: 2,
        clean: uint8ArrayToBase64(new Uint8Array(cleanBytes)),
        items: serializeItems(this.pageItems)
      };
      const embeddedBytes = embedMetadata(savedBytes, payload);
      const b64 = uint8ArrayToBase64(new Uint8Array(embeddedBytes));
      if (this.onSave) {
        this.onSave(b64, 'base64');
      }
      this.onToast('PDF saved successfully!');
    } catch (err) {
      console.error('PDF save error:', err);
      this.onToast('Failed to save PDF: ' + err.message);
    }
  }

  destroy() {
    this.selectedItem = null;
  }

  escapeHTML(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
}
