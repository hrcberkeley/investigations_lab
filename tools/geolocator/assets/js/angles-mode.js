/* ========== ANGLES MODE FUNCTIONALITY ========== */
let anglesAOILayer = null;
let anglesAOIWasVisible = false;
let anglesAllRoadsWasVisible = true;
let anglesSegmentsWasVisible = true;
let anglesIntersectionsWasVisible = true;
const anglesAllRoadsLayer = L.geoJSON(null, {
  style: { weight: 1, opacity: 0.5, color: '#888' }
}).addTo(map);

const anglesSegmentsLayer = L.geoJSON(null, {
  style: { weight: 3, color: '#9D2235', opacity: 0.8 }
}).addTo(map);

const anglesIntersectionsLayer = L.geoJSON(null, {
  pointToLayer: (f, latlng) => L.circleMarker(latlng, { 
    radius: 5, 
    weight: 1, 
    color: '#0066CC',
    fillColor: '#0066CC',
    fillOpacity: 0.7
  }),
  onEachFeature: (f, layer) => {
    const angle = f.properties?.angle?.toFixed(1);
    layer.bindPopup(`<div class="popup-title">Intersection Angle</div><div style="font-size:1.2rem;font-weight:700;color:#9D2235;text-align:center;margin-top:.5rem">${angle}°</div>`);
  }
}).addTo(map);

// Clear angles layers when needed
function clearAnglesLayers() {
  anglesAllRoadsLayer.clearLayers();
  anglesSegmentsLayer.clearLayers();
  anglesIntersectionsLayer.clearLayers();
  if (anglesAOILayer) {
    map.removeLayer(anglesAOILayer);
    anglesAOILayer = null;
  }
  anglesAOIWasVisible = false;
}

function detachAnglesMode() {
  anglesAllRoadsWasVisible = map.hasLayer(anglesAllRoadsLayer);
  anglesSegmentsWasVisible = map.hasLayer(anglesSegmentsLayer);
  anglesIntersectionsWasVisible = map.hasLayer(anglesIntersectionsLayer);

  if (anglesAllRoadsWasVisible) {
    map.removeLayer(anglesAllRoadsLayer);
  }
  if (anglesSegmentsWasVisible) {
    map.removeLayer(anglesSegmentsLayer);
  }
  if (anglesIntersectionsWasVisible) {
    map.removeLayer(anglesIntersectionsLayer);
  }

  anglesAOIWasVisible = !!(anglesAOILayer && map.hasLayer(anglesAOILayer));
  if (anglesAOIWasVisible) {
    map.removeLayer(anglesAOILayer);
  }
}

function restoreAnglesMode() {
  if (anglesAllRoadsWasVisible && !map.hasLayer(anglesAllRoadsLayer)) {
    anglesAllRoadsLayer.addTo(map);
  }
  if (anglesSegmentsWasVisible && !map.hasLayer(anglesSegmentsLayer)) {
    anglesSegmentsLayer.addTo(map);
  }
  if (anglesIntersectionsWasVisible && !map.hasLayer(anglesIntersectionsLayer)) {
    anglesIntersectionsLayer.addTo(map);
  }

  if (anglesAOIWasVisible && anglesAOILayer && !map.hasLayer(anglesAOILayer)) {
    anglesAOILayer.addTo(map);
  }

  anglesAllRoadsWasVisible = map.hasLayer(anglesAllRoadsLayer);
  anglesSegmentsWasVisible = map.hasLayer(anglesSegmentsLayer);
  anglesIntersectionsWasVisible = map.hasLayer(anglesIntersectionsLayer);
  anglesAOIWasVisible = false;
}

// Listen for polygon creation
map.on('pm:create', e => {
  if (mapMode === 'angles') {
    if (anglesAOILayer) map.removeLayer(anglesAOILayer);
    anglesAOILayer = e.layer.addTo(map);
    document.getElementById('status').textContent = 'Area selected - adjust settings and click Fetch';
  }
});

map.on('pm:remove', e => {
  if (e.layer === anglesAOILayer) {
    anglesAOILayer = null;
    clearAnglesLayers();
  }
});

function updateAngleMode() {
  const maxAllowed = document.querySelector('input[name="angleMode"]:checked').value === '180' ? 180 : 90;
  const rangeHint = document.getElementById('rangeHint');
  const minAngle = document.getElementById('minAngle');
  const maxAngle = document.getElementById('maxAngle');
  
  rangeHint.textContent = `Allowed: 0—${maxAllowed}°`;
  
  if (+minAngle.value > maxAllowed) minAngle.value = maxAllowed;
  if (+maxAngle.value > maxAllowed) maxAngle.value = maxAllowed;
}

function buildAnglesOverpassQL(polygonLatLngs, includedHighways) {
  const ring = polygonLatLngs.map(ll => `${ll.lat} ${ll.lng}`).join(' ');
  const hwyRegex = includedHighways.length ? `~"^(${includedHighways.join('|')})$"` : `~".*"`;
  return `
[out:json][timeout:60];
way(poly:"${ring}")["highway"${includedHighways.length ? hwyRegex : ''}]
  ["highway"!~"footway|path|cycleway|bridleway|steps|corridor|via_ferrata|pedestrian"];
out geom;
`;
}

async function fetchOSMRoads(ql) {
  try {
    let resp;
    let errorText = 'No error details available';
    const endpoints = [
      'https://lz4.overpass-api.de/api/interpreter',
      'https://overpass-api.de/api/interpreter',
      'https://overpass.kumi.systems/api/interpreter'
    ];

    for (const endpoint of endpoints) {
      try {
        resp = await fetch(endpoint, {
          method: 'POST', 
          body: new URLSearchParams({ data: ql }),
          signal: AbortSignal.timeout(30000) // 30 second timeout
        });
        if (resp.ok) break;
        errorText = await resp.text().catch(() => 'No error details available');
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        errorText = e.message;
      }
    }
    
    if (!resp || !resp.ok) {
      throw new Error(`Overpass API error (${resp ? resp.status : 'network'}): ${errorText.substring(0, 200)}`);
    }
    
    const data = await resp.json();
    
    if (!data || !Array.isArray(data.elements)) {
      throw new Error('Invalid response format from Overpass API');
    }
    
    const features = (data.elements || [])
      .filter(el => el.type === 'way' && Array.isArray(el.geometry))
      .map(el => ({
        type: 'Feature',
        properties: { id: el.id, tags: el.tags || {} },
        geometry: { type: 'LineString', coordinates: el.geometry.map(g => [g.lon, g.lat]) }
      }));
    
    return { type: 'FeatureCollection', features };
  } catch (error) {
    console.error('Error fetching OSM roads:', error);
    if (error.name === 'AbortError') {
      throw new Error('Request timed out. The area might be too large or the server is slow. Try a smaller polygon.');
    }
    throw new Error(`Failed to fetch road data: ${error.message}`);
  }
}

function angleBetween(b1, b2, modeMax) {
  let x = Math.abs(b1 - b2) % 360;
  if (x > 180) x = 360 - x;
  if (modeMax === 90 && x > 90) x = 180 - x;
  return x;
}

function computeMatchesAsPointsAndSegments(fcLines, minDeg, maxDeg, modeMax) {
  const segs = [];
  fcLines.features.forEach(f => {
    const c = f.geometry.coordinates;
    for (let i = 0; i < c.length - 1; i++) segs.push({ a: c[i], b: c[i + 1] });
  });

  const key = (pt) => pt[0].toFixed(7) + "," + pt[1].toFixed(7);
  const nodeToSegIdx = new Map();
  segs.forEach((s, idx) => {
    const ka = key(s.a), kb = key(s.b);
    if (!nodeToSegIdx.has(ka)) nodeToSegIdx.set(ka, []);
    if (!nodeToSegIdx.has(kb)) nodeToSegIdx.set(kb, []);
    nodeToSegIdx.get(ka).push(idx);
    nodeToSegIdx.get(kb).push(idx);
  });

  const segBear = segs.map(s => {
    const bAB = turf.bearing(turf.point(s.a), turf.point(s.b));
    const bBA = (bAB + 180 + 360) % 360;
    return { bAB, bBA };
  });

  const hitPts = [], hitSegIdx = new Set();
  for (const [k, idxs] of nodeToSegIdx.entries()) {
    if (idxs.length < 2) continue;
    const [lon, lat] = k.split(',').map(Number);
    for (let i = 0; i < idxs.length; i++) {
      for (let j = i + 1; j < idxs.length; j++) {
        const si = idxs[i], sj = idxs[j];
        const bi = (key(segs[si].a) === k) ? segBear[si].bAB : segBear[si].bBA;
        const bj = (key(segs[sj].a) === k) ? segBear[sj].bAB : segBear[sj].bBA;
        const ang = angleBetween(bi, bj, modeMax);
        if (ang >= minDeg && ang <= maxDeg) {
          hitPts.push(turf.point([lon, lat], { angle: ang }));
          hitSegIdx.add(si); 
          hitSegIdx.add(sj);
        }
      }
    }
  }

  const segFeatures = Array.from(hitSegIdx).map(idx => ({
    type: 'Feature',
    properties: {},
    geometry: { type: 'LineString', coordinates: [segs[idx].a, segs[idx].b] }
  }));

  const seen = new Map();
  const mid = (minDeg + maxDeg) / 2;
  for (const p of hitPts) {
    const k2 = key(p.geometry.coordinates);
    const prev = seen.get(k2);
    if (!prev || Math.abs(prev.properties.angle - mid) > Math.abs(p.properties.angle - mid)) {
      seen.set(k2, p);
    }
  }
  
  return {
    points: turf.featureCollection(Array.from(seen.values())),
    segments: turf.featureCollection(segFeatures)
  };
}

function extractLeafletRing(layer) {
  if (!layer || typeof layer.getLatLngs !== 'function') {
    console.error('Invalid layer provided to extractLeafletRing');
    return [];
  }
  
  const latlngs = layer.getLatLngs();
  if (!latlngs || latlngs.length === 0) {
    return [];
  }
  
  const ring = Array.isArray(latlngs[0]) ? latlngs[0] : latlngs;
  const closed = ring.slice();
  if (closed.length && (closed[0].lat !== closed[closed.length - 1].lat || closed[0].lng !== closed[closed.length - 1].lng)) {
    closed.push(closed[0]);
  }
  return closed;
}

async function fetchAnglesData() {
  try {
    if (typeof turf === 'undefined') {
      showToast('The geometry library failed to load. Refresh the page and try again.', { type: 'error' });
      document.getElementById('status').textContent = 'Turf.js not loaded';
      return;
    }

    if (!anglesAOILayer || !anglesAOILayer.getLatLngs) {
      showToast('Draw a polygon area first using the drawing tools.', { type: 'error' });
      document.getElementById('status').textContent = 'Draw a polygon to start';
      return;
    }

    const maxAllowed = document.querySelector('input[name="angleMode"]:checked').value === '180' ? 180 : 90;
    const minA = Number(document.getElementById('minAngle').value);
    const maxA = Number(document.getElementById('maxAngle').value);
    
    // Enhanced validation for angle ranges
    if (!Number.isFinite(minA) || !Number.isFinite(maxA) || isNaN(minA) || isNaN(maxA)) {
      showToast('Enter valid numeric values for the angle range.', { type: 'error' });
      return;
    }
    
    if (minA < 0 || maxA > maxAllowed || minA > maxA) {
      showToast(`Invalid angle range. Min must be ≥ 0, Max must be ≤ ${maxAllowed}°, and Min must be ≤ Max.`, { type: 'error' });
      return;
    }
    
    if (minA === maxA) {
      showToast('Minimum and maximum angles cannot be the same.', { type: 'error' });
      return;
    }

    const hwys = Array.from(document.querySelectorAll('.hwy:checked')).map(cb => cb.value);
    
    document.getElementById('status').textContent = 'Fetching OSM roads from Overpass...';
    
    // Don't clear the AOI layer, only the results
    anglesAllRoadsLayer.clearLayers();
    anglesSegmentsLayer.clearLayers();
    anglesIntersectionsLayer.clearLayers();

    const ring = extractLeafletRing(anglesAOILayer);
    if (!ring || ring.length < 3) {
      showToast('Draw a valid polygon with at least three points.', { type: 'error' });
      document.getElementById('status').textContent = 'Invalid polygon area';
      return;
    }
    
    const ql = buildAnglesOverpassQL(ring, hwys);
    const fc = await fetchOSMRoads(ql);

    if (document.getElementById('showAllRoads').checked) {
      anglesAllRoadsLayer.addData(fc);
    }

    document.getElementById('status').textContent = `Fetched ${fc.features.length} ways. Computing...`;
    
    const modeMax = maxAllowed;
    const result = computeMatchesAsPointsAndSegments(fc, minA, maxA, modeMax);

    anglesSegmentsLayer.addData(result.segments);
    anglesIntersectionsLayer.addData(result.points);

    const nPts = result.points.features.length;
    const nSegs = result.segments.features.length;
    document.getElementById('status').textContent = `Found ${nPts} intersections and ${nSegs} segments in ${minA}—${maxA}° range`;
    
    if (nPts || nSegs) {
      const group = L.featureGroup([anglesSegmentsLayer, anglesIntersectionsLayer]);
      map.fitBounds(group.getBounds(), { maxZoom: 18 });
    }
  } catch (err) {
    console.error(err);
    document.getElementById('status').textContent = 'Error: ' + err.message;
    showToast('Overpass request failed. Try a smaller area or fewer road types.', { type: 'error' });
  }
}

function downloadIntersections() {
  const fc = anglesIntersectionsLayer.toGeoJSON();
  if (!fc.features.length) {
    showToast('There are no intersections to download.', { type: 'error' });
    return;
  }
  const blob = new Blob([JSON.stringify(fc, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'intersections.geojson';
  a.click();
}

function downloadSegments() {
  const fc = anglesSegmentsLayer.toGeoJSON();
  if (!fc.features.length) {
    showToast('There are no segments to download.', { type: 'error' });
    return;
  }
  const blob = new Blob([JSON.stringify(fc, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'segments.geojson';
  a.click();
}
