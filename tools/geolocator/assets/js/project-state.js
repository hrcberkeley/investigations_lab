(function() {
  const PROJECT_VERSION = 1;
  const MAX_PROJECT_IMAGE_BYTES = 45 * 1024 * 1024;
  const MAX_PROJECT_IMAGE_PIXELS = 60000000;
  const MAX_PROJECT_SINGLE_IMAGE_BYTES = 25 * 1024 * 1024;
  const MAX_PROJECT_SINGLE_IMAGE_PIXELS = 40000000;
  let projectDirty = false;

  function projectId() {
    return typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  function drawingId(shape) {
    let id = shape.getAttr('projectId');
    if (!id) {
      id = projectId();
      shape.setAttr('projectId', id);
    }
    return id;
  }

  function mapDrawingId(layer) {
    if (!layer._projectId) layer._projectId = projectId();
    return layer._projectId;
  }

  function noteProjectId(note) {
    if (!note.projectId) note.projectId = projectId();
    return note.projectId;
  }

  function serializeKonvaDrawings() {
    const drawings = [];
    if (!window.drawingRouter || !drawingRouter.konvaManager) return drawings;
    drawingRouter.konvaManager.panels.forEach((panel, panelKey) => {
      panel.shapes.forEach((shape) => {
        const state = panel.serializeShape(shape);
        if (state) drawings.push({ id: drawingId(shape), panelKey, state, label: shape.getAttr('layerLabel') || null, createdAt: shape.getAttr('layerCreatedAt') || null });
      });
    });
    return drawings;
  }

  function serializeMapDrawings() {
    if (!window.drawingRouter) return [];
    return [...drawingRouter.geomanLayers].map((layer) => ({
      id: mapDrawingId(layer),
      label: layer._layerLabel || null,
      createdAt: layer._layerCreatedAt || null,
      geojson: layer.toGeoJSON(),
      shapeType: layer instanceof L.Rectangle ? 'Rectangle' : layer instanceof L.Circle ? 'Circle' : null,
      circleRadius: layer instanceof L.Circle ? layer.getRadius() : null,
      style: {
        color: layer.options.color,
        weight: layer.options.weight,
        opacity: layer.options.opacity,
        fillColor: layer.options.fillColor,
        fill: layer.options.fill,
        fillOpacity: layer.options.fillOpacity,
        dashArray: layer.options.dashArray
      }
    }));
  }

  function serializeNotes() {
    return stickyNotes.map((note) => ({
      id: noteProjectId(note),
      panelKey: note.panelKey,
      worldPoint: note.worldPoint,
      mapLatLng: note.mapLatLng,
      anchorLayerId: note.anchorLayerId,
      anchorLocalPoint: note.anchorLocalPoint,
      text: note.element.querySelector('.sticky-note-textarea').value
    }));
  }

  function buildProject() {
    const center = map.getCenter();
    return {
      format: 'geolocator-project',
      version: PROJECT_VERSION,
      savedAt: new Date().toISOString(),
      map: {
        center: [center.lat, center.lng],
        zoom: map.getZoom(),
        bearing: typeof map.getBearing === 'function' ? map.getBearing() : 0,
        mode: mapMode
      },
      imageViewport: { zoom: imageZoom, panX: imagePanX, panY: imagePanY },
      images: imageLayers.map((layer, order) => ({
        id: layer.id,
        order,
        name: layer.name,
        src: /\/protractor\.png(?:\?.*)?$/.test(layer.image.src) ? 'protractor.png' : layer.image.src,
        x: layer.x,
        y: layer.y,
        opacity: layer.opacity,
        visible: layer.visible,
        scale: layer.scale,
        rotation: layer.rotation || 0
      })),
      drawings: serializeKonvaDrawings(),
      mapDrawings: serializeMapDrawings(),
      notes: serializeNotes()
    };
  }

  function downloadProject(backup = false) {
    const project = buildProject();
    const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    link.href = url;
    link.download = `geolocator-${backup ? 'backup' : 'project'}-${stamp}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    if (!backup) projectDirty = false;
    showToast(backup ? 'Current project backed up.' : 'Project saved.', { type: 'success' });
  }

  function createShape(state) {
    const common = {
      stroke: state.stroke,
      strokeWidth: state.strokeWidth,
      dash: state.dash || [],
      fill: state.fill,
      shapeType: state.type
    };
    if (state.type === 'rect') return new Konva.Rect({ ...common });
    if (state.type === 'ellipse') return new Konva.Ellipse({ ...common });
    if (state.type === 'circle') return new Konva.Circle({ ...common });
    if (state.type === 'arrow') return new Konva.Arrow({ ...common, pointerLength: 14, pointerWidth: 14 });
    if (['line', 'polygon', 'freehand'].includes(state.type)) {
      return new Konva.Line({ ...common, closed: state.type === 'polygon', lineCap: 'round', lineJoin: 'round' });
    }
    if (state.type === 'text') return new Konva.Text({ ...common });
    return null;
  }

  function decodeImageLayer(data) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => {
        const id = Number(data.id);
        if (image.naturalWidth * image.naturalHeight > MAX_PROJECT_SINGLE_IMAGE_PIXELS) {
          reject(new Error(`Image "${data.name || 'Image'}" exceeds the 40 megapixel limit.`));
          return;
        }
        resolve({
          id,
          name: String(data.name || 'Image'),
          image,
          x: Number(data.x) || 0,
          y: Number(data.y) || 0,
          opacity: Number.isFinite(Number(data.opacity)) ? Number(data.opacity) : 1,
          visible: data.visible !== false,
          scale: Math.max(0.1, Math.min(3, Number(data.scale) || 1)),
          rotation: Number(data.rotation) || 0
        });
      };
      image.onerror = () => reject(new Error(`Could not restore image "${data.name || 'Image'}".`));
      image.src = data.src;
    });
  }

  function clearCurrentProject() {
    [...stickyNotes].forEach((note) => deleteStickyNote(note.id, false));
    drawingRouter.clearAllShapes();
    imageLayers = [];
    selectedLayerId = null;
    _imageLayerIdCounter = 0;
    updateLayersList();
  }

  function restoreMapDrawings(items) {
    items.forEach((item) => {
      let group;
      if (item.circleRadius && item.geojson.geometry?.type === 'Point') {
        group = L.layerGroup([L.circle([item.geojson.geometry.coordinates[1], item.geojson.geometry.coordinates[0]], { ...item.style, radius: item.circleRadius })]);
      } else if (item.shapeType === 'Rectangle' && item.geojson.geometry?.type === 'Polygon') {
        const corners = item.geojson.geometry.coordinates[0].map(([lng, lat]) => [lat, lng]);
        group = L.layerGroup([L.rectangle(L.latLngBounds(corners), item.style)]);
      } else {
        group = L.geoJSON(item.geojson, { style: item.style });
      }
      group.eachLayer((layer) => {
        layer._projectId = item.id || projectId();
        if (item.label) layer._layerLabel = item.label;
        if (item.createdAt) layer._layerCreatedAt = item.createdAt;
        layer.addTo(map);
        drawingRouter.geomanLayers.add(layer);
        if (window.drawingLayerRegistry) drawingLayerRegistry.registerLeafletLayer(layer);
      });
    });
  }

  function restoreKonvaDrawings(items) {
    items.forEach((item) => {
      const panel = drawingRouter.konvaManager.getPanel(item.panelKey);
      if (!panel) return;
      const shape = createShape(item.state);
      if (!shape) return;
      shape.setAttr('projectId', item.id || projectId());
      if (item.label) shape.setAttr('layerLabel', item.label);
      if (item.createdAt) shape.setAttr('layerCreatedAt', item.createdAt);
      panel.addShape(shape);
      panel.applyShapeState(shape, item.state);
    });
  }

  function restoreNotes(items) {
    items.forEach((item) => {
      const panel = drawingRouter.konvaManager.getPanel(item.panelKey);
      if (!panel) return;
      const point = item.worldPoint || { x: 40, y: 40 };
      const note = createStickyNote(point.x, point.y, panel.container, item.panelKey, false, false);
      note.projectId = item.id || projectId();
      note.worldPoint = point;
      note.mapLatLng = item.mapLatLng;
      note.anchorLayerId = item.anchorLayerId;
      note.anchorLocalPoint = item.anchorLocalPoint;
      note.element.querySelector('.sticky-note-textarea').value = String(item.text || '');
      if (item.panelKey === 'map-overlay') syncStickyNotesWithMap();
      if (item.panelKey === 'image') syncStickyNotesWithImageLayer();
    });
  }

  function validateProject(project) {
    if (!project || project.format !== 'geolocator-project' || project.version !== PROJECT_VERSION) {
      throw new Error('This is not a supported Geolocator project file.');
    }
    if (!Array.isArray(project.images) || !Array.isArray(project.drawings) || !Array.isArray(project.mapDrawings) || !Array.isArray(project.notes)) {
      throw new Error('The project file is incomplete.');
    }
    if (project.images.length > 100 || project.drawings.length > 5000 || project.mapDrawings.length > 1000 || project.notes.length > 1000) {
      throw new Error('The project contains too many layers or annotations.');
    }
    const ids = new Set();
    const finite = (value, limit = 10000000) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= limit;
    let imageBytes = 0;
    project.images.forEach((item) => {
      const id = Number(item.id);
      if (!Number.isSafeInteger(id) || id < 1 || ids.has(id)) throw new Error('The project has invalid or duplicate image IDs.');
      ids.add(id);
      if (typeof item.src !== 'string' || !(/^data:image\/(?:png|jpeg|webp|gif|bmp|avif|heic|heif);base64,[A-Za-z0-9+/=]+$/i.test(item.src) || item.src === 'protractor.png')) {
        throw new Error('The project contains an unsupported image source.');
      }
      if (item.src.length > MAX_PROJECT_SINGLE_IMAGE_BYTES * 4 / 3 + 1024) throw new Error('An image exceeds the project import limit.');
      if (item.src.startsWith('data:')) imageBytes += Math.floor(item.src.length * 0.75);
      if (item.order != null && (!Number.isSafeInteger(item.order) || item.order < 0 || item.order > 99)) throw new Error('The project has an invalid image order.');
      if (typeof item.name !== 'string' || item.name.length > 300 || !finite(item.x) || !finite(item.y) || !finite(item.opacity, 1) || item.opacity < 0 || !finite(item.scale, 3) || item.scale < 0.1 || typeof item.visible !== 'boolean' || (item.rotation != null && !finite(item.rotation, 360))) throw new Error('The project has invalid image settings.');
    });
    if (imageBytes > MAX_PROJECT_IMAGE_BYTES) throw new Error('Project images exceed the 45 MB total limit.');
    ['drawings', 'mapDrawings', 'notes'].forEach((key) => {
      const seen = new Set();
      project[key].forEach((item) => {
        if (item.id != null) {
          if (typeof item.id !== 'string' || item.id.length > 100 || seen.has(item.id)) throw new Error(`The project has invalid ${key} IDs.`);
          seen.add(item.id);
        }
      });
    });
    ['drawings', 'mapDrawings'].forEach((key) => project[key].forEach((item) => {
      if (item.label != null && (typeof item.label !== 'string' || item.label.length > 300)) throw new Error(`The project has an invalid ${key} label.`);
      if (item.createdAt != null && (!Number.isSafeInteger(item.createdAt) || item.createdAt < 0)) throw new Error(`The project has an invalid ${key} timestamp.`);
    }));
    project.drawings.forEach((item) => {
      if (!['image', 'map-overlay'].includes(item.panelKey) || !item.state || !['rect', 'ellipse', 'circle', 'arrow', 'line', 'polygon', 'freehand', 'text'].includes(item.state.type)) {
        throw new Error('The project contains an unsupported drawing.');
      }
      const state = item.state;
      ['x', 'y', 'width', 'height', 'radius', 'radiusX', 'radiusY', 'strokeWidth', 'rotation', 'scaleX', 'scaleY', 'skewX', 'skewY', 'offsetX', 'offsetY', 'fontSize'].forEach((field) => {
        if (state[field] != null && !finite(state[field])) throw new Error('The project has invalid drawing coordinates.');
      });
      if (state.points != null && (!Array.isArray(state.points) || state.points.length > 20000 || state.points.some((value) => !finite(value)))) throw new Error('The project has invalid drawing points.');
      if (state.strokeWidth != null && (state.strokeWidth < 0 || state.strokeWidth > 100)) throw new Error('The project has invalid drawing width.');
      if (state.fontSize != null && (state.fontSize < 1 || state.fontSize > 500)) throw new Error('The project has invalid drawing font size.');
      if (state.anchorLayerId != null && (!Number.isSafeInteger(state.anchorLayerId) || state.anchorLayerId < 1)) throw new Error('The project has an invalid drawing anchor.');
      if (state.text != null && (typeof state.text !== 'string' || state.text.length > 10000)) throw new Error('The project has invalid drawing text.');
      if (state.stroke != null && (typeof state.stroke !== 'string' || state.stroke.length > 100)) throw new Error('The project has invalid drawing color.');
      if (state.fill != null && (typeof state.fill !== 'string' || state.fill.length > 100)) throw new Error('The project has invalid drawing fill.');
    });
    project.mapDrawings.forEach((item) => {
      const feature = item.geojson;
      const geometry = feature?.geometry;
      if (feature?.type !== 'Feature' || !geometry || !['Point', 'LineString', 'Polygon', 'MultiPolygon'].includes(geometry.type) || !item.style || typeof item.style !== 'object') throw new Error('The project has invalid map geometry.');
      let count = 0;
      function checkCoordinates(coords, depth = 0) {
        if (!Array.isArray(coords) || depth > 5 || coords.length > 10000) throw new Error('The project has invalid map coordinates.');
        if (coords.length >= 2 && typeof coords[0] === 'number') {
          count++;
          if (count > 10000 || !finite(coords[0], 180) || !finite(coords[1], 90)) throw new Error('The project has invalid map coordinates.');
          return;
        }
        coords.forEach((child) => checkCoordinates(child, depth + 1));
      }
      checkCoordinates(geometry.coordinates);
      if (item.circleRadius != null && (!finite(item.circleRadius, 20000000) || item.circleRadius <= 0 || geometry.type !== 'Point')) throw new Error('The project has an invalid circle.');
      if (item.shapeType != null && !['Rectangle', 'Circle'].includes(item.shapeType)) throw new Error('The project has an invalid map shape.');
      if (item.shapeType === 'Rectangle' && geometry.type !== 'Polygon') throw new Error('The project has an invalid rectangle.');
      ['color', 'fillColor', 'dashArray'].forEach((field) => {
        if (item.style[field] != null && (typeof item.style[field] !== 'string' || item.style[field].length > 100)) throw new Error('The project has invalid map styling.');
      });
      ['weight', 'opacity', 'fillOpacity'].forEach((field) => {
        if (item.style[field] != null && !finite(item.style[field], 100)) throw new Error('The project has invalid map styling.');
      });
      if (item.style.weight != null && (item.style.weight < 0 || item.style.weight > 100)) throw new Error('The project has invalid map width.');
      if (item.style.opacity != null && (item.style.opacity < 0 || item.style.opacity > 1)) throw new Error('The project has invalid map opacity.');
      if (item.style.fillOpacity != null && (item.style.fillOpacity < 0 || item.style.fillOpacity > 1)) throw new Error('The project has invalid map fill opacity.');
      if (item.style.fill != null && typeof item.style.fill !== 'boolean') throw new Error('The project has invalid map fill.');
    });
    project.notes.forEach((item) => {
      if (!['image', 'map-overlay'].includes(item.panelKey) || typeof item.text !== 'string' || item.text.length > 10000) {
        throw new Error('The project contains an unsupported note.');
      }
      if (!item.worldPoint || !finite(item.worldPoint.x) || !finite(item.worldPoint.y)) throw new Error('The project has invalid note coordinates.');
      if (item.mapLatLng != null && (!Array.isArray(item.mapLatLng) || item.mapLatLng.length !== 2 || !finite(item.mapLatLng[0], 90) || !finite(item.mapLatLng[1], 180))) throw new Error('The project has invalid note map position.');
      if (item.anchorLayerId != null && (!Number.isSafeInteger(item.anchorLayerId) || item.anchorLayerId < 1)) throw new Error('The project has an invalid note anchor.');
      if (item.anchorLocalPoint != null && (!finite(item.anchorLocalPoint.x) || !finite(item.anchorLocalPoint.y))) throw new Error('The project has an invalid note anchor position.');
    });
    if (project.map?.center != null && (!Array.isArray(project.map.center) || project.map.center.length !== 2 || !finite(project.map.center[0], 90) || !finite(project.map.center[1], 180))) throw new Error('The project has an invalid map center.');
    if (project.map?.zoom != null && (!finite(project.map.zoom, 30) || project.map.zoom < 0)) throw new Error('The project has an invalid map zoom.');
    if (project.map?.mode != null && !['places', 'ground', 'draw', 'los', 'angles'].includes(project.map.mode)) throw new Error('The project has an invalid map mode.');
    if (project.imageViewport != null && (!finite(project.imageViewport.zoom, 10) || project.imageViewport.zoom <= 0 || !finite(project.imageViewport.panX) || !finite(project.imageViewport.panY))) throw new Error('The project has an invalid image viewport.');
    return project;
  }

  async function applyProject(project, rollback = true) {
    validateProject(project);
    const decoded = [];
    let imagePixels = 0;
    for (const item of project.images) {
      const layer = await decodeImageLayer(item);
      imagePixels += layer.image.naturalWidth * layer.image.naturalHeight;
      if (imagePixels > MAX_PROJECT_IMAGE_PIXELS) throw new Error('Project images exceed the 60 megapixel total limit.');
      decoded.push(layer);
    }
    const previous = rollback ? buildProject() : null;
    const wasDirty = projectDirty;
    try {
      clearCurrentProject();
      imageLayers = decoded;
      _imageLayerIdCounter = decoded.reduce((max, layer) => Math.max(max, layer.id), 0);

      const hasImages = imageLayers.length > 0;
      document.querySelector('.no-image').style.display = hasImages ? 'none' : 'flex';
      document.querySelector('.image-canvas-container').style.display = hasImages ? 'flex' : 'none';
      if (hasImages) {
        imagePanel.classList.remove('hidden');
        initializeCanvas();
      }

      imageZoom = Number(project.imageViewport?.zoom) || 1;
      imagePanX = Number(project.imageViewport?.panX) || 0;
      imagePanY = Number(project.imageViewport?.panY) || 0;
      redrawAllLayers();
      syncImageOverlay();
      restoreMapDrawings(project.mapDrawings);
      restoreKonvaDrawings(project.drawings);
      restoreNotes(project.notes);
      updateLayersList();

      if (Array.isArray(project.map?.center) && project.map.center.length === 2) {
        map.setView(project.map.center, Number(project.map.zoom) || map.getZoom());
        if (typeof map.setBearing === 'function') map.setBearing(Number(project.map.bearing) || 0);
      }
      if (project.map?.mode && typeof setMapMode === 'function' && project.map.mode !== mapMode) setMapMode(project.map.mode);

      drawingRouter.undoStack = [];
      drawingRouter.redoStack = [];
      projectDirty = false;
      if (rollback) showToast('Project loaded.', { type: 'success' });
    } catch (error) {
      if (previous) {
        try {
          await applyProject(previous, false);
          projectDirty = wasDirty;
        } catch (restoreError) {
          console.error('Project rollback failed:', restoreError);
        }
      }
      throw error;
    }
  }

  async function applyEntity(kind, id, data, appendNew = false) {
    if (!['images', 'drawings', 'mapDrawings', 'notes', 'imageOrder'].includes(kind)) throw new Error('Unsupported shared edit.');
    if (data && String(data.id) !== String(id)) throw new Error('Shared edit ID does not match its item.');
    if (kind === 'imageOrder') {
      if (id !== 'all' || !data || !Array.isArray(data.list) || data.list.length > 100 || new Set(data.list).size !== data.list.length || data.list.some((value) => !Number.isSafeInteger(value) || value < 1)) throw new Error('Invalid image order.');
      const byId = new Map(imageLayers.map((layer) => [layer.id, layer]));
      imageLayers = data.list.filter((value) => byId.has(value)).map((value) => byId.get(value)).concat(imageLayers.filter((layer) => !data.list.includes(layer.id)));
      updateLayersList();
      redrawAllLayers();
      markProjectDirty();
      return;
    }
    if (kind === 'images' && data && data.src == null) {
      const existing = imageLayers.find((layer) => layer.id === Number(id));
      if (!existing) throw new Error('Image settings arrived before the image.');
      const source = /\/protractor\.png(?:\?.*)?$/.test(existing.image.src) ? 'protractor.png' : existing.image.src;
      data = { ...data, src: source };
    }
    if (data) validateProject({ format: 'geolocator-project', version: PROJECT_VERSION, images: kind === 'images' ? [data] : [], drawings: kind === 'drawings' ? [data] : [], mapDrawings: kind === 'mapDrawings' ? [data] : [], notes: kind === 'notes' ? [data] : [] });

    if (kind === 'images') {
      const index = imageLayers.findIndex((layer) => layer.id === Number(id));
      if (!data) {
        if (index >= 0) removeLayer(Number(id));
      } else if (index < 0 || (/\/protractor\.png(?:\?.*)?$/.test(imageLayers[index].image.src) ? 'protractor.png' : imageLayers[index].image.src) !== data.src) {
        const layer = await decodeImageLayer(data);
        if (index >= 0) imageLayers.splice(index, 1, layer);
        else imageLayers.push(layer);
        _imageLayerIdCounter = Math.max(_imageLayerIdCounter, layer.id);
      } else {
        const layer = imageLayers[index];
        layer.name = data.name;
        layer.x = data.x;
        layer.y = data.y;
        layer.opacity = data.opacity;
        layer.visible = data.visible;
        layer.scale = data.scale;
        layer.rotation = data.rotation;
      }
      if (data && Number.isSafeInteger(data.order) && !appendNew) {
        const currentIndex = imageLayers.findIndex((layer) => layer.id === Number(id));
        if (currentIndex >= 0) {
          const [layer] = imageLayers.splice(currentIndex, 1);
          imageLayers.splice(Math.min(data.order, imageLayers.length), 0, layer);
        }
      }
      const hasImages = imageLayers.length > 0;
      document.querySelector('.no-image').style.display = hasImages ? 'none' : 'flex';
      document.querySelector('.image-canvas-container').style.display = hasImages ? 'flex' : 'none';
      if (hasImages) {
        imagePanel.classList.remove('hidden');
        initializeCanvas();
      }
      redrawAllLayers();
      syncImageOverlay();
      updateLayersList();
    } else if (kind === 'drawings') {
      let updated = false;
      drawingRouter.konvaManager.panels.forEach((panel) => {
        [...panel.shapes].forEach((shape) => {
          if (shape.getAttr('projectId') !== id) return;
          if (data && panel.key === data.panelKey && shape.getAttr('shapeType') === data.state.type) {
            panel.applyShapeState(shape, data.state);
            updated = true;
          } else {
            panel.removeShape(shape);
          }
        });
      });
      if (data && !updated) restoreKonvaDrawings([data]);
    } else if (kind === 'mapDrawings') {
      [...drawingRouter.geomanLayers].forEach((layer) => {
        if (layer._projectId !== id) return;
        map.removeLayer(layer);
        drawingRouter.geomanLayers.delete(layer);
        if (window.drawingLayerRegistry) drawingLayerRegistry.unregisterLeafletLayer(layer);
      });
      if (data) restoreMapDrawings([data]);
    } else {
      const note = stickyNotes.find((candidate) => candidate.projectId === id);
      if (!data) {
        if (note) deleteStickyNote(note.id, false);
      } else if (!note || note.panelKey !== data.panelKey) {
        if (note) deleteStickyNote(note.id, false);
        restoreNotes([data]);
      } else {
        note.worldPoint = data.worldPoint;
        note.mapLatLng = data.mapLatLng;
        note.anchorLayerId = data.anchorLayerId;
        note.anchorLocalPoint = data.anchorLocalPoint;
        note.element.querySelector('.sticky-note-textarea').value = data.text;
        setStickyNotePosition(note);
      }
    }
    markProjectDirty();
  }

  async function loadProjectFile(input) {
    const file = input.files && input.files[0];
    input.value = '';
    if (!file) return;
    if (window.GeolocatorCollaboration && GeolocatorCollaboration.active()) {
      showToast('End the live session before loading another project.', { type: 'error' });
      return;
    }
    if (file.size > 100 * 1024 * 1024) {
      showToast('Project files must be under 100 MB.', { type: 'error' });
      return;
    }
    try {
      const project = JSON.parse(await file.text());
      validateProject(project);
      const existing = buildProject();
      if (existing.images.length || existing.drawings.length || existing.mapDrawings.length || existing.notes.length) downloadProject(true);
      await applyProject(project);
    } catch (error) {
      console.error('Project load failed:', error);
      showToast(`Project could not be loaded: ${error.message}`, { type: 'error', duration: 8000 });
    }
  }

  function markProjectDirty() {
    projectDirty = true;
  }

  window.addEventListener('beforeunload', (event) => {
    if (!projectDirty) return;
    event.preventDefault();
    event.returnValue = '';
  });

  window.downloadProject = downloadProject;
  window.loadProjectFile = loadProjectFile;
  window.markProjectDirty = markProjectDirty;
  window.GeolocatorProject = { build: buildProject, apply: applyProject, applyEntity: applyEntity, validate: validateProject };
})();
