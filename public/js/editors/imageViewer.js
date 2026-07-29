/**
 * Image Viewer Component
 */

export class ImageViewer {
  constructor(container) {
    this.container = container;
    this.zoomLevel = 100;
    this.rotation = 0;
  }

  render(base64Data, mimeType, fileName) {
    this.zoomLevel = 100;
    this.rotation = 0;
    const imgSrc = `data:${mimeType};base64,${base64Data}`;

    this.container.innerHTML = `
      <div class="image-viewer-wrapper">
        <div class="image-toolbar">
          <div class="image-title">${this.escapeHTML(fileName)}</div>
          <div class="image-controls">
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
