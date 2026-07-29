/**
 * Markdown Editor with WYSIWYG / Live Preview and Toolbar
 */

export class MarkdownEditor {
  constructor(container, onSave) {
    this.container = container;
    this.onSave = onSave;
    this.mode = 'split'; // 'split', 'preview', 'raw'
  }

  render(markdownText) {
    this.container.innerHTML = `
      <div class="md-editor-wrapper">
        <div class="md-toolbar">
          <div class="md-toolbar-group">
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

    // Attach listeners
    this.textarea.addEventListener('input', () => this.updatePreview());

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

      this.textarea.value = text.substring(0, start) + replacement + text.substring(end);
      this.textarea.focus();
      this.textarea.setSelectionRange(start + prefix.length, end + prefix.length || start + prefix.length + 4);
      this.updatePreview();
    };

    this.container.querySelector('#mdBtnH1').addEventListener('click', () => insertFormatting('# '));
    this.container.querySelector('#mdBtnH2').addEventListener('click', () => insertFormatting('## '));
    this.container.querySelector('#mdBtnH3').addEventListener('click', () => insertFormatting('### '));
    this.container.querySelector('#mdBtnBold').addEventListener('click', () => insertFormatting('**', '**'));
    this.container.querySelector('#mdBtnItalic').addEventListener('click', () => insertFormatting('*', '*'));
    this.container.querySelector('#mdBtnCode').addEventListener('click', () => insertFormatting('`', '`'));
    this.container.querySelector('#mdBtnQuote').addEventListener('click', () => insertFormatting('> '));
    this.container.querySelector('#mdBtnList').addEventListener('click', () => insertFormatting('- '));
    this.container.querySelector('#mdBtnLink').addEventListener('click', () => insertFormatting('[', '](https://)'));

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

  updatePreview() {
    this.preview.innerHTML = this.parseMarkdown(this.textarea.value);
  }

  // Pure Vanilla JS Markdown Parser
  parseMarkdown(md) {
    if (!md) return '';
    let html = md;

    // Escaped raw chars
    html = this.escapeHTML(html);

    // Code blocks ```code```
    html = html.replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>');

    // Inline code `code`
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Headers
    html = html.replace(/^### (.*$)/gim, '<h3>$1</h3>');
    html = html.replace(/^## (.*$)/gim, '<h2>$1</h2>');
    html = html.replace(/^# (.*$)/gim, '<h1>$1</h1>');

    // Bold & Italic
    html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');

    // Blockquotes
    html = html.replace(/^\&gt; (.*$)/gim, '<blockquote>$1</blockquote>');

    // Horizontal Rule
    html = html.replace(/^---$/gim, '<hr>');

    // Unordered List Items
    html = html.replace(/^\- (.*$)/gim, '<ul><li>$1</li></ul>');
    html = html.replace(/<\/ul>\n<ul>/g, ''); // Join lists

    // Links [Text](Url)
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');

    // Paragraphs
    html = html.replace(/\n\n/g, '</p><p>');
    html = `<p>${html}</p>`;
    html = html.replace(/<p><\/p>/g, '');
    html = html.replace(/<p>(<h[1-3]>.*?<\/h[1-3]>)<\/p>/g, '$1');
    html = html.replace(/<p>(<pre>.*?<\/pre>)<\/p>/g, '$1');
    html = html.replace(/<p>(<ul>.*?<\/ul>)<\/p>/g, '$1');
    html = html.replace(/<p>(<blockquote>.*?<\/blockquote>)<\/p>/g, '$1');

    return html;
  }

  escapeHTML(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
}
