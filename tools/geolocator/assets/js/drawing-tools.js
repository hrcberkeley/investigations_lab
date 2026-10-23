/* ========== DRAWING INFRASTRUCTURE ==========
 * Provides a unified drawing experience across panels by routing toolbar
 * actions to either Leaflet Geoman (for geographic shapes) or Konva (for
 * pixel-based overlays). The module maintains a global undo/redo stack and
 * harmonises styling across backends.
 */

/* global map, Konva, stickyNotes, L */

const DRAWING_DEFAULTS = {
  tool: 'pan',
  color: '#FF4444',
  dashed: false,
  lineWidth: 2,
  filled: false,
  fillOpacity: 0.2
};

const SUN_ASSIGNMENT_ID_ATTR = '__sunAssignmentGuid';
const SUN_ASSIGNMENT_ID_KEY = typeof Symbol === 'function' ? Symbol('sunAssignmentGuid') : SUN_ASSIGNMENT_ID_ATTR;
let sunAssignmentIdCounter = 0;

function hexToRgba(hex, opacity) {
  const stripped = hex.replace('#', '');
  const bigint = parseInt(stripped, 16);
  const r = (bigint >> 16) & 255;
  const g = (bigint >> 8) & 255;
  const b = bigint & 255;
  return `rgba(${r}, ${g}, ${b}, ${opacity})`;
}

class KonvaPanel {
  constructor(key, container, router, options = {}) {
    this.key = key;
    this.container = container;
    this.router = router;
    this.forwardTarget = options.forwardTarget || container;
    this.overlay = document.createElement('div');
    this.overlay.className = 'konva-overlay';
    this.overlay.style.position = 'absolute';
    this.overlay.style.top = '0';
    this.overlay.style.left = '0';
    this.overlay.style.width = '100%';
    this.overlay.style.height = '100%';
    this.overlay.style.pointerEvents = 'none';
    this.pointerEnabled = false;
    this.boundHandleWheel = (event) => this.handleWheel(event);
    this.overlay.addEventListener('wheel', this.boundHandleWheel, { passive: false });
    const overlayZIndex = options.zIndex != null ? options.zIndex : 30;
    this.overlay.style.zIndex = String(overlayZIndex);

    // Ensure container can host absolute overlay
    if (getComputedStyle(container).position === 'static') {
      container.style.position = 'relative';
    }

    container.appendChild(this.overlay);

    this.stage = new Konva.Stage({
      container: this.overlay,
      width: container.clientWidth,
      height: container.clientHeight
    });

    this.layer = new Konva.Layer();
    this.stage.add(this.layer);

    this.viewportTransform = {
      scaleX: 1,
      scaleY: 1,
      translateX: 0,
      translateY: 0
    };

    this.transformer = new Konva.Transformer({
      rotateEnabled: true,
      rotateAnchorOffset: 30,
      enabledAnchors: ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'middle-left', 'middle-right', 'top-center', 'bottom-center'],
      anchorSize: 8,
      borderStroke: '#1971c2',
      borderStrokeWidth: 1
    });
    this.layer.add(this.transformer);

    this.shapes = new Set();
    this.angleMarkers = new Map();

    this.activeShape = null;
    this.drawingShape = null;
    this.pendingPolygon = null;
    this.forwarding = false;
    this.forwardingGuards = null;
    this.forwardingPointerId = null;
    this.drawingGuards = null;

    this.stage.on('mousedown touchstart', (evt) => this.onPointerDown(evt));
    this.stage.on('mousemove touchmove', (evt) => this.onPointerMove(evt));
    this.stage.on('mouseup touchend', (evt) => this.onPointerUp(evt));
    this.stage.on('click tap', (evt) => this.onClick(evt));
    this.stage.on('dblclick dbltap', (evt) => this.onDoubleClick(evt));
  }

  isMapOverlay() {
    return this.key === 'map-overlay';
  }

  shouldTrackGeo() {
    return this.isMapOverlay() && this.router && this.router.map && typeof this.router.map.latLngToContainerPoint === 'function';
  }

  setPointerEnabled(enabled) {
    this.pointerEnabled = !!enabled;
    if (this.forwarding) return;

    // CRITICAL: Never disable pointer events during active drawing
    // This ensures mouseup/touchend events are always captured
    if (this.drawingShape || this.pendingPolygon) {
      this.overlay.style.pointerEvents = 'auto';
      return;
    }

    const tool = this.router.state.tool;
    const usesMapGeoman = this.isMapOverlay()
      && this.router
      && typeof this.router.usesGeoman === 'function'
      && this.router.usesGeoman(tool);
    const isDrawingTool = this.router && typeof this.router.isDrawingTool === 'function'
      ? this.router.isDrawingTool(tool) && !usesMapGeoman
      : false;
    
    // For panels that forward events (all except 'image'), if the pan tool
    // is active AND we're not in a drawing tool mode, we want to be able to 
    // interact with the underlying canvas, so we disable pointer events on the overlay.
    // However, if enabled is true (panel is active) OR we're using a drawing tool, keep events enabled
    if (tool === 'pan' && this.key !== 'image' && !enabled && !isDrawingTool) {
      this.overlay.style.pointerEvents = 'none';
      return;
    }

    // If we're using a canvas drawing tool, always enable pointer events regardless of enabled flag
    if (isDrawingTool) {
      this.overlay.style.pointerEvents = 'auto';
      return;
    }

    this.overlay.style.pointerEvents = this.pointerEnabled ? 'auto' : 'none';
  }

  resize() {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    this.stage.size({ width, height });
    
    // Restore viewport transform after resize (important for image panel)
    if (this.viewportTransform && (this.viewportTransform.scaleX !== 1 || this.viewportTransform.translateX !== 0 || this.viewportTransform.translateY !== 0)) {
      this.stage.scale({ x: this.viewportTransform.scaleX, y: this.viewportTransform.scaleY });
      this.stage.position({ x: this.viewportTransform.translateX, y: this.viewportTransform.translateY });
    }
    
    this.stage.draw();
  }

  clear() {
    [...this.shapes].forEach(shape => {
      this.cleanupArrowLabel(shape, true);
      if (window.drawingLayerRegistry && typeof window.drawingLayerRegistry.unregisterKonvaShape === 'function') {
        window.drawingLayerRegistry.unregisterKonvaShape(shape, this.key);
      }
      shape.destroy();
    });
    this.shapes.clear();
    this.angleMarkers.forEach(marker => {
      if (marker.arc) marker.arc.destroy();
      if (marker.label) marker.label.destroy();
    });
    this.angleMarkers.clear();
    this.transformer.nodes([]);
    this.pendingPolygon = null;
    this.drawingShape = null;
    this.layer.draw();
  }

  registerShape(shape) {
    shape.setAttrs({
      draggable: true,
      name: 'drawing-shape'
    });

    shape.on('dragstart transformstart', () => {
      shape._initialState = this.serializeShape(shape);
    });

    shape.on('dragend transformend', () => {
      if (!shape._initialState) return;
      if (this.shouldTrackGeo()) {
        this.captureGeoReference(shape);
      }
      if (this.isImagePanel()) {
        this.captureImageLayerReference(shape);
      }
      const before = shape._initialState;
      const after = this.serializeShape(shape);
      shape._initialState = null;
      if (before && after && JSON.stringify(before) !== JSON.stringify(after)) {
        this.router.recordUpdate(this.key, shape, before, after);
      }
    });

    shape.on('click tap', (evt) => {
      const pendingSunAssignment = this.router && typeof this.router.hasPendingSunAssignment === 'function'
        ? this.router.hasPendingSunAssignment()
        : false;
      if (!pendingSunAssignment && this.router.state.tool !== 'pan') return;
      evt.cancelBubble = true;
      this.transformer.nodes([shape]);
      this.activeShape = shape;
      this.layer.batchDraw();
      if (this.router && typeof this.router.handleShapeSelection === 'function') {
        this.router.handleShapeSelection(this.key, shape);
      }
    });

    if (shape.getAttr('shapeType') === 'arrow') {
      const update = () => {
        this.updateArrowMeasurement(shape);
        this.updateArrowIntersections(shape);
      };
      shape.on('dragmove transform', update);
      shape.on('pointsChange strokeChange strokeWidthChange', update);
      shape.on('destroy', () => {
        this.cleanupArrowLabel(shape, true);
        this.removeAngleMarkersForShape(shape, true);
      });
    }

    shape.on('destroy', () => {
      if (window.drawingLayerRegistry && typeof window.drawingLayerRegistry.unregisterKonvaShape === 'function') {
        window.drawingLayerRegistry.unregisterKonvaShape(shape, this.key);
      }
      if (this.router && typeof this.router.handleShapeDestroyed === 'function') {
        this.router.handleShapeDestroyed(shape);
      }
    });

    this.shapes.add(shape);
  }

  addShape(shape) {
    this.registerShape(shape);
    this.layer.add(shape);
    if (window.drawingLayerRegistry && typeof window.drawingLayerRegistry.registerKonvaShape === 'function') {
      window.drawingLayerRegistry.registerKonvaShape(shape, this.key);
    }
    if (this.shouldTrackGeo()) {
      this.restoreGeoReference(shape);
      if (shape !== this.drawingShape) {
        this.captureGeoReference(shape);
      }
    }
    if (shape.getAttr('shapeType') === 'arrow') {
      const label = this.ensureArrowLabel(shape);
      if (label) {
        label.moveToTop();
        this.updateArrowMeasurement(shape);
      }
      this.updateArrowIntersections(shape);
    }
    this.layer.draw();
  }

  removeShape(shape) {
    this.shapes.delete(shape);
    if (this.transformer.nodes().includes(shape)) {
      this.transformer.nodes([]);
    }
    this.cleanupArrowLabel(shape);
    this.removeAngleMarkersForShape(shape, true);
    if (window.drawingLayerRegistry && typeof window.drawingLayerRegistry.unregisterKonvaShape === 'function') {
      window.drawingLayerRegistry.unregisterKonvaShape(shape, this.key);
    }
    shape.remove();
    this.layer.draw();
  }

  serializeShape(shape) {
    const type = shape.getAttr('shapeType');
    const common = {
      type,
      stroke: shape.stroke(),
      strokeWidth: shape.strokeWidth(),
      dash: shape.dash(),
      fill: shape.fill(),
      rotation: shape.rotation(),
      scaleX: shape.scaleX(),
      scaleY: shape.scaleY(),
      skewX: shape.skewX(),
      skewY: shape.skewY(),
      offsetX: shape.offsetX(),
      offsetY: shape.offsetY()
    };
    let result;

    switch (type) {
      case 'rect':
        result = { ...common, x: shape.x(), y: shape.y(), width: shape.width(), height: shape.height() };
        break;
      case 'ellipse':
        result = { ...common, x: shape.x(), y: shape.y(), radiusX: shape.radiusX(), radiusY: shape.radiusY() };
        break;
      case 'circle':
        result = { ...common, x: shape.x(), y: shape.y(), radius: shape.radius() };
        break;
      case 'line':
      case 'arrow':
      case 'polygon':
      case 'freehand':
        result = { ...common, points: [...shape.points()] };
        break;
      case 'text':
        result = { ...common, x: shape.x(), y: shape.y(), text: shape.text(), fontSize: shape.fontSize() };
        break;
      default:
        result = null;
    }

    if (!result) return null;

    if (this.shouldTrackGeo()) {
      result = {
        ...result,
        geoGeometry: shape.getAttr('geoGeometry') || null,
        geoPoints: shape.getAttr('geoPoints') || null,
        geoPoint: shape.getAttr('geoPoint') || null
      };
    }

    if (this.isImagePanel()) {
      result = {
        ...result,
        anchorLayerId: shape.getAttr('anchorLayerId') || null,
        anchorLocalGeometry: shape.getAttr('anchorLocalGeometry') || null
      };
    }

    return result;
  }

  applyShapeState(shape, state) {
    if (!state) return;
    shape.stroke(state.stroke);
    shape.strokeWidth(state.strokeWidth);
    shape.dash(state.dash || []);
    shape.fill(state.fill || 'rgba(0,0,0,0)');
    shape.rotation(state.rotation || 0);
    shape.scaleX(state.scaleX == null ? 1 : state.scaleX);
    shape.scaleY(state.scaleY == null ? 1 : state.scaleY);
    shape.skewX(state.skewX || 0);
    shape.skewY(state.skewY || 0);
    shape.offsetX(state.offsetX || 0);
    shape.offsetY(state.offsetY || 0);
    switch (state.type) {
      case 'rect':
        shape.position({ x: state.x, y: state.y });
        shape.width(state.width);
        shape.height(state.height);
        break;
      case 'ellipse':
        shape.position({ x: state.x, y: state.y });
        shape.radiusX(state.radiusX);
        shape.radiusY(state.radiusY);
        break;
      case 'circle':
        shape.position({ x: state.x, y: state.y });
        shape.radius(state.radius);
        break;
      case 'line':
      case 'arrow':
      case 'polygon':
      case 'freehand':
        shape.points(state.points);
        if (state.type === 'arrow') {
          this.ensureArrowLabel(shape);
          this.updateArrowMeasurement(shape);
        }
        break;
      case 'text':
        shape.position({ x: state.x, y: state.y });
        shape.text(state.text);
        shape.fontSize(state.fontSize);
        break;
      default:
        break;
    }
    if (this.shouldTrackGeo()) {
      if (state.geoPoints) {
        shape.setAttr('geoPoints', state.geoPoints);
      }
      if (state.geoPoint) {
        shape.setAttr('geoPoint', state.geoPoint);
      }
      if (state.geoGeometry) {
        shape.setAttr('geoGeometry', state.geoGeometry);
      }
      this.restoreGeoReference(shape);
      this.captureGeoReference(shape);
    }
    if (this.isImagePanel()) {
      shape.setAttr('anchorLayerId', state.anchorLayerId || null);
      shape.setAttr('anchorLocalGeometry', state.anchorLocalGeometry || null);
      this.restoreImageLayerReference(shape);
      this.captureImageLayerReference(shape);
    }
    this.layer.batchDraw();
  }

  getPointerPosition(evt) {
    const stage = evt && typeof evt.target?.getStage === 'function'
      ? evt.target.getStage()
      : this.stage;
    if (!stage) return null;

    const pointer = stage.getPointerPosition();
    if (!pointer) return null;

    const transform = this.viewportTransform || {};
    const scaleX = transform.scaleX || 1;
    const scaleY = transform.scaleY || 1;
    const translateX = transform.translateX || 0;
    const translateY = transform.translateY || 0;

    return {
      x: (pointer.x - translateX) / scaleX,
      y: (pointer.y - translateY) / scaleY
    };
  }

  styleAttributes() {
    const state = this.router.state;
    const fillOpacity = state.filled ? state.fillOpacity : 0;
    return {
      stroke: state.color,
      strokeWidth: state.lineWidth,
      dash: state.dashed ? [12, 6] : [],
      fill: fillOpacity > 0 ? hexToRgba(state.color, fillOpacity) : 'rgba(0,0,0,0)'
    };
  }

  createShape(tool, startPos) {
    const style = this.styleAttributes();
    switch (tool) {
      case 'rect':
        return new Konva.Rect({
          ...style,
          x: startPos.x,
          y: startPos.y,
          width: 0,
          height: 0,
          shapeType: 'rect'
        });
      case 'ellipse':
        return new Konva.Ellipse({
          ...style,
          x: startPos.x,
          y: startPos.y,
          radiusX: 0,
          radiusY: 0,
          shapeType: 'ellipse'
        });
      case 'circle':
        return new Konva.Circle({
          ...style,
          x: startPos.x,
          y: startPos.y,
          radius: 0,
          shapeType: 'circle'
        });
      case 'line':
        return new Konva.Line({
          ...style,
          points: [startPos.x, startPos.y, startPos.x, startPos.y],
          shapeType: 'line'
        });
      case 'arrow':
        return new Konva.Arrow({
          ...style,
          pointerLength: 14,
          pointerWidth: 14,
          points: [startPos.x, startPos.y, startPos.x, startPos.y],
          shapeType: 'arrow'
        });
      case 'freehand':
        return new Konva.Line({
          ...style,
          points: [startPos.x, startPos.y],
          lineCap: 'round',
          lineJoin: 'round',
          tension: 0,
          shapeType: 'freehand'
        });
      default:
        return null;
    }
  }

  onPointerDown(evt) {
    const tool = this.router.state.tool;

    if (tool === 'pan') {
      if (evt.target === this.stage) {
        this.startForwarding(evt, tool);
      }
      return;
    }

    if (tool === 'note') {
      const pos = this.getPointerPosition(evt);
      if (pos && typeof createStickyNote === 'function') {
        createStickyNote(pos.x, pos.y, this.container, this.key);
      }
      return;
    }

    const hasPendingSunAssignment = this.router && typeof this.router.hasPendingSunAssignment === 'function'
      ? this.router.hasPendingSunAssignment()
      : false;

    if (hasPendingSunAssignment && evt.target !== this.stage) {
      evt.cancelBubble = true;
      return;
    }

    const pos = this.getPointerPosition(evt);
    if (!pos) return;

    if (this.router.state.tool === 'polygon') {
      evt.cancelBubble = true;
      this.startPolygon(pos);
      return;
    }

    if (this.router.state.tool === 'freehand') {
      evt.cancelBubble = true;
      this.startFreehand(pos);
      return;
    }

    this.transformer.nodes([]);
    const shape = this.createShape(this.router.state.tool, pos);
    if (!shape) return;

    this.drawingShape = shape;
    this.addShape(shape);
    // Attach guards to ensure we capture mouseup even if it happens outside the canvas
    this.attachDrawingGuards();
    evt.cancelBubble = true;
  }

  onPointerMove(evt) {
    if (this.forwarding) {
      this.forwardPointerEvent(evt, 'mousemove');
      return;
    }

    if (!this.drawingShape) {
      if (this.pendingPolygon && this.pendingPolygon.line) {
        const pos = this.getPointerPosition(evt);
        if (!pos) return;
        const points = [...this.pendingPolygon.points, pos.x, pos.y];
        this.pendingPolygon.line.points(points);
        this.layer.batchDraw();
      }
      return;
    }

    const pos = this.getPointerPosition(evt);
    if (!pos) return;

    const tool = this.router.state.tool;
    if (tool === 'rect') {
      this.updateRect(pos);
    } else if (tool === 'ellipse') {
      this.updateEllipse(pos);
    } else if (tool === 'circle') {
      this.updateCircle(pos);
    } else if (tool === 'line' || tool === 'arrow') {
      this.updateLine(pos);
    } else if (tool === 'freehand') {
      const line = this.drawingShape;
      const points = line.points();
      const lastX = points[points.length - 2];
      const lastY = points[points.length - 1];
      if (points.length >= 10000 || Math.hypot(pos.x - lastX, pos.y - lastY) < 1.5) return;
      const newPoints = [...points, pos.x, pos.y];
      line.points(newPoints);
    }
    this.layer.batchDraw();
  }

  onPointerUp(evt) {
    if (this.forwarding) {
      this.stopForwarding(evt);
      return;
    }

    if (!this.drawingShape) return;

    const shape = this.drawingShape;
    this.drawingShape = null;
    this.detachDrawingGuards();
    evt.cancelBubble = true;

    // Remove zero-sized shapes
    const state = this.serializeShape(shape);
    if (!state) {
      this.removeShape(shape);
      return;
    }

    const isDegenerate = () => {
      if (state.type === 'rect') {
        return Math.abs(state.width) < 3 || Math.abs(state.height) < 3;
      }
      if (state.type === 'ellipse') {
        return Math.abs(state.radiusX) < 3 || Math.abs(state.radiusY) < 3;
      }
      if (state.type === 'circle') {
        return Math.abs(state.radius) < 3;
      }
      if (state.type === 'line' || state.type === 'arrow') {
        const pts = state.points;
        if (!pts || pts.length < 4) return true;
        const dx = pts[2] - pts[0];
        const dy = pts[3] - pts[1];
        return Math.sqrt(dx * dx + dy * dy) < 3;
      }
      if (state.type === 'freehand') {
        const pts = state.points;
        if (!pts || pts.length < 4) return true;
        
        // For freehand, check the bounding box of ALL points, not just first two
        let minX = pts[0], maxX = pts[0];
        let minY = pts[1], maxY = pts[1];
        
        for (let i = 0; i < pts.length; i += 2) {
          minX = Math.min(minX, pts[i]);
          maxX = Math.max(maxX, pts[i]);
          minY = Math.min(minY, pts[i + 1]);
          maxY = Math.max(maxY, pts[i + 1]);
        }
        
        const width = maxX - minX;
        const height = maxY - minY;
        
        // Consider degenerate if bounding box is too small
        return width < 3 && height < 3;
      }
      return false;
    };

    if (isDegenerate()) {
      this.removeShape(shape);
      return;
    }

    if (this.shouldTrackGeo()) {
      this.captureGeoReference(shape);
    }
    if (this.isImagePanel()) {
      this.captureImageLayerReference(shape);
    }
    this.router.recordAdd(this.key, shape);
  }

  onClick(evt) {
    if (this.router.state.tool !== 'pan') return;
    if (evt.target === this.stage) {
      this.transformer.nodes([]);
      this.layer.draw();
      this.forwardPointerEvent(evt, 'click');
    }
  }

  onDoubleClick(evt) {
    if (this.router.state.tool === 'polygon') {
      evt.cancelBubble = true;
      this.finishPolygon();
      return;
    }

    if (this.router.state.tool === 'pan' && evt.target === this.stage) {
      this.forwardPointerEvent(evt, 'dblclick');
    }
  }

  startForwarding(evt, tool) {
    if (!this.forwardTarget) return;
    if (this.forwarding) return;
    this.forwarding = true;
    this.overlay.style.pointerEvents = 'none';
    const source = evt && (evt.evt || evt);
    this.forwardingPointerId = (source && typeof source.pointerId === 'number')
      ? source.pointerId
      : null;
    this.forwardPointerEvent(evt, 'mousedown');
    this.attachForwardingGuards();
  }

  stopForwarding(evt, fallbackType = 'mouseup') {
    // M1: explicit re-entrancy guard. The synthetic event dispatched below can
    // synchronously trigger the window-capture listeners (finalize/cancel) which
    // would otherwise re-enter stopForwarding. The ordering below already prevents
    // the known path; this guard additionally covers pointercancel arriving
    // mid-dispatch.
    if (this._stoppingForward) return;
    if (!this.forwarding) {
      this.detachForwardingGuards();
      return;
    }
    this._stoppingForward = true;

    // Tear down state and detach window listeners BEFORE dispatching the
    // synthetic event. forwardPointerEvent calls dispatchEvent synchronously,
    // and the window capture listeners (finalize/cancel) fire during that
    // dispatch — before dispatchEvent ever returns. If the guards are still
    // attached at that point, finalize re-enters stopForwarding, which
    // re-dispatches, producing infinite recursion (stack overflow).
    this.forwarding = false;
    this.forwardingPointerId = null;
    this.detachForwardingGuards();

    try {
      this.forwardPointerEvent(evt, fallbackType);
    } finally {
      // Restore pointer-event passthrough after the synthetic event is sent.
      this.setPointerEnabled(this.pointerEnabled);
      this._stoppingForward = false;
    }
  }

  cancelForwarding() {
    if (!this.forwarding) {
      this.detachForwardingGuards();
      return;
    }

    this.forwarding = false;
    this.forwardingPointerId = null;
    // Restore pointer events, but respect active drawing state
    this.setPointerEnabled(this.pointerEnabled);
    this.detachForwardingGuards();
  }

  clearSelection() {
    this.transformer.nodes([]);
    this.activeShape = null;
    this.layer.batchDraw();
  }

  getActiveShape() {
    if (this.activeShape && !isShapeDestroyed(this.activeShape)) {
      return this.activeShape;
    }

    if (this.transformer && typeof this.transformer.nodes === 'function') {
      const nodes = this.transformer.nodes();
      if (Array.isArray(nodes)) {
        for (const node of nodes) {
          if (node && !isShapeDestroyed(node)) {
            this.activeShape = node;
            return node;
          }
        }
      }
    }

    return null;
  }

  applyViewportTransform(transform = {}) {
    if (!this.stage) return;

    const next = {
      scaleX: typeof transform.scaleX === 'number' ? transform.scaleX : (typeof transform.scale === 'number' ? transform.scale : this.viewportTransform.scaleX),
      scaleY: typeof transform.scaleY === 'number' ? transform.scaleY : (typeof transform.scale === 'number' ? transform.scale : this.viewportTransform.scaleY),
      translateX: typeof transform.translateX === 'number' ? transform.translateX : (typeof transform.x === 'number' ? transform.x : this.viewportTransform.translateX),
      translateY: typeof transform.translateY === 'number' ? transform.translateY : (typeof transform.y === 'number' ? transform.y : this.viewportTransform.translateY)
    };

    const changed =
      next.scaleX !== this.viewportTransform.scaleX ||
      next.scaleY !== this.viewportTransform.scaleY ||
      next.translateX !== this.viewportTransform.translateX ||
      next.translateY !== this.viewportTransform.translateY;

    if (!changed) return;

    this.viewportTransform = next;

    this.stage.scale({ x: next.scaleX, y: next.scaleY });
    this.stage.position({ x: next.translateX, y: next.translateY });
    this.stage.batchDraw();
  }

  forwardPointerEvent(evt, fallbackType) {
    if (!this.forwardTarget) return;

    let source = evt ? (evt.evt || evt) : null;
    let type = (source && source.type) || fallbackType;
    if (!type) return;

    if (!source) {
      source = this.createFallbackPointerSource(type);
    }

    const isEndEvent = typeof type === 'string' && /up$|cancel$|click$/.test(type);
    const baseInit = {
      bubbles: true,
      cancelable: true,
      clientX: source.clientX ?? 0,
      clientY: source.clientY ?? 0,
      screenX: source.screenX ?? 0,
      screenY: source.screenY ?? 0,
      button: source.button ?? 0,
      buttons: source.buttons ?? (isEndEvent ? 0 : 1),
      altKey: source.altKey ?? false,
      ctrlKey: source.ctrlKey ?? false,
      metaKey: source.metaKey ?? false,
      shiftKey: source.shiftKey ?? false
    };

    if (typeof TouchEvent !== 'undefined' && source instanceof TouchEvent) {
      const touch = source.touches[0] || source.changedTouches[0];
      if (touch) {
        baseInit.clientX = touch.clientX;
        baseInit.clientY = touch.clientY;
        baseInit.screenX = touch.screenX;
        baseInit.screenY = touch.screenY;
        baseInit.button = 0;
        baseInit.buttons = source.type === 'touchend' || source.type === 'touchcancel' ? 0 : 1;
      }

      if (typeof PointerEvent !== 'undefined') {
        const touchToPointer = {
          touchstart: 'pointerdown',
          touchmove: 'pointermove',
          touchend: 'pointerup',
          touchcancel: 'pointercancel'
        };
        const pointerType = touchToPointer[type] || type;
        const pointerEvent = new PointerEvent(pointerType, {
          ...baseInit,
          pointerId: touch?.identifier ?? 0,
          width: touch?.radiusX ?? 1,
          height: touch?.radiusY ?? 1,
          pressure: source.type === 'touchend' || source.type === 'touchcancel' ? 0 : 0.5,
          pointerType: 'touch',
          isPrimary: true
        });
        this.forwardTarget.dispatchEvent(pointerEvent);
        return;
      }

      type = fallbackType || 'mousedown';
    }

    if (typeof type === 'string' && type.startsWith('pointer')) {
      if (typeof PointerEvent !== 'undefined') {
        const pointerEvent = new PointerEvent(type, {
          ...baseInit,
          pointerId: source.pointerId ?? 0,
          width: source.width ?? 1,
          height: source.height ?? 1,
          pressure: source.pressure ?? (type === 'pointerup' || type === 'pointercancel' ? 0 : 0.5),
          tangentialPressure: source.tangentialPressure ?? 0,
          tiltX: source.tiltX ?? 0,
          tiltY: source.tiltY ?? 0,
          twist: source.twist ?? 0,
          pointerType: source.pointerType || 'mouse',
          isPrimary: source.isPrimary ?? true
        });
        this.forwardTarget.dispatchEvent(pointerEvent);
        return;
      }

      type = type === 'pointercancel'
        ? 'mouseup'
        : type.replace('pointer', 'mouse');
    }

    let mouseType = typeof type === 'string' ? type : 'mousedown';
    if (mouseType.startsWith('touch')) {
      const touchToMouse = {
        touchstart: 'mousedown',
        touchmove: 'mousemove',
        touchend: 'mouseup',
        touchcancel: 'mouseup'
      };
      mouseType = touchToMouse[mouseType] || 'mousedown';
    }

    const mouseEvent = new MouseEvent(mouseType, baseInit);
    this.forwardTarget.dispatchEvent(mouseEvent);
  }

  handleWheel(event) {
    if (!this.forwardTarget) return;
    if (!this.router || !this.router.state || this.router.state.tool !== 'pan') return;
    if (event.defaultPrevented) return;

    const wheelInit = {
      bubbles: true,
      cancelable: true,
      clientX: event.clientX ?? 0,
      clientY: event.clientY ?? 0,
      screenX: event.screenX ?? 0,
      screenY: event.screenY ?? 0,
      deltaX: event.deltaX ?? 0,
      deltaY: event.deltaY ?? 0,
      deltaZ: event.deltaZ ?? 0,
      deltaMode: event.deltaMode ?? 0,
      ctrlKey: event.ctrlKey ?? false,
      altKey: event.altKey ?? false,
      shiftKey: event.shiftKey ?? false,
      metaKey: event.metaKey ?? false
    };

    let forwarded;
    if (typeof WheelEvent === 'function') {
      forwarded = new WheelEvent('wheel', wheelInit);
    } else {
      forwarded = new CustomEvent('wheel', { bubbles: true, cancelable: true });
      Object.assign(forwarded, wheelInit);
    }

    this.forwardTarget.dispatchEvent(forwarded);
    if (typeof event.preventDefault === 'function') {
      event.preventDefault();
    }
  }

  createFallbackPointerSource(type) {
    const normalized = typeof type === 'string' ? type : 'pointerdown';
    const isPointer = normalized.startsWith('pointer');
    const isEnd = /up$|cancel$|click$/.test(normalized);
    return {
      type: normalized,
      clientX: 0,
      clientY: 0,
      screenX: 0,
      screenY: 0,
      button: 0,
      buttons: isEnd ? 0 : 1,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      pointerId: 0,
      width: 1,
      height: 1,
      pressure: isEnd ? 0 : 0.5,
      tangentialPressure: 0,
      tiltX: 0,
      tiltY: 0,
      twist: 0,
      pointerType: isPointer ? 'mouse' : undefined,
      isPrimary: true
    };
  }

  attachForwardingGuards() {
    if (this.forwardingGuards) return;

    const matchesPointer = (event) => {
      if (!event || this.forwardingPointerId == null) {
        return true;
      }
      if (typeof event.pointerId === 'number') {
        return event.pointerId === this.forwardingPointerId;
      }
      return true;
    };

    const finalize = (event) => {
      if (!matchesPointer(event)) return;
      const fallback = event && event.type ? event.type : 'pointerup';
      this.stopForwarding(event, fallback);
    };

    const cancel = (event) => {
      if (!matchesPointer(event)) return;
      const fallback = event && event.type ? event.type : 'pointercancel';
      this.stopForwarding(event, fallback);
    };

    const handleBlur = () => {
      if (!this.forwarding) return;
      this.stopForwarding(null, 'pointercancel');
    };

    const handleVisibility = () => {
      if (document.visibilityState !== 'visible' && this.forwarding) {
        this.stopForwarding(null, 'pointercancel');
      }
    };

    window.addEventListener('pointerup', finalize, true);
    window.addEventListener('pointercancel', cancel, true);
    window.addEventListener('mouseup', finalize, true);
    window.addEventListener('touchend', finalize, true);
    window.addEventListener('touchcancel', cancel, true);
    window.addEventListener('blur', handleBlur);
    document.addEventListener('visibilitychange', handleVisibility);

    this.forwardingGuards = {
      finalize,
      cancel,
      handleBlur,
      handleVisibility
    };
  }

  detachForwardingGuards() {
    if (!this.forwardingGuards) return;
    const { finalize, cancel, handleBlur, handleVisibility } = this.forwardingGuards;
    window.removeEventListener('pointerup', finalize, true);
    window.removeEventListener('pointercancel', cancel, true);
    window.removeEventListener('mouseup', finalize, true);
    window.removeEventListener('touchend', finalize, true);
    window.removeEventListener('touchcancel', cancel, true);
    window.removeEventListener('blur', handleBlur);
    document.removeEventListener('visibilitychange', handleVisibility);
    this.forwardingGuards = null;
    if (!this.forwarding) {
      this.forwardingPointerId = null;
    }
  }

  attachDrawingGuards() {
    if (this.drawingGuards) return;

    const finishDrawing = (event) => {
      if (!this.drawingShape) return;
      // Synthesize a mouseup event on the stage
      this.stage.fire('mouseup', {
        type: 'mouseup',
        target: this.stage,
        evt: event
      });
    };

    const cancelDrawing = (event) => {
      if (!this.drawingShape) return;
      // Cancel the drawing by removing the shape
      const shape = this.drawingShape;
      this.drawingShape = null;
      this.removeShape(shape);
      this.detachDrawingGuards();
    };

    const handleBlur = () => {
      if (!this.drawingShape) return;
      cancelDrawing(null);
    };

    const handleVisibility = () => {
      if (document.visibilityState !== 'visible' && this.drawingShape) {
        cancelDrawing(null);
      }
    };

    // Attach window-level listeners to capture mouseup even if it happens outside the canvas
    window.addEventListener('mouseup', finishDrawing, true);
    window.addEventListener('touchend', finishDrawing, true);
    window.addEventListener('pointerup', finishDrawing, true);
    window.addEventListener('blur', handleBlur);
    document.addEventListener('visibilitychange', handleVisibility);

    this.drawingGuards = {
      finishDrawing,
      cancelDrawing,
      handleBlur,
      handleVisibility
    };
  }

  detachDrawingGuards() {
    if (!this.drawingGuards) return;
    const { finishDrawing, cancelDrawing, handleBlur, handleVisibility } = this.drawingGuards;
    
    if (finishDrawing) {
      window.removeEventListener('mouseup', finishDrawing, true);
      window.removeEventListener('touchend', finishDrawing, true);
      window.removeEventListener('pointerup', finishDrawing, true);
    }
    if (handleBlur) {
      window.removeEventListener('blur', handleBlur);
    }
    if (handleVisibility) {
      document.removeEventListener('visibilitychange', handleVisibility);
    }
    
    this.drawingGuards = null;
  }

  cancelInProgressDrawing() {
    this.detachDrawingGuards();

    if (this.pendingPolygon && this.pendingPolygon.line) {
      this.removeShape(this.pendingPolygon.line);
    }
    this.pendingPolygon = null;

    if (this.drawingShape) {
      this.removeShape(this.drawingShape);
      this.drawingShape = null;
    }
  }

  startPolygon(pos) {
    if (!this.pendingPolygon) {
      // Clear any active selection before starting polygon drawing
      this.transformer.nodes([]);
      const style = this.styleAttributes();
      const line = new Konva.Line({
        ...style,
        points: [pos.x, pos.y],
        closed: false,
        shapeType: 'polygon'
      });
      this.pendingPolygon = {
        line,
        points: [pos.x, pos.y]
      };
      this.addShape(line);
    } else {
      const points = this.pendingPolygon.points;
      points.push(pos.x, pos.y);
      this.pendingPolygon.line.points(points);
      this.layer.batchDraw();
    }
  }

  finishPolygon() {
    if (!this.pendingPolygon || this.pendingPolygon.points.length < 6) {
      if (this.pendingPolygon && this.pendingPolygon.line) {
        this.removeShape(this.pendingPolygon.line);
      }
      this.pendingPolygon = null;
      return;
    }

    const line = this.pendingPolygon.line;
    line.closed(true);
    line.points([...this.pendingPolygon.points]);
    this.pendingPolygon = null;
    this.layer.batchDraw();
    if (this.shouldTrackGeo()) {
      this.captureGeoReference(line);
    }
    if (this.isImagePanel()) {
      this.captureImageLayerReference(line);
    }
    this.router.recordAdd(this.key, line);
  }

  startFreehand(pos) {
    // Clear any active selection before starting freehand drawing
    this.transformer.nodes([]);
    const line = this.createShape('freehand', pos);
    if (!line) return;
    this.drawingShape = line;
    this.addShape(line);
    // Attach guards to ensure we capture mouseup even if it happens outside the canvas
    this.attachDrawingGuards();
  }

  updateRect(pos) {
    const rect = this.drawingShape;
    const startX = rect.x();
    const startY = rect.y();
    rect.width(pos.x - startX);
    rect.height(pos.y - startY);
  }

  updateEllipse(pos) {
    const ellipse = this.drawingShape;
    const startX = ellipse.x();
    const startY = ellipse.y();
    ellipse.radiusX(Math.abs(pos.x - startX));
    ellipse.radiusY(Math.abs(pos.y - startY));
    ellipse.position({
      x: Math.min(startX, pos.x),
      y: Math.min(startY, pos.y)
    });
  }

  updateCircle(pos) {
    const circle = this.drawingShape;
    const startX = circle.x();
    const startY = circle.y();
    const radius = Math.sqrt(Math.pow(pos.x - startX, 2) + Math.pow(pos.y - startY, 2));
    circle.radius(radius);
  }

  updateLine(pos) {
    const line = this.drawingShape;
    const points = line.points();
    let endX = pos.x;
    let endY = pos.y;
    if (this.router && typeof this.router.isShiftPressed === 'function' && this.router.isShiftPressed()) {
      const startX = points[0];
      const startY = points[1];
      const dx = pos.x - startX;
      const dy = pos.y - startY;
      const length = Math.hypot(dx, dy);
      if (length > 0) {
        const angleDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
        const snappedDeg = Math.round(angleDeg / 45) * 45; // snap to 45° increments
        const snappedRad = (snappedDeg * Math.PI) / 180;
        endX = startX + Math.cos(snappedRad) * length;
        endY = startY + Math.sin(snappedRad) * length;
      } else {
        endX = startX;
        endY = startY;
      }
    }
    points[2] = endX;
    points[3] = endY;
    line.points(points);
    if (line.getAttr('shapeType') === 'arrow') {
      this.ensureArrowLabel(line);
      this.updateArrowMeasurement(line);
      this.updateArrowIntersections(line);
    }
  }

  ensureArrowLabel(shape) {
    if (!shape || shape.getAttr('shapeType') !== 'arrow') return null;
    let label = shape._measurementLabel;
    if (label && typeof label.isDestroyed === 'function' && label.isDestroyed()) {
      label = null;
    }
    if (!label) {
      label = new Konva.Text({
        text: '',
        fontSize: 12,
        fontFamily: 'Inter, Arial, sans-serif',
        fill: shape.stroke() || '#FF4444',
        padding: 2,
        align: 'center',
        listening: false,
        name: 'arrow-measurement-label',
        visible: false
      });
      shape._measurementLabel = label;
    }
    label.fill(shape.stroke() || '#FF4444');
    if (label.getLayer() !== this.layer) {
      this.layer.add(label);
    }
    return label;
  }

  cleanupArrowLabel(shape, destroy = false) {
    if (!shape || shape.getAttr('shapeType') !== 'arrow') return;
    const label = shape._measurementLabel;
    if (!label) return;
    if (destroy) {
      label.destroy();
      shape._measurementLabel = null;
    } else {
      label.remove();
    }
  }

  removeAngleMarkersForShape(shape, destroy = false) {
    if (!shape || !this.angleMarkers.size) return;
    const targetId = shape._id;
    const keysToDelete = [];
    this.angleMarkers.forEach((marker, key) => {
      if (!marker || !key) return;
      const [idA, idB] = key.split('|').map(Number);
      if (idA !== targetId && idB !== targetId) return;
      if (destroy) {
        if (marker.arc) marker.arc.destroy();
        if (marker.label) marker.label.destroy();
        keysToDelete.push(key);
      } else {
        if (marker.arc) marker.arc.visible(false);
        if (marker.label) marker.label.visible(false);
      }
    });
    keysToDelete.forEach(key => this.angleMarkers.delete(key));
  }

  updateArrowIntersections(shape) {
    if (!shape || shape.getAttr('shapeType') !== 'arrow') return;
    const otherArrows = [...this.shapes].filter(other => other !== shape && other.getAttr('shapeType') === 'arrow');
    const processed = new Set();

    otherArrows.forEach(other => {
      const key = this.angleMarkerKey(shape, other);
      processed.add(key);
      const geometry = this.computeArrowIntersectionGeometry(shape, other);
      if (geometry) {
        this.renderAngleMarker(key, shape, other, geometry);
      } else {
        this.hideAngleMarker(key);
      }
    });

    this.angleMarkers.forEach((marker, key) => {
      if (processed.has(key)) return;
      const [idA, idB] = key.split('|').map(Number);
      if (idA === shape._id || idB === shape._id) {
        this.hideAngleMarker(key);
      }
    });

    this.layer.batchDraw();
  }

  angleMarkerKey(a, b) {
    const ids = [a._id, b._id].sort((x, y) => x - y);
    return ids.join('|');
  }

  computeArrowIntersectionGeometry(shapeA, shapeB) {
    const segA = this.getArrowSegment(shapeA);
    const segB = this.getArrowSegment(shapeB);
    if (!segA || !segB) return null;

    const intersection = this.findSegmentIntersection(segA, segB);
    if (!intersection) return null;

    const dirA = this.directionFromIntersection(segA, intersection);
    const dirB = this.directionFromIntersection(segB, intersection);
    if (!dirA || !dirB) return null;

    const dot = dirA.x * dirB.x + dirA.y * dirB.y;
    const angleRad = Math.acos(Math.max(-1, Math.min(1, dot)));
    const angleDeg = angleRad * (180 / Math.PI);
    if (!Number.isFinite(angleDeg) || angleDeg < 0.5) {
      return null;
    }

    const angle1 = this.vectorAngle(dirA);
    const angle2 = this.vectorAngle(dirB);
    let delta = angle2 - angle1;
    delta = ((delta % 360) + 360) % 360;
    let sweep;
    let rotation;
    if (delta <= 180) {
      sweep = delta;
      rotation = angle1;
    } else {
      sweep = 360 - delta;
      rotation = angle2;
    }
    rotation = ((rotation % 360) + 360) % 360;
    const midAngle = rotation + sweep / 2;

    return {
      point: intersection,
      angle: angleDeg,
      rotation,
      sweep,
      midAngle
    };
  }

  getArrowSegment(shape) {
    if (!shape || shape.getAttr('shapeType') !== 'arrow') return null;
    const points = shape.points();
    if (!points || points.length < 4) return null;
    const transform = shape.getAbsoluteTransform().copy();
    const start = transform.point({ x: points[0], y: points[1] });
    const end = transform.point({ x: points[points.length - 2], y: points[points.length - 1] });
    return { start, end };
  }

  directionFromIntersection(segment, intersection) {
    if (!segment || !intersection) return null;
    const toEnd = { x: segment.end.x - intersection.x, y: segment.end.y - intersection.y };
    const toStart = { x: segment.start.x - intersection.x, y: segment.start.y - intersection.y };
    const vec = this.pickLongerVector(toEnd, toStart);
    const len = Math.hypot(vec.x, vec.y);
    if (!len) return null;
    return { x: vec.x / len, y: vec.y / len };
  }

  pickLongerVector(v1, v2) {
    const len1 = Math.hypot(v1.x, v1.y);
    const len2 = Math.hypot(v2.x, v2.y);
    return len1 >= len2 ? v1 : v2;
  }

  findSegmentIntersection(segA, segB) {
    const EPS = 1e-6;
    const { start: a1, end: a2 } = segA;
    const { start: b1, end: b2 } = segB;

    const shared = this.findSharedEndpoint(a1, a2, b1, b2, EPS);
    if (shared) return shared;

    const x1 = a1.x;
    const y1 = a1.y;
    const x2 = a2.x;
    const y2 = a2.y;
    const x3 = b1.x;
    const y3 = b1.y;
    const x4 = b2.x;
    const y4 = b2.y;

    const denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
    if (Math.abs(denom) < EPS) {
      return null;
    }

    const pre = x1 * y2 - y1 * x2;
    const post = x3 * y4 - y3 * x4;
    const x = (pre * (x3 - x4) - (x1 - x2) * post) / denom;
    const y = (pre * (y3 - y4) - (y1 - y2) * post) / denom;

    if (!this.pointOnSegment({ x, y }, a1, a2, EPS) || !this.pointOnSegment({ x, y }, b1, b2, EPS)) {
      return null;
    }

    return { x, y };
  }

  findSharedEndpoint(a1, a2, b1, b2, tolerance) {
    const pairs = [
      [a1, b1],
      [a1, b2],
      [a2, b1],
      [a2, b2]
    ];
    for (const [p, q] of pairs) {
      if (this.distance(p, q) <= tolerance) {
        return {
          x: (p.x + q.x) / 2,
          y: (p.y + q.y) / 2
        };
      }
    }
    return null;
  }

  pointOnSegment(point, segStart, segEnd, tolerance) {
    const minX = Math.min(segStart.x, segEnd.x) - tolerance;
    const maxX = Math.max(segStart.x, segEnd.x) + tolerance;
    const minY = Math.min(segStart.y, segEnd.y) - tolerance;
    const maxY = Math.max(segStart.y, segEnd.y) + tolerance;
    if (point.x < minX || point.x > maxX || point.y < minY || point.y > maxY) {
      return false;
    }
    const cross = (segEnd.x - segStart.x) * (point.y - segStart.y) - (segEnd.y - segStart.y) * (point.x - segStart.x);
    return Math.abs(cross) <= tolerance * Math.hypot(segEnd.x - segStart.x, segEnd.y - segStart.y);
  }

  distance(p, q) {
    return Math.hypot(p.x - q.x, p.y - q.y);
  }

  vectorAngle(vec) {
    return (Math.atan2(vec.y, vec.x) * 180) / Math.PI;
  }

  ensureAngleMarker(key, color) {
    let marker = this.angleMarkers.get(key);
    if (!marker) {
      const arc = new Konva.Arc({
        x: 0,
        y: 0,
        innerRadius: 16,
        outerRadius: 22,
        angle: 0,
        rotation: 0,
        stroke: color,
        strokeWidth: 2,
        listening: false,
        fill: 'rgba(0,0,0,0)',
        name: 'arrow-angle-arc'
      });
      const label = new Konva.Text({
        text: '',
        fontSize: 12,
        fontFamily: 'Inter, Arial, sans-serif',
        fill: color,
        align: 'center',
        listening: false,
        name: 'arrow-angle-label',
        visible: false
      });
      this.layer.add(arc);
      this.layer.add(label);
      marker = { arc, label };
      this.angleMarkers.set(key, marker);
    }
    return marker;
  }

  renderAngleMarker(key, shapeA, _shapeB, geometry) {
    const color = shapeA.stroke() || '#FF4444';
    const marker = this.ensureAngleMarker(key, color);
    const arc = marker.arc;
    const label = marker.label;
    if (!arc || !label) return;

    const toStagePoint = (point) => {
      if (!point || !this.stage || typeof this.stage.getAbsoluteTransform !== 'function') {
        return point;
      }
      const absolute = this.stage.getAbsoluteTransform();
      if (!absolute || typeof absolute.copy !== 'function') return point;
      const inverse = absolute.copy().invert();
      if (!inverse || typeof inverse.point !== 'function') return point;
      return inverse.point(point);
    };

    const stagePoint = toStagePoint(geometry.point);
    if (!stagePoint) return;

    arc.stroke(color);
    arc.position({ x: stagePoint.x, y: stagePoint.y });
    arc.rotation(geometry.rotation);
    arc.angle(geometry.sweep);
    arc.visible(true);

    const labelRadius = arc.outerRadius() + 12;
    const midRad = (geometry.midAngle * Math.PI) / 180;
    const text = this.formatAngleText(geometry.angle);
    const labelPos = {
      x: stagePoint.x + Math.cos(midRad) * labelRadius,
      y: stagePoint.y + Math.sin(midRad) * labelRadius
    };

    label.text(text);
    label.fill(color);
    label.position(labelPos);
    label.offset({ x: label.width() / 2, y: label.height() / 2 });
    label.visible(true);

    arc.moveToTop();
    label.moveToTop();
  }

  hideAngleMarker(key) {
    const marker = this.angleMarkers.get(key);
    if (!marker) return;
    if (marker.arc) marker.arc.visible(false);
    if (marker.label) marker.label.visible(false);
  }

  formatAngleText(angle) {
    if (!Number.isFinite(angle)) return '';
    const rounded = Math.round(angle * 10) / 10;
    return `${rounded % 1 === 0 ? Math.round(rounded) : rounded.toFixed(1)}°`;
  }

  updateArrowMeasurement(shape) {
    if (!shape || shape.getAttr('shapeType') !== 'arrow') return;
    const label = this.ensureArrowLabel(shape);
    if (!label) return;

    const points = shape.points();
    if (!points || points.length < 4) {
      label.visible(false);
      shape.setAttr('pixelLength', null);
      if (this.router && typeof this.router.handleArrowMeasurementUpdate === 'function') {
        this.router.handleArrowMeasurementUpdate(this.key, shape);
      }
      return;
    }

    const start = { x: points[0], y: points[1] };
    const end = { x: points[points.length - 2], y: points[points.length - 1] };
    const transform = shape.getAbsoluteTransform().copy();
    const startAbs = transform.point(start);
    const endAbs = transform.point(end);

    const dx = endAbs.x - startAbs.x;
    const dy = endAbs.y - startAbs.y;
    const length = Math.sqrt(dx * dx + dy * dy);

    if (!length || Number.isNaN(length)) {
      label.visible(false);
      shape.setAttr('pixelLength', null);
      if (this.router && typeof this.router.handleArrowMeasurementUpdate === 'function') {
        this.router.handleArrowMeasurementUpdate(this.key, shape);
      }
      return;
    }

    shape.setAttr('pixelLength', length);

    const text = Math.round(length).toString();
    label.text(text);
    label.fill(shape.stroke() || '#FF4444');
    label.visible(true);
    label.moveToTop();

    const midpoint = {
      x: (startAbs.x + endAbs.x) / 2,
      y: (startAbs.y + endAbs.y) / 2
    };

    let perpX = -dy;
    let perpY = dx;
    const perpLength = Math.sqrt(perpX * perpX + perpY * perpY);
    const offsetDistance = 12;
    if (perpLength > 0) {
      perpX = (perpX / perpLength) * offsetDistance;
      perpY = (perpY / perpLength) * offsetDistance;
    } else {
      perpX = 0;
      perpY = -offsetDistance;
    }

    const absolutePosition = {
      x: midpoint.x + perpX,
      y: midpoint.y + perpY
    };

    label.absolutePosition(absolutePosition);
    label.offset({ x: label.width() / 2, y: label.height() / 2 });

    let angle = Math.atan2(dy, dx) * (180 / Math.PI);
    if (angle > 90 || angle < -90) {
      angle += 180;
    }
    label.rotation(angle);

    const layer = label.getLayer();
    if (layer) {
      layer.batchDraw();
    }

    if (this.router && typeof this.router.handleArrowMeasurementUpdate === 'function') {
      this.router.handleArrowMeasurementUpdate(this.key, shape);
    }
  }

  getShapeGeometry(shape) {
    const type = shape.getAttr('shapeType');
    const transform = shape.getAbsoluteTransform().copy();
    const apply = (point) => transform.point(point);

    if (['line', 'arrow', 'polygon', 'freehand'].includes(type)) {
      const points = shape.points();
      const geometry = [];
      for (let i = 0; i < points.length; i += 2) {
        geometry.push(apply({ x: points[i], y: points[i + 1] }));
      }
      return geometry;
    }
    if (type === 'rect') {
      return [
        apply({ x: 0, y: 0 }),
        apply({ x: shape.width(), y: 0 }),
        apply({ x: 0, y: shape.height() })
      ];
    }
    if (type === 'ellipse' || type === 'circle') {
      const radiusX = type === 'circle' ? shape.radius() : shape.radiusX();
      const radiusY = type === 'circle' ? shape.radius() : shape.radiusY();
      return [
        apply({ x: 0, y: 0 }),
        apply({ x: radiusX, y: 0 }),
        apply({ x: 0, y: radiusY })
      ];
    }
    if (type === 'text') {
      return [
        apply({ x: 0, y: 0 }),
        apply({ x: 1, y: 0 }),
        apply({ x: 0, y: 1 })
      ];
    }
    return [];
  }

  resetShapeTransform(shape) {
    shape.position({ x: 0, y: 0 });
    shape.rotation(0);
    shape.scale({ x: 1, y: 1 });
    shape.skew({ x: 0, y: 0 });
    shape.offset({ x: 0, y: 0 });
  }

  applyShapeGeometry(shape, geometry) {
    if (!Array.isArray(geometry) || geometry.length === 0) return;
    const type = shape.getAttr('shapeType');
    if (['line', 'arrow', 'polygon', 'freehand'].includes(type)) {
      this.resetShapeTransform(shape);
      shape.points(geometry.flatMap((point) => [point.x, point.y]));
      if (type === 'arrow') {
        this.ensureArrowLabel(shape);
        this.updateArrowMeasurement(shape);
        this.updateArrowIntersections(shape);
      }
      return;
    }

    if (geometry.length < 3) return;
    const [origin, axisX, axisY] = geometry;
    const dx = axisX.x - origin.x;
    const dy = axisX.y - origin.y;
    const ydx = axisY.x - origin.x;
    const ydy = axisY.y - origin.y;
    const lengthX = Math.hypot(dx, dy);
    const lengthY = Math.hypot(ydx, ydy);
    const orientation = dx * ydy - dy * ydx < 0 ? -1 : 1;
    const rotation = Math.atan2(dy, dx) * 180 / Math.PI;

    this.resetShapeTransform(shape);
    shape.position(origin);
    shape.rotation(rotation);
    if (type === 'rect') {
      shape.width(lengthX);
      shape.height(lengthY);
      shape.scaleY(orientation);
    } else if (type === 'ellipse') {
      shape.radiusX(lengthX);
      shape.radiusY(lengthY);
      shape.scaleY(orientation);
    } else if (type === 'circle') {
      shape.radius(1);
      shape.scale({ x: lengthX, y: lengthY * orientation });
    } else if (type === 'text') {
      shape.scale({ x: lengthX, y: lengthY * orientation });
    }
  }

  captureGeoReference(shape) {
    if (!this.shouldTrackGeo() || !shape) return;
    const map = this.router.map;
    const geometry = this.getShapeGeometry(shape);
    if (!map || geometry.length === 0) return;
    const geoGeometry = geometry.map((point) => {
      const latLng = map.containerPointToLatLng(L.point(point.x, point.y));
      return [latLng.lat, latLng.lng];
    });
    shape.setAttr('geoGeometry', geoGeometry);
  }

  restoreGeoReference(shape) {
    if (!this.shouldTrackGeo() || !shape) return;
    const geoGeometry = shape.getAttr('geoGeometry');
    if (!Array.isArray(geoGeometry) || geoGeometry.length === 0) return;
    const geometry = geoGeometry.map(([lat, lng]) => this.router.map.latLngToContainerPoint([lat, lng]));
    this.applyShapeGeometry(shape, geometry);
  }

  syncWithMap() {
    if (!this.shouldTrackGeo()) return;
    const inProgress = new Set([this.drawingShape, this.pendingPolygon?.line].filter(Boolean));
    this.shapes.forEach(shape => {
      if (inProgress.has(shape)) return;
      this.restoreGeoReference(shape);
    });
    this.layer.batchDraw();
  }

  isImagePanel() {
    return this.key === 'image';
  }

  captureImageLayerReference(shape) {
    if (!this.isImagePanel() || !window.imageLayers || window.imageLayers.length === 0) return;
    const vt = this.viewportTransform || { scaleX: 1, scaleY: 1, translateX: 0, translateY: 0 };
    const geometry = this.getShapeGeometry(shape).map((point) => ({
      x: (point.x - vt.translateX) / vt.scaleX,
      y: (point.y - vt.translateY) / vt.scaleY
    }));
    if (geometry.length === 0) return;

    const anchorLayer = [...window.imageLayers].reverse().find((layer) => (
      layer.visible && worldToLayerCoords(geometry[0].x, geometry[0].y, layer)
    ));
    if (!anchorLayer) {
      shape.setAttr('anchorLayerId', null);
      shape.setAttr('anchorLocalGeometry', null);
      return;
    }

    const localGeometry = geometry.map((point) => {
      const local = worldToLayerCoords(point.x, point.y, anchorLayer, { allowOutside: true });
      return [local.x, local.y];
    });
    shape.setAttr('anchorLayerId', anchorLayer.id);
    shape.setAttr('anchorLocalGeometry', localGeometry);
  }

  restoreImageLayerReference(shape) {
    if (!this.isImagePanel() || !window.imageLayers) return;
    const layer = window.imageLayers.find((candidate) => candidate.id === shape.getAttr('anchorLayerId'));
    const localGeometry = shape.getAttr('anchorLocalGeometry');
    if (!layer || !Array.isArray(localGeometry) || localGeometry.length === 0) return;
    const geometry = localGeometry.map(([x, y]) => layerCoordsToWorld({ x, y }, layer));
    this.applyShapeGeometry(shape, geometry);
    shape.visible(layer.visible);
    if (shape.getAttr('shapeType') === 'arrow') {
      const label = this.ensureArrowLabel(shape);
      if (label) label.visible(layer.visible);
      if (layer.visible) {
        this.updateArrowIntersections(shape);
      } else {
        this.removeAngleMarkersForShape(shape, false);
      }
    }
  }

  syncWithImageLayer(layerId) {
    if (!this.isImagePanel()) return;
    this.shapes.forEach(shape => {
      if (shape.getAttr('anchorLayerId') === layerId) {
        this.restoreImageLayerReference(shape);
      }
    });
    this.layer.batchDraw();
  }
}

class KonvaManager {
  constructor(router) {
    this.router = router;
    this.panels = new Map();
    this.activePanel = null;
    this.pointerOverride = null;
    this.currentTool = router && router.state && router.state.tool ? router.state.tool : 'pan';
  }

  panelDefinitions() {
    return [
      { key: 'map-overlay', selector: '#mapOverlayHost', forwardSelector: '#map', zIndex: 900 },
      { key: 'image', selector: '.image-canvas-container', forwardSelector: '#imageCanvas' }
    ];
  }

  init() {
    this.panelDefinitions().forEach(def => {
      const container = document.querySelector(def.selector);
      if (!container) return;
      const forwardTarget = def.forwardSelector ? document.querySelector(def.forwardSelector) : container;
      const panel = new KonvaPanel(def.key, container, this.router, {
        forwardTarget,
        zIndex: def.zIndex
      });
      this.panels.set(def.key, panel);

      const focusHandler = (event) => {
        // Don't change focus if we're already on this panel
        const isMapOverlay = def.key === 'map-overlay';
        const currentPanel = this.router.activePanel;
        const targetPanel = isMapOverlay ? this.router.desiredMapPanel() : def.key;
        
        // If we're already on the correct panel, don't trigger unnecessary state changes
        if (currentPanel === targetPanel) {
          return;
        }
        
        // Check if the click is actually on a Konva element (starting to draw)
        // If so, let the drawing handler deal with it, don't change focus
        const isKonvaElement = event.target && (
          event.target.classList.contains('konvajs-content') ||
          event.target.tagName === 'CANVAS' && event.target.parentElement?.classList.contains('konvajs-content')
        );
        
        // If clicking on Konva canvas with a drawing tool active, let the drawing start first
        // The panel will be focused through the drawing event handlers
        if (isKonvaElement && this.router.isDrawingTool && this.router.isDrawingTool()) {
          return;
        }
        
        if (isMapOverlay) {
          this.router.focusMapPanel();
        } else {
          this.router.setActivePanel(def.key);
        }
      };

      container.addEventListener('pointerdown', focusHandler);
    });

    window.addEventListener('resize', () => {
      this.panels.forEach(panel => panel.resize());
    });
  }

  applyPointerState() {
    const drawModeActive = typeof mapMode === 'undefined' || mapMode === 'draw';
    if (!drawModeActive) {
      // Only cancel in-progress drawings on the map overlay, not the image panel
      const mapOverlayPanel = this.panels.get('map-overlay');
      if (mapOverlayPanel && typeof mapOverlayPanel.cancelInProgressDrawing === 'function') {
        mapOverlayPanel.cancelInProgressDrawing();
      }
    }

    const isKonvaDrawingTool = this.router && typeof this.router.isDrawingTool === 'function'
      && this.router.isDrawingTool(this.currentTool)
      && (!this.router.usesGeoman || !this.router.usesGeoman(this.currentTool));

    const isPanTool = this.currentTool === 'pan';

    this.panels.forEach((panel, panelKey) => {
      let shouldEnable = false;

      if (this.pointerOverride === 'all') {
        shouldEnable = true;
      } else if (this.pointerOverride === 'none') {
        shouldEnable = false;
      } else if (isKonvaDrawingTool) {
        // CRITICAL: Konva drawing tools work on all panels regardless of map mode.
        // Map overlay is only available when in draw mode.
        shouldEnable = panelKey !== 'map-overlay' || drawModeActive;
      } else if (!drawModeActive && panelKey !== 'image') {
        // Non-drawing tools: when map is not in draw mode, only the image panel
        // remains available. All map/3d panels are disabled.
        shouldEnable = false;
      } else {
        shouldEnable = this.activePanel && panelKey === this.activePanel;

        if (panelKey === 'map-overlay' && this.router && this.router.usesGeoman && this.router.usesGeoman(this.currentTool)) {
          shouldEnable = false;
        }
      }

      panel.setPointerEnabled(shouldEnable);
    });
  }

  setActivePanel(key) {
    this.activePanel = key;
    this.panels.forEach(panel => {
      panel.clearSelection();
    });
    this.applyPointerState();
  }

  updatePointerBehavior(tool) {
    this.currentTool = tool;
    this.applyPointerState();
  }

  setPointerOverride(mode) {
    const normalized = mode === 'all' ? 'all' : mode === 'none' ? 'none' : null;
    if (this.pointerOverride === normalized) return;
    this.pointerOverride = normalized;
    this.applyPointerState();
  }

  clearPointerOverride() {
    this.setPointerOverride(null);
  }

  cancelForwarding() {
    this.panels.forEach(panel => panel.cancelForwarding());
  }

  cancelInProgressDrawings() {
    this.panels.forEach(panel => {
      if (panel && typeof panel.cancelInProgressDrawing === 'function') {
        panel.cancelInProgressDrawing();
      }
    });
  }

  clearSelections() {
    this.panels.forEach(panel => panel.clearSelection());
  }

  getSelection() {
    const orderedKeys = [];
    if (this.activePanel) {
      orderedKeys.push(this.activePanel);
    }
    this.panels.forEach((_, key) => {
      if (!orderedKeys.includes(key)) {
        orderedKeys.push(key);
      }
    });

    for (const key of orderedKeys) {
      const panel = this.panels.get(key);
      if (!panel) continue;
      const shape = typeof panel.getActiveShape === 'function'
        ? panel.getActiveShape()
        : panel.activeShape;
      if (shape && !isShapeDestroyed(shape)) {
        return { key, panel, shape };
      }
    }

    return null;
  }

  getPanel(key) {
    return this.panels.get(key);
  }

  recordAdd(panelKey, shape) {
    const panel = this.panels.get(panelKey);
    if (!panel) return;
    this.router.recordAdd(panelKey, shape);
  }

  clearAll() {
    this.panels.forEach(panel => panel.clear());
  }
}

class DrawingRouter {
  constructor(mapInstance) {
    this.map = mapInstance;
    this.state = { ...DRAWING_DEFAULTS };
    this.undoStack = [];
    this.redoStack = [];
    this.MAX_UNDO_STACK_SIZE = 100; // Limit stack size to prevent memory issues
    this.konvaManager = new KonvaManager(this);
    this.activePanel = 'map';
    this.geomanLayers = new Set();
    this.modifiers = { shift: false };
    this.sunMeasurement = {
      height: null,
      shadow: null,
      ground: null,
      lastAngle: null,
      lastComputation: null,
      warnings: [],
      pendingRole: null
    };
  }

  init() {
    this.konvaManager.init();
    this.attachMapHandlers();
    this.setupKeyboardHandlers();
    this.setActivePanel('map');
    this.updateToolbarUI();
    this.konvaManager.updatePointerBehavior(this.state.tool);
    this.updateSunMeasurementUI();
    
    // Initialize image overlay sync if syncImageOverlay function exists
    if (typeof syncImageOverlay === 'function') {
      syncImageOverlay();
    }
  }

  attachMapHandlers() {
    if (!this.map || !this.map.pm) return;

    this.map.on('pm:create', (e) => {
      // H2: only track Geoman shapes when the drawing toolbar owns the map.
      // Angles mode (and others) have their own pm:create handler in angles-mode.js;
      // recording their layers here would pollute the shared undo stack.
      if (typeof mapMode !== 'undefined' && mapMode !== 'draw') return;
      const layer = e.layer;
      
      // Ensure layer is added to map (Leaflet Geoman should do this automatically,
      // but we ensure it explicitly for reliability)
      if (!this.map.hasLayer(layer)) {
        layer.addTo(this.map);
      }
      
      this.applyGeomanStyle(layer);
      this.geomanLayers.add(layer);
      if (window.drawingLayerRegistry && typeof window.drawingLayerRegistry.registerLeafletLayer === 'function') {
        window.drawingLayerRegistry.registerLeafletLayer(layer);
      }
      this.recordCommand({
        type: 'geoman-add',
        layer,
        undo: () => {
          if (window.drawingLayerRegistry && typeof window.drawingLayerRegistry.unregisterLeafletLayer === 'function') {
            window.drawingLayerRegistry.unregisterLeafletLayer(layer);
          }
          this.geomanLayers.delete(layer);
          this.map.removeLayer(layer);
        },
        redo: () => {
          layer.addTo(this.map);
          this.geomanLayers.add(layer);
          if (window.drawingLayerRegistry && typeof window.drawingLayerRegistry.registerLeafletLayer === 'function') {
            window.drawingLayerRegistry.registerLeafletLayer(layer);
          }
        }
      });
    });

    let syncFrame = null;
    const syncOverlay = () => {
      if (syncFrame != null) return;
      syncFrame = requestAnimationFrame(() => {
        syncFrame = null;
        const panel = this.konvaManager.getPanel('map-overlay');
        if (panel) panel.syncWithMap();
        if (typeof syncStickyNotesWithMap === 'function') syncStickyNotesWithMap();
      });
    };

    ['move', 'moveend', 'zoom', 'zoomend', 'zoomanim', 'rotate', 'resize'].forEach(evtName => {
      this.map.on(evtName, syncOverlay);
    });
  }

  recordCommand(command) {
    this.undoStack.push(command);
    if (typeof markProjectDirty === 'function') markProjectDirty();
    // Limit stack size to prevent unlimited memory growth
    if (this.undoStack.length > this.MAX_UNDO_STACK_SIZE) {
      this.undoStack.shift(); // Remove oldest command
    }
    this.redoStack = [];
  }

  recordAdd(panelKey, shape) {
    const panel = this.konvaManager.getPanel(panelKey);
    if (!panel) return;
    this.recordCommand({
      type: 'add',
      panelKey,
      shape,
      undo: () => {
        panel.removeShape(shape);
      },
      redo: () => {
        panel.addShape(shape);
      }
    });
  }

  recordUpdate(panelKey, shape, before, after) {
    const panel = this.konvaManager.getPanel(panelKey);
    if (!panel) return;
    this.recordCommand({
      type: 'update',
      panelKey,
      shape,
      undo: () => panel.applyShapeState(shape, before),
      redo: () => panel.applyShapeState(shape, after)
    });
  }

  setActivePanel(panelKey) {
    if (panelKey === 'map-overlay' && this.usesGeoman()) {
      panelKey = 'map';
    }

    if (panelKey === this.activePanel) {
      if (panelKey === 'map') {
        this.enableGeomanForCurrentTool();
      }
      this.konvaManager.updatePointerBehavior(this.state.tool);
      return;
    }

    this.activePanel = panelKey;
    if (panelKey === 'map') {
      this.konvaManager.setActivePanel(null);
      this.enableGeomanForCurrentTool();
    } else {
      this.disableGeomanDraw();
      if (panelKey) {
        this.konvaManager.setActivePanel(panelKey);
      }
    }
    this.konvaManager.updatePointerBehavior(this.state.tool);
  }

  usesGeoman(tool = this.state.tool) {
    return ['rect', 'polygon', 'circle', 'line'].includes(tool);
  }

  isDrawingTool(tool = this.state.tool) {
    // Returns true for ANY drawing tool (Geoman + Konva drawing tools)
    return ['rect', 'polygon', 'circle', 'line', 'ellipse', 'arrow', 'freehand'].includes(tool);
  }

  setupKeyboardHandlers() {
    if (this._keyboardHandlersAttached) return;
    this._keyboardHandlersAttached = true;

    const updateShift = (value) => {
      this.modifiers.shift = value;
    };

    window.addEventListener('keydown', (evt) => {
      if (evt.key === 'Shift') {
        updateShift(true);
      }
    });

    window.addEventListener('keyup', (evt) => {
      if (evt.key === 'Shift') {
        updateShift(false);
      }
    });

    window.addEventListener('blur', () => updateShift(false));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') {
        updateShift(false);
      }
    });
  }

  isShiftPressed() {
    return !!this.modifiers.shift;
  }

  desiredMapPanel(tool = this.state.tool) {
    return this.usesGeoman(tool) ? 'map' : 'map-overlay';
  }

  focusMapPanel() {
    const desired = this.desiredMapPanel();
    if (this.activePanel === desired) return;
    this.setActivePanel(desired);
  }

  enableGeomanForCurrentTool() {
    if (!this.map || !this.map.pm) return;

    if (this.state.tool === 'pan' || this.state.tool === 'note') {
      this.map.pm.disableDraw();
      return;
    }

    const toolMap = {
      rect: 'Rectangle',
      polygon: 'Polygon',
      circle: 'Circle',
      line: 'Line'
    };

    const geomanTool = toolMap[this.state.tool];
    if (!geomanTool) {
      this.map.pm.disableDraw();
      return;
    }

    if (!this.ensureGeomanDrawHandler(geomanTool)) {
      console.warn(`Geoman draw handler for ${geomanTool} is unavailable.`);
      this.map.pm.disableDraw();
      return;
    }

    this.map.pm.disableDraw();
    this.map.pm.setPathOptions(this.geomanOptions());
    this.map.pm.enableDraw(geomanTool, {
      finishOnDoubleClick: geomanTool === 'Polygon',
      snappable: true,
      snapDistance: 20
    });
  }

  ensureGeomanDrawHandler(tool) {
    if (!this.map || !this.map.pm) return false;
    if (this.map.pm.Draw && this.map.pm.Draw[tool]) return true;
    if (!window.L || !L.PM || !L.PM.Draw || !L.PM.Draw[tool]) {
      return false;
    }
    this.map.pm.Draw = this.map.pm.Draw || {};
    this.map.pm.Draw[tool] = new L.PM.Draw[tool](this.map);
    return !!this.map.pm.Draw[tool];
  }

  applyGeomanStyle(layer) {
    const opts = this.geomanOptions();
    if (layer.setStyle) {
      layer.setStyle({
        color: opts.color,
        weight: opts.weight,
        dashArray: opts.dashArray,
        fill: opts.fill,
        fillColor: opts.fillColor,
        fillOpacity: opts.fillOpacity
      });
    }
  }

  geomanOptions() {
    const fill = this.state.filled;
    return {
      color: this.state.color,
      weight: this.state.lineWidth,
      dashArray: this.state.dashed ? [12, 6] : undefined,
      fill,
      fillColor: this.state.color,
      fillOpacity: fill ? this.state.fillOpacity : 0
    };
  }

  disableGeomanDraw() {
    if (this.map && this.map.pm) {
      this.map.pm.disableDraw();
    }
  }

  selectTool(tool) {
    const previousTool = this.state.tool;
    this.state.tool = tool;
    
    // CRITICAL: Update KonvaManager's currentTool FIRST before any state changes
    // This ensures applyPointerState has the correct tool information
    this.konvaManager.currentTool = tool;
    
    // Critical: Cancel any active forwarding first
    this.konvaManager.cancelForwarding();
    this.konvaManager.cancelInProgressDrawings();
    
    if (tool !== 'pan') {
      this.konvaManager.clearSelections();
      if (typeof window.deselectImageLayer === 'function') {
        try {
          window.deselectImageLayer();
        } catch (err) {
          console.warn('Failed to deselect image layer', err);
        }
      }
    }
    
    if (this.activePanel === 'map' || this.activePanel === 'map-overlay') {
      const desiredPanel = this.desiredMapPanel(tool);
      if (desiredPanel !== this.activePanel) {
        this.setActivePanel(desiredPanel);
      } else if (desiredPanel === 'map') {
        this.enableGeomanForCurrentTool();
      }
    }

    const drawModeActive = typeof mapMode === 'undefined' || mapMode === 'draw';
    if (!drawModeActive) {
      this.disableGeomanDraw();
      // Don't clear the active panel if the user is working in the image panel —
      // the image panel is independent of the map mode.
      if (this.konvaManager.activePanel !== 'image') {
        this.setActivePanel(null);
      }
    }
    
    this.updateToolbarUI();
    
    // Ensure pointer behavior is applied with current tool state
    this.konvaManager.applyPointerState();
  }

  selectColor(color) {
    this.state.color = color;
    if (this.activePanel === 'map') {
      this.enableGeomanForCurrentTool();
    }
  }

  toggleDashed() {
    this.state.dashed = !this.state.dashed;
    if (this.activePanel === 'map') {
      this.enableGeomanForCurrentTool();
    }
  }

  toggleFill() {
    this.state.filled = !this.state.filled;
    if (this.activePanel === 'map') {
      this.enableGeomanForCurrentTool();
    }
    this.updateToolbarUI();
  }

  setFillOpacity(value) {
    this.state.fillOpacity = Math.max(0, Math.min(value / 100, 1));
    if (this.activePanel === 'map') {
      this.enableGeomanForCurrentTool();
    }
    const label = document.getElementById('opacityLabel');
    if (label) label.textContent = `${Math.round(this.state.fillOpacity * 100)}%`;
  }

  setLineWidth(width) {
    this.state.lineWidth = width;
    if (this.activePanel === 'map') {
      this.enableGeomanForCurrentTool();
    }
    this.updateToolbarUI();
  }

  setSunMeasurementRole(role) {
    if (!['height', 'shadow'].includes(role)) return;

    if (this.sunMeasurement.pendingRole === role) {
      this.sunMeasurement.pendingRole = null;
      this.sunMeasurement.warnings = [];
      this.updateSunAssignmentPointerMode();
      this.updateSunMeasurementUI();
      return;
    }

    const selection = typeof this.konvaManager.getSelection === 'function'
      ? this.konvaManager.getSelection()
      : null;
    const panelKey = selection?.key;
    if (panelKey && typeof this.setActivePanel === 'function') {
      this.setActivePanel(panelKey);
    }
    const panel = selection?.panel || (panelKey ? this.konvaManager.getPanel(panelKey) : null);
    const rawShape = selection?.shape || (panel && typeof panel.getActiveShape === 'function' ? panel.getActiveShape() : panel?.activeShape);
    const shape = rawShape && !isShapeDestroyed(rawShape) ? rawShape : null;

    this.sunMeasurement.pendingRole = role;

    if (shape) {
      const otherRole = role === 'height' ? 'shadow' : 'height';
      const selectedRole = shape.getAttr ? shape.getAttr('sunAssignmentRole') : null;
      const conflictsWithOther = this.sunMeasurement[otherRole]
        && shapesMatch(this.sunMeasurement[otherRole].shape, shape);
      if (!conflictsWithOther && (!selectedRole || selectedRole === role)) {
        const result = this.attemptSunArrowAssignment(role, shape, panelKey, {
          directSelection: true,
          suppressConflicts: true
        });
        if (result === 'assigned' || result === 'cleared') {
          return;
        }
      }
    }

    if (!shape || !Array.isArray(this.sunMeasurement.warnings) || this.sunMeasurement.warnings.length === 0) {
      const label = role === 'height' ? 'height' : 'shadow';
      this.sunMeasurement.warnings = [`Click an arrow to assign it as the ${label} measurement.`];
      this.updateSunMeasurementUI();
    }

    this.updateSunAssignmentPointerMode();
  }

  updateSunAssignmentPointerMode() {
    if (!this.konvaManager) return;
    if (typeof this.konvaManager.setPointerOverride !== 'function') return;
    if (this.sunMeasurement.pendingRole) {
      this.konvaManager.setPointerOverride('all');
    } else if (typeof this.konvaManager.clearPointerOverride === 'function') {
      this.konvaManager.clearPointerOverride();
    } else {
      this.konvaManager.setPointerOverride(null);
    }
  }

  hasPendingSunAssignment() {
    return Boolean(this.sunMeasurement.pendingRole);
  }

  setSunGroundPlane() {
    const selection = typeof this.konvaManager.getSelection === 'function'
      ? this.konvaManager.getSelection()
      : null;
    const panelKey = selection?.key;
    const panel = selection?.panel || (panelKey ? this.konvaManager.getPanel(panelKey) : null);
    const shape = selection?.shape || (panel && typeof panel.getActiveShape === 'function' ? panel.getActiveShape() : panel?.activeShape);

    if (!panel || !shape) {
      this.sunMeasurement.warnings = ['Select a polygon that represents the ground plane before assigning it.'];
      this.updateSunMeasurementUI();
      return;
    }

    const type = shape.getAttr('shapeType');
    if (!['polygon', 'freehand', 'line'].includes(type)) {
      this.sunMeasurement.warnings = ['Ground plane correction requires a four-corner polygon.'];
      this.updateSunMeasurementUI();
      return;
    }

    const points = this.extractPolygonPoints(shape);
    if (!points || points.length < 4) {
      this.sunMeasurement.warnings = ['Ground plane polygon needs at least four distinct corners.'];
      this.updateSunMeasurementUI();
      return;
    }

    this.sunMeasurement.pendingRole = null;
    this.updateSunAssignmentPointerMode();
    this.assignSunRole('ground', shape, panelKey);
    this.sunMeasurement.warnings = [];
    this.calculateSunElevation({ auto: true });
  }

  handleShapeSelection(panelKey, shape) {
    if (!shape) return;
    if (!this.sunMeasurement.pendingRole) return;
    const role = this.sunMeasurement.pendingRole;
    const outcome = this.attemptSunArrowAssignment(role, shape, panelKey, { fromClick: true });
    if (outcome !== 'assigned' && outcome !== 'cleared') {
      this.sunMeasurement.pendingRole = role;
      this.updateSunAssignmentPointerMode();
    }
    this.updateSunAssignmentPointerMode();
  }

  attemptSunArrowAssignment(role, shape, panelKey, options = {}) {
    if (!shape || typeof shape.getAttr !== 'function') {
      return 'ignored';
    }

    const { suppressConflicts = false } = options;

    if (shape.getAttr('shapeType') !== 'arrow') {
      const label = role === 'height' ? 'height' : 'shadow';
      this.sunMeasurement.warnings = [`Only arrow measurements can be marked as the ${label} measurement.`];
      this.updateSunMeasurementUI();
      return 'invalid';
    }

    if (isShapeDestroyed(shape)) {
      return 'ignored';
    }

    const currentEntry = this.sunMeasurement[role];
    if (currentEntry && currentEntry.shape && !isShapeDestroyed(currentEntry.shape) && shapesMatch(currentEntry.shape, shape)) {
      this.clearSunRole(role, { silent: false });
      this.sunMeasurement.pendingRole = null;
      this.sunMeasurement.warnings = [];
      this.updateSunMeasurementUI();
      this.updateSunAssignmentPointerMode();
      return 'cleared';
    }

    const otherRole = role === 'height' ? 'shadow' : 'height';
    const otherEntry = this.sunMeasurement[otherRole];
    if (otherEntry && otherEntry.shape && !isShapeDestroyed(otherEntry.shape) && shapesMatch(otherEntry.shape, shape)) {
      if (!suppressConflicts) {
        const label = role === 'height' ? 'height' : 'shadow';
        const otherLabel = otherRole === 'height' ? 'height' : 'shadow';
        this.sunMeasurement.warnings = [`This arrow is already assigned as the ${otherLabel} measurement. Select a different arrow for the ${label} measurement.`];
        this.updateSunMeasurementUI();
      }
      return 'conflict';
    }

    const currentAssignment = shape.getAttr('sunAssignmentRole');
    if (currentAssignment && currentAssignment !== role) {
      if (!suppressConflicts) {
        const currentLabel = currentAssignment === 'height' ? 'height' : 'shadow';
        const desiredLabel = role === 'height' ? 'height' : 'shadow';
        this.sunMeasurement.warnings = [`This arrow is already assigned as the ${currentLabel} measurement. Select a different arrow for the ${desiredLabel} measurement.`];
        this.updateSunMeasurementUI();
      }
      return 'conflict';
    }

    this.assignSunRole(role, shape, panelKey);
    this.sunMeasurement.pendingRole = null;
    this.sunMeasurement.warnings = [];
    this.calculateSunElevation({ auto: true });
    this.updateSunAssignmentPointerMode();
    return 'assigned';
  }

  assignSunRole(role, shape, panelKey) {
    const existing = this.sunMeasurement[role];
    if (existing && existing.shape && !isShapeDestroyed(existing.shape)) {
      if (existing.destroyHandler) {
        existing.shape.off('destroy', existing.destroyHandler);
      }
      if (Array.isArray(existing.listeners)) {
        existing.listeners.forEach(({ events, handler }) => {
          existing.shape.off(events, handler);
        });
      }
      if (existing.shape.getAttr && existing.shape.getAttr('sunAssignmentRole') === role) {
        existing.shape.setAttr('sunAssignmentRole', null);
      }
    }

    ensureSunAssignmentId(shape);

    const entry = { shape, panelKey, listeners: [] };
    const destroyHandler = () => {
      if (this.sunMeasurement[role] && shapesMatch(this.sunMeasurement[role].shape, shape)) {
        this.clearSunRole(role, { silent: true });
        this.calculateSunElevation({ auto: true });
      }
    };
    shape.on('destroy', destroyHandler);
    entry.destroyHandler = destroyHandler;

    if (role === 'ground') {
      const updateHandler = () => this.calculateSunElevation({ auto: true });
      const events = 'dragmove transform pointsChange';
      shape.on(events, updateHandler);
      entry.listeners.push({ events, handler: updateHandler });
    }

    shape.setAttr('sunAssignmentRole', role);
    this.sunMeasurement[role] = entry;
  }

  clearSunRole(role, options = {}) {
    const { silent = false } = options;
    const entry = this.sunMeasurement[role];
    if (!entry) return;
    const { shape, destroyHandler, listeners } = entry;
    if (shape && destroyHandler) {
      shape.off('destroy', destroyHandler);
    }
    if (shape && Array.isArray(listeners)) {
      listeners.forEach(({ events, handler }) => shape.off(events, handler));
    }
    if (shape && shape.getAttr && shape.getAttr('sunAssignmentRole') === role) {
      shape.setAttr('sunAssignmentRole', null);
    }
    this.sunMeasurement[role] = null;

    if (this.sunMeasurement.pendingRole === role) {
      this.sunMeasurement.pendingRole = null;
    }

    this.sunMeasurement.warnings = [];
    this.updateSunAssignmentPointerMode();

    if (!silent) {
      this.calculateSunElevation({ auto: true });
    }
  }

  clearSunMeasurements(options = {}) {
    const { silent = false } = options;
    this.clearSunRole('height', { silent: true });
    this.clearSunRole('shadow', { silent: true });
    this.clearSunRole('ground', { silent: true });
    this.sunMeasurement.lastAngle = null;
    this.sunMeasurement.lastComputation = null;
    this.sunMeasurement.warnings = [];
    this.sunMeasurement.pendingRole = null;
    this.updateSunAssignmentPointerMode();
    if (!silent) {
      this.updateSunMeasurementUI();
    }
  }

  handleArrowMeasurementUpdate(_panelKey, shape) {
    const { height, shadow } = this.sunMeasurement;
    const matchesHeight = height && shapesMatch(height.shape, shape);
    const matchesShadow = shadow && shapesMatch(shadow.shape, shape);
    if (!matchesHeight && !matchesShadow) return;
    this.calculateSunElevation({ auto: true });
  }

  handleShapeDestroyed(shape) {
    if (!shape) return;
    let affected = false;
    ['height', 'shadow', 'ground'].forEach(role => {
      const entry = this.sunMeasurement[role];
      if (entry && shapesMatch(entry.shape, shape)) {
        this.clearSunRole(role, { silent: true });
        affected = true;
      }
    });
    if (affected) {
      this.sunMeasurement.lastAngle = null;
      this.sunMeasurement.lastComputation = null;
      this.sunMeasurement.warnings = [];
      this.updateSunMeasurementUI();
    }
  }

  calculateSunElevation(options = {}) {
    const { auto = false } = options;
    const heightEntry = this.sunMeasurement.height;
    const shadowEntry = this.sunMeasurement.shadow;
    const warnings = [];

    if (!heightEntry || !heightEntry.shape || isShapeDestroyed(heightEntry.shape)) {
      if (!auto) warnings.push('Assign a height arrow before computing the sun elevation.');
      this.sunMeasurement.lastAngle = null;
      this.sunMeasurement.lastComputation = null;
      this.sunMeasurement.warnings = warnings;
      this.updateSunMeasurementUI();
      return null;
    }

    if (!shadowEntry || !shadowEntry.shape || isShapeDestroyed(shadowEntry.shape)) {
      if (!auto) warnings.push('Assign a shadow arrow before computing the sun elevation.');
      this.sunMeasurement.lastAngle = null;
      this.sunMeasurement.lastComputation = null;
      this.sunMeasurement.warnings = warnings;
      this.updateSunMeasurementUI();
      return null;
    }

    const heightShape = heightEntry.shape;
    const shadowShape = shadowEntry.shape;
    const heightLength = this.getArrowLength(heightShape);
    const shadowLength = this.getArrowLength(shadowShape);

    if (!heightLength || !Number.isFinite(heightLength)) {
      warnings.push('Height arrow has no measurable length. Adjust the arrow points.');
    }
    if (!shadowLength || !Number.isFinite(shadowLength)) {
      warnings.push('Shadow arrow has no measurable length. Adjust the arrow points.');
    }

    if (warnings.length && !auto) {
      this.sunMeasurement.lastAngle = null;
      this.sunMeasurement.lastComputation = null;
      this.sunMeasurement.warnings = warnings;
      this.updateSunMeasurementUI();
      return null;
    }

    let correctedShadow = shadowLength;
    let perspectiveApplied = false;
    let scaleFactor = 1;
    const groundEntry = this.sunMeasurement.ground;
    if (groundEntry && groundEntry.shape && !isShapeDestroyed(groundEntry.shape)) {
      const matrix = this.computeGroundHomography();
      const endpoints = this.getArrowEndpoints(shadowShape);
      if (matrix && endpoints) {
        const startWarped = applyHomography(matrix, endpoints.start);
        const endWarped = applyHomography(matrix, endpoints.end);
        if (startWarped && endWarped) {
          const warpedLength = distanceBetweenPoints(startWarped, endWarped);
          if (warpedLength && Number.isFinite(warpedLength)) {
            correctedShadow = warpedLength;
            perspectiveApplied = true;
            if (shadowLength && Number.isFinite(shadowLength) && shadowLength > 0) {
              scaleFactor = warpedLength / shadowLength;
            }
          } else if (!auto) {
            warnings.push('Perspective correction failed for the selected shadow arrow.');
          }
        } else if (!auto) {
          warnings.push('Ground plane homography produced invalid coordinates.');
        }
      } else if (!auto) {
        warnings.push('Ground plane polygon must contain four distinct corners for perspective correction.');
      }
    }

    const heightInput = document.getElementById('sunActualHeight');
    const overrideHeight = heightInput ? Number.parseFloat(heightInput.value) : NaN;
    let usedHeight = heightLength;
    let heightSource = 'pixel';
    if (Number.isFinite(overrideHeight) && overrideHeight > 0) {
      usedHeight = overrideHeight;
      heightSource = 'actual';
    } else if (perspectiveApplied && Number.isFinite(scaleFactor) && scaleFactor > 0 && heightLength) {
      usedHeight = heightLength * scaleFactor;
      heightSource = 'scaled-pixel';
    }

    if (!usedHeight || !Number.isFinite(usedHeight) || usedHeight <= 0) {
      if (!auto) warnings.push('Unable to determine a valid object height for the calculation.');
      this.sunMeasurement.lastAngle = null;
      this.sunMeasurement.lastComputation = null;
      this.sunMeasurement.warnings = warnings;
      this.updateSunMeasurementUI();
      return null;
    }

    if (!correctedShadow || !Number.isFinite(correctedShadow) || correctedShadow <= 0) {
      if (!auto) warnings.push('Unable to determine a valid shadow length for the calculation.');
      this.sunMeasurement.lastAngle = null;
      this.sunMeasurement.lastComputation = null;
      this.sunMeasurement.warnings = warnings;
      this.updateSunMeasurementUI();
      return null;
    }

    const angle = Math.atan(usedHeight / correctedShadow) * (180 / Math.PI);
    this.sunMeasurement.lastAngle = angle;
    this.sunMeasurement.lastComputation = {
      height: usedHeight,
      heightPixels: heightLength,
      heightSource,
      shadow: correctedShadow,
      shadowPixels: shadowLength,
      perspectiveApplied,
      scaleFactor
    };
    this.sunMeasurement.warnings = warnings;
    this.updateSunMeasurementUI();
    return angle;
  }

  updateSunMeasurementUI() {
    const angleEl = document.getElementById('sunAngleValue');
    if (angleEl) {
      const angle = this.sunMeasurement.lastAngle;
      if (Number.isFinite(angle)) {
        angleEl.textContent = `${Math.round(angle * 10) / 10}°`;
      } else {
        angleEl.textContent = '—';
      }
    }

    const heightEl = document.getElementById('sunHeightAssignment');
    if (heightEl) {
      const entry = this.sunMeasurement.height;
      const computation = this.sunMeasurement.lastComputation;
      if (entry && entry.shape && !isShapeDestroyed(entry.shape)) {
        const length = this.getArrowLength(entry.shape);
        const id = entry.shape._id;
        const detailParts = [];
        const pixelText = formatNumber(length);
        if (pixelText !== '—') {
          detailParts.push(`${pixelText} px`);
        }
        if (computation) {
          if (computation.heightSource === 'actual') {
            const overrideText = formatNumber(computation.height);
            if (overrideText !== '—') {
              detailParts.push(`override ${overrideText}`);
            }
          } else if (computation.heightSource === 'scaled-pixel') {
            const scaledText = formatNumber(computation.height);
            if (scaledText !== '—' && scaledText !== pixelText) {
              detailParts.push(`scaled ${scaledText}`);
            }
          }
        }
        const details = detailParts.length ? detailParts.join(' · ') : '—';
        heightEl.textContent = `Height arrow #${id}: ${details}`;
      } else {
        heightEl.textContent = 'Height arrow: —';
      }
    }

    const shadowEl = document.getElementById('sunShadowAssignment');
    if (shadowEl) {
      const entry = this.sunMeasurement.shadow;
      const computation = this.sunMeasurement.lastComputation;
      if (entry && entry.shape && !isShapeDestroyed(entry.shape)) {
        const length = this.getArrowLength(entry.shape);
        const id = entry.shape._id;
        const detailParts = [];
        const pixelText = formatNumber(length);
        if (pixelText !== '—') {
          detailParts.push(`${pixelText} px`);
        }
        if (computation && Number.isFinite(computation.shadow)) {
          const correctedText = formatNumber(computation.shadow);
          if (computation.perspectiveApplied && correctedText !== '—' && correctedText !== pixelText) {
            detailParts.push(`corrected ${correctedText}`);
          }
        }
        const details = detailParts.length ? detailParts.join(' · ') : '—';
        shadowEl.textContent = `Shadow arrow #${id}: ${details}`;
      } else {
        shadowEl.textContent = 'Shadow arrow: —';
      }
    }

    const perspectiveEl = document.getElementById('sunPerspectiveStatus');
    if (perspectiveEl) {
      const groundEntry = this.sunMeasurement.ground;
      const comp = this.sunMeasurement.lastComputation;
      if (groundEntry && groundEntry.shape && !isShapeDestroyed(groundEntry.shape)) {
        const applied = comp && comp.perspectiveApplied;
        perspectiveEl.textContent = applied ? 'Perspective correction: On' : 'Perspective correction: Assigned (waiting for valid homography)';
      } else {
        perspectiveEl.textContent = 'Perspective correction: Off';
      }
    }

    const warningEl = document.getElementById('sunWarnings');
    if (warningEl) {
      const warnings = this.sunMeasurement.warnings || [];
      if (warnings.length) {
        warningEl.innerHTML = warnings.map(text => `<li>${escapeHtml(text)}</li>`).join('');
        warningEl.parentElement?.classList.add('sun-tools-warnings--visible');
      } else {
        warningEl.innerHTML = '';
        warningEl.parentElement?.classList.remove('sun-tools-warnings--visible');
      }
    }
  }

  getArrowLength(shape) {
    if (!shape || typeof shape.points !== 'function') return null;
    const attrLength = Number(shape.getAttr('pixelLength'));
    if (attrLength && Number.isFinite(attrLength)) {
      return attrLength;
    }
    const endpoints = this.getArrowEndpoints(shape);
    if (!endpoints) return null;
    return distanceBetweenPoints(endpoints.start, endpoints.end);
  }

  getArrowEndpoints(shape) {
    if (!shape || typeof shape.points !== 'function' || typeof shape.getAbsoluteTransform !== 'function') return null;
    const points = shape.points();
    if (!Array.isArray(points) || points.length < 4) return null;
    const transform = shape.getAbsoluteTransform().copy();
    const start = transform.point({ x: points[0], y: points[1] });
    const end = transform.point({ x: points[points.length - 2], y: points[points.length - 1] });
    return { start, end };
  }

  extractPolygonPoints(shape) {
    if (!shape || typeof shape.points !== 'function' || typeof shape.getAbsoluteTransform !== 'function') return null;
    const points = shape.points();
    if (!Array.isArray(points) || points.length < 8) return null;
    const transform = shape.getAbsoluteTransform().copy();
    const absolute = [];
    for (let i = 0; i < points.length; i += 2) {
      const point = transform.point({ x: points[i], y: points[i + 1] });
      if (absolute.length) {
        const prev = absolute[absolute.length - 1];
        if (distanceBetweenPoints(prev, point) < 1e-3) {
          continue;
        }
      }
      if (absolute.length >= 3) {
        const first = absolute[0];
        if (distanceBetweenPoints(first, point) < 1e-3) {
          continue;
        }
      }
      absolute.push(point);
      if (absolute.length === 4) break;
    }
    return absolute.length >= 4 ? absolute.slice(0, 4) : null;
  }

  computeGroundHomography() {
    const groundEntry = this.sunMeasurement.ground;
    if (!groundEntry || !groundEntry.shape || isShapeDestroyed(groundEntry.shape)) return null;
    const points = this.extractPolygonPoints(groundEntry.shape);
    if (!points || points.length < 4) return null;
    const destination = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 }
    ];
    return computeHomographyMatrix(points, destination);
  }

  updateToolbarUI() {
    const toolButtons = document.querySelectorAll('.tool-btn');
    toolButtons.forEach(btn => {
      if (!btn.dataset.tool) return;
      btn.classList.toggle('active', btn.dataset.tool === this.state.tool);
    });

    const lineButtons = document.querySelectorAll('[data-width]');
    lineButtons.forEach(btn => {
      const width = Number(btn.dataset.width);
      btn.classList.toggle('active', width === this.state.lineWidth);
    });

    const solidToggle = document.getElementById('solidToggle');
    if (solidToggle) {
      solidToggle.textContent = this.state.dashed ? 'Dashed' : 'Solid';
      solidToggle.classList.toggle('active', !this.state.dashed);
    }

    const fillToggle = document.getElementById('fillToggle');
    if (fillToggle) {
      fillToggle.classList.toggle('active', this.state.filled);
    }
  }

  undo() {
    const command = this.undoStack.pop();
    if (!command) return;
    if (typeof command.undo === 'function') {
      command.undo();
    }
    this.redoStack.push(command);
  }

  redo() {
    const command = this.redoStack.pop();
    if (!command) return;
    if (typeof command.redo === 'function') {
      command.redo();
    }
    this.undoStack.push(command);
    // Limit stack size to prevent unlimited memory growth
    if (this.undoStack.length > this.MAX_UNDO_STACK_SIZE) {
      this.undoStack.shift(); // Remove oldest command
    }
  }

  clearAllShapes() {
    if (typeof markProjectDirty === 'function') markProjectDirty();
    // Clear Konva overlays
    this.konvaManager.clearAll();
    // Clear map shapes
    if (this.map) {
      [...this.geomanLayers].forEach(layer => {
        this.map.removeLayer(layer);
        if (window.drawingLayerRegistry && typeof window.drawingLayerRegistry.unregisterLeafletLayer === 'function') {
          window.drawingLayerRegistry.unregisterLeafletLayer(layer);
        }
      });
      this.geomanLayers.clear();
    }
    if (window.drawingLayerRegistry && typeof window.drawingLayerRegistry.clearAll === 'function') {
      window.drawingLayerRegistry.clearAll();
    }
    this.undoStack = [];
    this.redoStack = [];
  }
}

function isShapeDestroyed(shape) {
  return Boolean(shape && typeof shape.isDestroyed === 'function' && shape.isDestroyed());
}

function ensureSunAssignmentId(shape) {
  if (!shape) return null;
  if (shape[SUN_ASSIGNMENT_ID_KEY]) {
    return shape[SUN_ASSIGNMENT_ID_KEY];
  }

  let existing = null;
  if (typeof shape.getAttr === 'function') {
    existing = shape.getAttr(SUN_ASSIGNMENT_ID_ATTR);
  }

  if (!existing) {
    existing = `sun-${sunAssignmentIdCounter += 1}`;
    if (typeof shape.setAttr === 'function') {
      shape.setAttr(SUN_ASSIGNMENT_ID_ATTR, existing);
    }
  }

  try {
    shape[SUN_ASSIGNMENT_ID_KEY] = existing;
  } catch (err) {
    // Ignore assignment issues (frozen objects etc.). Attr already set if possible.
  }

  return existing;
}

function shapesMatch(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const idA = ensureSunAssignmentId(a);
  const idB = ensureSunAssignmentId(b);
  if (idA && idB) {
    return idA === idB;
  }
  return false;
}

function distanceBetweenPoints(a, b) {
  if (!a || !b) return null;
  if (!Number.isFinite(a.x) || !Number.isFinite(a.y) || !Number.isFinite(b.x) || !Number.isFinite(b.y)) return null;
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function formatNumber(value) {
  if (!Number.isFinite(value)) return '—';
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(Math.round(rounded)) : rounded.toFixed(1);
}

function escapeHtml(input) {
  if (input == null) return '';
  return String(input)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function computeHomographyMatrix(srcPoints, dstPoints) {
  if (!Array.isArray(srcPoints) || !Array.isArray(dstPoints) || srcPoints.length < 4 || dstPoints.length < 4) return null;
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i += 1) {
    const src = srcPoints[i];
    const dst = dstPoints[i];
    if (!src || !dst) return null;
    const { x, y } = src;
    const { x: X, y: Y } = dst;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(X) || !Number.isFinite(Y)) return null;
    A.push([x, y, 1, 0, 0, 0, -X * x, -X * y]);
    b.push(X);
    A.push([0, 0, 0, x, y, 1, -Y * x, -Y * y]);
    b.push(Y);
  }
  const solution = solveLinearSystem(A, b);
  if (!solution) return null;
  const [h11, h12, h13, h21, h22, h23, h31, h32] = solution;
  return [
    [h11, h12, h13],
    [h21, h22, h23],
    [h31, h32, 1]
  ];
}

function solveLinearSystem(matrix, values) {
  if (!Array.isArray(matrix) || !Array.isArray(values)) return null;
  const n = matrix.length;
  if (!n || values.length !== n) return null;
  const m = matrix[0].length;
  const augmented = matrix.map((row, idx) => {
    if (!Array.isArray(row) || row.length !== m) return null;
    return [...row, values[idx]];
  });
  if (augmented.some(row => row == null)) return null;

  for (let col = 0; col < m; col += 1) {
    let pivot = col;
    let max = Math.abs(augmented[pivot][col]);
    for (let row = col + 1; row < n; row += 1) {
      const val = Math.abs(augmented[row][col]);
      if (val > max) {
        pivot = row;
        max = val;
      }
    }
    if (max < 1e-12) {
      return null;
    }
    if (pivot !== col) {
      [augmented[pivot], augmented[col]] = [augmented[col], augmented[pivot]];
    }
    const pivotVal = augmented[col][col];
    for (let j = col; j <= m; j += 1) {
      augmented[col][j] /= pivotVal;
    }
    for (let row = 0; row < n; row += 1) {
      if (row === col) continue;
      const factor = augmented[row][col];
      if (!factor) continue;
      for (let j = col; j <= m; j += 1) {
        augmented[row][j] -= factor * augmented[col][j];
      }
    }
  }

  const result = [];
  for (let i = 0; i < m; i += 1) {
    result.push(augmented[i][m]);
  }
  return result;
}

function applyHomography(matrix, point) {
  if (!matrix || !point) return null;
  const [[h11, h12, h13], [h21, h22, h23], [h31, h32, h33]] = matrix;
  const { x, y } = point;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const denom = h31 * x + h32 * y + h33;
  if (!Number.isFinite(denom) || Math.abs(denom) < 1e-12) return null;
  const X = (h11 * x + h12 * y + h13) / denom;
  const Y = (h21 * x + h22 * y + h23) / denom;
  if (!Number.isFinite(X) || !Number.isFinite(Y)) return null;
  return { x: X, y: Y };
}

const drawingRouter = new DrawingRouter(typeof map !== 'undefined' ? map : null);
window.drawingRouter = drawingRouter;

document.addEventListener('DOMContentLoaded', () => {
  drawingRouter.init();
  selectTool(DRAWING_DEFAULTS.tool);
  selectColor(DRAWING_DEFAULTS.color);
  updateFillOpacity(DRAWING_DEFAULTS.fillOpacity * 100);
  selectLineWidth(DRAWING_DEFAULTS.lineWidth);
  resizeMapCanvas();

  const actualHeightInput = document.getElementById('sunActualHeight');
  if (actualHeightInput) {
    actualHeightInput.addEventListener('input', () => {
      drawingRouter.calculateSunElevation({ auto: true });
    });
  }
});

/* ========== Toolbar Helpers ========== */

function selectTool(tool) {
  const dynamicView = typeof currentView !== 'undefined' && ['3d', 'peakfinder', 'streetview'].includes(currentView);
  const imageActive = drawingRouter.konvaManager && drawingRouter.konvaManager.activePanel === 'image';
  if (dynamicView && !imageActive && drawingRouter.isDrawingTool(tool)) {
    showToast('Drawings are supported on the 2D map and uploaded images. Return to the map or select the image panel.', { type: 'error' });
    return;
  }
  drawingRouter.selectTool(tool);
}

function selectColor(color) {
  drawingRouter.selectColor(color);
  const picker = document.getElementById('colorPicker');
  if (picker) picker.value = color;
}

function toggleLineStyle() {
  drawingRouter.toggleDashed();
  drawingRouter.updateToolbarUI();
}

function toggleFill() {
  drawingRouter.toggleFill();
}

function updateFillOpacity(value) {
  const numeric = Number(value);
  drawingRouter.setFillOpacity(numeric);
  const slider = document.getElementById('opacitySlider');
  if (slider && slider.value !== String(numeric)) {
    slider.value = numeric;
  }
}

function selectLineWidth(width) {
  drawingRouter.setLineWidth(width);
}

function toggleSunToolsPanel(forceState) {
  const panel = document.getElementById('sunToolsPanel');
  const toggle = document.getElementById('sunToolsToggle');
  if (!panel) return;
  let open;
  if (typeof forceState === 'boolean') {
    open = forceState;
  } else {
    open = !panel.classList.contains('open');
  }
  panel.classList.toggle('open', open);
  panel.setAttribute('aria-hidden', open ? 'false' : 'true');
  if (toggle) {
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  if (open) {
    drawingRouter.updateSunMeasurementUI();
  }
}

function setSunMeasurementRole(role) {
  drawingRouter.setSunMeasurementRole(role);
}

function setSunGroundPlane() {
  drawingRouter.setSunGroundPlane();
}

function clearSunMeasurements() {
  drawingRouter.clearSunMeasurements();
}

function calculateSunElevation() {
  drawingRouter.calculateSunElevation({ auto: false });
}

function showSunToolsHelp() {
  const overlay = document.getElementById('sunHelpOverlay');
  if (!overlay) return;
  overlay.classList.add('visible');
  overlay.setAttribute('aria-hidden', 'false');
  const closeButton = overlay.querySelector('.sun-help-close');
  if (closeButton && typeof closeButton.focus === 'function') {
    closeButton.focus();
  }
}

function hideSunToolsHelp() {
  const overlay = document.getElementById('sunHelpOverlay');
  if (!overlay) return;
  overlay.classList.remove('visible');
  overlay.setAttribute('aria-hidden', 'true');
}

function undoLast() {
  drawingRouter.undo();
}

function redoLast() {
  drawingRouter.redo();
}

function clearAll() {
  if (Array.isArray(stickyNotes)) {
    const notes = [...stickyNotes];
    notes.forEach(note => {
      if (note && typeof deleteStickyNote === 'function') {
        deleteStickyNote(note.id, false);
      }
    });
  }
  drawingRouter.clearAllShapes();
}

function resizeMapCanvas() {
  const mapElement = document.getElementById('map');
  const canvas = document.getElementById('mapCanvas');
  if (!mapElement || !canvas) return;

  const width = mapElement.clientWidth;
  const height = mapElement.clientHeight;
  if (!width || !height) return;

  if (canvas.width !== width) {
    canvas.width = width;
  }
  if (canvas.height !== height) {
    canvas.height = height;
  }

  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;

  if (window.drawingRouter && drawingRouter.konvaManager) {
    const panel = drawingRouter.konvaManager.getPanel('map-overlay');
    if (panel && typeof panel.resize === 'function') {
      panel.resize();
      if (typeof panel.syncWithMap === 'function') {
        panel.syncWithMap();
      }
    }
  }
}

window.selectTool = selectTool;
window.selectColor = selectColor;
window.toggleLineStyle = toggleLineStyle;
window.toggleFill = toggleFill;
window.updateFillOpacity = updateFillOpacity;
window.selectLineWidth = selectLineWidth;
window.undoLast = undoLast;
window.redoLast = redoLast;
window.clearAll = clearAll;
window.resizeMapCanvas = resizeMapCanvas;
window.toggleSunToolsPanel = toggleSunToolsPanel;
window.setSunMeasurementRole = setSunMeasurementRole;
window.setSunGroundPlane = setSunGroundPlane;
window.clearSunMeasurements = clearSunMeasurements;
window.calculateSunElevation = calculateSunElevation;
window.showSunToolsHelp = showSunToolsHelp;
window.hideSunToolsHelp = hideSunToolsHelp;

const sunHelpOverlay = document.getElementById('sunHelpOverlay');
if (sunHelpOverlay) {
  sunHelpOverlay.addEventListener('click', (event) => {
    if (event.target === sunHelpOverlay) {
      hideSunToolsHelp();
    }
  });
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    const overlay = document.getElementById('sunHelpOverlay');
    if (overlay && overlay.classList.contains('visible')) {
      hideSunToolsHelp();
    }
  }
});
