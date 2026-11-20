'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { WebSocket } = require('ws');
const { createServer } = require('./server');
const { createReadOnlyGateway } = require('./tunnel');
const { startSimulator, makeTelemetry } = require('./simulator');
const { randomUUID } = require('node:crypto');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { for (let i = 0; i < 100; i++) { const v = await fn(); if (v) return v; await delay(25); } throw new Error('Timed out'); }
const DEVICE = 'test-device-token-000000000000', CONTROL = 'test-control-token-00000000000';

test('tunnel gateway provides read-only HTTP and live updates without exposing controls', async t => {
  const backend = createServer({
    deviceToken: 'test-device-token-000000000000',
    controlToken: 'test-control-token-00000000000',
    demoAccess: true, allowSimulator: true,
  });
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
  const gateway = createReadOnlyGateway(backend.address().port);
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await gateway.shutdown(); await backend.shutdown(); });
  const base = `http://127.0.0.1:${gateway.address().port}`;
  assert.equal((await fetch(base + '/')).status, 200);
  const state = await (await fetch(base + '/api/state', {
    headers: { Origin: 'https://example.trycloudflare.com' },
  })).json();
  assert.equal(state.connection, 'disconnected');
  assert.equal((await fetch(base + '/api/demo/access')).status, 403);
  assert.equal((await fetch(base + '/api/commands/id', {
    headers: { Authorization: 'Bearer test-control-token-00000000000' },
  })).status, 403);
  for (const path of ['/api/commands', '/api/control/heartbeat', '/api/surveys/analyze', '/api/sitl/stop-and-surface']) {
    assert.equal((await fetch(base + path, { method: 'POST' })).status, 403);
  }
  const live = new WebSocket(base.replace('http:', 'ws:') + '/ws/live', {
    headers: { Origin: `https://example.trycloudflare.com`, Host: 'example.trycloudflare.com' },
  });
  const [message] = await once(live, 'message');
  assert.equal(JSON.parse(message).type, 'state');
  live.terminate();
  const device = new WebSocket(base.replace('http:', 'ws:') + '/ws/device');
  const [error] = await once(device, 'error');
  assert.ok(error);
});

test('writable tunnel requires a token and same-origin browser requests', async t => {
  const backend = createServer({ deviceToken: DEVICE, controlToken: CONTROL, allowSimulator: true, heartbeatMs: 50, leaseMs: 1000 });
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
  const gateway = createReadOnlyGateway(backend.address().port, '127.0.0.1', { controlToken: CONTROL, tunnelSecret: backend.tunnelSecret });
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  const local = `http://127.0.0.1:${backend.address().port}`, remote = `http://127.0.0.1:${gateway.address().port}`;
  const sim = startSimulator({ token: DEVICE, url: local.replace('http', 'ws') + '/ws/device', intervalMs: 50 });
  t.after(async () => { await sim.stop(); await gateway.shutdown(); await backend.shutdown(); });
  await until(async () => !(await fetch(remote + '/api/state').then(r => r.json())).stale);
  const headers = { Origin: `https://127.0.0.1:${gateway.address().port}`, 'Content-Type': 'application/json', Authorization: `Bearer ${CONTROL}` };
  const post = (path, data, h = headers) => fetch(remote + path, { method: 'POST', headers: h, body: JSON.stringify(data) });
  const wrongToken = await post('/api/control/heartbeat', {}, { ...headers, Authorization: 'Bearer wrong' });
  assert.equal(wrongToken.status, 401, await wrongToken.text());
  assert.equal((await post('/api/control/heartbeat', {}, { ...headers, Origin: 'https://evil.example' })).status, 403);
  assert.equal((await post('/api/control/heartbeat', {}, { ...headers, 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await fetch(remote + '/api/demo/access')).status, 403);
  assert.equal((await post('/api/unknown', {})).status, 403);
  const mission = { vertices: [[-123, 49], [-122.9999, 49], [-122.9999, 49.0001], [-123, 49.0001]], settings: { depth_m: 1, fov_deg: 60, overlap: 0.2 } };
  assert.equal((await post('/api/mission', mission, { ...headers, Authorization: '' })).status, 401);
  assert.equal((await post('/api/mission', mission)).status, 201);
  assert.equal((await post('/api/surveys/analyze', {})).status, 400);
  assert.equal((await post('/api/sitl/stop-and-surface', {})).status, 409);
  assert.equal((await post('/api/control/heartbeat', {})).status, 200);
  await delay(80);
  const c = { schema_version: 1, id: randomUUID(), action: 'start', args: {}, ttl_ms: 1000 };
  assert.equal((await post('/api/commands', c)).status, 202);
  const commandStatus = await until(async () => {
    const r = await fetch(remote + `/api/commands/${c.id}`, { headers }).then(res => res.json());
    return r.status !== 'pending' && r;
  });
  assert.equal(commandStatus.status, 'applied');
  assert.equal(sim.control.flapping, true);
  assert.equal((await fetch(remote + `/api/commands/${c.id}`)).status, 401);
});

test('writable tunnel rejects hardware heartbeat and commands even with token', async t => {
  const backend = createServer({ deviceToken: DEVICE, controlToken: CONTROL, allowSimulator: true });
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
  const gateway = createReadOnlyGateway(backend.address().port, '127.0.0.1', { controlToken: CONTROL, tunnelSecret: backend.tunnelSecret });
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  const local = `http://127.0.0.1:${backend.address().port}`, remote = `http://127.0.0.1:${gateway.address().port}`;
  const device = new WebSocket(local.replace('http', 'ws') + '/ws/device');
  t.after(async () => { device.terminate(); await gateway.shutdown(); await backend.shutdown(); });
  await once(device, 'open');
  device.send(JSON.stringify({ type: 'hello', schema_version: 1, robot_id: 'manta-01', source: 'hardware', token: DEVICE }));
  await once(device, 'message');
  const telemetry = makeTelemetry(); telemetry.source = 'hardware'; delete telemetry.simulation;
  device.send(JSON.stringify(telemetry));
  await until(async () => !(await fetch(remote + '/api/state').then(r => r.json())).stale);
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${CONTROL}`, 'X-Manta-Tunnel': 'forged' };
  const post = (base, path, body) => fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) });
  assert.equal((await post(remote, '/api/control/heartbeat', {})).status, 409);
  assert.equal((await post(local, '/api/control/heartbeat', {})).status, 200);
  const c = { schema_version: 1, id: randomUUID(), action: 'start', args: {}, ttl_ms: 1000 };
  assert.equal((await post(remote, '/api/commands', c)).status, 409);
});
