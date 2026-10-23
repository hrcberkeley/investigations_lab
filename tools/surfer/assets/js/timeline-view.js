/**
 * Timeline view (Session 6).
 *
 * A slim canvas post-volume histogram above the graph, with drag-to-brush
 * selection that drives the existing date filter. After CIB detection a second
 * (flagged-account) series overlays the total. Binning math is in
 * timeline-model.js; this file is canvas rendering + brush interaction.
 */
import { buildTimelineBins } from './timeline-model.js';

const BAR_COLOR = '#cbd5e1';
const FLAGGED_COLOR = '#dc2626';
const BRUSH_FILL = 'rgba(124, 58, 237, 0.15)';
const BRUSH_STROKE = '#7c3aed';
const DRAG_THRESHOLD = 4; // px — below this a drag counts as a click (clear)

export class TimelineView {
  constructor(container, { onBrush } = {}) {
    this.container = container;
    this.onBrush = onBrush;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'timeline-canvas';
    this.container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');

    this.model = null;        // last built bins {min,max,binSize,...}
    this.brushSec = null;     // [startSec, endSec] | null
    this.dragStartX = null;
    this.dragCurrentX = null;
    this.dragging = false;

    this._onDown = this._onDown.bind(this);
    this._onMove = this._onMove.bind(this);
    this._onUp = this._onUp.bind(this);
    this.canvas.addEventListener('pointerdown', this._onDown);

    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(() => this.render());
      this._ro.observe(this.container);
    }
  }

  setData({ timestamps, indices = null, flaggedMask = null, numBins = 160 } = {}) {
    if (!timestamps || timestamps.length === 0) {
      this.model = null;
      this.render();
      return;
    }
    this.model = buildTimelineBins(timestamps, { numBins, indices, flaggedMask });
    this.render();
  }

  // Reflect the date inputs onto the brush without firing onBrush.
  setBrushRange(startSec, endSec) {
    if (startSec == null && endSec == null) { this.brushSec = null; }
    else this.brushSec = [startSec ?? this.model?.min ?? 0, endSec ?? this.model?.max ?? 0];
    this.render();
  }

  _dims() {
    const rect = this.container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.floor(rect.width));
    const h = Math.max(1, Math.floor(rect.height));
    if (this.canvas.width !== w * dpr || this.canvas.height !== h * dpr) {
      this.canvas.width = w * dpr;
      this.canvas.height = h * dpr;
      this.canvas.style.width = w + 'px';
      this.canvas.style.height = h + 'px';
    }
    return { w, h, dpr };
  }

  _xForSec(sec, w) {
    if (!this.model || this.model.max === this.model.min) return 0;
    return ((sec - this.model.min) / (this.model.max - this.model.min)) * w;
  }

  _secForX(x, w) {
    if (!this.model || w === 0) return this.model?.min ?? 0;
    return this.model.min + (x / w) * (this.model.max - this.model.min);
  }

  render() {
    const { w, h, dpr } = this._dims();
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    if (!this.model || this.model.count === 0) {
      ctx.fillStyle = '#9ca3af';
      ctx.font = '11px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('No timestamps in this dataset', w / 2, h / 2);
      return;
    }

    const { bins, flaggedBins } = this.model;
    const n = bins.length;
    let peak = 0;
    for (let i = 0; i < n; i++) if (bins[i] > peak) peak = bins[i];
    if (peak === 0) peak = 1;

    const pad = 2;
    const usableH = h - pad * 2;
    const barW = w / n;

    for (let i = 0; i < n; i++) {
      const x = i * barW;
      const bh = (bins[i] / peak) * usableH;
      ctx.fillStyle = BAR_COLOR;
      ctx.fillRect(x, h - pad - bh, Math.max(0.5, barW - 0.5), bh);
      if (flaggedBins && flaggedBins[i] > 0) {
        const fh = (flaggedBins[i] / peak) * usableH;
        ctx.fillStyle = FLAGGED_COLOR;
        ctx.fillRect(x, h - pad - fh, Math.max(0.5, barW - 0.5), fh);
      }
    }

    // Brush overlay: live drag takes priority over the committed range.
    let bx0 = null, bx1 = null;
    if (this.dragging && this.dragStartX != null && this.dragCurrentX != null) {
      bx0 = Math.min(this.dragStartX, this.dragCurrentX);
      bx1 = Math.max(this.dragStartX, this.dragCurrentX);
    } else if (this.brushSec) {
      bx0 = this._xForSec(this.brushSec[0], w);
      bx1 = this._xForSec(this.brushSec[1], w);
    }
    if (bx0 != null && bx1 - bx0 > 0.5) {
      ctx.fillStyle = BRUSH_FILL;
      ctx.fillRect(bx0, 0, bx1 - bx0, h);
      ctx.strokeStyle = BRUSH_STROKE;
      ctx.lineWidth = 1;
      ctx.strokeRect(bx0 + 0.5, 0.5, bx1 - bx0 - 1, h - 1);
    }
  }

  _localX(e) {
    const rect = this.canvas.getBoundingClientRect();
    return Math.max(0, Math.min(rect.width, e.clientX - rect.left));
  }

  _onDown(e) {
    if (!this.model || this.model.count === 0) return;
    this.dragging = true;
    this.dragStartX = this._localX(e);
    this.dragCurrentX = this.dragStartX;
    try { this.canvas.setPointerCapture?.(e.pointerId); } catch { /* capture is best-effort */ }
    window.addEventListener('pointermove', this._onMove);
    window.addEventListener('pointerup', this._onUp);
    e.preventDefault();
  }

  _onMove(e) {
    if (!this.dragging) return;
    this.dragCurrentX = this._localX(e);
    this.render();
  }

  _onUp(e) {
    if (!this.dragging) return;
    this.dragging = false;
    window.removeEventListener('pointermove', this._onMove);
    window.removeEventListener('pointerup', this._onUp);

    const w = this.container.getBoundingClientRect().width;
    const x0 = Math.min(this.dragStartX, this.dragCurrentX);
    const x1 = Math.max(this.dragStartX, this.dragCurrentX);
    this.dragStartX = this.dragCurrentX = null;

    if (x1 - x0 < DRAG_THRESHOLD) {
      // Treat as a click → clear the brush/filter.
      this.brushSec = null;
      this.render();
      if (this.onBrush) this.onBrush(null);
      return;
    }
    const startSec = Math.floor(this._secForX(x0, w));
    const endSec = Math.ceil(this._secForX(x1, w));
    this.brushSec = [startSec, endSec];
    this.render();
    if (this.onBrush) this.onBrush({ startSec, endSec });
  }
}
