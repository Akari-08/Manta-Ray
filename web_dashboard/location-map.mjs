import { Map as MapLibreMap, Marker } from '/vendor/maplibre-gl.mjs';
import { validateBoundary, simulatedPositionOnMap } from './mission-planner.mjs';

// OpenMapTiles vector layers only: no symbol/text layers or external fonts.
export const mapStyle = {
  version: 8,
  sources: { osm: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' } },
  layers: [
    { id: 'background', type: 'background', paint: { 'background-color': '#12211a' } },
    { id: 'landcover', type: 'fill', source: 'osm', 'source-layer': 'landcover', paint: { 'fill-color': '#1c3428', 'fill-opacity': 0.7 } },
    { id: 'landuse', type: 'fill', source: 'osm', 'source-layer': 'landuse', paint: { 'fill-color': '#1b3025', 'fill-opacity': 0.5 } },
    { id: 'water', type: 'fill', source: 'osm', 'source-layer': 'water', paint: { 'fill-color': '#102f31' } },
    { id: 'waterway', type: 'line', source: 'osm', 'source-layer': 'waterway', paint: { 'line-color': '#285054', 'line-width': 1 } },
    { id: 'roads', type: 'line', source: 'osm', 'source-layer': 'transportation', paint: { 'line-color': '#456253', 'line-opacity': 0.65, 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.4, 16, 2] } },
    { id: 'buildings', type: 'fill', source: 'osm', 'source-layer': 'building', minzoom: 13, paint: { 'fill-color': '#344b3d', 'fill-opacity': 0.7 } },
  ],
};

export function createLocationMap(token = () => '') {
  const placeholder = document.getElementById('map-placeholder');
  const status = document.getElementById('mission-status');
  let map = null, marker = null, rayMarker = null, lastPosition = null, watchId = null, interacted = false, confirmed = false, preview = null, busy = false;
  const vertices = [];
  const notify = text => { status.textContent = text; };
  function features() {
    const data = vertices.map(point => ({ type: 'Feature', properties: { kind: 'vertex' }, geometry: { type: 'Point', coordinates: point } }));
    if (vertices.length >= 2) data.push({ type: 'Feature', properties: { kind: 'boundary' }, geometry: {
      type: 'LineString', coordinates: confirmed ? [...vertices, vertices[0]] : vertices,
    } });
    if (confirmed) data.push({ type: 'Feature', properties: { kind: 'area' }, geometry: { type: 'Polygon', coordinates: [[...vertices, vertices[0]]] } });
    if (preview) for (const segment of preview.swaths) data.push({ type: 'Feature', properties: { kind: 'swath' }, geometry: {
      type: 'LineString', coordinates: segment.map(p => [p.longitude, p.latitude]),
    } });
    if (preview) data.push({ type: 'Feature', properties: { kind: 'route' }, geometry: {
      type: 'LineString', coordinates: preview.waypoints.map(p => [p.longitude, p.latitude]),
    } });
    return { type: 'FeatureCollection', features: data };
  }
  function draw() { map?.getSource('mission-preview')?.setData(features()); }
  function updateRay() {
    const point = simulatedPositionOnMap(preview, lastPosition);
    if (!point || !map) { if (rayMarker) { rayMarker.remove(); rayMarker = null; } return; }
    if (!rayMarker) {
      const dot = document.createElement('div'); dot.className = 'manta-map-marker';
      dot.setAttribute('role', 'img'); dot.setAttribute('aria-label', 'Simulated Roblox manta ray position');
      dot.title = 'Simulated Roblox manta ray position';
      rayMarker = new Marker({ element: dot }).setLngLat(point).addTo(map);
    } else rayMarker.setLngLat(point);
  }
  function invalidate() {
    confirmed = false; preview = null;
    document.getElementById('mission-waypoints').textContent = 'No preview generated.';
    notify(`${vertices.length} point(s). Confirm the area before running startpath.`);
    draw(); updateRay();
  }
  try {
    map = new MapLibreMap({ container: 'location-map', style: mapStyle, center: [0, 20], zoom: 2, attributionControl: false });
    map.on('load', () => {
      map.addSource('mission-preview', { type: 'geojson', data: features() });
      map.addLayer({ id: 'mission-area', type: 'fill', source: 'mission-preview', filter: ['==', ['get', 'kind'], 'area'], paint: { 'fill-color': '#82c8dd', 'fill-opacity': 0.18 } });
      map.addLayer({ id: 'mission-boundary', type: 'line', source: 'mission-preview', filter: ['==', ['get', 'kind'], 'boundary'], paint: { 'line-color': '#8de5e3', 'line-width': 3 } });
      map.addLayer({ id: 'mission-swaths', type: 'line', source: 'mission-preview', filter: ['==', ['get', 'kind'], 'swath'], paint: { 'line-color': '#f1dc86', 'line-width': 2 } });
      map.addLayer({ id: 'mission-route', type: 'line', source: 'mission-preview', filter: ['==', ['get', 'kind'], 'route'], paint: { 'line-color': '#ff5555', 'line-width': 2 } });
      map.addLayer({ id: 'mission-vertices', type: 'circle', source: 'mission-preview', filter: ['==', ['get', 'kind'], 'vertex'], paint: { 'circle-radius': 5, 'circle-color': '#d7ffb6', 'circle-stroke-color': '#10251e', 'circle-stroke-width': 2 } });
      placeholder.hidden = true;
    });
    map.on('dragstart', () => { interacted = true; });
    map.on('click', event => {
      interacted = true;
      if (busy) { notify('Wait for the current preview to finish.'); return; }
      if (vertices.length >= 64) { notify('Maximum 64 boundary vertices.'); return; }
      vertices.push([event.lngLat.lng, event.lngLat.lat]); invalidate();
    });
    if (window.isSecureContext && navigator.geolocation) {
      watchId = navigator.geolocation.watchPosition(position => {
        const { latitude, longitude } = position.coords;
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;
        if (!marker) {
          const dot = document.createElement('div'); dot.className = 'location-marker'; dot.setAttribute('aria-label', 'Browser location');
          marker = new Marker({ element: dot }).setLngLat([longitude, latitude]).addTo(map);
          if (!interacted) map.jumpTo({ center: [longitude, latitude], zoom: 14 });
        } else marker.setLngLat([longitude, latitude]);
      }, () => notify('Location unavailable; pan and zoom to choose an area manually.'), { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 });
    }
  } catch {
    placeholder.textContent = 'Map unavailable. WebGL and an internet connection are required.';
  }
  // Restore the active preview on a dashboard reload or a read-only viewer.
  // Never replace an area the user has already started editing.
  fetch('/api/mission', { signal: AbortSignal.timeout(5000) }).then(response => response.ok ? response.json() : null).then(result => {
    const mission = result?.mission;
    if (!mission || vertices.length || confirmed || busy || preview ||
        typeof mission.id !== 'string' || !Array.isArray(mission.boundary) || !Array.isArray(mission.waypoints) || !Array.isArray(mission.swaths)) return;
    const boundary = mission.boundary.map(p => [p.longitude, p.latitude]);
    try { validateBoundary(boundary); } catch { return; }
    vertices.push(...boundary); confirmed = true; preview = mission; draw(); updateRay();
    document.getElementById('mission-waypoints').textContent = preview.waypoints.map((p, i) => `${i + 1}. ${p.latitude.toFixed(7)}, ${p.longitude.toFixed(7)}`).join('\n');
    notify('Active simulation preview restored. Position is simulated, not GPS.');
  }).catch(() => {});
  document.getElementById('mission-undo').addEventListener('click', () => { if (!busy) { vertices.pop(); invalidate(); } });
  document.getElementById('mission-clear').addEventListener('click', () => { if (!busy) { vertices.length = 0; invalidate(); } });
  document.getElementById('mission-confirm').addEventListener('click', () => {
    if (busy) return;
    try { validateBoundary(vertices); confirmed = true; preview = null; draw(); updateRay(); notify('Area confirmed. Run startpath in the command log.'); }
    catch (error) { confirmed = false; notify(error.message); }
  });
  for (const id of ['mission-depth', 'mission-fov', 'mission-overlap']) {
    document.getElementById(id).addEventListener('input', () => {
      if (preview) { preview = null; draw(); updateRay(); notify('Settings changed. Run startpath again to update the preview.'); }
    });
  }
  window.addEventListener('pagehide', () => { if (watchId !== null) navigator.geolocation.clearWatch(watchId); });
  return {
    updateState(state, connected) {
      lastPosition = connected && !state?.stale && state?.imu_source === 'roblox' ? state.roblox_position : null;
      updateRay();
    },
    async startPath() {
      if (!confirmed) throw new Error('Confirm a valid map area first.');
      if (busy) throw new Error('A preview is already being generated.');
      const settings = {
        depth_m: Number(document.getElementById('mission-depth').value),
        fov_deg: Number(document.getElementById('mission-fov').value),
        overlap: Number(document.getElementById('mission-overlap').value),
      };
      busy = true;
      try {
        const controlToken = token();
        const response = await fetch('/api/mission', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(controlToken ? { Authorization: `Bearer ${controlToken}` } : {}) },
          body: JSON.stringify({ vertices, settings }), signal: AbortSignal.timeout(5000) });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Could not create mission preview.');
        preview = result.mission; draw(); updateRay();
        document.getElementById('mission-waypoints').textContent = preview.waypoints.map((p, i) => `${i + 1}. ${p.latitude.toFixed(7)}, ${p.longitude.toFixed(7)}`).join('\n');
        notify(`${preview.swaths.length} swaths · ${preview.settings.swath_m.toFixed(2)} m sensor width. Simulation only; turns and obstacles are not modeled.`);
        return preview;
      } finally { busy = false; }
    },
  };
}
