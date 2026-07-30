import { downloadFile } from '../api.js';

export class DocxViewer {
  constructor(container, onSave) {
    this.container = container;
    this.onSave = onSave;
    this.filePath = '';
  }

  async render(filePath) {
    this.filePath = filePath;

    this.container.innerHTML = `
      <div class="docx-viewer-wrapper">
        <div class="docx-toolbar">
          <span class="file-path-badge">${this.escapeHTML(filePath)}</span>
          <div class="docx-controls">
            <button class="btn btn-sm btn-outline" id="docxDownloadBtn" title="Download DOCX">⬇ Download</button>
          </div>
        </div>
        <div class="docx-loading" id="docxLoading">Loading DOCX…</div>
        <div class="docx-content" id="docxContent"></div>
      </div>
    `;

    try {
      const response = await downloadFile(filePath);
      const arrayBuffer = await response.arrayBuffer();

      const result = await mammoth.convertToHtml({
        arrayBuffer: arrayBuffer,
        styleMap: [
          "p[style-name='Title'] => h1:fresh",
          "p[style-name='Heading 1'] => h1:fresh",
          "p[style-name='Heading 2'] => h2:fresh",
          "p[style-name='Heading 3'] => h3:fresh",
          "p[style-name='Heading 4'] => h4:fresh",
          "r[style-name='Strong'] => strong",
          "r[style-name='Emphasis'] => em",
        ]
      });

      document.getElementById('docxLoading').style.display = 'none';

      const contentEl = document.getElementById('docxContent');
      contentEl.innerHTML = result.value;

      if (result.messages.length > 0) {
        console.warn('DOCX conversion messages:', result.messages);
      }

      document.getElementById('docxDownloadBtn').addEventListener('click', () => this.onDownload());
    } catch (err) {
      const el = document.getElementById('docxLoading');
      el.textContent = 'Failed to load DOCX: ' + err.message;
      el.style.color = 'var(--error-color, #f38ba8)';
    }
  }

  async onDownload() {
    try {
      const response = await downloadFile(this.filePath);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = this.filePath.split('/').pop() || 'document.docx';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (err) {
      console.error('Download failed:', err);
    }
  }

  save() {
    // DOCX viewer is read-only
  }

  escapeHTML(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
}
