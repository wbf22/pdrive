/**
 * Image Viewer Component
 */
import { ImageEditor } from './imageEditor.js';

export class ImageViewer {
  constructor(container, onSave) {
    this.container = container;
    this.onSave = onSave;
    this.zoomLevel = 100;
    this.rotation = 0;
    this.currentEditor = null;
  }

  render(base64Data, mimeType, fileName) {
    this.base64Data = base64Data;
    this.mimeType = mimeType;
    this.fileName = fileName;
    this.zoomLevel = 100;
    this.rotation = 0;
    this.currentEditor = null;
    const imgSrc = `data:${mimeType};base64,${base64Data}`;

    this.container.innerHTML = `
      <div class="image-viewer-wrapper">
        <div class="image-toolbar">
          <div class="image-title">${this.escapeHTML(fileName)}</div>
          <div class="image-controls">
            <button class="btn btn-sm btn-primary" id="imgEditBtn">✏️ Edit</button>
            <span class="toolbar-divider" style="display:inline-block;width:1px;height:16px;background:var(--border-color);margin:0 4px;"></span>
            <button class="btn btn-sm" id="imgZoomOut">-</button>
            <span class="zoom-label" id="zoomLabel">100%</span>
            <button class="btn btn-sm" id="imgZoomIn">+</button>
            <button class="btn btn-sm" id="imgReset">Reset</button>
            <button class="btn btn-sm" id="imgRotate">Rotate 90°</button>
          </div>
        </div>
        <div class="image-display-area">
          <img id="viewImage" src="${imgSrc}" alt="${this.escapeHTML(fileName)}" style="transform: scale(1) rotate(0deg);" />
        </div>
      </div>
    `;

    this.imgEl = this.container.querySelector('#viewImage');
    this.zoomLabel = this.container.querySelector('#zoomLabel');

    this.container.querySelector('#imgEditBtn').addEventListener('click', () => {
      this.openEditor();
    });

    this.container.querySelector('#imgZoomIn').addEventListener('click', () => {
      this.zoomLevel = Math.min(300, this.zoomLevel + 20);
      this.applyTransform();
    });

    this.container.querySelector('#imgZoomOut').addEventListener('click', () => {
      this.zoomLevel = Math.max(20, this.zoomLevel - 20);
      this.applyTransform();
    });

    this.container.querySelector('#imgReset').addEventListener('click', () => {
      this.zoomLevel = 100;
      this.rotation = 0;
      this.applyTransform();
    });

    this.container.querySelector('#imgRotate').addEventListener('click', () => {
      this.rotation = (this.rotation + 90) % 360;
      this.applyTransform();
    });
  }

  openEditor() {
    this.currentEditor = new ImageEditor(this.container, {
      onSave: (newBase64) => {
        this.base64Data = newBase64;
        if (this.onSave) {
          this.onSave(newBase64, 'base64');
        }
      },
      onClose: () => {
        this.currentEditor = null;
        this.render(this.base64Data, this.mimeType, this.fileName);
      }
    });
    this.currentEditor.render(this.base64Data, this.mimeType, this.fileName);
  }

  save() {
    if (this.currentEditor && typeof this.currentEditor.save === 'function') {
      this.currentEditor.save();
    } else if (this.onSave) {
      this.onSave(this.base64Data, 'base64');
    }
  }

  applyTransform() {
    this.imgEl.style.transform = `scale(${this.zoomLevel / 100}) rotate(${this.rotation}deg)`;
    this.zoomLabel.textContent = `${this.zoomLevel}%`;
  }

  escapeHTML(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
}
