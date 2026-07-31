/**
 * Image Viewer Component
 */
import { ImageEditor } from './imageEditor.js';
import { attachPinchZoom } from '../pinchZoom.js';
import { initFullscreenButton } from '../fullscreen.js';

export class ImageViewer {
  constructor(container, onSave) {
    this.container = container;
    this.onSave = onSave;
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.rotation = 0;
    this.currentEditor = null;
  }

  render(base64Data, mimeType, fileName) {
    this.base64Data = base64Data;
    this.mimeType = mimeType;
    this.fileName = fileName;
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.rotation = 0;
    this.currentEditor = null;
    const imgSrc = `data:${mimeType};base64,${base64Data}`;

    this.container.innerHTML = `
      <div class="image-viewer-wrapper">
        <div class="image-toolbar">
          <div class="image-title">${this.escapeHTML(fileName)}</div>
          <div class="image-controls">
            <button class="btn btn-sm btn-primary" id="imgEditBtn">✏️ Edit</button>
            <span class="toolbar-divider"></span>
            <button class="btn btn-sm" id="imgZoomOut">-</button>
            <span class="zoom-label" id="zoomLabel">100%</span>
            <button class="btn btn-sm" id="imgZoomIn">+</button>
            <button class="btn btn-sm" id="imgReset">Reset</button>
            <button class="btn btn-sm" id="imgRotate">Rotate 90°</button>
            <button class="btn btn-sm btn-outline" id="imgFullscreenBtn" title="Fullscreen">⛶ Fullscreen</button>
          </div>
        </div>
        <div class="image-display-area" id="imageDisplayArea">
          <div class="image-transform-layer" id="imageTransformLayer">
            <img id="viewImage" src="${imgSrc}" alt="${this.escapeHTML(fileName)}" draggable="false" />
          </div>
        </div>
      </div>
    `;

    this.displayArea = this.container.querySelector('#imageDisplayArea');
    this.layer = this.container.querySelector('#imageTransformLayer');
    this.imgEl = this.container.querySelector('#viewImage');
    this.zoomLabel = this.container.querySelector('#zoomLabel');

    if (this._detachFs) this._detachFs();
    this._detachFs = initFullscreenButton(
      this.container.querySelector('#imgFullscreenBtn'),
      this.container.querySelector('.image-viewer-wrapper')
    );

    this.imgEl.addEventListener('load', () => this.fitToViewport());
    if (this.imgEl.complete && this.imgEl.naturalWidth) this.fitToViewport();

    this.container.querySelector('#imgEditBtn').addEventListener('click', () => {
      this.openEditor();
    });

    this.container.querySelector('#imgZoomIn').addEventListener('click', () => {
      this.zoomAt(1.2, this.centerClientX(), this.centerClientY());
    });

    this.container.querySelector('#imgZoomOut').addEventListener('click', () => {
      this.zoomAt(1 / 1.2, this.centerClientX(), this.centerClientY());
    });

    this.container.querySelector('#imgReset').addEventListener('click', () => {
      this.fitToViewport();
    });

    this.container.querySelector('#imgRotate').addEventListener('click', () => {
      this.rotation = (this.rotation + 90) % 360;
      this.fitToViewport();
    });

    // Mouse wheel zoom (desktop)
    this.displayArea.addEventListener('wheel', this._wheelHandler = (e) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      this.zoomAt(factor, e.clientX, e.clientY);
    }, { passive: false });

    // Single-finger pan (touch)
    this.displayArea.addEventListener('touchstart', this._touchStart = (e) => {
      if (e.touches.length === 1) {
        this._panning = true;
        this._lastTouchX = e.touches[0].clientX;
        this._lastTouchY = e.touches[0].clientY;
        this.displayArea.classList.add('dragging');
        if (e.cancelable) e.preventDefault();
      }
    }, { passive: false });

    this.displayArea.addEventListener('touchmove', this._touchMove = (e) => {
      if (this._panning && e.touches.length === 1) {
        const t = e.touches[0];
        this.panX += t.clientX - this._lastTouchX;
        this.panY += t.clientY - this._lastTouchY;
        this._lastTouchX = t.clientX;
        this._lastTouchY = t.clientY;
        this.applyTransform();
        if (e.cancelable) e.preventDefault();
      }
    }, { passive: false });

    this.displayArea.addEventListener('touchend', this._touchEnd = () => {
      if (this._panning) {
        this._panning = false;
        this.displayArea.classList.remove('dragging');
      }
    });

    this.displayArea.addEventListener('touchcancel', this._touchEnd);

    // Two-finger pinch to zoom + pan
    this._detachPinch = attachPinchZoom(this.displayArea, {
      getZoom: () => this.zoom,
      onPinch: (zoom, midX, midY, panDx, panDy) => {
        this.applyPinch(zoom, midX, midY, panDx, panDy);
      },
      onEnd: () => {
        this._panning = false;
        this.displayArea.classList.remove('dragging');
      }
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

  centerClientX() {
    const rect = this.displayArea.getBoundingClientRect();
    return rect.left + rect.width / 2;
  }

  centerClientY() {
    const rect = this.displayArea.getBoundingClientRect();
    return rect.top + rect.height / 2;
  }

  fitToViewport() {
    const rect = this.displayArea.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const rotated = this.rotation % 180 !== 0;
    const nw = rotated ? this.imgEl.naturalHeight : this.imgEl.naturalWidth;
    const nh = rotated ? this.imgEl.naturalWidth : this.imgEl.naturalHeight;
    if (!nw || !nh) return;
    const maxW = Math.max(rect.width - 48, 1);
    const maxH = Math.max(rect.height - 48, 1);
    this.zoom = Math.min(1, maxW / nw, maxH / nh);
    if (this.zoom <= 0) this.zoom = 1;
    this.panX = (rect.width - nw * this.zoom) / 2;
    this.panY = (rect.height - nh * this.zoom) / 2;
    this.applyTransform();
  }

  zoomAt(factor, clientX, clientY) {
    const oldZoom = this.zoom;
    const newZoom = Math.min(20, Math.max(0.1, oldZoom * factor));
    if (newZoom === oldZoom) return;
    const rect = this.displayArea.getBoundingClientRect();
    const relX = clientX - rect.left - this.panX;
    const relY = clientY - rect.top - this.panY;
    this.panX -= relX * (newZoom / oldZoom - 1);
    this.panY -= relY * (newZoom / oldZoom - 1);
    this.zoom = newZoom;
    this.applyTransform();
  }

  applyPinch(zoom, midX, midY, panDx, panDy) {
    const oldZoom = this.zoom;
    const newZoom = Math.min(20, Math.max(0.1, zoom));
    if (newZoom === oldZoom) return;
    const rect = this.displayArea.getBoundingClientRect();
    const ratio = newZoom / oldZoom;
    const oldMidRelX = (midX - panDx) - rect.left;
    const oldMidRelY = (midY - panDy) - rect.top;
    this.panX = ratio * this.panX + (1 - ratio) * oldMidRelX + panDx;
    this.panY = ratio * this.panY + (1 - ratio) * oldMidRelY + panDy;
    this.zoom = newZoom;
    this.applyTransform();
  }

  applyTransform() {
    this.layer.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.zoom})`;
    this.imgEl.style.transform = `rotate(${this.rotation}deg)`;
    this.zoomLabel.textContent = `${Math.round(this.zoom * 100)}%`;
  }

  escapeHTML(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
}
