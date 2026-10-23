const GOOGLE_STREET_VIEW_API_KEY_STORAGE = 'geolocator_googleStreetViewApiKey';
const GOOGLE_STREET_VIEW_API_KEY_LEGACY = 'googleStreetViewApiKey';

function loadGoogleStreetViewApiKey() {
  const existing = localStorage.getItem(GOOGLE_STREET_VIEW_API_KEY_STORAGE);
  if (existing) return existing;
  const legacy = localStorage.getItem(GOOGLE_STREET_VIEW_API_KEY_LEGACY);
  if (legacy) {
    localStorage.setItem(GOOGLE_STREET_VIEW_API_KEY_STORAGE, legacy);
    localStorage.removeItem(GOOGLE_STREET_VIEW_API_KEY_LEGACY);
    return legacy;
  }
  return '';
}

function saveGoogleStreetViewApiKey(value) {
  const normalized = (value || '').trim();
  if (normalized) {
    localStorage.setItem(GOOGLE_STREET_VIEW_API_KEY_STORAGE, normalized);
    localStorage.removeItem(GOOGLE_STREET_VIEW_API_KEY_LEGACY);
  } else {
    localStorage.removeItem(GOOGLE_STREET_VIEW_API_KEY_STORAGE);
    localStorage.removeItem(GOOGLE_STREET_VIEW_API_KEY_LEGACY);
  }
}

function getGoogleStreetViewApiKey() {
  const input = document.getElementById('googleStreetViewApiKey');
  const typed = input ? input.value.trim() : '';
  if (typed) {
    saveGoogleStreetViewApiKey(typed);
    return typed;
  }
  return loadGoogleStreetViewApiKey();
}

function showStreetView() {
  if (!streetViewMarker) {
    showToast('Click the map first to select a Street View location.', { type: 'error' });
    return;
  }

  const apiKey = getGoogleStreetViewApiKey();
  if (!apiKey) {
    const input = document.getElementById('googleStreetViewApiKey');
    if (input) input.focus();
    showToast('Enter a Google Street View API key in Ground settings first.', { type: 'error' });
    return;
  }

  const lat = streetViewMarker.lat;
  const lng = streetViewMarker.lng;
  const iframe = document.getElementById('streetViewPano');
  iframe.src = `https://www.google.com/maps/embed/v1/streetview?location=${lat},${lng}&key=${encodeURIComponent(apiKey)}&heading=0&pitch=0&fov=90`;

  currentView = 'streetview';
  document.getElementById('map').style.display = 'none';
  document.getElementById('mapCanvas').style.display = 'none';
  document.getElementById('view3DContainer').classList.remove('active');
  document.getElementById('peakFinderContainer').classList.remove('active');
  document.getElementById('streetViewContainer').classList.add('active');
  if (typeof syncDrawingPanel === 'function') syncDrawingPanel();
}

function backToMap() {
  document.getElementById('streetViewContainer').classList.remove('active');
  document.getElementById('view3DContainer').classList.remove('active');
  document.getElementById('peakFinderContainer').classList.remove('active');
  const iframe = document.getElementById('streetViewPano');
  if (iframe) iframe.src = 'about:blank';

  document.getElementById('map').style.display = 'block';
  document.getElementById('mapCanvas').style.display = 'block';
  currentView = '2d';

  if (mapMode === 'ground' && streetViewMarker) {
    document.getElementById('streetViewControls').classList.add('visible');
  }

  setTimeout(() => map.invalidateSize(), 100);
  if (typeof syncDrawingPanel === 'function') syncDrawingPanel();
}

function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  const toggle = document.getElementById('sidebarToggle');
  const collapseBtn = sidebar.querySelector('.collapse-btn');
  sidebar.classList.toggle('collapsed');
  const isCollapsed = sidebar.classList.contains('collapsed');
  toggle.classList.toggle('visible', isCollapsed);
  collapseBtn.textContent = isCollapsed ? '▶' : '◀';
}

function toggleSummary() {
  const summary = document.getElementById('summaryPanel');
  const toggle = document.getElementById('summaryToggle');
  const collapseBtn = summary.querySelector('.collapse-btn');
  summary.classList.toggle('collapsed');
  const isCollapsed = summary.classList.contains('collapsed');
  toggle.classList.toggle('visible', isCollapsed);
  collapseBtn.textContent = isCollapsed ? '◀' : '▶';
}

function showHelp() {
  document.getElementById('helpOverlay').classList.add('visible');
}

function hideHelp() {
  document.getElementById('helpOverlay').classList.remove('visible');
}

document.getElementById('helpOverlay').addEventListener('click', (event) => {
  if (event.target === event.currentTarget) hideHelp();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && document.getElementById('helpOverlay').classList.contains('visible')) {
    hideHelp();
  }
});

document.addEventListener('DOMContentLoaded', () => {
  ['mapillaryClientId', 'mapillaryClientSecret', 'mapillaryAccessToken', 'mapillaryTokenExpiry'].forEach((key) => {
    localStorage.removeItem(key);
  });

  const input = document.getElementById('googleStreetViewApiKey');
  if (input && !input.value) input.value = loadGoogleStreetViewApiKey();
  initFilters();
  document.getElementById('streetViewControls').classList.remove('visible');
  setTimeout(() => {
    map.invalidateSize();
    resizeMapCanvas();
  }, 100);
});

window.saveGoogleStreetViewApiKey = saveGoogleStreetViewApiKey;
window.showStreetView = showStreetView;
window.backToMap = backToMap;
window.toggleSidebar = toggleSidebar;
window.toggleSummary = toggleSummary;
window.showHelp = showHelp;
window.hideHelp = hideHelp;
