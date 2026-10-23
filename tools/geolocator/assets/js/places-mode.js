/* ========== PLACES MODE FUNCTIONALITY ========== */
const osmCategories = {
  'Services & Amenities': [
    'amenity', 'shop', 'office', 'craft', 'emergency', 'healthcare', 
    'public_transport', 'religion', 'education', 'social_facility'
  ],
  'Tourism & Leisure': [
    'tourism', 'leisure', 'sport', 'attraction', 'accommodation'
  ],
  'Transportation': [
    'highway', 'railway', 'aeroway', 'waterway', 'route', 'public_transport'
  ],
  'Physical Features': [
    'natural', 'landuse', 'waterway', 'coastline', 'seamark'
  ],
  'Built Environment': [
    'building', 'man_made', 'barrier', 'power', 'telecom'
  ],
  'Administrative': [
    'place', 'boundary', 'admin_level', 'postal_code'
  ],
  'Historical & Cultural': [
    'historic', 'archaeological_site', 'memorial', 'monument'
  ],
  'Military & Security': [
    'military', 'security', 'defence'
  ],
  'Other': [
    'entrance', 'access', 'fee', 'opening_hours', 'website', 'phone', 'email'
  ]
};

const allOsmCategories = [...new Set(Object.values(osmCategories).flat())];

let activeFilters = new Set(allOsmCategories);
let allPlaces = [];

// Track drawn markers per summary category (e.g., "amenity: cafe")
let markersByCategory = new Map();
// Categories toggled off from the Discovery Summary
let hiddenSummaryCategories = new Set();

function initFilters() {
  const grid = document.getElementById('filterGrid');
  if (!grid) {
    console.error('Filter grid element not found');
    return;
  }
  grid.innerHTML = '';
  
  const processedCategories = new Set();
  
  Object.entries(osmCategories).forEach(([categoryName, categories]) => {
    const categoryDiv = document.createElement('div');
    categoryDiv.className = 'filter-category';
    
    // Filter out categories that have already been processed to avoid duplicates
    const uniqueCategories = categories.filter(cat => {
      if (processedCategories.has(cat)) {
        return false;
      }
      processedCategories.add(cat);
      return true;
    });
    
    categoryDiv.innerHTML = `
      <div class="category-header">
        <input type="checkbox" id="category_${categoryName}" checked onchange="toggleCategorySelection('${categoryName}')" class="category-checkbox">
        <span class="category-name" onclick="toggleCategory('${categoryName}')">${categoryName}</span>
        <span class="category-count">(${uniqueCategories.length})</span>
        <span class="category-toggle" onclick="toggleCategory('${categoryName}')">▼</span>
      </div>
      <div class="category-items" id="category_${categoryName}">
        ${uniqueCategories.map(cat => `
          <div class="filter-item checked">
            <input type="checkbox" id="filter_${cat}" checked onchange="toggleFilter('${cat}')">
            <label for="filter_${cat}">${cat}</label>
          </div>
        `).join('')}
      </div>
    `;
    grid.appendChild(categoryDiv);
  });
  
  updateFilterCount();
}

function toggleCategory(categoryName) {
  const categoryItems = document.getElementById(`category_${categoryName}`);
  const toggle = categoryItems.previousElementSibling.querySelector('.category-toggle');
  
  if (categoryItems.style.display === 'none') {
    categoryItems.style.display = 'block';
    toggle.textContent = '▼';
  } else {
    categoryItems.style.display = 'none';
    toggle.textContent = '▶';
  }
}

function toggleCategorySelection(categoryName) {
  const categoryCheckbox = document.getElementById(`category_${categoryName}`);
  const categories = osmCategories[categoryName];
  const isChecked = categoryCheckbox.checked;
  
  categories.forEach(cat => {
    const checkbox = document.getElementById(`filter_${cat}`);
    if (checkbox) { // Only process if checkbox exists (i.e., it's unique)
      const item = checkbox.parentElement;
      
      if (isChecked) {
        activeFilters.add(cat);
        checkbox.checked = true;
        item.classList.add('checked');
      } else {
        activeFilters.delete(cat);
        checkbox.checked = false;
        item.classList.remove('checked');
      }
    }
  });
  
  updateFilterCount();
  if (allPlaces.length > 0) filterAndDrawPlaces();
}

function toggleFilter(category) {
  const checkbox = document.getElementById(`filter_${category}`);
  const item = checkbox.parentElement;
  
  if (checkbox.checked) {
    activeFilters.add(category);
    item.classList.add('checked');
  } else {
    activeFilters.delete(category);
    item.classList.remove('checked');
  }
  
  updateCategoryCheckboxState(category);
  
  updateFilterCount();
  if (allPlaces.length > 0) filterAndDrawPlaces();
}

function updateCategoryCheckboxState(category) {
  for (const [categoryName, categories] of Object.entries(osmCategories)) {
    if (categories.includes(category)) {
      const categoryCheckbox = document.getElementById(`category_${categoryName}`);
      const selectedInCategory = categories.filter(cat => activeFilters.has(cat));
      
      if (selectedInCategory.length === 0) {
        categoryCheckbox.checked = false;
        categoryCheckbox.indeterminate = false;
      } else if (selectedInCategory.length === categories.length) {
        categoryCheckbox.checked = true;
        categoryCheckbox.indeterminate = false;
      } else {
        categoryCheckbox.checked = false;
        categoryCheckbox.indeterminate = true;
      }
      break;
    }
  }
}

function selectAllFilters() {
  allOsmCategories.forEach(cat => {
    activeFilters.add(cat);
    const checkbox = document.getElementById(`filter_${cat}`);
    if (checkbox) {
      checkbox.checked = true;
      checkbox.parentElement.classList.add('checked');
    }
  });
  
  Object.keys(osmCategories).forEach(categoryName => {
    const categoryCheckbox = document.getElementById(`category_${categoryName}`);
    if (categoryCheckbox) {
      categoryCheckbox.checked = true;
      categoryCheckbox.indeterminate = false;
    }
  });
  
  updateFilterCount();
  if (allPlaces.length > 0) filterAndDrawPlaces();
}

function deselectAllFilters() {
  activeFilters.clear();
  allOsmCategories.forEach(cat => {
    const checkbox = document.getElementById(`filter_${cat}`);
    if (checkbox) {
      checkbox.checked = false;
      checkbox.parentElement.classList.remove('checked');
    }
  });
  
  Object.keys(osmCategories).forEach(categoryName => {
    const categoryCheckbox = document.getElementById(`category_${categoryName}`);
    if (categoryCheckbox) {
      categoryCheckbox.checked = false;
      categoryCheckbox.indeterminate = false;
    }
  });
  
  updateFilterCount();
  cluster.clearLayers();
  updateSummary([]);
}

function updateFilterCount() {
  const countSpan = document.getElementById('filterCount');
  if (countSpan) countSpan.textContent = `(${activeFilters.size}/${allOsmCategories.length})`;
}

let mapMode = 'places';
let currentView = '2d';
let streetViewMarker = null;
const mapCanvas = document.getElementById('mapCanvas');

let placesMarkerVisible = false;
let placesCircleVisible = false;
let placesClusterAttached = true;
let groundDetachedView = '2d';
let groundControlsWereVisible = false;
let drawDetachedView = '2d';

function syncDrawingPanel() {
  if (typeof drawingRouter === 'undefined') return;
  if (drawingRouter && drawingRouter.konvaManager && typeof drawingRouter.konvaManager.cancelForwarding === 'function') {
    drawingRouter.konvaManager.cancelForwarding();
  }
  if (mapMode !== 'draw') {
    if (drawingRouter && drawingRouter.konvaManager) {
      // Only cancel in-progress drawings on the map overlay, not the image panel
      const mapOverlayPanel = drawingRouter.konvaManager.panels &&
        drawingRouter.konvaManager.panels.get('map-overlay');
      if (mapOverlayPanel && typeof mapOverlayPanel.cancelInProgressDrawing === 'function') {
        mapOverlayPanel.cancelInProgressDrawing();
      }
    }
    // Only reset the active panel if the user is not working in the image panel
    if (!drawingRouter.konvaManager || drawingRouter.konvaManager.activePanel !== 'image') {
      drawingRouter.setActivePanel(null);
    }
    return;
  }

  const panelByView = {
    '2d': 'map'
  };
  const panel = panelByView[currentView] || null;
  drawingRouter.setActivePanel(panel);
}

function detachPlacesMode() {
  // Cancel any pending Overpass request so it cannot fire after the mode switch
  if (overpassDebounceHandle) {
    clearTimeout(overpassDebounceHandle);
    overpassDebounceHandle = null;
  }
  if (overpassAbortController) {
    overpassAbortController.abort();
    overpassAbortController = null;
  }

  placesClusterAttached = map.hasLayer(cluster);
  if (placesClusterAttached) {
    map.removeLayer(cluster);
  }

  placesMarkerVisible = !!(pin && map.hasLayer(pin));
  if (placesMarkerVisible) {
    map.removeLayer(pin);
  }

  placesCircleVisible = !!(circle && map.hasLayer(circle));
  if (placesCircleVisible) {
    map.removeLayer(circle);
  }

  const summary = document.getElementById('summaryPanel');
  const summaryToggle = document.getElementById('summaryToggle');
  if (summary) summary.hidden = true;
  if (summaryToggle) summaryToggle.hidden = true;
}

function restorePlacesMode() {
  const summary = document.getElementById('summaryPanel');
  const summaryToggle = document.getElementById('summaryToggle');
  if (summary) summary.hidden = false;
  if (summaryToggle) summaryToggle.hidden = false;
  if (placesClusterAttached && !map.hasLayer(cluster)) {
    map.addLayer(cluster);
  }

  if (pin && placesMarkerVisible && !map.hasLayer(pin)) {
    pin.addTo(map);
  }

  if (circle && placesCircleVisible && !map.hasLayer(circle)) {
    circle.addTo(map);
  }

  placesClusterAttached = map.hasLayer(cluster);
  placesMarkerVisible = !!(pin && map.hasLayer(pin));
  placesCircleVisible = !!(circle && map.hasLayer(circle));
}

function detachGroundMode() {
  const controls = document.getElementById('streetViewControls');
  groundControlsWereVisible = controls.classList.contains('visible');
  controls.classList.remove('visible');

  if (streetViewMarker && streetViewMarker.marker && map.hasLayer(streetViewMarker.marker)) {
    map.removeLayer(streetViewMarker.marker);
    streetViewMarker.visible = true;
  } else if (streetViewMarker) {
    streetViewMarker.visible = false;
  }

  groundDetachedView = currentView;
  if (currentView === 'streetview' && typeof backToMap === 'function') {
    backToMap();
    controls.classList.remove('visible');
  }
}

function restoreGroundMode() {
  const controls = document.getElementById('streetViewControls');

  if (streetViewMarker && streetViewMarker.marker && streetViewMarker.visible) {
    streetViewMarker.marker.addTo(map);
    controls.classList.add('visible');
    document.getElementById('status').textContent = 'Location selected - Choose a view option';
  } else {
    controls.classList.toggle('visible', groundControlsWereVisible);
  }

  if (groundDetachedView === 'streetview' && streetViewMarker && typeof showStreetView === 'function') {
    showStreetView();
  }

  groundDetachedView = '2d';
  groundControlsWereVisible = controls.classList.contains('visible');
}

function detachDrawMode() {
  drawDetachedView = currentView;

  if (currentView === '3d' || currentView === 'peakfinder') {
    toggleMapView();
  }

  if (!map.dragging._enabled) {
    map.dragging.enable();
  }

  if (typeof drawingRouter !== 'undefined') {
    drawingRouter.setActivePanel(null);
  }
}

function restoreDrawMode() {
  if (drawDetachedView !== '2d' && currentView === '2d') {
    toggleMapView();
  }

  drawDetachedView = '2d';
  syncDrawingPanel();
}

function detachModeResources(mode) {
  if (mode === 'places') {
    detachPlacesMode();
  } else if (mode === 'ground') {
    detachGroundMode();
  } else if (mode === 'los') {
    if (typeof detachLOSMode === 'function') detachLOSMode();
  } else if (mode === 'angles') {
    if (typeof detachAnglesMode === 'function') detachAnglesMode();
  } else if (mode === 'draw') {
    detachDrawMode();
  }
}

function restoreModeResources(mode) {
  if (mode === 'places') {
    restorePlacesMode();
  } else if (mode === 'ground') {
    restoreGroundMode();
  } else if (mode === 'los') {
    if (typeof restoreLOSMode === 'function') restoreLOSMode();
  } else if (mode === 'angles') {
    if (typeof restoreAnglesMode === 'function') restoreAnglesMode();
  } else if (mode === 'draw') {
    restoreDrawMode();
  }
}

function setMapMode(mode) {
  if (mode === mapMode) return;

  const previousMode = mapMode;
  detachModeResources(previousMode);

  mapMode = mode;

  document.getElementById('placesMode').classList.toggle('active', mode === 'places');
  document.getElementById('groundMode').classList.toggle('active', mode === 'ground');
  document.getElementById('drawMode').classList.toggle('active', mode === 'draw');
  document.getElementById('losMode').classList.toggle('active', mode === 'los');
  document.getElementById('anglesMode').classList.toggle('active', mode === 'angles');

  document.getElementById('placesControls').style.display = mode === 'places' ? 'block' : 'none';
  document.getElementById('groundControls').style.display = mode === 'ground' ? 'block' : 'none';
  document.getElementById('anglesControls').style.display = mode === 'angles' ? 'block' : 'none';
  document.getElementById('losControls').style.display = mode === 'los' ? 'block' : 'none';

  map.dragging.enable();

  const view3DCanvas = document.getElementById('view3DCanvas');
  if (view3DCanvas) view3DCanvas.classList.remove('active');

  if (mode === 'places') {
    document.getElementById('status').textContent = 'Click map to search places';

    if (currentView === '3d' || currentView === 'peakfinder') {
      toggleMapView();
    }
    if (currentView === 'streetview' && typeof backToMap === 'function') {
      backToMap();
    }
  } else if (mode === 'ground') {
    document.getElementById('status').textContent = 'Click map for ground view';
  } else if (mode === 'draw') {
    document.getElementById('status').textContent = 'Drawing mode active!';

    if (currentView === '3d') {
      view3DCanvas.classList.add('active');
      setup3DViewCanvas();
    } else {
      if (currentView !== '2d' && typeof backToMap === 'function') backToMap();
    }
  } else if (mode === 'los') {
    document.getElementById('status').textContent = 'Click point A (observer)';
    loadMapboxToken();
    updateLOSStatus();
  } else if (mode === 'angles') {
    document.getElementById('status').textContent = 'Draw polygon area to analyze intersections';

    if (currentView === '3d' || currentView === 'peakfinder') {
      toggleMapView();
    }
    if (currentView === 'streetview' && typeof backToMap === 'function') {
      backToMap();
    }
  }

  restoreModeResources(mode);
  syncDrawingPanel();
}

function toggleMapView() {
  const map2D = document.getElementById('map');
  const mapCanvas2D = document.getElementById('mapCanvas');
  const view3D = document.getElementById('view3DContainer');
  const peakFinder = document.getElementById('peakFinderContainer');
  const view3DCanvasEl = document.getElementById('view3DCanvas');
  const toggleBtn = document.getElementById('viewToggleBtn');
  const infoBar = document.getElementById('viewInfoBar');
  
  if (currentView === '2d') {
    if (losMode === 'peakfinder') {
      currentView = 'peakfinder';
      peakFinder.classList.add('active');
    } else {
      currentView = '3d';
      view3D.classList.add('active');
      if (mapMode === 'draw') {
        view3DCanvasEl.classList.add('active');
        setup3DViewCanvas();
      }
    }
    
    map2D.style.display = 'none';
    mapCanvas2D.style.display = 'none';
    map.dragging.enable();
    
    toggleBtn.style.display = 'flex';
    infoBar.classList.add('visible');
    
    document.getElementById('viewToggleIcon').textContent = '🗺️';
    document.getElementById('viewToggleText').textContent = 'Back to 2D Map';
    
    if (window.map3D && currentView === '3d') {
      setTimeout(() => {
        window.map3D.resize();
        setup3DViewCanvas();
      }, 100);
    }
  } else {
    currentView = '2d';
    map2D.style.display = 'block';
    mapCanvas2D.style.display = 'block';
    view3D.classList.remove('active');
    peakFinder.classList.remove('active');
    view3DCanvasEl.classList.remove('active');
    toggleBtn.style.display = 'none';
    infoBar.classList.remove('visible');

    if (mapMode === 'draw') {
      map.dragging.disable();
    }

    setTimeout(() => {
      map.invalidateSize();
    }, 100);
  }

  syncDrawingPanel();
}

const cluster = L.markerClusterGroup({
  chunkedLoading: true,
  spiderfyOnMaxZoom: true,
  showCoverageOnHover: false,
  zoomToBoundsOnClick: true
});
map.addLayer(cluster);

let pin = null, circle = null;
const rSlider = document.getElementById('radiusSlider');
const rLabel = document.getElementById('radiusLabel');
const status = document.getElementById('status');
const summaryPanel = document.getElementById('summaryPanel');
const OVERPASS_DEBOUNCE_MS = 250;
let overpassDebounceHandle = null;
let overpassAbortController = null;
let overpassRequestCounter = 0;

function syncRadiusLabel() { rLabel.textContent = rSlider.value; }
syncRadiusLabel();

function scheduleOverpassQuery({ immediate = false } = {}) {
  if (!pin) return;

  if (overpassDebounceHandle) {
    clearTimeout(overpassDebounceHandle);
    overpassDebounceHandle = null;
  }

  if (immediate) {
    queryOverpass();
    return;
  }

  overpassDebounceHandle = setTimeout(() => {
    overpassDebounceHandle = null;
    queryOverpass();
  }, OVERPASS_DEBOUNCE_MS);
}

rSlider.addEventListener('input', () => {
  syncRadiusLabel();
  if (circle) circle.setRadius(+rSlider.value);
  if (pin) scheduleOverpassQuery();
});

map.on('click', e => {
  if (mapMode === 'places') {
    cluster.clearLayers();
    if (pin) map.removeLayer(pin);
    if (circle) map.removeLayer(circle);

    pin = L.marker(e.latlng, {
      icon: LeafletIconAssets.createIcon('red')
    }).addTo(map);

    circle = L.circle(e.latlng, {
      radius: +rSlider.value,
      color: '#9D2235',
      weight: 2,
      fillOpacity: 0.1
    }).addTo(map);

    scheduleOverpassQuery({ immediate: true });
    
    document.getElementById('streetViewControls').classList.remove('visible');
  } else if (mapMode === 'ground') {
    if (streetViewMarker && streetViewMarker.marker) {
      map.removeLayer(streetViewMarker.marker);
      streetViewMarker.visible = false;
    }

    const marker = L.marker(e.latlng, {
      icon: LeafletIconAssets.createIcon('blue')
    }).addTo(map).bindPopup('Ground View Location').openPopup();
    
    streetViewMarker = {
      lat: e.latlng.lat,
      lng: e.latlng.lng,
      marker: marker,
      visible: true
    };
    
    const controls = document.getElementById('streetViewControls');
    controls.classList.add('visible');
    document.getElementById('status').textContent = 'Location selected - Choose a view option';
  } else if (mapMode === 'los') {
    handleLOSClick(e.latlng);
  }
});

function buildQuery(lat, lon, r) {
  const activeList = Array.from(activeFilters);
  let parts = [];
  
  activeList.forEach(k => {
    parts.push(`node(around:${r},${lat},${lon})["${k}"];`);
    parts.push(`way(around:${r},${lat},${lon})["${k}"];`);
    parts.push(`rel(around:${r},${lat},${lon})["${k}"];`);
  });
  
  return `[out:json][timeout:30];(${parts.join('')});out center tags;`;
}

async function queryOverpass() {
  if (!pin) return;

  if (overpassAbortController) {
    overpassAbortController.abort();
  }

  overpassAbortController = new AbortController();
  const requestController = overpassAbortController;
  const requestId = ++overpassRequestCounter;
  let timedOut = false;
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    requestController.abort();
  }, 30000);

  const {lat, lng} = pin.getLatLng();
  const radius = rSlider.value;
  status.textContent = 'Querying OpenStreetMap...';
  summaryPanel.classList.remove('visible');

  try {
    let res;
    let errorText = 'No error details';
    const endpoints = [
      'https://lz4.overpass-api.de/api/interpreter',
      'https://overpass-api.de/api/interpreter',
      'https://overpass.kumi.systems/api/interpreter'
    ];
    
    for (const endpoint of endpoints) {
      try {
        res = await fetch(endpoint, {
          method: 'POST',
          body: buildQuery(lat.toFixed(6), lng.toFixed(6), radius),
          headers: {'Content-Type': 'text/plain'},
          signal: requestController.signal
        });
        if (res.ok) break;
        errorText = await res.text().catch(() => 'No error details');
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        errorText = e.message;
      }
    }
    
    if (!res || !res.ok) {
      throw new Error(`Overpass API error (${res ? res.status : 'network'}): ${errorText.substring(0, 200)}`);
    }
    
    const data = await res.json();
    
    if (!data || !Array.isArray(data.elements)) {
      throw new Error('Invalid response format from Overpass API');
    }

    // Ignore stale responses if a newer request has already been issued.
    if (requestId !== overpassRequestCounter) {
      return;
    }
    
    allPlaces = data.elements;
    
    status.textContent = `Found ${allPlaces.length} places`;
    filterAndDrawPlaces();
    
  } catch (err) {
    if (requestId !== overpassRequestCounter) {
      return;
    }

    console.error('Error querying Overpass API:', err);
    if (err.name === 'AbortError' && timedOut) {
      status.textContent = 'Request timed out - try a smaller search radius';
    } else if (err.name === 'AbortError') {
      // Superseded by a newer request; keep current UI state.
      return;
    } else {
      status.textContent = `Failed to load data: ${err.message}`;
    }
    allPlaces = [];
  } finally {
    clearTimeout(timeoutHandle);
    if (requestId === overpassRequestCounter) {
      overpassAbortController = null;
    }
  }
}

function filterAndDrawPlaces() {
  const filtered = allPlaces.filter(el => {
    const tags = el.tags || {};
    return allOsmCategories.some(cat => tags[cat] && activeFilters.has(cat));
  });
  
  drawElements(filtered);
  updateSummary(filtered);
  summaryPanel.classList.add('visible');
}

function drawElements(els) {
  cluster.clearLayers();
  markersByCategory.clear();
  
  els.forEach(el => {
    let lat, lon;
    if (el.type === 'node') {
      lat = el.lat;
      lon = el.lon;
    } else if (el.center) {
      lat = el.center.lat;
      lon = el.center.lon;
    }
    
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

    const tags = el.tags || {};
    const name = tags.name || tags['name:en'] || tags.ref || '(Unnamed location)';
    const category = getCategory(tags);
    const summaryCategory = category; // e.g., "amenity: cafe" or "miscellaneous"
    const gMapsUrl = `https://www.google.com/maps?q=${lat},${lon}`;
    
    const tagList = Object.entries(tags)
      .filter(([k,v]) => k !== 'name' && k !== 'name:en')
      .slice(0, 10)
      .map(([k,v]) => `<span class="popup-tag">${escapeHtml(k)}: ${escapeHtml(v)}</span>`)
      .join('');

    const popupHtml = `
      <div class="popup-title">${escapeHtml(name)}</div>
      <div class="popup-category">${escapeHtml(category)}</div>
      ${tagList ? `<div class="popup-tags">${tagList}</div>` : ''}
      <a href="${gMapsUrl}" target="_blank" rel="noopener noreferrer" class="popup-link">
        Open in Google Maps
      </a>
    `;

    const markerColor = getMarkerColorKey(category);
    const marker = L.marker([lat, lon], {
      icon: LeafletIconAssets.createIcon(markerColor)
    });
    
    marker.bindPopup(popupHtml, {maxWidth: 300});
    // Store marker in registry
    if (!markersByCategory.has(summaryCategory)) {
      markersByCategory.set(summaryCategory, []);
    }
    markersByCategory.get(summaryCategory).push(marker);
    // Add to map only if category is not hidden
    if (!hiddenSummaryCategories.has(summaryCategory)) {
      cluster.addLayer(marker);
    }
  });
}

function getCategory(tags) {
  for (const k of allOsmCategories) {
    if (tags[k]) return `${k}: ${tags[k]}`;
  }
  return 'miscellaneous';
}

function getMarkerColorKey(category) {
  const colors = {
    'amenity': 'blue',
    'shop': 'green',
    'tourism': 'orange',
    'leisure': 'yellow',
    'historic': 'violet'
  };

  for (const [key, color] of Object.entries(colors)) {
    if (category.startsWith(key)) return color;
  }

  return 'grey';
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function updateSummary(places) {
  document.getElementById('totalPlaces').textContent = places.length;
  
  const categoryData = {};
  places.forEach(el => {
    const tags = el.tags || {};
    for (const cat of allOsmCategories) {
      if (tags[cat]) {
        const key = `${cat}: ${tags[cat]}`;
        if (!categoryData[key]) {
          categoryData[key] = [];
        }
        categoryData[key].push(el);
      }
    }
  });
  
  const uniqueCategories = Object.keys(categoryData).length;
  document.getElementById('totalCategories').textContent = uniqueCategories;
  
  const categoryList = document.getElementById('categoryList');
  categoryList.innerHTML = '';
  
  const sorted = Object.entries(categoryData)
    .sort((a,b) => b[1].length - a[1].length)
    .slice(0, 15);
  
  if (sorted.length === 0) {
    categoryList.innerHTML = '<p style="color:#999;font-size:.8rem;text-align:center;padding:.8rem">No places found</p>';
  } else {
    sorted.forEach(([cat, placesList], index) => {
      const div = document.createElement('div');
      div.className = 'category-item';
      const categoryId = `cat-${index}`;

      // M6: build with DOM APIs + addEventListener so external OSM text (cat labels,
      // place names) can never break out of an onclick attribute or inject script.
      const header = document.createElement('div');
      header.className = 'category-header';

      const label = document.createElement('label');
      label.style.cssText = 'display:flex;align-items:center;gap:.5rem;flex:1;cursor:pointer';
      label.title = 'Show/Hide pins in this category';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = !hiddenSummaryCategories.has(cat);
      checkbox.style.cursor = 'pointer';
      checkbox.addEventListener('change', () => toggleSummaryCategory(cat));
      label.appendChild(checkbox);

      const nameSpan = document.createElement('span');
      nameSpan.className = 'name';
      nameSpan.textContent = cat;
      label.appendChild(nameSpan);
      header.appendChild(label);

      const countSpan = document.createElement('span');
      countSpan.className = 'count';
      countSpan.textContent = String(placesList.length);
      header.appendChild(countSpan);

      const toggleIcon = document.createElement('span');
      toggleIcon.className = 'toggle-icon';
      toggleIcon.id = `icon-${categoryId}`;
      toggleIcon.textContent = '▼';
      toggleIcon.addEventListener('click', () => toggleCategoryDisplay(categoryId));
      header.appendChild(toggleIcon);

      div.appendChild(header);

      const placesDiv = document.createElement('div');
      placesDiv.className = 'category-places';
      placesDiv.id = categoryId;

      placesList.forEach(place => {
        const name = place.tags.name || place.tags['name:en'] || place.tags.ref || '(Unnamed)';
        let lat, lon;
        if (place.type === 'node') {
          lat = place.lat;
          lon = place.lon;
        } else if (place.center) {
          lat = place.center.lat;
          lon = place.center.lon;
        }

        const item = document.createElement('div');
        item.className = 'place-item';
        item.addEventListener('click', () => centerMapOnPlace(lat, lon, name));

        const iconSpan = document.createElement('span');
        iconSpan.className = 'icon';
        iconSpan.textContent = '📍';
        item.appendChild(iconSpan);

        const textSpan = document.createElement('span');
        textSpan.className = 'text';
        textSpan.textContent = name;
        item.appendChild(textSpan);

        placesDiv.appendChild(item);
      });

      div.appendChild(placesDiv);
      categoryList.appendChild(div);
    });
  }
}

function toggleCategoryDisplay(categoryId) {
  const placesDiv = document.getElementById(categoryId);
  const icon = document.getElementById(`icon-${categoryId}`);
  
  placesDiv.classList.toggle('expanded');
  icon.classList.toggle('expanded');
}

// Show/hide markers for a given summary category label (e.g., "amenity: cafe")
function toggleSummaryCategory(catLabel) {
  if (hiddenSummaryCategories.has(catLabel)) {
    hiddenSummaryCategories.delete(catLabel);
    const arr = markersByCategory.get(catLabel) || [];
    arr.forEach(m => {
      if (!cluster.hasLayer(m)) cluster.addLayer(m);
    });
  } else {
    hiddenSummaryCategories.add(catLabel);
    const arr = markersByCategory.get(catLabel) || [];
    arr.forEach(m => {
      if (cluster.hasLayer(m)) cluster.removeLayer(m);
    });
  }
}

function centerMapOnPlace(lat, lon, name) {
  const latNum = Number(lat);
  const lonNum = Number(lon);

  if (Number.isFinite(latNum) && Number.isFinite(lonNum)) {
    map.setView([latNum, lonNum], 20);
    
    cluster.eachLayer(marker => {
      const markerLatLng = marker.getLatLng();
      if (Math.abs(markerLatLng.lat - latNum) < 0.0001 && Math.abs(markerLatLng.lng - lonNum) < 0.0001) {
        marker.openPopup();
      }
    });
  }
}
