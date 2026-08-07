/**
 * Markdown Editor with WYSIWYG / Live Preview and Toolbar
 */
import { loadScript } from '../lazyLoad.js';

const MARKED_SRC = '/lib/marked.min.js';

export class MarkdownEditor {
  constructor(container, onSave, onNotify = null) {
    this.container = container;
    this.onSave = onSave;
    this.onNotify = onNotify;
    this.mode = 'preview'; // 'split', 'preview', 'raw'
    this._history = [];
    this._historyIndex = -1;
  }

  render(markdownText) {
    this.container.innerHTML = `
      <div class="md-editor-wrapper">
        <div class="md-toolbar">
          <div class="md-toolbar-group">
            <button class="btn btn-sm" id="mdBtnUndo" title="Undo (Ctrl+Z)">↶</button>
            <button class="btn btn-sm" id="mdBtnRedo" title="Redo (Ctrl+Y)">↷</button>
            <span class="toolbar-divider"></span>
            <button class="btn btn-sm" id="mdBtnH1" title="Heading 1"><b>H1</b></button>
            <button class="btn btn-sm" id="mdBtnH2" title="Heading 2"><b>H2</b></button>
            <button class="btn btn-sm" id="mdBtnH3" title="Heading 3"><b>H3</b></button>
            <span class="toolbar-divider"></span>
            <button class="btn btn-sm" id="mdBtnBold" title="Bold"><b>B</b></button>
            <button class="btn btn-sm" id="mdBtnItalic" title="Italic"><i>I</i></button>
            <button class="btn btn-sm" id="mdBtnCode" title="Code"><code>&lt;&gt;</code></button>
            <span class="toolbar-divider"></span>
            <button class="btn btn-sm" id="mdBtnQuote" title="Quote">”</button>
            <button class="btn btn-sm" id="mdBtnList" title="Bullet List">• List</button>
            <button class="btn btn-sm" id="mdBtnLink" title="Link">🔗</button>
            <span class="toolbar-divider"></span>
            <button class="btn btn-sm" id="mdBtnTable" title="Insert table">⇥ Tbl</button>
            <button class="btn btn-sm" id="mdBtnRowAdd" title="Add row to the table under the cursor">Row+</button>
            <button class="btn btn-sm" id="mdBtnRowDel" title="Delete the row under the cursor">Row−</button>
            <button class="btn btn-sm" id="mdBtnColAdd" title="Add column to the table under the cursor">Col+</button>
            <button class="btn btn-sm" id="mdBtnColDel" title="Delete the column under the cursor">Col−</button>
          </div>

          <div class="md-toolbar-group">
            <div class="mode-toggle">
              <button class="btn btn-sm ${this.mode === 'split' ? 'active' : ''}" id="mdModeSplit">Split</button>
              <button class="btn btn-sm ${this.mode === 'preview' ? 'active' : ''}" id="mdModePreview">Rendered</button>
              <button class="btn btn-sm ${this.mode === 'raw' ? 'active' : ''}" id="mdModeRaw">Raw Source</button>
            </div>
            <button class="btn btn-primary btn-sm" id="mdSaveBtn">Save</button>
          </div>
        </div>

        <div class="md-body mode-${this.mode}">
          <textarea class="md-textarea" id="mdTextarea" placeholder="Type Markdown here...">${this.escapeHTML(markdownText)}</textarea>
          <div class="md-preview markdown-body" id="mdPreview"></div>
        </div>
      </div>
    `;

    this.textarea = this.container.querySelector('#mdTextarea');
    this.preview = this.container.querySelector('#mdPreview');

    // Kick off loading the markdown parser up front so the first render is fast.
    this._markedReady = loadScript(MARKED_SRC);

    // History: the initial document is the first undo state.
    this._history = [{ value: markdownText, time: Date.now(), key: 'init' }];
    this._historyIndex = 0;
    this._opSeq = 0;

    // Attach listeners
    this.textarea.addEventListener('input', () => {
      this._pushHistory(this.textarea.value, 'type');
      this.updatePreview();
    });

    this.textarea.addEventListener('keydown', (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      if ((e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        if (this.onSave) this.onSave(this.textarea.value);
        return;
      }
      if ((e.key === 'z' || e.key === 'Z') && !e.shiftKey) {
        e.preventDefault();
        this.undo();
      } else if (e.key === 'y' || e.key === 'Y' || ((e.key === 'z' || e.key === 'Z') && e.shiftKey)) {
        e.preventDefault();
        this.redo();
      }
    });

    this.container.querySelector('#mdSaveBtn').addEventListener('click', () => {
      if (this.onSave) this.onSave(this.textarea.value);
    });

    // Toolbar formatting action helper
    const insertFormatting = (prefix, suffix = '') => {
      const start = this.textarea.selectionStart;
      const end = this.textarea.selectionEnd;
      const text = this.textarea.value;
      const selected = text.substring(start, end);
      const replacement = `${prefix}${selected || 'text'}${suffix}`;
      const newValue = text.substring(0, start) + replacement + text.substring(end);
      const newStart = start + prefix.length;
      const newEnd = end + prefix.length || newStart + 4;
      this._applyTextEdit(newValue, newStart, newEnd);
    };

    this.container.querySelector('#mdBtnUndo').addEventListener('click', () => this.undo());
    this.container.querySelector('#mdBtnRedo').addEventListener('click', () => this.redo());
    this.container.querySelector('#mdBtnH1').addEventListener('click', () => insertFormatting('# '));
    this.container.querySelector('#mdBtnH2').addEventListener('click', () => insertFormatting('## '));
    this.container.querySelector('#mdBtnH3').addEventListener('click', () => insertFormatting('### '));
    this.container.querySelector('#mdBtnBold').addEventListener('click', () => insertFormatting('**', '**'));
    this.container.querySelector('#mdBtnItalic').addEventListener('click', () => insertFormatting('*', '*'));
    this.container.querySelector('#mdBtnCode').addEventListener('click', () => insertFormatting('`', '`'));
    this.container.querySelector('#mdBtnQuote').addEventListener('click', () => insertFormatting('> '));
    this.container.querySelector('#mdBtnList').addEventListener('click', () => insertFormatting('- '));
    this.container.querySelector('#mdBtnLink').addEventListener('click', () => insertFormatting('[', '](https://)'));

    // Table actions
    this.container.querySelector('#mdBtnTable').addEventListener('click', () => this.insertTable());
    this.container.querySelector('#mdBtnRowAdd').addEventListener('click', () => this.addTableRow());
    this.container.querySelector('#mdBtnRowDel').addEventListener('click', () => this.deleteTableRow());
    this.container.querySelector('#mdBtnColAdd').addEventListener('click', () => this.addTableColumn());
    this.container.querySelector('#mdBtnColDel').addEventListener('click', () => this.deleteTableColumn());

    // Mode toggles
    this.container.querySelector('#mdModeSplit').addEventListener('click', () => this.setMode('split'));
    this.container.querySelector('#mdModePreview').addEventListener('click', () => this.setMode('preview'));
    this.container.querySelector('#mdModeRaw').addEventListener('click', () => this.setMode('raw'));

    this.updatePreview();
  }

  setMode(mode) {
    this.mode = mode;
    const body = this.container.querySelector('.md-body');
    body.className = `md-body mode-${mode}`;

    const buttons = this.container.querySelectorAll('.mode-toggle button');
    buttons.forEach(btn => btn.classList.remove('active'));

    if (mode === 'split') this.container.querySelector('#mdModeSplit').classList.add('active');
    if (mode === 'preview') this.container.querySelector('#mdModePreview').classList.add('active');
    if (mode === 'raw') this.container.querySelector('#mdModeRaw').classList.add('active');

    this.updatePreview();
  }

  async updatePreview() {
    try {
      const html = await this.parseMarkdown(this.textarea.value);
      if (this.preview) this.preview.innerHTML = html;
    } catch {
      // Parsing failed (e.g. script load error) — show the raw source as a fallback.
      if (this.preview) this.preview.textContent = this.textarea.value;
    }
  }

  // Render Markdown to HTML using the lazy-loaded marked parser.
  async parseMarkdown(md) {
    await this._markedReady;
    const marked = window.marked;
    if (!marked) return md;
    if (!this._configured) {
      marked.setOptions({
        gfm: true,
        breaks: false,
      });
      this._configured = true;
    }
    return marked.parse(md || '');
  }

  escapeHTML(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // ----- Table editing -------------------------------------------------

  // ----- Undo / redo ---------------------------------------------------

  /** Push a new document state onto the history. Coalesces consecutive typing. */
  _pushHistory(value, key = null) {
    if (key === null) key = 'op' + (++this._opSeq);
    const now = Date.now();
    const atHead = this._historyIndex === this._history.length - 1;
    const last = atHead && this._history.length ? this._history[this._historyIndex] : null;
    if (key === 'type' && last && last.key === 'type' && now - last.time < 1500 && atHead) {
      last.value = value;
      last.time = now;
      this._updateHistoryButtons();
      return;
    }
    this._history.length = this._historyIndex + 1;
    this._history.push({ value, time: now, key });
    if (this._history.length > 200) this._history.shift();
    this._historyIndex = this._history.length - 1;
    this._updateHistoryButtons();
  }

  /** Set the textarea value without recording history (used by undo/redo). */
  _applyValue(value, selStart = null, selEnd = null) {
    this.textarea.value = value;
    this.updatePreview();
    this.textarea.focus();
    if (selStart !== null) {
      this.textarea.setSelectionRange(selStart, selEnd !== null ? selEnd : selStart);
    }
  }

  /** Apply an edit, record it in history, and refresh the preview. */
  _applyTextEdit(newValue, selStart = null, selEnd = null, key = null) {
    this._pushHistory(newValue, key);
    this._applyValue(newValue, selStart, selEnd);
  }

  _updateHistoryButtons() {
    const undoBtn = this.container?.querySelector('#mdBtnUndo');
    const redoBtn = this.container?.querySelector('#mdBtnRedo');
    if (undoBtn) undoBtn.disabled = !this.canUndo();
    if (redoBtn) redoBtn.disabled = !this.canRedo();
  }

  canUndo() { return this._historyIndex > 0; }
  canRedo() { return this._historyIndex < this._history.length - 1; }

  undo() {
    if (!this.canUndo()) {
      this.onNotify?.('Nothing to undo');
      return;
    }
    this._historyIndex--;
    this._applyValue(this._history[this._historyIndex].value);
    this.onNotify?.('Undo');
  }

  redo() {
    if (!this.canRedo()) {
      this.onNotify?.('Nothing to redo');
      return;
    }
    this._historyIndex++;
    this._applyValue(this._history[this._historyIndex].value);
    this.onNotify?.('Redo');
  }

  /** Does this line look like a markdown table row? (optional indent, starts with |) */
  _isTableLine(line) {
    return /^\s*\|/.test(line);
  }

  /** Is this line a table separator (| --- | --- |)? One or more dashed alignment cells. */
  _isTableSeparator(line) {
    return /^\s*\|(\s*:?-+:?\s*\|)+\s*$/.test(line);
  }

  /** Number of columns in a table row, computed from the outer pipe delimiters. */
  _rowColumnCount(line) {
    const inner = line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|');
    return inner.length;
  }

  /**
   * Find the table block under the textarea cursor.
   * Returns { lineStart, lineEnd, cursorRow, columnCount } or null.
   */
  _getTableAtCursor() {
    const text = this.textarea.value;
    const pos = this.textarea.selectionStart;
    const lines = text.split('\n');

    // Map each line to its start offset in the source.
    const offsets = [];
    let offset = 0;
    for (const line of lines) {
      offsets.push(offset);
      offset += line.length + 1;
    }

    // Line under the cursor.
    let lineIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (pos >= offsets[i] && pos <= offsets[i] + lines[i].length) {
        lineIdx = i;
        break;
      }
    }
    if (lineIdx < 0 || !this._isTableLine(lines[lineIdx])) return null;

    // Expand to the contiguous block of table lines.
    let start = lineIdx;
    while (start > 0 && this._isTableLine(lines[start - 1])) start--;
    let end = lineIdx;
    while (end < lines.length - 1 && this._isTableLine(lines[end + 1])) end++;

    // Must be a real table: at least a header + a separator row.
    if (end - start < 1 || !this._isTableSeparator(lines[start + 1])) return null;

    const columnCount = this._rowColumnCount(lines[start]);
    return {
      lineStart: start,
      lineEnd: end,
      cursorRow: lineIdx - start,
      columnCount: Math.max(1, columnCount),
    };
  }

  insertTable() {
    const cols = 3;
    const dataRows = 2;
    const header = '| Col 1 | Col 2 | Col 3 |';
    const separator = '| --- | --- | --- |';
    const bodyRows = Array.from({ length: dataRows }, () => '|  |  |  |');
    const table = [header, separator, ...bodyRows].join('\n') + '\n\n';

    const pos = this.textarea.selectionStart;
    const text = this.textarea.value;
    const prefix = pos > 0 && text[pos - 1] !== '\n' ? '\n' : '';
    const newValue = text.slice(0, pos) + prefix + table + text.slice(pos);
    this._applyTextEdit(newValue, pos + prefix.length + header.indexOf('Col 1') + 3);
    this.onNotify?.('Inserted table');
  }

  addTableRow() {
    const info = this._getTableAtCursor();
    if (!info) {
      this.onNotify?.('Cursor is not inside a table');
      return;
    }
    const lines = this.textarea.value.split('\n');
    const cursorRow = info.lineStart + info.cursorRow;
    const cell = this._captureCell(lines, cursorRow);
    const cells = Array.from({ length: info.columnCount }, () => '  ');
    const newRow = '| ' + cells.join(' | ') + ' |';
    // Insert after the row under the cursor — the cursor's own cell is untouched.
    lines.splice(cursorRow + 1, 0, newRow);
    const newPos = this._cellStartOffset(lines, cursorRow, cell.col) + cell.inCellOffset;
    this._applyTextEdit(lines.join('\n'), newPos);
    this.onNotify?.('Added row');
  }

  deleteTableRow() {
    const info = this._getTableAtCursor();
    if (!info) {
      this.onNotify?.('Cursor is not inside a table');
      return;
    }
    const lines = this.textarea.value.split('\n');
    const row = info.lineStart + info.cursorRow;
    const cell = this._captureCell(lines, row);
    // Can't delete the header or separator.
    if (row <= info.lineStart + 1) {
      this.onNotify?.('Cannot delete the header or separator row');
      return;
    }
    if (info.lineEnd <= info.lineStart + 1) {
      this.onNotify?.('No data rows to delete');
      return;
    }
    lines.splice(row, 1);
    // Put the cursor in the same column of the row now occupying this slot.
    let newRow = row;
    if (newRow >= lines.length) newRow = Math.max(info.lineStart + 1, lines.length - 1);
    const newPos = this._cellStartOffset(lines, newRow, cell.col) + cell.inCellOffset;
    this._applyTextEdit(lines.join('\n'), newPos);
    this.onNotify?.('Deleted row');
  }

  addTableColumn() {
    const info = this._getTableAtCursor();
    if (!info) {
      this.onNotify?.('Cursor is not inside a table');
      return;
    }
    const lines = this.textarea.value.split('\n');
    const cursorRow = info.lineStart + info.cursorRow;
    const cell = this._captureCell(lines, cursorRow);
    for (let i = info.lineStart; i <= info.lineEnd; i++) {
      lines[i] = this._appendCell(lines[i]);
    }
    // New cells are appended at the end, so the cursor's own cell is unchanged.
    const newPos = this._cellStartOffset(lines, cursorRow, cell.col) + cell.inCellOffset;
    this._applyTextEdit(lines.join('\n'), newPos);
    this.onNotify?.('Added column');
  }

  /** Append one cell to a table row so the column count stays consistent. */
  _appendCell(line) {
    const trimmed = line.trimEnd();
    const leading = line.slice(0, line.length - trimmed.length);
    const body = trimmed.replace(/\|\s*$/, '');
    if (this._isTableSeparator(line)) {
      return leading + body + ' | --- |';
    }
    return leading + body + ' |  |';
  }

  deleteTableColumn() {
    const info = this._getTableAtCursor();
    if (!info) {
      this.onNotify?.('Cursor is not inside a table');
      return;
    }
    if (info.columnCount <= 1) {
      this.onNotify?.('Cannot delete the only column');
      return;
    }
    const lines = this.textarea.value.split('\n');
    const cursorRow = info.lineStart + info.cursorRow;
    const cell = this._captureCell(lines, cursorRow);
    const col = cell.col;

    for (let i = info.lineStart; i <= info.lineEnd; i++) {
      lines[i] = this._removeCell(lines[i], col);
    }
    // The cursor's column was removed — place it at the same spot (now the
    // following column) or clamp to the new last column.
    const newCol = Math.min(col, info.columnCount - 2);
    const newPos = this._cellStartOffset(lines, cursorRow, newCol) + cell.inCellOffset;
    this._applyTextEdit(lines.join('\n'), newPos);
    this.onNotify?.('Deleted column');
  }

  /** Determine the 0-based column index the cursor falls into within a row. */
  _columnAtCursor(line, cursorOffset) {
    const inner = line.replace(/^\s*\|/, '');
    let posInInner = cursorOffset - (line.length - inner.length);
    const cells = inner.split('|');
    let running = 0;
    for (let i = 0; i < cells.length; i++) {
      running += cells[i].length + 1; // +1 for the pipe separator
      if (posInInner < running) return i;
    }
    return cells.length - 1;
  }

  /** Absolute offset of the start of a line in a line array. */
  _lineStartOffset(lines, row) {
    let offset = 0;
    for (let i = 0; i < row; i++) offset += lines[i].length + 1;
    return offset;
  }

  /** Absolute offset of the start of the (row, col) cell in a line array. */
  _cellStartOffset(lines, row, col) {
    const line = lines[row];
    const inner = line.replace(/^\s*\|/, '');
    const leadingPipe = line.length - inner.length;
    const cells = inner.split('|');
    let within = leadingPipe + 1; // skip the leading pipe
    for (let i = 0; i < col && i < cells.length; i++) {
      within += cells[i].length + 1;
    }
    return this._lineStartOffset(lines, row) + within;
  }

  /**
   * Record where the cursor is inside its cell: { row, col, inCellOffset }.
   * inCellOffset is the cursor's position relative to the start of that cell,
   * so it survives structural edits that shift surrounding lines.
   */
  _captureCell(lines, row) {
    const pos = this.textarea.selectionStart;
    const lineStart = this._lineStartOffset(lines, row);
    const col = this._columnAtCursor(lines[row], pos - lineStart);
    const cellStart = this._cellStartOffset(lines, row, col);
    const inCellOffset = Math.max(0, pos - cellStart);
    return { row, col, inCellOffset };
  }

  /** Remove one cell (column) from a table row, preserving the row's shape. */
  _removeCell(line, col) {
    const trimmed = line.trimEnd();
    const leading = line.slice(0, line.length - trimmed.length);
    const separator = this._isTableSeparator(line);
    let inner = trimmed.replace(/^\s*\|/, '').replace(/\|\s*$/, '');
    let cells = inner.split('|');
    if (col < 0) col = 0;
    if (col >= cells.length) col = cells.length - 1;
    cells.splice(col, 1);
    let rebuilt = '|' + cells.map(c => ` ${c.trim()} `).join('|') + '|';
    if (separator) rebuilt = rebuilt.replace(/---/g, '---');
    return leading + rebuilt;
  }
}
