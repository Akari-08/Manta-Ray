'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { inflateSync } = require('node:zlib');
const { WebSocket } = require('ws');
const { once } = require('node:events');
const { createServer } = require('./server');
const { createReadOnlyGateway } = require('./tunnel');
const { startSimulator, makeTelemetry } = require('./simulator');
const { BYTES, encodeFrame } = require('./roblox-camera');
const DEVICE = 'test-device-token-000000000000', CONTROL = 'test-control-token-00000000000', TOKEN = 'test-roblox-imu-token-000000000';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { for (let i = 0; i < 100; i++) { const value = await fn(); if (value) return value; await delay(25); } throw new Error('Timeout'); }

test('PNG encoder preserves 128x72 RGBA pixels', () => {
  const pixels = Buffer.alloc(BYTES);
  pixels.set([11, 47, 219, 255], 0);
  pixels.set([211, 33, 44, 255], BYTES - 4);
  const png = encodeFrame(pixels);
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.readUInt32BE(16), 128); assert.equal(png.readUInt32BE(20), 72);
  const size = png.readUInt32BE(33);
  const raw = inflateSync(png.subarray(41, 41 + size));
  assert.deepEqual([...raw.subarray(1, 5)], [11, 47, 219, 255]);
  assert.deepEqual([...raw.subarray(raw.length - 4)], [211, 33, 44, 255]);
  assert.throws(() => encodeFrame(Buffer.alloc(1)), /128x72/);
});

test('raycast feed is authenticated, bounded, rate limited, labeled and expires', async t => {
  let now = Date.now();
  const server = createServer({ deviceToken: DEVICE, controlToken: CONTROL, robloxImuToken: TOKEN, allowSimulator: true, now: () => now, staleMs: 2000 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const gateway = createReadOnlyGateway(server.address().port);
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`, publicBase = `http://127.0.0.1:${gateway.address().port}`;
  const sim = startSimulator({ token: DEVICE, url: base.replace('http', 'ws') + '/ws/device', intervalMs: 50 });
  t.after(async () => { await sim.stop(); await gateway.shutdown(); await server.shutdown(); });
  await until(async () => !(await fetch(base + '/api/state').then(r => r.json())).stale);
  const post = (body, token = TOKEN, extra = {}) => fetch(publicBase + '/api/roblox/camera', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', Authorization: `Bearer ${token}`, ...extra }, body });
  assert.equal((await post(Buffer.alloc(BYTES), 'wrong')).status, 401);
  assert.equal((await post(Buffer.alloc(BYTES), TOKEN, { Origin: 'https://example.com' })).status, 403);
  assert.equal((await post(Buffer.alloc(10))).status, 400);
  assert.equal((await post(Buffer.alloc(BYTES + 1))).status, 400);
  assert.equal((await post(Buffer.alloc(BYTES, 127))).status, 200);
  assert.equal((await post(Buffer.alloc(BYTES))).status, 429);
  now += 1000;
  assert.equal((await post(Buffer.alloc(BYTES, 128))).status, 200);
  const state = await fetch(base + '/api/state').then(r => r.json());
  assert.equal(state.roblox_camera.source, 'roblox-raycast');
  const frame = await fetch(publicBase + '/api/roblox/camera/frame');
  assert.equal(frame.status, 200); assert.equal(frame.headers.get('content-type'), 'image/png');
  assert.equal((await frame.arrayBuffer()).byteLength > 50, true);
  now += 9000;
  assert.equal((await fetch(base + '/api/roblox/camera/frame')).status, 503);
});

test('hardware never accepts or exposes simulated raycast frames', async t => {
  const server = createServer({ deviceToken: DEVICE, controlToken: CONTROL, robloxImuToken: TOKEN, allowSimulator: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const device = new WebSocket(base.replace('http', 'ws') + '/ws/device');
  t.after(async () => { device.terminate(); await server.shutdown(); });
  await once(device, 'open');
  device.send(JSON.stringify({ type: 'hello', schema_version: 1, robot_id: 'manta-01', source: 'hardware', token: DEVICE }));
  await once(device, 'message');
  const telemetry = makeTelemetry(); telemetry.source = 'hardware'; delete telemetry.simulation;
  device.send(JSON.stringify(telemetry));
  await until(async () => !(await fetch(base + '/api/state').then(r => r.json())).stale);
  const response = await fetch(base + '/api/roblox/camera', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', Authorization: `Bearer ${TOKEN}` }, body: Buffer.alloc(BYTES) });
  assert.equal(response.status, 409);
  assert.equal((await fetch(base + '/api/roblox/camera/frame')).status, 503);
});
