/**
 * Plain Text / Code Editor with Line Numbers and Status Bar
 */

export class TextEditor {
  constructor(container, onSave) {
    this.container = container;
    this.onSave = onSave;
  }

  render(textContent, filePath) {
    this.container.innerHTML = `
      <div class="text-editor-wrapper">
        <div class="editor-toolbar">
          <div class="file-path-badge">${this.escapeHTML(filePath || 'Untitled')}</div>
          <button class="btn btn-primary btn-sm" id="textSaveBtn">Save</button>
        </div>
        <div class="editor-main">
          <div class="line-numbers" id="lineNumbers">1</div>
          <textarea class="code-textarea" id="codeArea" spellcheck="false">${this.escapeHTML(textContent)}</textarea>
        </div>
        <div class="editor-statusbar">
          <span id="editorStats">Lines: 1 | Characters: 0</span>
        </div>
      </div>
    `;

    this.textarea = this.container.querySelector('#codeArea');
    this.lineNumbers = this.container.querySelector('#lineNumbers');
    this.stats = this.container.querySelector('#editorStats');

    // Sync scroll & line numbers
    this.textarea.addEventListener('input', () => {
      this.updateLineNumbers();
      this.updateStats();
    });

    this.textarea.addEventListener('scroll', () => {
      this.lineNumbers.scrollTop = this.textarea.scrollTop;
    });

    // Handle Tab key in code editor
    this.textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        const start = this.textarea.selectionStart;
        const end = this.textarea.selectionEnd;

        this.textarea.value = this.textarea.value.substring(0, start) + '  ' + this.textarea.value.substring(end);
        this.textarea.selectionStart = this.textarea.selectionEnd = start + 2;
        this.updateLineNumbers();
        this.updateStats();
      }
    });

    this.container.querySelector('#textSaveBtn').addEventListener('click', () => {
      if (this.onSave) this.onSave(this.textarea.value);
    });

    this.updateLineNumbers();
    this.updateStats();
  }

  updateLineNumbers() {
    const lines = this.textarea.value.split('\n').length;
    let numbersHTML = '';
    for (let i = 1; i <= lines; i++) {
      numbersHTML += `${i}<br>`;
    }
    this.lineNumbers.innerHTML = numbersHTML;
  }

  updateStats() {
    const text = this.textarea.value;
    const lines = text.split('\n').length;
    const chars = text.length;
    this.stats.textContent = `Lines: ${lines} | Chars: ${chars}`;
  }

  escapeHTML(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
}
