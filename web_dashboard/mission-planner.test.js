'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('./server');
const { createReadOnlyGateway } = require('./tunnel');
const planner = import('./mission-planner.mjs');
const boundary = [[-123, 49], [-122.9999, 49], [-122.9999, 49.0001], [-123, 49.0001]];
const settings = { depth_m: 1, fov_deg: 60, overlap: 0.2 };

test('lawnmower preview computes FOV swaths and alternating endpoints', async () => {
  const { createPreview } = await planner;
  const plan = createPreview(boundary, settings);
  assert.equal(plan.preview_only, true);
  assert.ok(Math.abs(plan.settings.swath_m - 2 * Math.tan(Math.PI / 6) * 0.8) < 1e-9);
  assert.ok(plan.swaths.length > 1);
  assert.ok(plan.swaths[0][0].north_m < plan.swaths[0][1].north_m);
  assert.ok(plan.swaths[1][0].north_m > plan.swaths[1][1].north_m);
  assert.ok(plan.waypoints.length >= plan.swaths.length * 2);
  assert.equal((Math.min(...plan.boundary.map(p => p.east_m)) + Math.max(...plan.boundary.map(p => p.east_m))) / 2, 0);
});

test('simulated position projects back to the matching geographic preview', async () => {
  const { createPreview, simulatedPositionOnMap } = await planner;
  const plan = { ...createPreview(boundary, settings), id: 'mission-1' };
  const waypoint = plan.waypoints[0];
  const position = { mission_id: plan.id, east_m: waypoint.east_m, north_m: waypoint.north_m };
  const coordinates = simulatedPositionOnMap(plan, position);
  assert.ok(Math.abs(coordinates[0] - waypoint.longitude) < 1e-10);
  assert.ok(Math.abs(coordinates[1] - waypoint.latitude) < 1e-10);
  assert.equal(simulatedPositionOnMap(plan, { ...position, mission_id: 'old' }), null);
  assert.equal(simulatedPositionOnMap(plan, { ...position, east_m: NaN }), null);
  assert.equal(simulatedPositionOnMap(null, position), null);
});

test('rejects invalid geometry, tiny swaths and unsupported large regions', async () => {
  const { createPreview } = await planner;
  assert.throws(() => createPreview([boundary[0], boundary[1]], settings), /3–64/);
  assert.throws(() => createPreview([boundary[0], boundary[2], boundary[1], boundary[3]], settings), /cross|area/i);
  assert.throws(() => createPreview(boundary, { ...settings, overlap: 1 }), /overlap/i);
  assert.throws(() => createPreview(boundary, { ...settings, fov_deg: 0.001 }), /swath/i);
  assert.throws(() => createPreview([[0, 0], [1, 0], [1, 1], [0, 1]], settings), /2 km/);
});

test('concave polygon connectors remain inside the polygon', async () => {
  const { createPreview, validateBoundary, segmentInside } = await planner;
  const shape = [[0, 0], [0.0001, 0], [0.0001, 0.0001], [0.00007, 0.0001],
    [0.00007, 0.00003], [0.00003, 0.00003], [0.00003, 0.0001], [0, 0.0001]];
  const plan = createPreview(shape, settings);
  assert.ok(plan.swaths.every(segment => segment.length === 2));
  assert.match(plan.warning, /obstacles are not modeled/);
  const poly = validateBoundary(shape).local;
  for (let i = 1; i < plan.waypoints.length; i++) {
    const a = plan.waypoints[i - 1], b = plan.waypoints[i];
    assert.ok(segmentInside([a.east_m, a.north_m], [b.east_m, b.north_m], poly));
  }
});

test('mission creation is local only, while tunnel exposes read-only preview', async t => {
  const backend = createServer({ deviceToken: 'test-device-token-000000000000', controlToken: 'test-control-token-00000000000' });
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
  const gateway = createReadOnlyGateway(backend.address().port);
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await gateway.shutdown(); await backend.shutdown(); });
  const local = `http://127.0.0.1:${backend.address().port}`;
  const publicGateway = `http://127.0.0.1:${gateway.address().port}`;
  const post = base => fetch(base + '/api/mission', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ vertices: boundary, settings }) });
  assert.equal((await post(publicGateway)).status, 403);
  assert.equal((await (await fetch(local + '/api/mission')).json()).mission, null);
  const response = await post(local);
  assert.equal(response.status, 201);
  const saved = (await response.json()).mission;
  assert.equal((await (await fetch(publicGateway + '/api/mission')).json()).mission.id, saved.id);
  const bad = await fetch(local + '/api/mission', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ vertices: [], settings }) });
  assert.equal(bad.status, 400);
  assert.equal((await (await fetch(local + '/api/mission')).json()).mission.id, saved.id);
});
