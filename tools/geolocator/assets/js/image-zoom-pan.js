/* ========== IMAGE ZOOM & PAN ========== */
let imageZoom = 1;
let imagePanX = 0;
let imagePanY = 0;
let isPanning = false;
let panStartX = 0;
let panStartY = 0;
let activePanPointerId = null;
let panRafPending = false;

const imageContainer = document.querySelector('.image-canvas-container');
if (imageContainer) {
  imageContainer.style.touchAction = 'none';
}

// Use centralized tool accessor from image-layers.js
function getActiveTool() {
  return window.getCurrentTool ? window.getCurrentTool() : 
    ((window.drawingRouter && drawingRouter.state && drawingRouter.state.tool) || 'pan');
}

imageContainer.addEventListener('wheel', (e) => {
  if (imageLayers.length === 0) return;
  
  e.preventDefault();
  
  const delta = e.deltaY > 0 ? 0.9 : 1.1;
  const newZoom = Math.max(0.1, Math.min(imageZoom * delta, 10));
  
  const rect = imageCanvas.getBoundingClientRect();
  const mouseX = e.clientX - rect.left;
  const mouseY = e.clientY - rect.top;
  
  imagePanX = mouseX - (mouseX - imagePanX) * (newZoom / imageZoom);
  imagePanY = mouseY - (mouseY - imagePanY) * (newZoom / imageZoom);
  
  imageZoom = newZoom;
  updateImageTransform();
}, { passive: false });

function isNonMousePointerEvent(event) {
  return event
    && typeof event.type === 'string'
    && event.type.startsWith('pointer')
    && event.pointerType
    && event.pointerType !== 'mouse';
}

function startImagePan(e) {
  const tool = getActiveTool();
  const leftClick = e.button === 0;
  const midClick = e.button === 1;
  
  // Check if we're using a drawing tool
  const isDrawingTool = window.drawingRouter && typeof window.drawingRouter.isDrawingTool === 'function' 
    ? window.drawingRouter.isDrawingTool(tool) 
    : false;
  
  // Only pan if: middle click OR (left click AND pan tool AND not drawing tool AND not dragging/resizing)
  if ((midClick || (leftClick && tool === 'pan' && !isDrawingTool)) && !isDraggingLayer && !isResizingLayer) {
    e.preventDefault();
    isPanning = true;
    panStartX = e.clientX - imagePanX;
    panStartY = e.clientY - imagePanY;
    imageContainer.classList.add('panning');
  }
}

function moveImagePan(e) {
  if (isPanning) {
    e.preventDefault();
    imagePanX = e.clientX - panStartX;
    imagePanY = e.clientY - panStartY;
    if (!panRafPending) {
      panRafPending = true;
      requestAnimationFrame(() => {
        panRafPending = false;
        updateImageTransform();
      });
    }
  }
}

function finishImagePan() {
  if (isPanning || activePanPointerId !== null) {
    isPanning = false;
    activePanPointerId = null;
    imageContainer.classList.remove('panning');
  }
}

imageContainer.addEventListener('mousedown', (e) => {
  startImagePan(e);
});

imageContainer.addEventListener('pointerdown', (e) => {
  if (!isNonMousePointerEvent(e)) return;
  activePanPointerId = e.pointerId;
  e.preventDefault();
  if (typeof imageContainer.setPointerCapture === 'function') {
    try {
      imageContainer.setPointerCapture(e.pointerId);
    } catch (_err) {
      // Ignore capture failures; global listeners still clean up pan state.
    }
  }
  startImagePan(e);
});

imageContainer.addEventListener('mousemove', (e) => {
  moveImagePan(e);
});

imageContainer.addEventListener('pointermove', (e) => {
  if (!isNonMousePointerEvent(e)) return;
  if (activePanPointerId !== null && e.pointerId !== activePanPointerId) return;
  e.preventDefault();
  moveImagePan(e);
});

imageContainer.addEventListener('mouseup', () => {
  finishImagePan();
});

imageContainer.addEventListener('pointerup', (e) => {
  if (!isNonMousePointerEvent(e)) return;
  if (activePanPointerId !== null && e.pointerId !== activePanPointerId) return;
  e.preventDefault();
  finishImagePan();
});

imageContainer.addEventListener('pointercancel', (e) => {
  if (!isNonMousePointerEvent(e)) return;
  if (activePanPointerId !== null && e.pointerId !== activePanPointerId) return;
  e.preventDefault();
  finishImagePan();
});

window.addEventListener('mouseup', () => {
  if (isPanning) {
    finishImagePan();
  }
}, true);

window.addEventListener('pointerup', (e) => {
  if (!isNonMousePointerEvent(e)) return;
  if (activePanPointerId !== null && e.pointerId !== activePanPointerId) return;
  finishImagePan();
}, true);

window.addEventListener('pointercancel', (e) => {
  if (!isNonMousePointerEvent(e)) return;
  if (activePanPointerId !== null && e.pointerId !== activePanPointerId) return;
  finishImagePan();
}, true);

window.addEventListener('blur', () => {
  finishImagePan();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') {
    finishImagePan();
  }
});

imageContainer.addEventListener('mouseleave', () => {
  if (isPanning || activePanPointerId !== null) {
    finishImagePan();
  }
});

imageContainer.addEventListener('dblclick', (e) => {
  if (e.target === imageContainer) {
    imageZoom = 1;
    imagePanX = 0;
    imagePanY = 0;
    updateImageTransform();
  }
});

function updateImageTransform() {
  if (typeof markProjectDirty === 'function') markProjectDirty();
  redrawAllLayers();
  syncImageOverlay();
}

function resetImageZoom() {
  if (typeof markProjectDirty === 'function') markProjectDirty();
  imageZoom = 1;
  imagePanX = 0;
  imagePanY = 0;
  redrawAllLayers();
  syncImageOverlay();
}

function syncImageOverlay() {
  if (!window.drawingRouter || !drawingRouter.konvaManager) return;
  const panel = drawingRouter.konvaManager.getPanel('image');
  if (!panel || typeof panel.applyViewportTransform !== 'function') return;
  panel.applyViewportTransform({
    scaleX: imageZoom,
    scaleY: imageZoom,
    translateX: imagePanX,
    translateY: imagePanY
  });
  if (typeof syncStickyNotesWithImageLayer === 'function') syncStickyNotesWithImageLayer();
}

// Sync will be called after drawingRouter is initialized and when images are loaded/transformed
