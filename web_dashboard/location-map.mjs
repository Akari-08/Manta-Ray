import { Map as MapLibreMap, Marker } from '/vendor/maplibre-gl.mjs';

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

export function createLocationMap() {
  const placeholder = document.getElementById('map-placeholder');
  let map = null, marker = null, watchId = null, generation = 0;
  function message(text) { placeholder.textContent = text; placeholder.hidden = false; }
  function clear() {
    generation++;
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    watchId = null; marker = null; if (map) map.remove(); map = null;
  }
  function start() {
    if (!window.isSecureContext || !navigator.geolocation) { message('Location requires a secure context. Open the dashboard on localhost.'); return; }
    const request = ++generation;
    message('Waiting for location permission…');
    try { watchId = navigator.geolocation.watchPosition(position => {
      if (generation !== request) return;
      const { latitude, longitude } = position.coords;
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) { message('Location is unavailable.'); return; }
      try {
        if (!map) {
          map = new MapLibreMap({ container: 'location-map', style: mapStyle, center: [longitude, latitude], zoom: 14, attributionControl: false, interactive: false });
          map.on('error', () => message('Map unavailable. Check your internet connection.'));
          map.on('idle', () => { if (map?.areTilesLoaded()) placeholder.hidden = true; });
          const dot = document.createElement('div'); dot.className = 'location-marker'; dot.setAttribute('aria-label', 'Current location');
          marker = new Marker({ element: dot }).setLngLat([longitude, latitude]).addTo(map);
          placeholder.hidden = true;
        } else { marker.setLngLat([longitude, latitude]); map.setCenter([longitude, latitude]); }
      } catch { clear(); message('Map could not be displayed. WebGL and an internet connection are required.'); }
    }, error => {
      if (generation !== request) return;
      if (error.code === 1) { clear(); message('Location permission denied. Allow location in your browser and reload.'); }
      else message('Location unavailable. Check your device location settings.');
    }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }); }
    catch { clear(); message('Location is unavailable in this browser.'); }
  }
  window.addEventListener('pagehide', clear);
  window.addEventListener('pageshow', event => { if (event.persisted) start(); });
  start();
}
