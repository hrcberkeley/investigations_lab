let stickyNotes = [];
let draggedNote = null;
let dragOffsetNoteX = 0;
let dragOffsetNoteY = 0;
let noteIdCounter = 0;

function setStickyNotePosition(note) {
  let point = note.worldPoint;
  let visible = true;

  if (note.panelKey === 'map-overlay' && note.mapLatLng && window.map) {
    point = map.latLngToContainerPoint(note.mapLatLng);
  } else if (note.panelKey === 'image' && note.anchorLayerId != null && window.imageLayers) {
    const layer = window.imageLayers.find((candidate) => candidate.id === note.anchorLayerId);
    if (layer && note.anchorLocalPoint) {
      point = layerCoordsToWorld(note.anchorLocalPoint, layer);
      visible = layer.visible;
    } else {
      visible = false;
    }
  }

  if (!point) return;
  const screenPoint = note.panelKey === 'image'
    ? { x: point.x * imageZoom + imagePanX, y: point.y * imageZoom + imagePanY }
    : point;
  note.element.style.left = `${screenPoint.x}px`;
  note.element.style.top = `${screenPoint.y}px`;
  note.element.hidden = !visible;
}

function attachStickyNote(note) {
  if (!note.element.isConnected) note.container.appendChild(note.element);
  if (!stickyNotes.includes(note)) stickyNotes.push(note);
  setStickyNotePosition(note);
}

function detachStickyNote(note) {
  note.element.remove();
  stickyNotes = stickyNotes.filter((candidate) => candidate !== note);
}

function createStickyNote(x, y, container, panelKey = 'image', record = true, focus = true) {
  const noteId = `note-${noteIdCounter++}`;
  const noteDiv = document.createElement('div');
  noteDiv.className = 'sticky-note';
  noteDiv.id = noteId;
  noteDiv.innerHTML = '<div class="sticky-note-header"><span class="sticky-note-drag-handle">⠿⠿</span><button class="sticky-note-delete" type="button" title="Delete note" aria-label="Delete note">×</button></div><textarea class="sticky-note-textarea" placeholder="Type your note here..."></textarea>';

  const note = {
    id: noteId,
    element: noteDiv,
    container,
    panelKey,
    worldPoint: { x, y },
    mapLatLng: null,
    anchorLayerId: null,
    anchorLocalPoint: null
  };

  if (panelKey === 'map-overlay' && window.map) {
    const latLng = map.containerPointToLatLng([x, y]);
    note.mapLatLng = [latLng.lat, latLng.lng];
  } else if (panelKey === 'image' && typeof findTopVisibleLayerAt === 'function') {
    const hit = findTopVisibleLayerAt(x, y);
    const layer = hit ? hit.layer : null;
    if (layer) {
      note.anchorLayerId = layer.id;
      note.anchorLocalPoint = worldToLayerCoords(x, y, layer, { allowOutside: true });
    }
  }

  attachStickyNote(note);
  noteDiv.querySelector('.sticky-note-header').addEventListener('pointerdown', (event) => startDragNote(event, note));
  noteDiv.querySelector('.sticky-note-delete').addEventListener('click', (event) => {
    event.stopPropagation();
    deleteStickyNote(note.id);
  });
  noteDiv.querySelector('.sticky-note-textarea').addEventListener('input', () => {
    if (typeof markProjectDirty === 'function') markProjectDirty();
  });

  if (record && window.drawingRouter && typeof drawingRouter.recordCommand === 'function') {
    drawingRouter.recordCommand({
      type: 'note-add',
      note,
      undo: () => detachStickyNote(note),
      redo: () => attachStickyNote(note)
    });
  }

  if (focus) setTimeout(() => noteDiv.querySelector('.sticky-note-textarea').focus(), 100);
  return note;
}

function startDragNote(event, note) {
  event.preventDefault();
  event.stopPropagation();
  draggedNote = note;
  note.element.classList.add('dragging');
  const rect = note.element.getBoundingClientRect();
  dragOffsetNoteX = event.clientX - rect.left;
  dragOffsetNoteY = event.clientY - rect.top;
  if (typeof note.element.setPointerCapture === 'function') note.element.setPointerCapture(event.pointerId);
}

document.addEventListener('pointermove', (event) => {
  if (!draggedNote) return;
  event.preventDefault();
  const containerRect = draggedNote.container.getBoundingClientRect();
  const screenX = Math.max(0, Math.min(event.clientX - containerRect.left - dragOffsetNoteX, containerRect.width - draggedNote.element.offsetWidth));
  const screenY = Math.max(0, Math.min(event.clientY - containerRect.top - dragOffsetNoteY, containerRect.height - draggedNote.element.offsetHeight));
  draggedNote.element.style.left = `${screenX}px`;
  draggedNote.element.style.top = `${screenY}px`;

  if (draggedNote.panelKey === 'map-overlay') {
    const latLng = map.containerPointToLatLng([screenX, screenY]);
    draggedNote.mapLatLng = [latLng.lat, latLng.lng];
  } else {
    const worldX = (screenX - imagePanX) / imageZoom;
    const worldY = (screenY - imagePanY) / imageZoom;
    draggedNote.worldPoint = { x: worldX, y: worldY };
    const hit = typeof findTopVisibleLayerAt === 'function' ? findTopVisibleLayerAt(worldX, worldY) : null;
    const layer = hit ? hit.layer : null;
    draggedNote.anchorLayerId = layer ? layer.id : null;
    draggedNote.anchorLocalPoint = layer ? worldToLayerCoords(worldX, worldY, layer, { allowOutside: true }) : null;
  }
});

function finishStickyNoteDrag() {
  if (!draggedNote) return;
  draggedNote.element.classList.remove('dragging');
  draggedNote = null;
  if (typeof markProjectDirty === 'function') markProjectDirty();
}

document.addEventListener('pointerup', finishStickyNoteDrag);
document.addEventListener('pointercancel', finishStickyNoteDrag);

function deleteStickyNote(noteId, record = true) {
  const note = stickyNotes.find((candidate) => candidate.id === noteId);
  if (!note) return;
  detachStickyNote(note);
  if (record && window.drawingRouter && typeof drawingRouter.recordCommand === 'function') {
    drawingRouter.recordCommand({
      type: 'note-delete',
      note,
      undo: () => attachStickyNote(note),
      redo: () => detachStickyNote(note)
    });
  }
}

function syncStickyNotesWithMap() {
  stickyNotes.filter((note) => note.panelKey === 'map-overlay').forEach(setStickyNotePosition);
}

function syncStickyNotesWithImageLayer(layerId) {
  stickyNotes
    .filter((note) => note.panelKey === 'image' && (layerId == null || note.anchorLayerId === layerId))
    .forEach(setStickyNotePosition);
}

function removeStickyNotesForImageLayer(layerId) {
  stickyNotes
    .filter((note) => note.anchorLayerId === layerId)
    .forEach((note) => deleteStickyNote(note.id, false));
}

window.createStickyNote = createStickyNote;
window.deleteStickyNote = deleteStickyNote;
window.syncStickyNotesWithMap = syncStickyNotesWithMap;
window.syncStickyNotesWithImageLayer = syncStickyNotesWithImageLayer;
window.removeStickyNotesForImageLayer = removeStickyNotesForImageLayer;
