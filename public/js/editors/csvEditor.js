/**
 * Interactive CSV & Custom Meta Spreadsheet Editor
 */
import { attachPinchZoom } from '../pinchZoom.js';

export class CSVEditor {
  constructor(container, onSave) {
    this.container = container;
    this.onSave = onSave;
    this.grid = []; // 2D array of raw values [row][col]
    this.formulas = {}; // { 'c4': 'b4*1' }
    this.styles = {}; // { 'b6': { color: '13,115,30' } }
    this.metaLines = []; // preserves any unknown <meta> tags
    this.selectedCell = null; // { r, c }
    this.zoom = 1;
  }

  // Parse CSV string into grid, formulas, styles
  parse(csvText) {
    this.grid = [];
    this.formulas = {};
    this.styles = {};
    this.metaLines = [];

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
    // e.g., <meta> c4=b4*1  OR  <meta> color b6=13,115,30
    const content = line.substring(6).trim();
    if (content.toLowerCase().startsWith('color ')) {
      const parts = content.substring(6).split('=');
      if (parts.length === 2) {
        const cell = parts[0].trim().toLowerCase();
        const colorVal = parts[1].trim();
        this.styles[cell] = { ...(this.styles[cell] || {}), color: colorVal };
      }
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
            <input type="color" id="csvColorPicker" title="Cell Text Color" value="#00ffaa" />
            <button class="btn btn-sm" id="csvAddRowBtn">+ Row</button>
            <button class="btn btn-sm" id="csvAddColBtn">+ Col</button>
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
    this.colorPicker.addEventListener('change', (e) => this.onColorChange(e.target.value));
    this.container.querySelector('#csvZoomIn').addEventListener('click', () => this.setZoom(this.zoom + 0.1));
    this.container.querySelector('#csvZoomOut').addEventListener('click', () => this.setZoom(this.zoom - 0.1));
    this.container.querySelector('#csvZoomReset').addEventListener('click', () => this.setZoom(1));

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
  }

  buildGridUI() {
    const numCols = this.grid[0] ? this.grid[0].length : 10;
    
    // Header Row (Corner + A, B, C...)
    let headerHTML = '<th class="row-header"></th>';
    for (let c = 0; c < numCols; c++) {
      headerHTML += `<th>${this.colToName(c)}</th>`;
    }
    this.tableHeader.innerHTML = headerHTML;

    // Body Rows
    let bodyHTML = '';
    for (let r = 0; r < this.grid.length; r++) {
      bodyHTML += `<tr><td class="row-header">${r + 1}</td>`;
      for (let c = 0; c < numCols; c++) {
        const cellRef = `${this.colToName(c).toLowerCase()}${r + 1}`;
        const displayVal = this.getDisplayValue(r, c);
        const styleObj = this.styles[cellRef];
        let styleAttr = '';
        if (styleObj && styleObj.color) {
          styleAttr = `style="color: rgb(${styleObj.color})"`;
        }

        bodyHTML += `<td class="csv-cell" data-r="${r}" data-c="${c}" ${styleAttr}>${this.escapeHTML(displayVal)}</td>`;
      }
      bodyHTML += '</tr>';
    }
    this.tableBody.innerHTML = bodyHTML;

    // Attach Cell Event Listeners
    const cells = this.tableBody.querySelectorAll('.csv-cell');
    cells.forEach(cell => {
      cell.addEventListener('click', (e) => {
        const r = parseInt(cell.getAttribute('data-r'));
        const c = parseInt(cell.getAttribute('data-c'));
        this.selectCell(r, c);
        this.startDirectEdit(cell, r, c);
      });
    });

    // Set table width: fill container but never narrower than columns
    const table = this.container.querySelector('#csvTable');
    const container = table.parentElement;
    const cellMin = 90;
    const tableMin = Math.max(container.clientWidth, numCols * cellMin);
    table.style.width = tableMin + 'px';
  }

  selectCell(r, c) {
    if (this.selectedCell) {
      const prev = this.tableBody.querySelector(`.csv-cell[data-r="${this.selectedCell.r}"][data-c="${this.selectedCell.c}"]`);
      if (prev) prev.classList.remove('selected');
    }

    this.selectedCell = { r, c };
    const current = this.tableBody.querySelector(`.csv-cell[data-r="${r}"][data-c="${c}"]`);
    if (current) current.classList.add('selected');

    const cellName = `${this.colToName(c)}${r + 1}`;
    this.cellRefDisplay.textContent = cellName;
    this.formulaInput.value = this.getRawValue(r, c);
  }

  startDirectEdit(tdCell, r, c) {
    const rawVal = this.getRawValue(r, c);
    tdCell.innerHTML = `<input type="text" class="csv-inline-input" value="${this.escapeHTML(rawVal)}" />`;
    const input = tdCell.querySelector('input');
    input.focus();
    input.select();

    const commitEdit = (val) => {
      this.updateCellValue(r, c, val);
      const cellRef = `${this.colToName(c).toLowerCase()}${r + 1}`;
      tdCell.textContent = this.getDisplayValue(r, c);
      const styleObj = this.styles[cellRef];
      if (styleObj && styleObj.color) {
        tdCell.style.color = `rgb(${styleObj.color})`;
      }
      this.formulaInput.value = this.getRawValue(r, c);
    };

    input.addEventListener('input', () => {
      this.formulaInput.value = input.value;
    });

    let navigating = false;

    input.addEventListener('blur', () => {
      if (!navigating) commitEdit(input.value);
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
  }

  onColorChange(hexColor) {
    if (!this.selectedCell) return;
    const { r, c } = this.selectedCell;
    const cellRef = `${this.colToName(c).toLowerCase()}${r + 1}`;

    // Convert hex to r,g,b
    const rVal = parseInt(hexColor.slice(1, 3), 16);
    const gVal = parseInt(hexColor.slice(3, 5), 16);
    const bVal = parseInt(hexColor.slice(5, 7), 16);

    this.styles[cellRef] = { ...(this.styles[cellRef] || {}), color: `${rVal},${gVal},${bVal}` };
    this.refreshGrid();
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
      this.selectCell(this.selectedCell.r, this.selectedCell.c);
    }
  }

  addRow() {
    const numCols = this.grid[0] ? this.grid[0].length : 10;
    const newRow = new Array(numCols).fill('');
    this.grid.push(newRow);
    this.refreshGrid();
  }

  addCol() {
    for (let r = 0; r < this.grid.length; r++) {
      this.grid[r].push('');
    }
    this.refreshGrid();
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
