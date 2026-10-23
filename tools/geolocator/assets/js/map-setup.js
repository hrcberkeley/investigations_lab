/* ========== MAP SETUP ========== */
const map = L.map('map', {
  center: [19.4326, -99.1332],
  zoom: 13,
  zoomControl: true,
  scrollWheelZoom: true,
  doubleClickZoom: true,
  boxZoom: true,
  keyboard: true,
  maxZoom: 20,
  minZoom: 2,
  rotate: true,
  bearing: 0,
  touchRotate: true
});

// Add Geoman drawing controls
map.pm.addControls({
  position: 'topright',
  drawCircle: false,
  drawMarker: false,
  drawCircleMarker: false,
  drawPolyline: false
});

L.Control.RotationControl = L.Control.extend({
  onAdd: function(map) {
    const container = L.DomUtil.create('div', 'leaflet-bar leaflet-control');
    container.style.background = '#fff';
    container.style.borderRadius = '4px';
    container.style.padding = '5px';
    container.style.boxShadow = '0 2px 6px rgba(0,0,0,0.3)';
    
    const compass = L.DomUtil.create('div', '', container);
    compass.id = 'mapCompass';
    compass.style.cssText = 'width:50px;height:50px;position:relative;margin:5px';
    compass.innerHTML = `
      <svg width="50" height="50" viewBox="0 0 50 50" style="transform-origin:center;transition:transform 0.3s">
        <circle cx="25" cy="25" r="23" fill="#f0f0f0" stroke="#9D2235" stroke-width="2"/>
        <path d="M25 5 L25 45 M25 5 L21 9 M25 5 L29 9" stroke="#9D2235" stroke-width="2.5" fill="none"/>
        <text x="25" y="15" text-anchor="middle" fill="#9D2235" font-size="10" font-weight="bold">N</text>
        <text x="25" y="43" text-anchor="middle" fill="#666" font-size="8">S</text>
        <text x="8" y="28" text-anchor="middle" fill="#666" font-size="8">W</text>
        <text x="42" y="28" text-anchor="middle" fill="#666" font-size="8">E</text>
      </svg>
    `;
    
    const bearingDisplay = L.DomUtil.create('div', '', container);
    bearingDisplay.id = 'bearingDisplay';
    bearingDisplay.style.cssText = 'text-align:center;font-size:11px;font-weight:bold;color:#333;margin-bottom:5px';
    bearingDisplay.textContent = '0°';
    
    const helpText = L.DomUtil.create('div', '', container);
    helpText.style.cssText = 'text-align:center;font-size:9px;color:#888;margin-bottom:3px;line-height:1.2';
    helpText.innerHTML = 'Use buttons below<br/>to rotate map';
    
    const btnContainer = L.DomUtil.create('div', '', container);
    btnContainer.style.cssText = 'display:flex;gap:2px;margin-top:5px';
    
    const rotateLeftBtn = L.DomUtil.create('button', '', btnContainer);
    rotateLeftBtn.innerHTML = '↶';
    rotateLeftBtn.title = 'Rotate Left (5°)';
    rotateLeftBtn.style.cssText = 'flex:1;padding:5px;cursor:pointer;border:1px solid #ddd;background:#fff;border-radius:3px;font-size:16px';
    
    const resetBtn = L.DomUtil.create('button', '', btnContainer);
    resetBtn.innerHTML = '⬆';
    resetBtn.title = 'Reset to North (0°)';
    resetBtn.style.cssText = 'flex:1;padding:5px;cursor:pointer;border:1px solid #ddd;background:#fff;border-radius:3px;font-size:16px';
    
    const rotateRightBtn = L.DomUtil.create('button', '', btnContainer);
    rotateRightBtn.innerHTML = '↷';
    rotateRightBtn.title = 'Rotate Right (5°)';
    rotateRightBtn.style.cssText = 'flex:1;padding:5px;cursor:pointer;border:1px solid #ddd;background:#fff;border-radius:3px;font-size:16px';
    
    L.DomEvent.on(rotateLeftBtn, 'click', function(e) {
      L.DomEvent.stopPropagation(e);
      L.DomEvent.preventDefault(e);
      const currentBearing = map.getBearing() || 0;
      map.setBearing(currentBearing - 5);
    });
    
    L.DomEvent.on(resetBtn, 'click', function(e) {
      L.DomEvent.stopPropagation(e);
      L.DomEvent.preventDefault(e);
      map.setBearing(0);
    });
    
    L.DomEvent.on(rotateRightBtn, 'click', function(e) {
      L.DomEvent.stopPropagation(e);
      L.DomEvent.preventDefault(e);
      const currentBearing = map.getBearing() || 0;
      map.setBearing(currentBearing + 5);
    });
    
    function updateCompass() {
      const bearing = map.getBearing() || 0;
      const svg = compass.querySelector('svg');
      svg.style.transform = `rotate(${bearing}deg)`;
      bearingDisplay.textContent = Math.round(bearing) + '°';
    }
    
    map.on('rotate', updateCompass);
    updateCompass();
    
    L.DomEvent.disableClickPropagation(container);
    return container;
  }
});

new L.Control.RotationControl({ position: 'bottomleft' }).addTo(map);

let currentLayer = 'street';
const streetLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; OpenStreetMap contributors',
  maxZoom: 19
}).addTo(map);

const satelliteLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
  attribution: '&copy; Esri',
  maxZoom: 19
});

const googleSatelliteLayer = L.tileLayer('https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}', {
  attribution: '&copy; Google',
  maxZoom: 20
});

const labelsOverlay = L.tileLayer('https://{s}.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}.png', {
  attribution: '&copy; OpenStreetMap contributors, &copy; CARTO',
  subdomains: 'abcd',
  maxZoom: 20,
  opacity: 0.9
});

const geocoder = L.Control.geocoder({
  defaultMarkGeocode: false,
  position: 'topright',
  placeholder: 'Search location...',
  errorMessage: 'Nothing found.'
}).on('markgeocode', function(e) {
  const latlng = e.geocode.center;
  map.setView(latlng, 15);
  L.marker(latlng).addTo(map).bindPopup(e.geocode.name).openPopup();
}).addTo(map);

function setMapLayer(layer) {
  // L2: guard each removal — removeLayer on a non-member is a no-op in Leaflet
  // but noisy if anyone ever turns on debug logging.
  [streetLayer, satelliteLayer, googleSatelliteLayer].forEach(l => {
    if (map.hasLayer(l)) map.removeLayer(l);
  });
  if (map.hasLayer(labelsOverlay)) map.removeLayer(labelsOverlay);
  
  if (layer === 'street') {
    map.addLayer(streetLayer);
  } else if (layer === 'satellite') {
    map.addLayer(satelliteLayer);
    labelsOverlay.addTo(map);
  } else if (layer === 'google') {
    map.addLayer(googleSatelliteLayer);
    labelsOverlay.addTo(map);
  }
  
  currentLayer = layer;
  
  document.getElementById('layerStreet').classList.toggle('active', layer === 'street');
  document.getElementById('layerSatellite').classList.toggle('active', layer === 'satellite');
  document.getElementById('layerGoogle').classList.toggle('active', layer === 'google');
  applyElevationOverlayStyles();
}
