/**
 * Interactive CSV & Custom Meta Spreadsheet Editor
 */
import { attachPinchZoom } from '../pinchZoom.js';
import {
  parseCellValue,
  renderXYChart,
  renderPieChart,
  canvasToJpegBase64,
} from './chartRenderer.js';

const MAX_HISTORY = 120;

export class CSVEditor {
  /**
   * @param {HTMLElement} container
   * @param {(csv: string) => void} onSave
   * @param {(msg: string) => void} onNotify
   * @param {{ filePath?: string, writeFile?: (path: string, content: string, encoding?: string) => Promise<any> }} opts
   *   filePath  — path of the CSV being edited (charts are written beside it)
   *   writeFile — writes an arbitrary file (used for the generated chart JPEGs)
   */
  constructor(container, onSave, onNotify, opts = {}) {
    this.container = container;
    this.onSave = onSave;
    this.onNotify = onNotify;
    this.filePath = opts.filePath || '';
    this.writeFile = opts.writeFile || null;
    this.grid = []; // 2D array of raw values [row][col]
    this.formulas = {}; // { 'c4': 'b4*1' }
    this.styles = {}; // { 'b6': { color: '13,115,30' } }
    this.charts = []; // [{ id, type, title, ... }] from <meta> chart tags
    this.metaLines = []; // preserves any unknown <meta> tags
    this.floatedRows = new Set(); // 0-based row indices pinned while scrolling
    this.floatedCols = new Set(); // 0-based col indices pinned while scrolling
    this.selectedCell = null; // { r, c } — active/cursor cell
    this.anchor = null; // { r, c } — selection start point
    this.selection = null; // { r1, c1, r2, c2 } normalized; null = single cell
    this.zoom = 1;
    this._cellGesture = null;
    this._handleDrag = null;
    this._cellMenu = null;
    this._suppressClick = false;
    this._history = [];
    this._historyIndex = -1;
    this._lastCommit = null; // { key, time } — used to coalesce rapid edits
    this._chartDialog = null;
    this._rangeCapture = null;
    this._chartRefreshTimer = null;
    this._pendingChartIds = new Set();
  }

  // Parse CSV string into grid, formulas, styles
  parse(csvText) {
    this.grid = [];
    this.formulas = {};
    this.styles = {};
    this.charts = [];
    this.metaLines = [];
    this.floatedRows = new Set();
    this.floatedCols = new Set();

    const lines = csvText.split(/\r?\n/);
    const dataLines = [];

    for (let line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('<meta>')) {
        this.parseMetaLine(trimmed);
      } else {
        dataLines.push(line);
      }
    }

    // Parse CSV data lines using proper CSV parsing
    for (let line of dataLines) {
      if (line === '' && dataLines.indexOf(line) === dataLines.length - 1) continue;
      this.grid.push(this.parseCSVLine(line));
    }

    // Ensure minimum 10x10 grid for comfortable editing
    const minRows = Math.max(10, this.grid.length);
    let maxCols = 10;
    for (let row of this.grid) {
      maxCols = Math.max(maxCols, row.length);
    }

    for (let r = 0; r < minRows; r++) {
      if (!this.grid[r]) this.grid[r] = [];
      while (this.grid[r].length < maxCols) {
        this.grid[r].push('');
      }
    }
  }

  parseCSVLine(line) {
    const row = [];
    let insideQuote = false;
    let entry = '';

    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        if (insideQuote && line[i + 1] === '"') {
          entry += '"';
          i++;
        } else {
          insideQuote = !insideQuote;
        }
      } else if (c === ',' && !insideQuote) {
        row.push(entry);
        entry = '';
      } else {
        entry += c;
      }
    }
    row.push(entry);
    return row;
  }

  parseMetaLine(line) {
    // e.g., <meta> c4=b4*1  OR  <meta> color b6=13,115,30  OR  <meta> wrap a2
    //  OR  <meta> float row 2  OR  <meta> float col C
    const content = line.substring(6).trim();
    if (content.toLowerCase().startsWith('float')) {
      const parts = content.substring(5).trim().split(/\s+/);
      const which = (parts[0] || '').toLowerCase();
      const name = parts[1];
      if (which === 'row' && name !== undefined) {
        const rowNum = parseInt(name);
        if (!isNaN(rowNum)) this.floatedRows.add(rowNum - 1);
      } else if (which === 'col' && name !== undefined) {
        const coord = this.cellNameToCoord(name + '1');
        if (coord) this.floatedCols.add(coord.c);
      } else {
        this.metaLines.push(line);
      }
    } else if (content.toLowerCase().startsWith('chart ')) {
      // <meta> chart {"id":"...","type":"xy",...}
      try {
        const spec = JSON.parse(content.substring(6).trim());
        if (spec && spec.id && (spec.type === 'xy' || spec.type === 'pie')) {
          this.charts.push(spec);
        } else {
          this.metaLines.push(line);
        }
      } catch {
        this.metaLines.push(line);
      }
    } else if (content.toLowerCase().startsWith('color ')) {
      const parts = content.substring(6).split('=');
      if (parts.length === 2) {
        const cell = parts[0].trim().toLowerCase();
        const colorVal = parts[1].trim();
        this.styles[cell] = { ...(this.styles[cell] || {}), color: colorVal };
      }
    } else if (content.toLowerCase().startsWith('wrap ')) {
      const cell = content.substring(5).trim().toLowerCase();
      this.styles[cell] = { ...(this.styles[cell] || {}), wrap: true };
    } else if (content.includes('=')) {
      const parts = content.split('=');
      const cell = parts[0].trim().toLowerCase();
      const expr = parts[1].trim();
      this.formulas[cell] = expr;
    } else {
      this.metaLines.push(line);
    }
  }

  // Convert column index (0-based) to letter (A, B, C... AA, AB)
  colToName(col) {
    let name = '';
    col++;
    while (col > 0) {
      const rem = (col - 1) % 26;
      name = String.fromCharCode(65 + rem) + name;
      col = Math.floor((col - 1) / 26);
    }
    return name;
  }

  // Convert cell name (e.g. "B4") to { r: 3, c: 1 } (0-based)
  cellNameToCoord(name) {
    const match = name.trim().toUpperCase().match(/^([A-Z]+)([0-9]+)$/);
    if (!match) return null;
    const colStr = match[1];
    const rowStr = match[2];

    let col = 0;
    for (let i = 0; i < colStr.length; i++) {
      col = col * 26 + (colStr.charCodeAt(i) - 64);
    }
    return { r: parseInt(rowStr) - 1, c: col - 1 };
  }

  // Get raw value or formula for cell
  getRawValue(r, c) {
    const cellRef = `${this.colToName(c).toLowerCase()}${r + 1}`;
    if (cellRef in this.formulas) {
      return '=' + this.formulas[cellRef];
    }
    return this.grid[r] && this.grid[r][c] !== undefined ? this.grid[r][c] : '';
  }

  // Evaluate formula or computed value for cell
  getDisplayValue(r, c, visited = new Set()) {
    const cellRef = `${this.colToName(c).toLowerCase()}${r + 1}`;
    if (visited.has(cellRef)) return '#CIRCULAR!';

    let expr = this.formulas[cellRef];
    let val = this.grid[r] && this.grid[r][c] !== undefined ? this.grid[r][c] : '';

    if (!expr && typeof val === 'string' && val.startsWith('=')) {
      expr = val.substring(1);
    }

    if (!expr) return val;

    visited.add(cellRef);

    try {
      // Substitute cell references in expression with evaluated numeric values
      const evalExpr = expr.replace(/[a-zA-Z]+[0-9]+/g, (match) => {
        const coord = this.cellNameToCoord(match);
        if (!coord) return '0';
        const numVal = parseFloat(this.getDisplayValue(coord.r, coord.c, new Set(visited)));
        return isNaN(numVal) ? '0' : numVal;
      });

      // Basic safe Math evaluation
      if (/^[0-9+\-*/().\s]+$/.test(evalExpr)) {
        const result = Function(`"use strict"; return (${evalExpr})`)();
        return String(result);
      }
      return '#ERR!';
    } catch (e) {
      return '#ERR!';
    }
  }

  // Render spreadsheet editor UI
  render(csvText) {
    this.parse(csvText);

    this.container.innerHTML = `
      <div class="csv-editor-wrapper">
        <div class="csv-toolbar">
          <div class="csv-cell-ref" id="csvCellRef">A1</div>
          <div class="csv-formula-bar">
            <span>fx</span>
            <input type="text" id="csvFormulaInput" placeholder="Enter text or formula (e.g. =B4*1)" />
          </div>
          <div class="csv-actions">
            <button class="btn btn-sm" id="csvUndoBtn" title="Undo (Ctrl+Z)" disabled>↶</button>
            <button class="btn btn-sm" id="csvRedoBtn" title="Redo (Ctrl+Y)" disabled>↷</button>
            <input type="color" id="csvColorPicker" title="Cell Text Color" value="#00ffaa" />
            <button class="btn btn-sm" id="csvWrapBtn" title="Wrap text in this cell">Wrap</button>
            <button class="btn btn-sm" id="csvAddRowBtn">+ Row</button>
            <button class="btn btn-sm" id="csvAddColBtn">+ Col</button>
            <button class="btn btn-sm" id="csvGraphBtn" title="Create a graph from a cell range">📈 Graph</button>
            <button class="btn btn-sm" id="csvPieBtn" title="Create a pie chart from a cell range">🥧 Pie</button>
            <button class="btn btn-sm" id="csvChartsBtn" title="Manage saved charts">Charts</button>
            <button class="btn btn-primary btn-sm" id="csvSaveBtn">Save CSV</button>
          </div>
          <div class="csv-actions">
            <button class="btn btn-sm" id="csvZoomOut" title="Zoom Out">−</button>
            <span class="csv-zoom-label" id="csvZoomLabel">100%</span>
            <button class="btn btn-sm" id="csvZoomIn" title="Zoom In">+</button>
            <button class="btn btn-sm" id="csvZoomReset" title="Reset Zoom">Reset</button>
          </div>
        </div>
        <div class="csv-table-container">
          <table class="csv-table" id="csvTable">
            <thead>
              <tr id="csvHeaderRow"></tr>
            </thead>
            <tbody id="csvBody"></tbody>
          </table>
          <div class="csv-selection-handle tl" id="csvHandleTL" title="Drag to select"></div>
          <div class="csv-selection-handle br" id="csvHandleBR" title="Drag to select"></div>
        </div>
      </div>
    `;

    this.tableHeader = this.container.querySelector('#csvHeaderRow');
    this.tableBody = this.container.querySelector('#csvBody');
    this.tableEl = this.container.querySelector('#csvTable');
    this.tableContainer = this.container.querySelector('.csv-table-container');
    this.zoomLabel = this.container.querySelector('#csvZoomLabel');
    this.formulaInput = this.container.querySelector('#csvFormulaInput');
    this.cellRefDisplay = this.container.querySelector('#csvCellRef');
    this.colorPicker = this.container.querySelector('#csvColorPicker');

    this.buildGridUI();

    // Event listeners
    this.formulaInput.addEventListener('input', (e) => this.onFormulaInputChange(e.target.value));
    this.container.querySelector('#csvAddRowBtn').addEventListener('click', () => this.addRow());
    this.container.querySelector('#csvAddColBtn').addEventListener('click', () => this.addCol());
    this.container.querySelector('#csvSaveBtn').addEventListener('click', () => this.save());
    this.container.querySelector('#csvWrapBtn').addEventListener('click', () => this.toggleWrap());
    this.container.querySelector('#csvUndoBtn').addEventListener('click', () => this.undo());
    this.container.querySelector('#csvRedoBtn').addEventListener('click', () => this.redo());
    this.container.querySelector('#csvGraphBtn').addEventListener('click', () => this.openChartDialog('xy'));
    this.container.querySelector('#csvPieBtn').addEventListener('click', () => this.openChartDialog('pie'));
    this.container.querySelector('#csvChartsBtn').addEventListener('click', () => this.openChartList());
    this.colorPicker.addEventListener('change', (e) => this.onColorChange(e.target.value));
    this.container.querySelector('#csvZoomIn').addEventListener('click', () => this.setZoom(this.zoom + 0.1));
    this.container.querySelector('#csvZoomOut').addEventListener('click', () => this.setZoom(this.zoom - 0.1));
    this.container.querySelector('#csvZoomReset').addEventListener('click', () => this.setZoom(1));

    this._handles = {
      tl: this.container.querySelector('#csvHandleTL'),
      br: this.container.querySelector('#csvHandleBR'),
    };
    this._handles.tl.addEventListener('pointerdown', (e) => this._startHandleDrag(e, 'tl'));
    this._handles.br.addEventListener('pointerdown', (e) => this._startHandleDrag(e, 'br'));

    // Desktop: ctrl+wheel zoom anchored at the cursor
    this.tableContainer.addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      this.setZoom(this.zoom * factor, e.clientX, e.clientY);
    }, { passive: false });

    // Mobile: two-finger pinch zoom
    attachPinchZoom(this.tableContainer, {
      getZoom: () => this.zoom,
      onPinch: (zoom, midX, midY) => this.setZoom(zoom, midX, midY),
    });

    // Default select A1
    this.selectCell(0, 0);

    this._setupSelectionGesture();
    this._setupKeyboard();
    this._resetHistory();
    this._updateChartsBtn();
  }

  _setupSelectionGesture() {
    this._teardownSelectionGesture();
    this._containerPointerDown = (e) => this._gridPointerDown(e);
    this._onGridPointerMove = (e) => this._gridPointerMove(e);
    this._onGridPointerUp = (e) => this._gridPointerUp(e);
    this._onHandleDragMove = (e) => this._handleDragMove(e);
    this._onHandleDragEnd = (e) => this._endHandleDrag(e);
    this._onCellMenuDismiss = (e) => {
      if (this._cellMenu && !this._cellMenu.contains(e.target)) {
        this._closeCellMenu();
      }
    };
    this._onCellMenuScroll = () => this._closeCellMenu();
    this._onGridContextMenu = (e) => {
      const cell = e.target.closest && e.target.closest('.csv-cell');
      if (cell) {
        e.preventDefault();
        const r = parseInt(cell.getAttribute('data-r'));
        const c = parseInt(cell.getAttribute('data-c'));
        if (this._activeInlineInput) this._commitInlineEdit();
        if (!this._isInSelection(r, c)) {
          this.selectCell(r, c);
        }
        this._showCellMenu(e.clientX, e.clientY, { r, c });
        return;
      }
      const colHeader = e.target.closest && e.target.closest('.col-header');
      if (colHeader) {
        e.preventDefault();
        const c = parseInt(colHeader.getAttribute('data-c'));
        if (!isNaN(c)) this._showHeaderMenu(e.clientX, e.clientY, { type: 'col', c });
        return;
      }
      const rowHeader = e.target.closest && e.target.closest('.row-header');
      if (rowHeader) {
        const r = parseInt(rowHeader.getAttribute('data-r'));
        if (isNaN(r)) return; // corner cell
        e.preventDefault();
        this._showHeaderMenu(e.clientX, e.clientY, { type: 'row', r });
      }
    };
    this._onSecondPointerDown = (e) => {
      if (this._cellGesture && e.pointerId !== this._cellGesture.pointerId) {
        this._cancelCellGesture();
      }
      if (this._handleDrag && e.pointerId !== this._handleDrag.pointerId) {
        this._endHandleDrag(e);
      }
    };
    this.tableContainer.addEventListener('pointerdown', this._containerPointerDown);
    this.tableContainer.addEventListener('contextmenu', this._onGridContextMenu);
    document.addEventListener('pointermove', this._onGridPointerMove);
    document.addEventListener('pointerup', this._onGridPointerUp);
    document.addEventListener('pointercancel', this._onGridPointerUp);
    document.addEventListener('pointermove', this._onHandleDragMove);
    document.addEventListener('pointerup', this._onHandleDragEnd);
    document.addEventListener('pointercancel', this._onHandleDragEnd);
    document.addEventListener('pointerdown', this._onSecondPointerDown);
    document.addEventListener('pointerdown', this._onCellMenuDismiss, true);
    document.addEventListener('scroll', this._onCellMenuScroll, true);
  }

  _teardownSelectionGesture() {
    if (this.tableContainer && this._containerPointerDown) {
      this.tableContainer.removeEventListener('pointerdown', this._containerPointerDown);
    }
    if (this.tableContainer && this._onGridContextMenu) {
      this.tableContainer.removeEventListener('contextmenu', this._onGridContextMenu);
    }
    document.removeEventListener('pointermove', this._onGridPointerMove);
    document.removeEventListener('pointerup', this._onGridPointerUp);
    document.removeEventListener('pointercancel', this._onGridPointerUp);
    document.removeEventListener('pointermove', this._onHandleDragMove);
    document.removeEventListener('pointerup', this._onHandleDragEnd);
    document.removeEventListener('pointercancel', this._onHandleDragEnd);
    document.removeEventListener('pointerdown', this._onSecondPointerDown);
    document.removeEventListener('pointerdown', this._onCellMenuDismiss, true);
    document.removeEventListener('scroll', this._onCellMenuScroll, true);
    this._closeCellMenu();
  }

  _setupKeyboard() {
    this._keydownHandler = (e) => this._handleKeydown(e);
    document.removeEventListener('keydown', this._keydownHandler);
    document.addEventListener('keydown', this._keydownHandler);
  }

  // ----- Undo / redo --------------------------------------------------
  // Every mutating action snapshots the whole document (grid + formulas +
  // styles + floats + charts). Sheets are small enough that copying the state
  // is far cheaper than maintaining per-action inverse operations.

  _snapshot() {
    return {
      grid: this.grid.map(row => row.slice()),
      formulas: { ...this.formulas },
      styles: Object.fromEntries(
        Object.entries(this.styles).map(([k, v]) => [k, { ...v }])
      ),
      charts: this.charts.map(spec => ({ ...spec })),
      metaLines: [...this.metaLines],
      floatedRows: [...this.floatedRows],
      floatedCols: [...this.floatedCols],
      selectedCell: this.selectedCell ? { ...this.selectedCell } : null,
      selection: this.selection ? { ...this.selection } : null,
      anchor: this.anchor ? { ...this.anchor } : null,
    };
  }

  _restore(state) {
    this.grid = state.grid.map(row => row.slice());
    this.formulas = { ...state.formulas };
    this.styles = Object.fromEntries(
      Object.entries(state.styles).map(([k, v]) => [k, { ...v }])
    );
    this.charts = state.charts.map(spec => ({ ...spec }));
    this.metaLines = [...state.metaLines];
    this.floatedRows = new Set(state.floatedRows);
    this.floatedCols = new Set(state.floatedCols);
    this.selectedCell = state.selectedCell ? { ...state.selectedCell } : null;
    this.selection = state.selection ? { ...state.selection } : null;
    this.anchor = state.anchor ? { ...state.anchor } : null;
    this.refreshGrid();
    this._updateChartsBtn();
    this._updateHistoryButtons();
  }

  _resetHistory() {
    this._history = [this._snapshot()];
    this._historyIndex = 0;
    this._lastCommit = null;
    this._updateHistoryButtons();
  }

  /**
   * Record the current state as a new undo step.
   * coalesceKey merges consecutive edits to the same target (e.g. typing in
   * the formula bar) into a single undo step.
   */
  _commit(coalesceKey = null) {
    const now = Date.now();
    const last = this._lastCommit;
    const snap = this._snapshot();

    if (coalesceKey && last && last.key === coalesceKey &&
        now - last.time < 1500 && this._historyIndex === this._history.length - 1 &&
        this._historyIndex > 0) {
      this._history[this._historyIndex] = snap;
      this._lastCommit = { key: coalesceKey, time: now };
      this._updateHistoryButtons();
      return;
    }

    this._history.length = this._historyIndex + 1;
    this._history.push(snap);
    if (this._history.length > MAX_HISTORY) {
      this._history.shift();
    }
    this._historyIndex = this._history.length - 1;
    this._lastCommit = coalesceKey ? { key: coalesceKey, time: now } : null;
    this._updateHistoryButtons();
  }

  canUndo() { return this._historyIndex > 0; }

  canRedo() { return this._historyIndex < this._history.length - 1; }

  undo() {
    this._commitInlineEdit();
    if (!this.canUndo()) {
      this.onNotify?.('Nothing to undo');
      return;
    }
    this._lastCommit = null;
    this._historyIndex--;
    this._restore(this._history[this._historyIndex]);
    this._scheduleChartRefresh(null);
    this.onNotify?.('Undo');
  }

  redo() {
    this._commitInlineEdit();
    if (!this.canRedo()) {
      this.onNotify?.('Nothing to redo');
      return;
    }
    this._lastCommit = null;
    this._historyIndex++;
    this._restore(this._history[this._historyIndex]);
    this._scheduleChartRefresh(null);
    this.onNotify?.('Redo');
  }

  _updateHistoryButtons() {
    const undoBtn = this.container?.querySelector('#csvUndoBtn');
    const redoBtn = this.container?.querySelector('#csvRedoBtn');
    if (undoBtn) undoBtn.disabled = !this.canUndo();
    if (redoBtn) redoBtn.disabled = !this.canRedo();
  }

  // ----- Range selection model ---------------------------------------

  _isInSelection(r, c) {
    if (!this.selection) return false;
    return r >= this.selection.r1 && r <= this.selection.r2 &&
           c >= this.selection.c1 && c <= this.selection.c2;
  }

  _getSelectionRect() {
    if (this.selection) return this.selection;
    const { r, c } = this.selectedCell;
    return { r1: r, c1: c, r2: r, c2: c };
  }

  _applySelectionUI() {
    if (this.tableBody) {
      this.tableBody.querySelectorAll('.csv-cell').forEach(cell => {
        const r = parseInt(cell.getAttribute('data-r'));
        const c = parseInt(cell.getAttribute('data-c'));
        cell.classList.toggle('range-selected', this._isInSelection(r, c));
        cell.classList.toggle('selected', !!this.selectedCell && this.selectedCell.r === r && this.selectedCell.c === c);
      });
    }
    this._positionHandles();
    if (!this.selectedCell) return;
    if (this._rangeCapture) this._writeCapturedRange();
    const { r, c } = this.selectedCell;
    const cellName = `${this.colToName(c)}${r + 1}`;
    if (this.cellRefDisplay) this.cellRefDisplay.textContent = cellName;
    if (this.formulaInput) this.formulaInput.value = this.getRawValue(r, c);
    const cellRef = `${this.colToName(c).toLowerCase()}${r + 1}`;
    const wrapBtn = this.container.querySelector('#csvWrapBtn');
    if (wrapBtn) {
      wrapBtn.classList.toggle('active', !!(this.styles[cellRef] && this.styles[cellRef].wrap));
    }
  }

  _collapseSelection() {
    if (!this.selection) return;
    this.selection = null;
    this.anchor = this.selectedCell;
    this._applySelectionUI();
  }

  _deselect() {
    this.selectedCell = null;
    this.selection = null;
    this.anchor = null;
    this._applySelectionUI();
  }

  setZoom(newZoom, clientX, clientY) {
    const clamped = Math.min(2, Math.max(0.5, newZoom));
    if (Math.abs(clamped - this.zoom) < 0.001) return;
    const sx = this.tableContainer.scrollLeft;
    const sy = this.tableContainer.scrollTop;
    const rect = this.tableContainer.getBoundingClientRect();
    const vx = clientX === undefined ? rect.width / 2 : clientX - rect.left;
    const vy = clientY === undefined ? rect.height / 2 : clientY - rect.top;
    const k = clamped / this.zoom;
    this.zoom = clamped;
    this.tableEl.style.zoom = this.zoom;
    this.zoomLabel.textContent = `${Math.round(this.zoom * 100)}%`;
    this.tableContainer.scrollLeft = (sx + vx) * k - vx;
    this.tableContainer.scrollTop = (sy + vy) * k - vy;
    this._positionHandles();
    this._positionFloats();
  }

  buildGridUI() {
    const numCols = this.grid[0] ? this.grid[0].length : 10;

    // Header Row (Corner + A, B, C...)
    let headerHTML = '<th class="row-header"></th>';
    for (let c = 0; c < numCols; c++) {
      const floated = this.floatedCols.has(c) ? ' floated-col' : '';
      headerHTML += `<th class="col-header${floated}" data-c="${c}">${this.colToName(c)}</th>`;
    }
    this.tableHeader.innerHTML = headerHTML;

    // Body Rows
    let bodyHTML = '';
    for (let r = 0; r < this.grid.length; r++) {
      const rowFloated = this.floatedRows.has(r);
      bodyHTML += `<tr data-r="${r}" class="${rowFloated ? 'floated-row' : ''}"><td class="row-header${rowFloated ? ' floated-row' : ''}" data-r="${r}">${r + 1}</td>`;
      for (let c = 0; c < numCols; c++) {
        const cellRef = `${this.colToName(c).toLowerCase()}${r + 1}`;
        const displayVal = this.getDisplayValue(r, c);
        const styleObj = this.styles[cellRef];
        let styleAttr = '';
        let cellClass = 'csv-cell';
        if (this.floatedCols.has(c)) {
          cellClass += ' floated-col';
        }
        if (styleObj && styleObj.color) {
          styleAttr = `style="color: rgb(${styleObj.color})"`;
        }
        if (styleObj && styleObj.wrap) {
          cellClass += ' wrapped';
        }

        bodyHTML += `<td class="${cellClass}" data-r="${r}" data-c="${c}" ${styleAttr}>${this.escapeHTML(displayVal)}</td>`;
      }
      bodyHTML += '</tr>';
    }
    this.tableBody.innerHTML = bodyHTML;

    // Attach Cell Event Listeners
    const cells = this.tableBody.querySelectorAll('.csv-cell');
    cells.forEach(cell => {
      cell.addEventListener('click', (e) => {
        if (this._suppressClick) {
          this._suppressClick = false;
          return;
        }
        const r = parseInt(cell.getAttribute('data-r'));
        const c = parseInt(cell.getAttribute('data-c'));
        this.selectCell(r, c, e.shiftKey);
      });
    });

    // Set table width: fill container but never narrower than columns
    const table = this.container.querySelector('#csvTable');
    const container = table.parentElement;
    const cellMin = 90;
    const tableMin = Math.max(container.clientWidth, numCols * cellMin);
    table.style.width = tableMin + 'px';

    this._positionFloats();
  }

  selectCell(r, c, extend = false) {
    if (extend && this.anchor) {
      this.selection = {
        r1: Math.min(this.anchor.r, r),
        c1: Math.min(this.anchor.c, c),
        r2: Math.max(this.anchor.r, r),
        c2: Math.max(this.anchor.c, c),
      };
    } else {
      this.anchor = { r, c };
      this.selection = null;
    }
    this.selectedCell = { r, c };
    this._applySelectionUI();
  }

  startDirectEdit(tdCell, r, c) {
    const rawVal = this.getRawValue(r, c);
    tdCell.innerHTML = `<input type="text" class="csv-inline-input" value="${this.escapeHTML(rawVal)}" />`;
    const input = tdCell.querySelector('input');
    this._activeInlineInput = input;
    input.focus();
    input.select();

    const commitEdit = (val) => {
      const changed = val !== rawVal;
      this.updateCellValue(r, c, val);
      const cellRef = `${this.colToName(c).toLowerCase()}${r + 1}`;
      tdCell.textContent = this.getDisplayValue(r, c);
      const styleObj = this.styles[cellRef];
      if (styleObj && styleObj.color) {
        tdCell.style.color = `rgb(${styleObj.color})`;
      }
      this.formulaInput.value = this.getRawValue(r, c);
      if (changed) {
        this._commit();
        this._scheduleChartRefresh({ r1: r, c1: c, r2: r, c2: c });
      }
    };

    input.addEventListener('input', () => {
      this.formulaInput.value = input.value;
    });

    let navigating = false;

    input.addEventListener('blur', () => {
      if (!navigating) commitEdit(input.value);
      if (this._activeInlineInput === input) this._activeInlineInput = null;
    });

    input.addEventListener('keydown', (e) => {
      const keyActions = {
        'Enter': { dr: 1, dc: 0 },
        'Tab': { dr: 0, dc: 1 },
        'ArrowDown': { dr: 1, dc: 0 },
        'ArrowUp': { dr: -1, dc: 0 },
        'ArrowRight': { dr: 0, dc: 1 },
        'ArrowLeft': { dr: 0, dc: -1 },
      };
      const shiftActions = {
        'Enter': { dr: -1, dc: 0 },
        'Tab': { dr: 0, dc: -1 },
      };

      if (e.key === 'Escape') {
        e.preventDefault();
        commitEdit(rawVal);
        return;
      }

      const action = e.shiftKey ? shiftActions[e.key] : keyActions[e.key];
      if (!action) return;
      e.preventDefault();

      let newR = r + action.dr;
      let newC = c + action.dc;

      const numRows = this.grid.length;
      const numCols = this.grid[0] ? this.grid[0].length : 0;

      if (newR >= numRows) {
        this.addRow();
      } else if (newR < 0) {
        newR = 0;
      }
      if (newC >= numCols) {
        this.addCol();
      } else if (newC < 0) {
        newC = 0;
      }

      newR = Math.max(0, Math.min(this.grid.length - 1, newR));
      newC = Math.max(0, Math.min(this.grid[0] ? this.grid[0].length - 1 : 0, newC));

      navigating = true;
      commitEdit(input.value);
      this.selectCell(newR, newC);
      const newCell = this.tableBody.querySelector(`.csv-cell[data-r="${newR}"][data-c="${newC}"]`);
      if (newCell) this.startDirectEdit(newCell, newR, newC);
    });
  }

  onFormulaInputChange(val) {
    if (!this.selectedCell) return;
    const { r, c } = this.selectedCell;
    this.updateCellValue(r, c, val);
    this.refreshGrid();
    // Keystrokes in the formula bar coalesce into one undo step per cell.
    this._commit(`formula:${r},${c}`);
    this._scheduleChartRefresh({ r1: r, c1: c, r2: r, c2: c });
  }

  toggleWrap() {
    if (!this.selectedCell) return;
    const { r1, c1, r2, c2 } = this._getSelectionRect();
    const refs = [];
    let allWrapped = true;
    for (let r = r1; r <= r2; r++) {
      for (let c = c1; c <= c2; c++) {
        const cellRef = `${this.colToName(c).toLowerCase()}${r + 1}`;
        refs.push(cellRef);
        if (!(this.styles[cellRef] && this.styles[cellRef].wrap)) allWrapped = false;
      }
    }
    for (const cellRef of refs) {
      const styleObj = this.styles[cellRef] || {};
      if (allWrapped) {
        const { wrap, ...rest } = styleObj;
        if (Object.keys(rest).length) this.styles[cellRef] = rest;
        else delete this.styles[cellRef];
      } else {
        this.styles[cellRef] = { ...styleObj, wrap: true };
      }
    }
    this.refreshGrid();
    this._commit();
    this.onNotify?.(`Wrap ${allWrapped ? 'off' : 'on'} for ${refs.length} cell${refs.length === 1 ? '' : 's'}`);
  }

  onColorChange(hexColor) {
    if (!this.selectedCell) return;
    const rVal = parseInt(hexColor.slice(1, 3), 16);
    const gVal = parseInt(hexColor.slice(3, 5), 16);
    const bVal = parseInt(hexColor.slice(5, 7), 16);

    const { r1, c1, r2, c2 } = this._getSelectionRect();
    let count = 0;
    for (let r = r1; r <= r2; r++) {
      for (let c = c1; c <= c2; c++) {
        const cellRef = `${this.colToName(c).toLowerCase()}${r + 1}`;
        this.styles[cellRef] = { ...(this.styles[cellRef] || {}), color: `${rVal},${gVal},${bVal}` };
        count++;
      }
    }
    this.refreshGrid();
    this._commit();
    this.onNotify?.(`Colored ${count} cell${count === 1 ? '' : 's'}`);
  }

  updateCellValue(r, c, val) {
    const cellRef = `${this.colToName(c).toLowerCase()}${r + 1}`;

    if (val.startsWith('=')) {
      this.formulas[cellRef] = val.substring(1).trim();
      this.grid[r][c] = '';
    } else {
      delete this.formulas[cellRef];
      this.grid[r][c] = val;
    }
  }

  refreshGrid() {
    this.buildGridUI();
    if (this.selectedCell) {
      this._applySelectionUI();
    }
  }

  addRow() {
    const numCols = this.grid[0] ? this.grid[0].length : 10;
    const newRow = new Array(numCols).fill('');
    this.grid.push(newRow);
    this.refreshGrid();
    this._commit();
  }

  addCol() {
    for (let r = 0; r < this.grid.length; r++) {
      this.grid[r].push('');
    }
    this.refreshGrid();
    this._commit();
  }

  // ----- Selection actions --------------------------------------------

  _ensureGridSize() {
    const minRows = Math.max(10, this.grid.length);
    let maxCols = 10;
    for (const row of this.grid) maxCols = Math.max(maxCols, row.length);
    for (let r = 0; r < minRows; r++) {
      if (!this.grid[r]) this.grid[r] = [];
      while (this.grid[r].length < maxCols) this.grid[r].push('');
    }
  }

  tsvEscape(v) {
    if (v === null || v === undefined) return '';
    v = String(v);
    if (v.includes('\t') || v.includes('\n') || v.includes('"')) {
      return '"' + v.replace(/"/g, '""') + '"';
    }
    return v;
  }

  parseTSVLine(line) {
    const row = [];
    let insideQuote = false;
    let entry = '';
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        if (insideQuote && line[i + 1] === '"') {
          entry += '"';
          i++;
        } else {
          insideQuote = !insideQuote;
        }
      } else if (c === '\t' && !insideQuote) {
        row.push(entry);
        entry = '';
      } else {
        entry += c;
      }
    }
    row.push(entry);
    return row;
  }

  _writeClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(() => this._legacyCopy(text));
    } else {
      this._legacyCopy(text);
    }
  }

  _legacyCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch { /* ignore */ }
    ta.remove();
  }

  copySelection() {
    if (!this.selectedCell) return;
    const { r1, c1, r2, c2 } = this._getSelectionRect();
    const lines = [];
    for (let r = r1; r <= r2; r++) {
      const row = [];
      for (let c = c1; c <= c2; c++) {
        row.push(this.tsvEscape(this.getRawValue(r, c)));
      }
      lines.push(row.join('\t'));
    }
    this._writeClipboard(lines.join('\n'));
    const count = (r2 - r1 + 1) * (c2 - c1 + 1);
    this.onNotify?.(`Copied ${count} cell${count === 1 ? '' : 's'}`);
  }

  async pasteSelection() {
    if (!this.selectedCell) return;
    let tsv = null;
    if (navigator.clipboard && navigator.clipboard.readText) {
      try { tsv = await navigator.clipboard.readText(); } catch { tsv = null; }
    }
    if (!tsv) {
      this.onNotify?.('Clipboard is empty or unavailable');
      return;
    }
    const rows = tsv.split(/\r?\n/);
    const { r: ar, c: ac } = this.selectedCell;
    let written = 0;
    for (let dr = 0; dr < rows.length; dr++) {
      const values = this.parseTSVLine(rows[dr]);
      for (let dc = 0; dc < values.length; dc++) {
        const r = ar + dr;
        const c = ac + dc;
        while (this.grid.length <= r) this.grid.push([]);
        this.grid[r][c] = '';
        this.updateCellValue(r, c, values[dc]);
        written++;
      }
    }
    this._ensureGridSize();
    this.refreshGrid();
    this._commit();
    this._scheduleChartRefresh({
      r1: ar, c1: ac,
      r2: ar + rows.length - 1,
      c2: ac + Math.max(...rows.map(row => this.parseTSVLine(row).length)) - 1,
    });
    this.onNotify?.(`Pasted ${written} cell${written === 1 ? '' : 's'}`);
  }

  clearSelection() {
    if (!this.selectedCell) return;
    const { r1, c1, r2, c2 } = this._getSelectionRect();
    let count = 0;
    for (let r = r1; r <= r2; r++) {
      for (let c = c1; c <= c2; c++) {
        this.updateCellValue(r, c, '');
        count++;
      }
    }
    this.refreshGrid();
    this._commit();
    this._scheduleChartRefresh({ r1, c1, r2, c2 });
    this.onNotify?.(`Cleared ${count} cell${count === 1 ? '' : 's'}`);
  }

  cutSelection() {
    this.copySelection();
    this.clearSelection();
  }

  selectAll() {
    const numRows = this.grid.length;
    const numCols = this.grid[0] ? this.grid[0].length : 0;
    if (!numRows || !numCols) return;
    this.anchor = { r: 0, c: 0 };
    this.selection = { r1: 0, c1: 0, r2: numRows - 1, c2: numCols - 1 };
    this.selectedCell = { r: numRows - 1, c: numCols - 1 };
    this._applySelectionUI();
  }

  selectRow(r) {
    const numCols = this.grid[0] ? this.grid[0].length : 0;
    this.anchor = { r, c: 0 };
    this.selection = { r1: r, c1: 0, r2: r, c2: numCols - 1 };
    this.selectedCell = { r, c: 0 };
    this._applySelectionUI();
  }

  selectCol(c) {
    const numRows = this.grid.length;
    this.anchor = { r: 0, c };
    this.selection = { r1: 0, c1: c, r2: numRows - 1, c2: c };
    this.selectedCell = { r: 0, c };
    this._applySelectionUI();
  }

  toggleFloatRow(r) {
    if (this.floatedRows.has(r)) {
      this.floatedRows.delete(r);
      this.onNotify?.(`Un-floated row ${r + 1}`);
    } else {
      this.floatedRows.add(r);
      this.onNotify?.(`Floated row ${r + 1}`);
    }
    this.refreshGrid();
    this._commit();
  }

  toggleFloatCol(c) {
    if (this.floatedCols.has(c)) {
      this.floatedCols.delete(c);
      this.onNotify?.(`Un-floated column ${this.colToName(c)}`);
    } else {
      this.floatedCols.add(c);
      this.onNotify?.(`Floated column ${this.colToName(c)}`);
    }
    this.refreshGrid();
    this._commit();
  }

  _positionFloats() {
    if (!this.tableBody || !this.tableHeader || !this.tableEl) return;
    const z = this.zoom || 1;

    const headerH = this.tableHeader.getBoundingClientRect().height;
    const floatedRows = this.tableBody.querySelectorAll('tr.floated-row');
    const rowH = floatedRows.length ? floatedRows[0].getBoundingClientRect().height : 0;
    floatedRows.forEach((tr, i) => {
      const top = (headerH + i * rowH) / z;
      tr.querySelectorAll('td, th').forEach(cell => { cell.style.top = top + 'px'; });
    });

    const rowHeader = this.tableBody.querySelector('.row-header');
    const rowHeaderW = rowHeader ? rowHeader.getBoundingClientRect().width : 0;
    const colWs = new Map();
    const sortedCols = [...this.floatedCols].sort((a, b) => a - b);
    sortedCols.forEach((c, i) => {
      let colW = colWs.get(c);
      if (colW === undefined) {
        const sample = this.tableBody.querySelector(`.csv-cell[data-c="${c}"]`);
        colW = sample ? sample.getBoundingClientRect().width : 0;
        colWs.set(c, colW);
      }
      const left = (rowHeaderW + i * colW) / z;
      this.tableBody.querySelectorAll(`td[data-c="${c}"]`).forEach(cell => { cell.style.left = left + 'px'; });
      const headerTh = this.tableEl.querySelector(`th[data-c="${c}"]`);
      if (headerTh) headerTh.style.left = left + 'px';
    });
  }

  _commitInlineEdit() {
    if (this._activeInlineInput) {
      const input = this._activeInlineInput;
      this._activeInlineInput = null;
      if (input.isConnected) input.blur();
    }
  }

  _handleKeydown(e) {
    if (!this.container || !document.body.contains(this.container)) return;
    // Typing inside the chart dialog must never reach the grid.
    if (this._chartDialog && this._chartDialog.contains(e.target)) {
      if (e.key === 'Escape') this._closeChartDialog();
      return;
    }
    const editing = e.target && e.target.tagName === 'INPUT';
    const formulaBar = editing && e.target.id === 'csvFormulaInput';
    const mod = e.ctrlKey || e.metaKey;
    const hasRange = !!this.selection;

    if (mod && (e.key === 'v' || e.key === 'V')) {
      if (formulaBar) return; // native paste into the formula bar
      e.preventDefault();
      this._commitInlineEdit();
      this.pasteSelection();
      return;
    }
    if (mod && (e.key === 'c' || e.key === 'C')) {
      if (formulaBar) return; // native copy of selected text in the formula bar
      if (!editing || hasRange) {
        e.preventDefault();
        if (editing) this._commitInlineEdit();
        this.copySelection();
      }
      return;
    }
    if (mod && (e.key === 'x' || e.key === 'X')) {
      if (formulaBar) return;
      if (!editing || hasRange) {
        e.preventDefault();
        if (editing) this._commitInlineEdit();
        this.cutSelection();
      }
      return;
    }
    if (editing) return;

    if (mod && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      if (e.shiftKey) this.redo();
      else this.undo();
      return;
    }
    if (mod && (e.key === 'y' || e.key === 'Y')) {
      e.preventDefault();
      this.redo();
      return;
    }

    if (e.key === 'Escape') {
      if (this._chartDialog) {
        this._closeChartDialog();
        return;
      }
      if (this._cellMenu) {
        this._closeCellMenu();
        return;
      }
      this._collapseSelection();
      return;
    }
    if (mod && (e.key === 'a' || e.key === 'A')) {
      e.preventDefault();
      this.selectAll();
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      this.clearSelection();
      return;
    }

    // Type-to-edit: typing a printable character starts editing the selected
    // cell, replacing its current contents (like Excel).
    if (this.selectedCell && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && !e.isComposing) {
      e.preventDefault();
      this._closeCellMenu();
      this._commitInlineEdit();
      const { r, c } = this.selectedCell;
      this.startDirectEdit(this._cellElFor(r, c), r, c);
      if (this._activeInlineInput) this._activeInlineInput.value = e.key;
      return;
    }

    const dirs = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
    };
    const d = dirs[e.key];
    if (!d || !this.selectedCell) return;
    e.preventDefault();
    const numRows = this.grid.length;
    const numCols = this.grid[0] ? this.grid[0].length : 0;
    let r = this.selectedCell.r + d[0];
    let c = this.selectedCell.c + d[1];
    r = Math.max(0, Math.min(numRows - 1, r));
    c = Math.max(0, Math.min(numCols - 1, c));
    this.selectCell(r, c, e.shiftKey);
  }

  // ----- Mobile touch selection gesture -------------------------------
  // Long-press a cell to open the action menu; drag the corner handles to
  // extend the selection. Container scrolling stays natural.

  _gridPointerDown(e) {
    this._suppressClick = false;
    this._pendingTouchTap = false;
    if (e.pointerType !== 'touch') return;
    this._closeCellMenu();
    if (this._cellGesture) {
      this._cancelCellGesture();
      return;
    }
    this._pendingTouchTap = true;
    this._cellGesture = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
    };
    this._cellGestureTimer = setTimeout(() => this._openCellMenu(), 450);
  }

  _gridPointerMove(e) {
    const g = this._cellGesture;
    if (!g || e.pointerId !== g.pointerId) return;
    g.lastX = e.clientX;
    g.lastY = e.clientY;
    if (Math.abs(e.clientX - g.startX) > 8 || Math.abs(e.clientY - g.startY) > 8) {
      this._cancelCellGesture();
    }
  }

  _gridPointerUp(e) {
    const g = this._cellGesture;
    if (!g || e.pointerId !== g.pointerId) return;
    this._cancelCellGesture();
  }

  _cancelCellGesture() {
    if (this._cellGestureTimer) {
      clearTimeout(this._cellGestureTimer);
      this._cellGestureTimer = null;
    }
    this._cellGesture = null;
  }

  _openCellMenu() {
    const g = this._cellGesture;
    if (!g) return;
    this._cellGesture = null;
    if (this._cellGestureTimer) {
      clearTimeout(this._cellGestureTimer);
      this._cellGestureTimer = null;
    }
    this._suppressClick = true;
    this._commitInlineEdit();
    const cell = this._cellFromPoint(g.startX, g.startY);
    if (cell && !this._isInSelection(cell.r, cell.c)) {
      this.selectCell(cell.r, cell.c);
    }
    this._showCellMenu(g.startX, g.startY, cell);
  }

  // ----- Corner selection handles -------------------------------------

  _startHandleDrag(e, corner) {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    this._closeCellMenu();
    this._commitInlineEdit();
    this._suppressClick = true;
    const rect = this._getSelectionRect();
    this._handleDrag = {
      pointerId: e.pointerId,
      corner,
      anchor: corner === 'br' ? { r: rect.r1, c: rect.c1 } : { r: rect.r2, c: rect.c2 },
    };
    this.anchor = this._handleDrag.anchor;
    this.tableContainer.classList.add('csv-handle-dragging');
  }

  _handleDragMove(e) {
    const h = this._handleDrag;
    if (!h || e.pointerId !== h.pointerId) return;
    const cell = this._cellFromPoint(e.clientX, e.clientY);
    if (cell) this.selectCell(cell.r, cell.c, true);
    this._edgeScroll(e.clientX, e.clientY);
  }

  _endHandleDrag(e) {
    const h = this._handleDrag;
    if (!h || (e && e.pointerId !== h.pointerId)) return;
    this._handleDrag = null;
    if (this.tableContainer) this.tableContainer.classList.remove('csv-handle-dragging');
  }

  _positionHandles() {
    if (!this._handles || !this.tableBody || !this.tableContainer) return;
    const hide = () => {
      this._handles.tl.style.display = 'none';
      this._handles.br.style.display = 'none';
    };
    if (!this.selectedCell) {
      hide();
      return;
    }
    const rect = this._getSelectionRect();
    const contRect = this.tableContainer.getBoundingClientRect();
    const place = (handle, cell, corner) => {
      if (!handle) return;
      if (!cell) {
        handle.style.display = 'none';
        return;
      }
      const cr = cell.getBoundingClientRect();
      if (corner === 'br') {
        handle.style.left = (cr.right - contRect.left + this.tableContainer.scrollLeft) + 'px';
        handle.style.top = (cr.bottom - contRect.top + this.tableContainer.scrollTop) + 'px';
      } else {
        handle.style.left = (cr.left - contRect.left + this.tableContainer.scrollLeft) + 'px';
        handle.style.top = (cr.top - contRect.top + this.tableContainer.scrollTop) + 'px';
      }
      const tr = cell.closest('tr');
      const onFloated = cell.classList.contains('floated-col') ||
                        (tr && tr.classList.contains('floated-row'));
      handle.style.zIndex = onFloated ? '10' : '0';
      handle.style.display = 'block';
    };
    place(this._handles.tl, this._cellElFor(rect.r1, rect.c1), 'tl');
    place(this._handles.br, this._cellElFor(rect.r2, rect.c2), 'br');
  }

  _cellElFor(r, c) {
    return this.tableBody.querySelector(`.csv-cell[data-r="${r}"][data-c="${c}"]`);
  }

  // ----- Cell action menu (long-press / right-click) ------------------

  _showCellMenu(x, y, cell) {
    const items = [
      {
        label: 'Edit',
        action: () => {
          this._closeCellMenu();
          if (cell) this.startDirectEdit(this._cellElFor(cell.r, cell.c), cell.r, cell.c);
        },
      },
      { label: 'Cut', action: () => { this._closeCellMenu(); this.cutSelection(); } },
      { label: 'Copy', action: () => { this._closeCellMenu(); this.copySelection(); } },
      { label: 'Paste', action: () => { this._closeCellMenu(); this.pasteSelection(); } },
      { label: 'Clear', action: () => { this._closeCellMenu(); this.clearSelection(); } },
    ];
    this._renderMenu(x, y, items, true);
  }

  _showHeaderMenu(x, y, target) {
    const isCol = target.type === 'col';
    const name = isCol ? this.colToName(target.c) : String(target.r + 1);
    const floated = isCol ? this.floatedCols.has(target.c) : this.floatedRows.has(target.r);
    const items = [
      {
        label: `${floated ? 'Un-float' : 'Float'} ${isCol ? 'Column' : 'Row'} ${name}`,
        action: () => {
          this._closeCellMenu();
          if (isCol) this.toggleFloatCol(target.c);
          else this.toggleFloatRow(target.r);
        },
      },
      {
        label: `Select ${isCol ? 'Column' : 'Row'} ${name}`,
        action: () => {
          this._closeCellMenu();
          if (isCol) this.selectCol(target.c);
          else this.selectRow(target.r);
        },
      },
    ];
    this._renderMenu(x, y, items, false);
  }

  _renderMenu(x, y, items, deselect) {
    this._closeCellMenu();
    const menu = document.createElement('div');
    menu.className = 'context-menu csv-cell-menu';
    for (const item of items) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ctx-item';
      btn.textContent = item.label;
      btn.addEventListener('click', () => {
        item.action();
        if (deselect) this._deselect();
      });
      menu.appendChild(btn);
    }
    document.body.appendChild(menu);
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    let left = x + 8;
    let top = y + 8;
    if (left + mw > window.innerWidth - 4) left = Math.max(4, window.innerWidth - mw - 4);
    if (top + mh > window.innerHeight - 4) top = Math.max(4, window.innerHeight - mh - 4);
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
    this._cellMenu = menu;
  }

  _closeCellMenu() {
    if (this._cellMenu) {
      this._cellMenu.remove();
      this._cellMenu = null;
    }
  }

  _cellFromPoint(x, y) {
    const el = document.elementFromPoint(x, y);
    const cell = el ? el.closest('.csv-cell') : null;
    if (!cell) return null;
    return { r: parseInt(cell.getAttribute('data-r')), c: parseInt(cell.getAttribute('data-c')) };
  }

  _edgeScroll(x, y) {
    const rect = this.tableContainer.getBoundingClientRect();
    const edge = 28;
    const step = 14;
    if (y < rect.top + edge) this.tableContainer.scrollTop -= step;
    else if (y > rect.bottom - edge) this.tableContainer.scrollTop += step;
    if (x < rect.left + edge) this.tableContainer.scrollLeft -= step;
    else if (x > rect.right - edge) this.tableContainer.scrollLeft += step;
  }

  // ----- Cell ranges ---------------------------------------------------

  /** { r1, c1, r2, c2 } → "A1:B10" (or "A1" for a single cell). */
  rangeToString(rect) {
    const start = `${this.colToName(rect.c1)}${rect.r1 + 1}`;
    const end = `${this.colToName(rect.c2)}${rect.r2 + 1}`;
    return start === end ? start : `${start}:${end}`;
  }

  /** "A1:B10" / "a1" → normalized { r1, c1, r2, c2 }, or null when invalid. */
  parseRange(str) {
    if (!str) return null;
    const parts = String(str).trim().split(':');
    if (parts.length > 2) return null;
    const a = this.cellNameToCoord(parts[0]);
    const b = this.cellNameToCoord(parts[1] !== undefined ? parts[1] : parts[0]);
    if (!a || !b) return null;
    if (a.r < 0 || a.c < 0 || b.r < 0 || b.c < 0) return null;
    return {
      r1: Math.min(a.r, b.r), c1: Math.min(a.c, b.c),
      r2: Math.max(a.r, b.r), c2: Math.max(a.c, b.c),
    };
  }

  /** Cells of a range in reading order: [{ ref, value }] (formulas evaluated). */
  _rangeCells(rect) {
    const cells = [];
    for (let r = rect.r1; r <= rect.r2; r++) {
      for (let c = rect.c1; c <= rect.c2; c++) {
        cells.push({
          ref: `${this.colToName(c)}${r + 1}`,
          value: this.getDisplayValue(r, c),
        });
      }
    }
    return cells;
  }

  _rectsIntersect(a, b) {
    return a.r1 <= b.r2 && b.r1 <= a.r2 && a.c1 <= b.c2 && b.c1 <= a.c2;
  }

  _rangeHasFormula(rect) {
    for (let r = rect.r1; r <= rect.r2; r++) {
      for (let c = rect.c1; c <= rect.c2; c++) {
        const ref = `${this.colToName(c).toLowerCase()}${r + 1}`;
        if (ref in this.formulas) return true;
        const raw = this.grid[r] && this.grid[r][c];
        if (typeof raw === 'string' && raw.startsWith('=')) return true;
      }
    }
    return false;
  }

  _specRanges(spec) {
    const names = spec.type === 'pie'
      ? ['labelsRange', 'valuesRange']
      : ['xRange', 'yRange'];
    return names.map(n => this.parseRange(spec[n])).filter(Boolean);
  }

  // ----- Chart data extraction -----------------------------------------

  _requireRange(str, label) {
    const rect = this.parseRange(str);
    if (!rect) throw new Error(`${label} is not a valid cell range — use e.g. A1:A10`);
    return rect;
  }

  _buildXYPoints(spec) {
    const xRect = this._requireRange(spec.xRange, 'X axis range');
    const yRect = this._requireRange(spec.yRange, 'Y axis range');
    const xCells = this._rangeCells(xRect);
    const yCells = this._rangeCells(yRect);
    if (xCells.length !== yCells.length) {
      throw new Error(
        `The X range holds ${xCells.length} cells but the Y range holds ${yCells.length} — ` +
        'they must be the same size so each point is the nth pair'
      );
    }

    const points = [];
    let xKind = null;
    let yKind = null;
    for (let i = 0; i < xCells.length; i++) {
      const xRaw = String(xCells[i].value ?? '').trim();
      const yRaw = String(yCells[i].value ?? '').trim();
      if (!xRaw && !yRaw) continue; // blank pair — skip
      if (!xRaw || !yRaw) {
        const empty = !xRaw ? xCells[i].ref : yCells[i].ref;
        throw new Error(`Cell ${empty} is empty but its pair is not — each point needs both an X and a Y value`);
      }
      const xVal = parseCellValue(xRaw);
      if (!xVal) throw new Error(`Cell ${xCells[i].ref} ("${xRaw}") is not a date, number, or currency value`);
      const yVal = parseCellValue(yRaw);
      if (!yVal) throw new Error(`Cell ${yCells[i].ref} ("${yRaw}") is not a date, number, or currency value`);

      if (xKind && xVal.kind !== xKind) {
        throw new Error(`Cell ${xCells[i].ref} mixes ${xVal.kind}s with ${xKind}s — the X range must be all one type`);
      }
      if (yKind && yVal.kind !== yKind) {
        throw new Error(`Cell ${yCells[i].ref} mixes ${yVal.kind}s with ${yKind}s — the Y range must be all one type`);
      }
      xKind = xVal.kind;
      yKind = yVal.kind;
      points.push({ x: xVal.value, y: yVal.value });
    }
    if (!points.length) throw new Error('The selected ranges contain no values to plot');
    return { points, xKind: xKind || 'number', yKind: yKind || 'number' };
  }

  _buildPieSlices(spec) {
    const labelRect = this._requireRange(spec.labelsRange, 'Labels range');
    const valueRect = this._requireRange(spec.valuesRange, 'Values range');
    const labelCells = this._rangeCells(labelRect);
    const valueCells = this._rangeCells(valueRect);
    if (labelCells.length !== valueCells.length) {
      throw new Error(
        `The labels range holds ${labelCells.length} cells but the values range holds ${valueCells.length} — ` +
        'they must be the same size so each slice is the nth pair'
      );
    }

    const slices = [];
    for (let i = 0; i < labelCells.length; i++) {
      const label = String(labelCells[i].value ?? '').trim();
      const raw = String(valueCells[i].value ?? '').trim();
      if (!label && !raw) continue;
      if (!raw) throw new Error(`Cell ${valueCells[i].ref} is empty but its label is not`);
      const parsed = parseCellValue(raw);
      if (!parsed || parsed.kind !== 'number') {
        throw new Error(`Cell ${valueCells[i].ref} ("${raw}") is not a number or currency value`);
      }
      if (parsed.value < 0) {
        throw new Error(`Cell ${valueCells[i].ref} is negative — pie slices need values of zero or more`);
      }
      slices.push({ label: label || labelCells[i].ref, value: parsed.value });
    }
    if (!slices.length) throw new Error('The selected ranges contain no values to plot');
    return slices;
  }

  // ----- Chart image generation ----------------------------------------

  _csvDir() {
    const idx = this.filePath.lastIndexOf('/');
    return idx > 0 ? this.filePath.slice(0, idx) : '';
  }

  _csvBaseName() {
    const name = this.filePath.split('/').pop() || 'chart';
    return name.replace(/\.[^.]+$/, '') || 'chart';
  }

  chartPath(spec) {
    return `${this._csvDir()}/${spec.file}`;
  }

  _slug(text, fallback) {
    const slug = String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40);
    return slug || fallback;
  }

  _defaultChartFile(type, title, ignoreId = null) {
    const base = `${this._csvBaseName()}-${this._slug(title, type === 'pie' ? 'pie' : 'graph')}`;
    let name = `${base}.jpg`;
    let n = 2;
    const taken = new Set(this.charts.filter(s => s.id !== ignoreId).map(s => s.file));
    while (taken.has(name)) name = `${base}-${n++}.jpg`;
    return name;
  }

  _sanitizeChartFile(name, type, title, ignoreId) {
    let file = String(name || '').trim().replace(/[\\/]/g, '').replace(/^\.+/, '');
    if (!file) return this._defaultChartFile(type, title, ignoreId);
    if (!/\.jpe?g$/i.test(file)) file = file.replace(/\.[^.]*$/, '') + '.jpg';
    return file;
  }

  /** Render a chart spec and write the JPEG next to the CSV. Throws on error. */
  async generateChartImage(spec) {
    if (!this.writeFile || !this.filePath) {
      throw new Error('Charts can only be generated for a saved CSV file');
    }
    let canvas;
    if (spec.type === 'pie') {
      canvas = renderPieChart({ title: spec.title || '', slices: this._buildPieSlices(spec) });
    } else {
      const { points, xKind, yKind } = this._buildXYPoints(spec);
      canvas = renderXYChart({
        title: spec.title || '',
        xLabel: spec.xLabel || '',
        yLabel: spec.yLabel || '',
        logX: !!spec.logX,
        logY: !!spec.logY,
        style: spec.style || 'lines',
        points,
        xKind,
        yKind,
      });
    }
    const base64 = canvasToJpegBase64(canvas);
    await this.writeFile(this.chartPath(spec), base64, 'base64');
    return this.chartPath(spec);
  }

  /**
   * Re-render chart images whose source cells just changed.
   * rect === null re-renders every chart (undo/redo, bulk changes).
   */
  _scheduleChartRefresh(rect) {
    if (!this.charts.length || !this.writeFile || !this.filePath) return;
    const affected = this.charts.filter(spec => {
      if (!rect) return true;
      const ranges = this._specRanges(spec);
      if (!ranges.length) return false;
      // A formula inside the range can depend on any other cell, so treat
      // formula-backed ranges as always stale.
      return ranges.some(r => this._rectsIntersect(r, rect) || this._rangeHasFormula(r));
    });
    if (!affected.length) return;

    this._pendingChartIds = this._pendingChartIds || new Set();
    for (const spec of affected) this._pendingChartIds.add(spec.id);
    clearTimeout(this._chartRefreshTimer);
    this._chartRefreshTimer = setTimeout(() => this._runChartRefresh(), 800);
  }

  async _runChartRefresh() {
    this._chartRefreshTimer = null;
    const ids = this._pendingChartIds || new Set();
    this._pendingChartIds = new Set();
    let updated = 0;
    const errors = [];
    for (const id of ids) {
      const spec = this.charts.find(s => s.id === id);
      if (!spec) continue;
      try {
        await this.generateChartImage(spec);
        updated++;
      } catch (err) {
        errors.push(`${spec.title || spec.file}: ${err.message}`);
      }
    }
    if (updated) this.onNotify?.(`Updated ${updated} chart image${updated === 1 ? '' : 's'}`);
    if (errors.length) this.onNotify?.(`Chart not updated — ${errors[0]}`);
  }

  // ----- Chart dialogs --------------------------------------------------

  openChartDialog(type, existing = null) {
    this._commitInlineEdit();
    this._closeCellMenu();
    const selectionRef = this.selectedCell ? this.rangeToString(this._getSelectionRect()) : '';
    const spec = existing || {
      id: '',
      type,
      title: '',
      style: 'lines',
      xRange: type === 'xy' ? selectionRef : '',
      yRange: '',
      labelsRange: type === 'pie' ? selectionRef : '',
      valuesRange: '',
      xLabel: '',
      yLabel: '',
      logX: false,
      logY: false,
      file: '',
    };
    const editing = !!existing;
    const esc = (v) => this.escapeHTML(v ?? '');

    const rangeField = (id, label, value, hint) => `
      <div class="input-group">
        <label>${label}</label>
        <div class="csv-range-row">
          <input type="text" id="${id}" value="${esc(value)}" placeholder="${hint}" />
          <button type="button" class="btn btn-sm csv-pick-btn" data-target="${id}" title="Pick this range in the sheet">Pick</button>
        </div>
      </div>`;

    const body = type === 'pie'
      ? `
        <div class="input-group">
          <label>Title</label>
          <input type="text" id="chartTitle" value="${esc(spec.title)}" placeholder="Chart title" />
        </div>
        ${rangeField('chartLabelsRange', 'Labels range', spec.labelsRange, 'e.g. A2:A9')}
        ${rangeField('chartValuesRange', 'Values range', spec.valuesRange, 'e.g. B2:B9')}
        <p class="csv-chart-hint">Each slice is the nth label paired with the nth value.</p>`
      : `
        <div class="input-group">
          <label>Title</label>
          <input type="text" id="chartTitle" value="${esc(spec.title)}" placeholder="Chart title" />
        </div>
        ${rangeField('chartXRange', 'X axis range', spec.xRange, 'e.g. A2:A20')}
        ${rangeField('chartYRange', 'Y axis range', spec.yRange, 'e.g. B2:B20')}
        <div class="csv-field-row">
          <div class="input-group">
            <label>X axis label</label>
            <input type="text" id="chartXLabel" value="${esc(spec.xLabel)}" placeholder="(blank)" />
          </div>
          <div class="input-group">
            <label>Y axis label</label>
            <input type="text" id="chartYLabel" value="${esc(spec.yLabel)}" placeholder="(blank)" />
          </div>
        </div>
        <div class="input-group">
          <label>Plot style</label>
          <select id="chartStyle">
            <option value="lines"${spec.style === 'lines' ? ' selected' : ''}>Lines</option>
            <option value="points"${spec.style === 'points' ? ' selected' : ''}>Points</option>
            <option value="both"${spec.style === 'both' ? ' selected' : ''}>Lines + points</option>
          </select>
        </div>
        <label class="checkbox-label"><input type="checkbox" id="chartLogX"${spec.logX ? ' checked' : ''} /> Log scale on X axis</label>
        <label class="checkbox-label"><input type="checkbox" id="chartLogY"${spec.logY ? ' checked' : ''} /> Log scale on Y axis</label>
        <p class="csv-chart-hint">Each point is the nth X value paired with the nth Y value.</p>`;

    const html = `
      <div class="csv-chart-header">
        <h3>${type === 'pie' ? '🥧 ' : '📈 '}${editing ? 'Edit' : 'Create'} ${type === 'pie' ? 'pie chart' : 'graph'}</h3>
        <button type="button" class="close-btn" id="chartDialogClose">&times;</button>
      </div>
      <div class="csv-chart-body">
        ${body}
        <div class="input-group">
          <label>Image file (saved next to the CSV)</label>
          <input type="text" id="chartFile" value="${esc(spec.file)}" placeholder="${esc(this._defaultChartFile(type, spec.title, spec.id))}" />
        </div>
        <div class="csv-chart-error hidden" id="chartError"></div>
      </div>
      <div class="csv-chart-footer">
        <button type="button" class="btn btn-outline" id="chartCancel">Cancel</button>
        <button type="button" class="btn btn-primary" id="chartSubmit">${editing ? 'Update' : 'Create'} ${type === 'pie' ? 'chart' : 'graph'}</button>
      </div>`;

    const dialog = this._openDialogShell(html);
    dialog.querySelector('#chartDialogClose').addEventListener('click', () => this._closeChartDialog());
    dialog.querySelector('#chartCancel').addEventListener('click', () => this._closeChartDialog());
    dialog.querySelectorAll('.csv-pick-btn').forEach(btn => {
      btn.addEventListener('click', () => this._toggleRangeCapture(btn));
    });
    dialog.querySelector('#chartSubmit').addEventListener('click', () => {
      this._submitChartDialog(type, existing);
    });
    dialog.querySelector('#chartTitle')?.focus();
  }

  _submitChartDialog(type, existing) {
    const dialog = this._chartDialog;
    if (!dialog) return;
    const val = (id) => (dialog.querySelector('#' + id)?.value || '').trim();
    const checked = (id) => !!dialog.querySelector('#' + id)?.checked;
    const title = val('chartTitle');

    const spec = {
      id: existing ? existing.id : `chart-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4)}`,
      type,
      title,
    };
    if (type === 'pie') {
      spec.labelsRange = val('chartLabelsRange').toUpperCase();
      spec.valuesRange = val('chartValuesRange').toUpperCase();
    } else {
      spec.xRange = val('chartXRange').toUpperCase();
      spec.yRange = val('chartYRange').toUpperCase();
      spec.xLabel = val('chartXLabel');
      spec.yLabel = val('chartYLabel');
      spec.logX = checked('chartLogX');
      spec.logY = checked('chartLogY');
      spec.style = val('chartStyle') || 'lines';
    }
    spec.file = this._sanitizeChartFile(val('chartFile'), type, title, spec.id);

    const submitBtn = dialog.querySelector('#chartSubmit');
    submitBtn.disabled = true;
    this.generateChartImage(spec)
      .then((path) => {
        const idx = this.charts.findIndex(s => s.id === spec.id);
        if (idx >= 0) this.charts[idx] = spec;
        else this.charts.push(spec);
        this._commit();
        this._updateChartsBtn();
        this._closeChartDialog();
        // Persist the <meta> chart tag straight away so the CSV and the
        // image on disk never disagree.
        this.save();
        this.onNotify?.(`Chart saved to ${path}`);
      })
      .catch((err) => {
        submitBtn.disabled = false;
        this._showChartError(err.message || String(err));
      });
  }

  openChartList() {
    this._commitInlineEdit();
    this._closeCellMenu();
    const rows = this.charts.length
      ? this.charts.map(spec => `
          <div class="csv-chart-row" data-id="${this.escapeHTML(spec.id)}">
            <div class="csv-chart-row-info">
              <strong>${this.escapeHTML(spec.title || '(untitled)')}</strong>
              <span>${spec.type === 'pie' ? 'Pie chart' : 'Graph'} · ${this.escapeHTML(spec.file)}</span>
              <span>${this.escapeHTML(spec.type === 'pie'
                ? `${spec.labelsRange} / ${spec.valuesRange}`
                : `${spec.xRange} / ${spec.yRange}`)}</span>
            </div>
            <div class="csv-chart-row-actions">
              <button type="button" class="btn btn-sm" data-act="edit">Edit</button>
              <button type="button" class="btn btn-sm" data-act="refresh">Refresh</button>
              <button type="button" class="btn btn-sm btn-danger" data-act="delete">Delete</button>
            </div>
          </div>`).join('')
      : '<p class="csv-chart-hint">No charts yet — use 📈 Graph or 🥧 Pie to create one.</p>';

    const dialog = this._openDialogShell(`
      <div class="csv-chart-header">
        <h3>📊 Charts in this sheet</h3>
        <button type="button" class="close-btn" id="chartDialogClose">&times;</button>
      </div>
      <div class="csv-chart-body">
        ${rows}
        <div class="csv-chart-error hidden" id="chartError"></div>
      </div>
      <div class="csv-chart-footer">
        <button type="button" class="btn btn-outline" id="chartCancel">Close</button>
      </div>`);

    dialog.querySelector('#chartDialogClose').addEventListener('click', () => this._closeChartDialog());
    dialog.querySelector('#chartCancel').addEventListener('click', () => this._closeChartDialog());
    dialog.querySelectorAll('.csv-chart-row').forEach(row => {
      const id = row.getAttribute('data-id');
      row.querySelectorAll('button[data-act]').forEach(btn => {
        btn.addEventListener('click', () => {
          const spec = this.charts.find(s => s.id === id);
          if (!spec) return;
          const act = btn.getAttribute('data-act');
          if (act === 'edit') {
            this.openChartDialog(spec.type, spec);
          } else if (act === 'refresh') {
            btn.disabled = true;
            this.generateChartImage(spec)
              .then(path => this.onNotify?.(`Chart updated: ${path}`))
              .catch(err => this._showChartError(err.message || String(err)))
              .finally(() => { btn.disabled = false; });
          } else if (act === 'delete') {
            this.charts = this.charts.filter(s => s.id !== id);
            this._commit();
            this._updateChartsBtn();
            this.save();
            this.onNotify?.('Chart removed (the image file was left in place)');
            this.openChartList();
          }
        });
      });
    });
  }

  _openDialogShell(innerHTML) {
    this._closeChartDialog();
    const dialog = document.createElement('div');
    dialog.className = 'csv-chart-dialog';
    dialog.innerHTML = innerHTML;
    // Mounted inside the editor wrapper so tearing the editor down (opening
    // another file) removes the dialog with it.
    const host = this.container.querySelector('.csv-editor-wrapper') || this.container;
    host.appendChild(dialog);
    this._chartDialog = dialog;
    return dialog;
  }

  _closeChartDialog() {
    this._stopRangeCapture();
    if (this._chartDialog) {
      this._chartDialog.remove();
      this._chartDialog = null;
    }
  }

  _showChartError(msg) {
    const el = this._chartDialog?.querySelector('#chartError');
    if (!el) {
      this.onNotify?.(msg);
      return;
    }
    el.textContent = msg;
    el.classList.remove('hidden');
  }

  _toggleRangeCapture(btn) {
    const dialog = this._chartDialog;
    if (!dialog) return;
    const input = dialog.querySelector('#' + btn.getAttribute('data-target'));
    if (!input) return;
    if (this._rangeCapture && this._rangeCapture.input === input) {
      this._stopRangeCapture();
      return;
    }
    this._stopRangeCapture();
    this._rangeCapture = { input, btn };
    btn.classList.add('active');
    btn.textContent = 'Picking…';
    this.onNotify?.('Select cells in the sheet to fill this range');
    if (this.selectedCell) this._writeCapturedRange();
  }

  _writeCapturedRange() {
    if (!this._rangeCapture || !this.selectedCell) return;
    this._rangeCapture.input.value = this.rangeToString(this._getSelectionRect());
  }

  _stopRangeCapture() {
    if (!this._rangeCapture) return;
    const { btn } = this._rangeCapture;
    if (btn && btn.isConnected) {
      btn.classList.remove('active');
      btn.textContent = 'Pick';
    }
    this._rangeCapture = null;
  }

  _updateChartsBtn() {
    const btn = this.container?.querySelector('#csvChartsBtn');
    if (!btn) return;
    btn.textContent = this.charts.length ? `📊 Charts (${this.charts.length})` : '📊 Charts';
  }

  /** Release document-level listeners and timers when the editor goes away. */
  destroy() {
    this._teardownSelectionGesture();
    this._closeChartDialog();
    clearTimeout(this._chartRefreshTimer);
    this._chartRefreshTimer = null;
    if (this._keydownHandler) {
      document.removeEventListener('keydown', this._keydownHandler);
      this._keydownHandler = null;
    }
  }

  // Serialize grid, formulas, and styles back into exact CSV + <meta> format
  serialize() {
    const lines = [];

    // Serialize CSV grid
    for (let row of this.grid) {
      const lineStr = row.map(cell => {
        if (cell === null || cell === undefined) cell = '';
        if (cell.includes(',') || cell.includes('"') || cell.includes('\n')) {
          return `"${cell.replace(/"/g, '""')}"`;
        }
        return cell;
      }).join(',');
      lines.push(lineStr);
    }

    // Append meta formulas: <meta> c4=b4*1
    for (let [cellRef, expr] of Object.entries(this.formulas)) {
      lines.push(`<meta> ${cellRef}=${expr}`);
    }

    // Append meta styles: <meta> color b6=13,115,30
    for (let [cellRef, style] of Object.entries(this.styles)) {
      if (style.color) {
        lines.push(`<meta> color ${cellRef}=${style.color}`);
      }
    }

    // Append meta wrap markers: <meta> wrap a2
    for (let [cellRef, style] of Object.entries(this.styles)) {
      if (style.wrap) {
        lines.push(`<meta> wrap ${cellRef}`);
      }
    }

    // Append meta float markers: <meta> float row 2 / <meta> float col C
    for (const r of [...this.floatedRows].sort((a, b) => a - b)) {
      lines.push(`<meta> float row ${r + 1}`);
    }
    for (const c of [...this.floatedCols].sort((a, b) => a - b)) {
      lines.push(`<meta> float col ${this.colToName(c)}`);
    }

    // Append chart definitions: <meta> chart {"id":...}
    for (const spec of this.charts) {
      lines.push(`<meta> chart ${JSON.stringify(spec)}`);
    }

    // Append preserved unknown meta lines
    for (let line of this.metaLines) {
      lines.push(line);
    }

    return lines.join('\n');
  }

  save() {
    const outputCSV = this.serialize();
    if (this.onSave) {
      this.onSave(outputCSV);
    }
  }

  escapeHTML(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
}
