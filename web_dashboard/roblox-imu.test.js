'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('./server');
const { startSimulator } = require('./simulator');
const { makeTelemetry } = require('./simulator');
const { createReadOnlyGateway } = require('./tunnel');
const { WebSocket } = require('ws');
const { once } = require('node:events');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('Roblox IMU is authenticated, simulator-only, sequenced, and falls back after timeout', async t => {
  const token = 'test-roblox-imu-token-000000000';
  const backend = createServer({ deviceToken: 'test-device-token-000000000000', controlToken: 'test-control-token-00000000000', robloxImuToken: token, allowSimulator: true, staleMs: 500 });
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
  const gateway = createReadOnlyGateway(backend.address().port);
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${backend.address().port}`;
  const publicBase = `http://127.0.0.1:${gateway.address().port}`;
  const sim = startSimulator({ token: 'test-device-token-000000000000', url: base.replace('http', 'ws') + '/ws/device', intervalMs: 50 });
  t.after(async () => { await sim.stop(); await gateway.shutdown(); await backend.shutdown(); });
  for (let i = 0; i < 100 && (await (await fetch(base + '/api/state')).json()).stale; i++) await delay(25);
  const mission = await fetch(base + '/api/mission', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    vertices: [[-123, 49], [-122.9999, 49], [-122.9999, 49.0001], [-123, 49.0001]], settings: { depth_m: 1, fov_deg: 60, overlap: 0.2 },
  }) }).then(r => r.json());
  const position = { mission_id: mission.mission.id, east_m: 1.5, north_m: -2 };
  const sample = { session_id: 'abcd1234-1234-1234-1234-123456789012', seq: 1, acceleration: [1, 2, 3], angular_velocity: [4, 5, 6], roll_deg: 12, pitch_deg: -5, yaw_deg: 45, position };
  const post = (value, auth = token, extra = {}) => fetch(publicBase + '/api/roblox/imu', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth}`, ...extra }, body: JSON.stringify(value) });
  assert.equal((await post(sample, 'wrong')).status, 401);
  assert.equal((await post(sample, token, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await post({ ...sample, acceleration: [1, 2, 999] })).status, 400);
  assert.equal((await post({ ...sample, position: { ...position, east_m: 5000 } })).status, 400);
  assert.equal((await post(sample)).status, 200);
  let state = await (await fetch(base + '/api/state')).json();
  assert.equal(state.imu_source, 'roblox');
  assert.equal(state.roblox_yaw_deg, 45);
  assert.deepEqual(state.telemetry.imu.acceleration.value, [1, 2, 3]);
  assert.deepEqual(state.roblox_position, position);
  assert.equal((await post(sample)).status, 409);
  assert.equal((await post({ ...sample, seq: 2 })).status, 429);
  assert.equal((await post({ ...sample, session_id: 'ffff1234-1234-1234-1234-123456789012' })).status, 409);
  await fetch(base + '/api/mission', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    vertices: [[-123, 49], [-122.9999, 49], [-122.9999, 49.0001], [-123, 49.0001]], settings: { depth_m: 1, fov_deg: 60, overlap: 0.2 },
  }) });
  assert.equal((await (await fetch(base + '/api/state')).json()).roblox_position, null);
  await delay(2600);
  state = await (await fetch(base + '/api/state')).json();
  assert.equal(state.imu_source, 'simulator');
  assert.equal(state.roblox_yaw_deg, null);
  assert.equal(state.roblox_position, null);
});

test('authenticated Roblox IMU cannot replace hardware telemetry', async t => {
  const deviceToken = 'test-device-token-000000000000', token = 'test-roblox-imu-token-000000000';
  const backend = createServer({ deviceToken, controlToken: 'test-control-token-00000000000', robloxImuToken: token, allowSimulator: true });
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${backend.address().port}`;
  const device = new WebSocket(base.replace('http', 'ws') + '/ws/device');
  t.after(async () => { device.terminate(); await backend.shutdown(); });
  await once(device, 'open');
  device.send(JSON.stringify({ type: 'hello', schema_version: 1, robot_id: 'manta-01', source: 'hardware', token: deviceToken }));
  await once(device, 'message');
  const telemetry = makeTelemetry(); telemetry.source = 'hardware'; delete telemetry.simulation;
  device.send(JSON.stringify(telemetry));
  for (let i = 0; i < 100 && (await (await fetch(base + '/api/state')).json()).stale; i++) await delay(25);
  const response = await fetch(base + '/api/roblox/imu', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ session_id: 'abcd1234-1234-1234-1234-123456789012', seq: 1, acceleration: [0, 0, 9], angular_velocity: [0, 0, 0], roll_deg: 0, pitch_deg: 0, yaw_deg: 0 }) });
  assert.equal(response.status, 409);
  assert.equal((await (await fetch(base + '/api/state')).json()).imu_source, 'hardware');
});
