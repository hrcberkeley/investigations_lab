(function() {
  if (typeof map === 'undefined') {
    console.error('Grid overlay requires the global map instance.');
    return;
  }

  const GRID_MIN_KM = 0.1;
  const DEFAULT_GRID_KM = 1;
  let gridEnabled = false;
  let gridSizeKm = DEFAULT_GRID_KM;
  let gridThicknessPx = 1;
  const gridLayer = L.layerGroup();

  const menuContainer = document.getElementById('mapGridMenu');
  let menuLauncherButton = null;
  let menuOpen = false;

  function clampGridSize(value) {
    const MAX_GRID_KM = 100;
    if (Number.isNaN(value) || !Number.isFinite(value) || value <= 0) {
      console.warn(`Invalid grid size: ${value}, using default ${gridSizeKm}`);
      return gridSizeKm;
    }
    const clamped = Math.max(GRID_MIN_KM, Math.min(MAX_GRID_KM, value));
    if (clamped !== value) {
      console.warn(`Grid size ${value} clamped to ${clamped} (range: ${GRID_MIN_KM}-${MAX_GRID_KM})`);
    }
    return clamped;
  }

  function formatInputValue(value) {
    return Number.parseFloat(value.toFixed(2));
  }

  function clampThickness(value) {
    const min = 1;
    const max = 5;
    if (Number.isNaN(value) || !Number.isFinite(value) || value <= 0) {
      console.warn(`Invalid thickness: ${value}, using default ${gridThicknessPx}`);
      return gridThicknessPx;
    }
    const clamped = Math.max(min, Math.min(max, Math.round(value)));
    if (clamped !== value) {
      console.warn(`Thickness ${value} clamped to ${clamped} (range: ${min}-${max})`);
    }
    return clamped;
  }

  function updateGrid() {
    if (!gridEnabled) {
      return;
    }

    const cellSizeMeters = gridSizeKm * 1000;
    if (cellSizeMeters <= 0) {
      return;
    }

    const bounds = map.getBounds().pad(0.5);
    const crs = map.options.crs || L.CRS.EPSG3857;
    const southWest = crs.project(bounds.getSouthWest());
    const northEast = crs.project(bounds.getNorthEast());

    const minX = Math.min(southWest.x, northEast.x);
    const maxX = Math.max(southWest.x, northEast.x);
    const minY = Math.min(southWest.y, northEast.y);
    const maxY = Math.max(southWest.y, northEast.y);

    const startX = Math.floor(minX / cellSizeMeters) * cellSizeMeters;
    const endX = Math.ceil(maxX / cellSizeMeters) * cellSizeMeters;
    const startY = Math.floor(minY / cellSizeMeters) * cellSizeMeters;
    const endY = Math.ceil(maxY / cellSizeMeters) * cellSizeMeters;

    gridLayer.clearLayers();

    for (let x = startX; x <= endX; x += cellSizeMeters) {
      const startPoint = L.point(x, minY);
      const endPoint = L.point(x, maxY);
      const startLatLng = crs.unproject(startPoint);
      const endLatLng = crs.unproject(endPoint);
      const line = L.polyline([startLatLng, endLatLng], {
        color: '#FFD700',
        opacity: 0.35,
        weight: gridThicknessPx,
        interactive: false
      });
      gridLayer.addLayer(line);
    }

    for (let y = startY; y <= endY; y += cellSizeMeters) {
      const startPoint = L.point(minX, y);
      const endPoint = L.point(maxX, y);
      const startLatLng = crs.unproject(startPoint);
      const endLatLng = crs.unproject(endPoint);
      const line = L.polyline([startLatLng, endLatLng], {
        color: '#FFD700',
        opacity: 0.35,
        weight: gridThicknessPx,
        interactive: false
      });
      gridLayer.addLayer(line);
    }
  }

  const toggleBtn = document.getElementById('mapGridToggle');
  const sizeInput = document.getElementById('mapGridSize');
  const thicknessInput = document.getElementById('mapGridThickness');

  function setMenuOpen(open) {
    menuOpen = open;
    if (menuContainer) {
      if (open) {
        menuContainer.classList.add('open');
        menuContainer.removeAttribute('hidden');
        menuContainer.setAttribute('aria-hidden', 'false');
        if (typeof menuContainer.focus === 'function') {
          menuContainer.focus();
        }
      } else {
        menuContainer.classList.remove('open');
        menuContainer.setAttribute('hidden', '');
        menuContainer.setAttribute('aria-hidden', 'true');
      }
    }

    if (menuLauncherButton) {
      menuLauncherButton.classList.toggle('open', open);
      menuLauncherButton.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
  }

  function toggleMenu() {
    setMenuOpen(!menuOpen);
  }

  function closeMenu() {
    if (menuOpen) {
      setMenuOpen(false);
      if (menuLauncherButton && typeof menuLauncherButton.focus === 'function') {
        menuLauncherButton.focus();
      }
    }
  }

  function updateLauncherState() {
    if (!menuLauncherButton) return;
    menuLauncherButton.classList.toggle('active', gridEnabled);
    menuLauncherButton.setAttribute('aria-pressed', gridEnabled ? 'true' : 'false');
  }

  function syncUI() {
    if (toggleBtn) {
      toggleBtn.textContent = gridEnabled ? 'Hide Grid' : 'Show Grid';
      toggleBtn.classList.toggle('active', gridEnabled);
      toggleBtn.setAttribute('aria-pressed', gridEnabled ? 'true' : 'false');
    }

    updateLauncherState();

    if (sizeInput && document.activeElement !== sizeInput) {
      sizeInput.value = formatInputValue(gridSizeKm);
    }
    if (thicknessInput && document.activeElement !== thicknessInput) {
      thicknessInput.value = String(gridThicknessPx);
    }
  }

  function enableGrid() {
    if (!gridEnabled) {
      gridEnabled = true;
      gridLayer.addTo(map);
      updateGrid();
      syncUI();
    }
  }

  function disableGrid() {
    if (gridEnabled) {
      gridEnabled = false;
      gridLayer.clearLayers();
      map.removeLayer(gridLayer);
      syncUI();
    }
  }

  function setGridEnabled(nextEnabled) {
    if (nextEnabled) {
      enableGrid();
    } else {
      disableGrid();
    }
  }

  if (toggleBtn) {
    toggleBtn.addEventListener('click', function() {
      setGridEnabled(!gridEnabled);
      closeMenu();
    });
  } else {
    console.warn('Map grid toggle button not found in grid menu.');
  }

  if (sizeInput) {
    const initialValue = clampGridSize(parseFloat(sizeInput.value));
    gridSizeKm = initialValue;
    sizeInput.value = formatInputValue(gridSizeKm);

    const commitSize = function() {
      const parsed = parseFloat(sizeInput.value);
      const newValue = clampGridSize(parsed);
      const changed = newValue !== gridSizeKm;
      gridSizeKm = newValue;
      sizeInput.value = formatInputValue(gridSizeKm);
      syncUI();
      if (changed && gridEnabled) {
        updateGrid();
      }
    };

    sizeInput.addEventListener('change', commitSize);
    sizeInput.addEventListener('blur', commitSize);
  } else {
    console.warn('Map grid size input not found in grid menu.');
  }

  if (thicknessInput) {
    const initialThickness = clampThickness(parseInt(thicknessInput.value, 10));
    gridThicknessPx = initialThickness;
    thicknessInput.value = String(gridThicknessPx);

    const commitThickness = function() {
      const parsed = parseInt(thicknessInput.value, 10);
      const newValue = clampThickness(parsed);
      const changed = newValue !== gridThicknessPx;
      gridThicknessPx = newValue;
      thicknessInput.value = String(gridThicknessPx);
      syncUI();
      if (changed && gridEnabled) {
        updateGrid();
      }
    };

    thicknessInput.addEventListener('change', commitThickness);
    thicknessInput.addEventListener('input', commitThickness);
    thicknessInput.addEventListener('blur', commitThickness);
  } else {
    console.warn('Map grid thickness input not found in grid menu.');
  }

  if (menuContainer) {
    const stop = (evt) => evt.stopPropagation();
    menuContainer.addEventListener('mousedown', stop);
    menuContainer.addEventListener('touchstart', stop);
    menuContainer.addEventListener('click', stop);
    menuContainer.addEventListener('keydown', (evt) => {
      if (evt.key === 'Escape') {
        evt.preventDefault();
        closeMenu();
      }
    });
  }

  const GridMenuControl = L.Control.extend({
    onAdd() {
      const container = L.DomUtil.create('div', 'leaflet-bar leaflet-control map-grid-launcher');
      const button = L.DomUtil.create('button', 'map-grid-launch', container);
      button.type = 'button';
      button.title = 'Grid overlay controls';
      button.setAttribute('aria-label', 'Grid overlay controls');
      button.setAttribute('aria-haspopup', 'true');
      button.innerHTML = '&#x2317;';

      L.DomEvent.on(button, 'click', (evt) => {
        L.DomEvent.stop(evt);
        toggleMenu();
      });
      L.DomEvent.on(button, 'keydown', (evt) => {
        if (evt.key === 'Enter' || evt.key === ' ') {
          L.DomEvent.stop(evt);
          toggleMenu();
        }
      });

      L.DomEvent.disableClickPropagation(container);
      L.DomEvent.disableScrollPropagation(container);

      menuLauncherButton = button;
      updateLauncherState();
      return container;
    }
  });

  new GridMenuControl({ position: 'topright' }).addTo(map);

  setMenuOpen(false);

  // H4: rebuild only after the user stops moving/zooming for a moment. updateGrid
  // clear+recreates every polyline over the padded bounds, which on a small cell +
  // large viewport is hundreds of lines per event — causing jank and memory churn.
  let gridDebounceTimer = null;
  const debouncedUpdateGrid = () => {
    clearTimeout(gridDebounceTimer);
    gridDebounceTimer = setTimeout(updateGrid, 200);
  };
  map.on('moveend zoomend rotate', debouncedUpdateGrid);
  syncUI();
})();
