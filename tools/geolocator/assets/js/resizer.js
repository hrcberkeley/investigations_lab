const resizer = document.getElementById('resizer');
const mapPanel = document.querySelector('.map-panel');
const imagePanel = document.getElementById('imagePanel');
const contentContainer = document.querySelector('.content-container');
let isResizing = false;
let activeResizePointer = null;
let resizerRafPending = false;

function isStackedLayout() {
  return window.matchMedia('(max-width: 800px)').matches;
}

function refreshPanels() {
  if (resizerRafPending) return;
  resizerRafPending = true;
  requestAnimationFrame(() => {
    resizerRafPending = false;
    map.invalidateSize();
    if (typeof resizeMapCanvas === 'function') resizeMapCanvas();
    if (typeof imageLayers !== 'undefined' && imageLayers.length > 0 && typeof initializeCanvas === 'function') {
      initializeCanvas();
      redrawAllLayers();
    }
    if (window.drawingRouter && window.drawingRouter.konvaManager) {
      window.drawingRouter.konvaManager.panels.forEach((panel) => panel.resize());
    }
  });
}

function setPanelSplit(percent) {
  const value = Math.max(20, Math.min(80, percent));
  mapPanel.style.flex = `0 0 ${value}%`;
  imagePanel.style.flex = `0 0 ${100 - value}%`;
  resizer.setAttribute('aria-valuenow', Math.round(value));
  refreshPanels();
}

function beginResize(event) {
  event.preventDefault();
  isResizing = true;
  activeResizePointer = event.pointerId;
  if (typeof resizer.setPointerCapture === 'function') resizer.setPointerCapture(event.pointerId);
  document.body.style.cursor = isStackedLayout() ? 'row-resize' : 'col-resize';
  document.body.style.userSelect = 'none';
  document.body.classList.add('resizing');
}

function moveResize(event) {
  if (!isResizing || event.pointerId !== activeResizePointer) return;
  event.preventDefault();
  const rect = contentContainer.getBoundingClientRect();
  const percent = isStackedLayout()
    ? ((event.clientY - rect.top) / rect.height) * 100
    : ((event.clientX - rect.left) / rect.width) * 100;
  setPanelSplit(percent);
}

function finishResize(event) {
  if (!isResizing || (event.pointerId != null && event.pointerId !== activeResizePointer)) return;
  isResizing = false;
  activeResizePointer = null;
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
  document.body.classList.remove('resizing');
}

resizer.addEventListener('pointerdown', beginResize);
resizer.addEventListener('pointermove', moveResize);
resizer.addEventListener('pointerup', finishResize);
resizer.addEventListener('pointercancel', finishResize);
resizer.addEventListener('keydown', (event) => {
  const stacked = isStackedLayout();
  const decrease = stacked ? event.key === 'ArrowUp' : event.key === 'ArrowLeft';
  const increase = stacked ? event.key === 'ArrowDown' : event.key === 'ArrowRight';
  if (!decrease && !increase) return;
  event.preventDefault();
  const current = parseFloat(resizer.getAttribute('aria-valuenow')) || 50;
  setPanelSplit(current + (increase ? 5 : -5));
});

function updateResizerOrientation() {
  resizer.setAttribute('aria-orientation', isStackedLayout() ? 'horizontal' : 'vertical');
  contentContainer.scrollLeft = 0;
  contentContainer.scrollTop = 0;
  refreshPanels();
}

window.addEventListener('resize', updateResizerOrientation);
updateResizerOrientation();
