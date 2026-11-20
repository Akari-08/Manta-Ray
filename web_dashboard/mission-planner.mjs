// Local, small-area simulation preview only. This is not Fields2Cover.
const R = 6371008.8;
const RAD = Math.PI / 180;
// Inverse of the preview projection; positions are synthetic Roblox offsets.
export function simulatedPositionOnMap(preview, position) {
  if (!preview || !position || preview.id !== position.mission_id ||
      !Number.isFinite(position.east_m) || !Number.isFinite(position.north_m) ||
      !Number.isFinite(preview.origin?.longitude) || !Number.isFinite(preview.origin?.latitude) ||
      Math.abs(preview.origin.latitude) > 80) return null;
  return [preview.origin.longitude + position.east_m / (RAD * R * Math.cos(preview.origin.latitude * RAD)),
    preview.origin.latitude + position.north_m / (RAD * R)];
}
const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
const onSegment = (a, b, p) => Math.abs(cross(a, b, p)) < 1e-8 &&
  p[0] >= Math.min(a[0], b[0]) - 1e-8 && p[0] <= Math.max(a[0], b[0]) + 1e-8 &&
  p[1] >= Math.min(a[1], b[1]) - 1e-8 && p[1] <= Math.max(a[1], b[1]) + 1e-8;
function intersects(a, b, c, d) {
  const ab1 = cross(a, b, c), ab2 = cross(a, b, d), cd1 = cross(c, d, a), cd2 = cross(c, d, b);
  return (ab1 * ab2 < 0 && cd1 * cd2 < 0) || onSegment(a, b, c) || onSegment(a, b, d) ||
    onSegment(c, d, a) || onSegment(c, d, b);
}

function inPolygon(point, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j], b = poly[i];
    if (onSegment(a, b, point)) return true;
    if ((a[1] > point[1]) !== (b[1] > point[1]) &&
        point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

// Split at every boundary intersection and verify each interval, including
// collinear boundary travel. A midpoint alone is insufficient for concavities.
export function segmentInside(a, b, poly) {
  const dx = b[0] - a[0], dy = b[1] - a[1], length2 = dx * dx + dy * dy;
  if (length2 < 1e-16) return inPolygon(a, poly);
  const cuts = [0, 1];
  for (let i = 0; i < poly.length; i++) {
    const c = poly[i], d = poly[(i + 1) % poly.length];
    const ex = d[0] - c[0], ey = d[1] - c[1], denom = dx * ey - dy * ex;
    if (Math.abs(denom) < 1e-10) {
      if (Math.abs(cross(a, b, c)) < 1e-8) {
        for (const p of [c, d]) cuts.push(Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length2)));
      }
    } else {
      const t = ((c[0] - a[0]) * ey - (c[1] - a[1]) * ex) / denom;
      const u = ((c[0] - a[0]) * dy - (c[1] - a[1]) * dx) / denom;
      if (t >= -1e-9 && t <= 1 + 1e-9 && u >= -1e-9 && u <= 1 + 1e-9) cuts.push(Math.max(0, Math.min(1, t)));
    }
  }
  cuts.sort((x, y) => x - y);
  if (!inPolygon(a, poly) || !inPolygon(b, poly)) return false;
  for (let i = 1; i < cuts.length; i++) {
    if (cuts[i] - cuts[i - 1] < 1e-10) continue;
    const t = (cuts[i] + cuts[i - 1]) / 2;
    if (!inPolygon([a[0] + t * dx, a[1] + t * dy], poly)) return false;
  }
  return true;
}

function connector(a, b, polygon, visibility) {
  if (segmentInside(a, b, polygon)) return [b];
  const nodes = [a, ...polygon, b], end = nodes.length - 1;
  const dist = nodes.map(() => Infinity), previous = nodes.map(() => -1), done = new Set();
  dist[0] = 0;
  while (done.size < nodes.length) {
    let u = -1;
    for (let i = 0; i < nodes.length; i++) if (!done.has(i) && (u < 0 || dist[i] < dist[u])) u = i;
    if (u < 0 || !Number.isFinite(dist[u]) || u === end) break;
    done.add(u);
    for (let v = 1; v < nodes.length; v++) {
      if (done.has(v) || v === u) continue;
      const visible = u > 0 && u < end && v < end ? visibility[u - 1][v - 1] : segmentInside(nodes[u], nodes[v], polygon);
      if (!visible) continue;
      const candidate = dist[u] + Math.hypot(nodes[u][0] - nodes[v][0], nodes[u][1] - nodes[v][1]);
      if (candidate < dist[v]) { dist[v] = candidate; previous[v] = u; }
    }
  }
  if (!Number.isFinite(dist[end])) throw new Error('Could not connect swaths within the boundary.');
  const route = [];
  for (let i = end; i !== 0; i = previous[i]) route.push(nodes[i]);
  return route.reverse();
}

export function validateBoundary(vertices) {
  if (!Array.isArray(vertices) || vertices.length < 3 || vertices.length > 64)
    throw new Error('Plot 3–64 boundary vertices.');
  if (!vertices.every(p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite) &&
      Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 80))
    throw new Error('Invalid coordinates; the preview supports latitudes between −80° and 80°.');
  const lons = vertices.map(p => p[0]), lats = vertices.map(p => p[1]);
  if (Math.max(...lons) - Math.min(...lons) > 180) throw new Error('Antimeridian-crossing boundaries are not supported.');
  const origin = [(Math.min(...lons) + Math.max(...lons)) / 2, (Math.min(...lats) + Math.max(...lats)) / 2];
  const cos = Math.cos(origin[1] * RAD);
  const local = vertices.map(([lon, lat]) => [(lon - origin[0]) * RAD * R * cos, (lat - origin[1]) * RAD * R]);
  const xs = local.map(p => p[0]), ys = local.map(p => p[1]);
  const width = Math.max(...xs) - Math.min(...xs), height = Math.max(...ys) - Math.min(...ys);
  if (width > 2000 || height > 2000) throw new Error('Preview boundaries must fit within 2 km in each direction.');
  let area2 = 0;
  for (let i = 0; i < local.length; i++) {
    const a = local[i], b = local[(i + 1) % local.length];
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.01) throw new Error('Adjacent vertices must be distinct.');
    area2 += a[0] * b[1] - b[0] * a[1];
    for (let j = i + 1; j < local.length; j++) {
      if (j === i + 1 || (i === 0 && j === local.length - 1)) continue;
      if (intersects(a, b, local[j], local[(j + 1) % local.length])) throw new Error('Boundary edges must not cross or touch.');
    }
  }
  if (Math.abs(area2) < 0.02 || width < 0.01 || height < 0.01) throw new Error('Boundary area is too small.');
  return { origin, local, width, height };
}

export function createPreview(vertices, settings) {
  const { origin, local, width } = validateBoundary(vertices);
  const { depth_m, fov_deg, overlap } = settings || {};
  if (![depth_m, fov_deg, overlap].every(Number.isFinite) || depth_m <= 0 || depth_m > 100 ||
      fov_deg <= 0 || fov_deg >= 180 || overlap < 0 || overlap >= 1)
    throw new Error('Enter depth 0–100 m, FOV between 0° and 180°, and overlap from 0 to below 1.');
  const swath = 2 * depth_m * Math.tan(fov_deg * RAD / 2) * (1 - overlap);
  if (!Number.isFinite(swath) || swath < 0.05) throw new Error('Calculated swath must be at least 0.05 m.');
  const count = Math.max(1, Math.ceil(width / swath));
  if (count > 500) throw new Error('Too many swaths; increase swath width or choose a smaller area.');
  const minX = Math.min(...local.map(p => p[0]));
  const toGeo = ([x, y]) => [origin[0] + x / (RAD * R * Math.cos(origin[1] * RAD)), origin[1] + y / (RAD * R)];
  const swaths = [];
  for (let i = 0; i < count; i++) {
    const x = minX + (i + 0.5) * width / count, crossings = [];
    for (let j = 0; j < local.length; j++) {
      const a = local[j], b = local[(j + 1) % local.length];
      // Half-open rule counts a vertex once and ignores vertical edges.
      if ((a[0] <= x && x < b[0]) || (b[0] <= x && x < a[0]))
        crossings.push(a[1] + (x - a[0]) * (b[1] - a[1]) / (b[0] - a[0]));
    }
    crossings.sort((a, b) => a - b);
    if (crossings.length % 2) throw new Error('Could not intersect the boundary reliably.');
    const segments = [];
    for (let j = 0; j < crossings.length; j += 2)
      if (crossings[j + 1] - crossings[j] > 0.001) segments.push([[x, crossings[j]], [x, crossings[j + 1]]]);
    if (i % 2) segments.reverse();
    for (const segment of segments) swaths.push(i % 2 ? segment.reverse() : segment);
    if (swaths.length > 1000) throw new Error('Too many swath segments.');
  }
  if (!swaths.length) throw new Error('No swaths fit inside this boundary.');
  const visibility = local.map((a, i) => local.map((b, j) => i !== j && segmentInside(a, b, local)));
  const route = [swaths[0][0], swaths[0][1]];
  for (const segment of swaths.slice(1)) {
    route.push(...connector(route.at(-1), segment[0], local, visibility), segment[1]);
    if (route.length > 512) throw new Error('Preview path is too large; increase swath width or choose a smaller area.');
  }
  const point = p => ({ longitude: toGeo(p)[0], latitude: toGeo(p)[1], east_m: p[0], north_m: p[1] });
  return {
    preview_only: true,
    route_version: 1,
    warning: 'Simulation only: connectors stay inside the boundary but turns, clearance and obstacles are not modeled.',
    origin: { longitude: origin[0], latitude: origin[1] },
    boundary: vertices.map((p, i) => ({ longitude: p[0], latitude: p[1], east_m: local[i][0], north_m: local[i][1] })),
    settings: { depth_m, fov_deg, overlap, swath_m: swath },
    swaths: swaths.map(s => s.map(point)),
    waypoints: route.map(point),
  };
}
