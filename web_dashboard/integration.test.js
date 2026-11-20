'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { WebSocket } = require('ws');
const { createServer, cameraURLs, localIP } = require('./server');
const { startSimulator, makeTelemetry, stepBuoyancy } = require('./simulator');
const { validateTelemetry, validateCommand, validateAck } = require('./protocol');
const DEVICE = 'test-device-token-000000000000', CONTROL = 'test-control-token-00000000000';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, timeout = 5000) { const deadline = Date.now() + timeout; do { const result = await fn(); if (result) return result; await delay(25); } while (Date.now() < deadline); throw new Error('Condition did not become true'); }
const command = (action = 'start', args = {}) => ({ schema_version: 1, id: randomUUID(), action, args, ttl_ms: 1000 });
async function fixture(t, options = {}) {
  const server = createServer({ deviceToken: DEVICE, controlToken: CONTROL, allowSimulator: true, staleMs: 300, deadMs: 2000, heartbeatMs: 50, leaseMs: 250, ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.shutdown());
  const base = `http://127.0.0.1:${server.address().port}`, ws = base.replace('http', 'ws');
  const get = endpoint => fetch(base + endpoint).then(r => r.json());
  const post = (endpoint, body, token = CONTROL) => fetch(base + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  const events = [];
  const sim = startSimulator({ token: DEVICE, url: ws + '/ws/device', intervalMs: 50, heartbeatTimeoutMs: 500, reconnectMinMs: 100, reconnectMaxMs: 200, onEvent: event => events.push(event), ...options.sim });
  t.after(() => sim.stop());
  await until(async () => (await get('/api/state')).connection === 'live');
  return { server, base, ws, get, post, sim, events };
}
test('v1 telemetry validates units, null reasons, provenance, fields and calibration', () => {
  assert.equal(validateTelemetry(makeTelemetry()).source, 'simulator');
  for (const change of [t => t.schema_version = 2, t => t.battery_voltage = 12, t => t.imu.acceleration.unit = 'g', t => t.imu.acceleration.value = [1, 2], t => t.water.temperature.reason = null, t => t.water.tds_estimate = { value: 150, unit: 'ppm', reason: null }, t => t.control.flapping = 'yes', t => t.seq = -1, t => t.uptime_ms = 1.5, t => t.control.amplitude_deg = NaN]) {
    const telemetry = makeTelemetry(); change(telemetry); assert.throws(() => validateTelemetry(telemetry));
  }
});
test('all command limits and ACK statuses reject malformed values', () => {
  for (const c of [command(), command('stop'), command('set_fin', { amplitude_deg: 45, cycle_hz: 2, centre_deg: 180 }), command('set_syringe', { target_deg: 0 })]) validateCommand(c);
  for (const c of [command('set_fin', { amplitude_deg: 46, cycle_hz: 1, centre_deg: 135 }), command('set_fin', { amplitude_deg: 20, cycle_hz: 0, centre_deg: 135 }), command('set_fin', { amplitude_deg: 20, cycle_hz: 1, centre_deg: 181 }), command('set_syringe', { target_deg: 181 }), command('start', { target_deg: 90 }), command('surface'), { ...command(), ttl_ms: 2001 }, { ...command(), args: [] }, { ...command(), id: 'x' }]) assert.throws(() => validateCommand(c));
  const ack = { schema_version: 1, type: 'ack', session_id: randomUUID(), id: randomUUID(), status: 'applied', reason: null };
  validateAck(ack); assert.throws(() => validateAck({ ...ack, status: 'success' })); assert.throws(() => validateAck({ ...ack, status: 'rejected' }));
});
test('buoyancy settles near both extremes and acceleration changes during motion', () => {
  const state = { volume: 0, depth: 0.5, velocity: 0, acceleration: 0 };
  stepBuoyancy(state, 0.02);
  assert.ok(state.acceleration > 0 && state.depth > 0.5);
  for (let i = 0; i < 3000; i++) stepBuoyancy(state, 0.02);
  assert.ok(state.depth > 0.94 && Math.abs(state.velocity) < 0.001);
  state.volume = 20;
  stepBuoyancy(state, 0.02);
  assert.ok(state.acceleration < 0);
  for (let i = 0; i < 3000; i++) stepBuoyancy(state, 0.02);
  assert.ok(state.depth < 0.06 && Math.abs(state.velocity) < 0.001);
  assert.throws(() => validateCommand(command('set_syringe_volume', { volume_ml: 20.01 })));
  const hardware = makeTelemetry(); hardware.source = 'hardware';
  assert.throws(() => validateTelemetry(hardware), /simulation fields/);
});
test('simulated syringe volume uses authorization, heartbeat, acknowledgement and telemetry', async t => {
  const f = await fixture(t);
  const c = command('set_syringe_volume', { volume_ml: 0 });
  assert.equal((await f.post('/api/commands', c, 'wrong')).status, 401);
  assert.equal((await f.post('/api/commands', c)).status, 409);
  await f.post('/api/control/heartbeat', {}); await delay(70);
  assert.equal((await f.post('/api/commands', c)).status, 202);
  const result = await until(async () => {
    const r = await fetch(`${f.base}/api/commands/${c.id}`, { headers: { Authorization: `Bearer ${CONTROL}` } }).then(r => r.json());
    return r.status !== 'pending' && r;
  });
  assert.equal(result.status, 'applied');
  const telemetry = await until(async () => { const s = await f.get('/api/state'); return s.telemetry.simulation.syringe_volume_ml === 0 && s.telemetry.simulation.depth_m > 0.5 && s.telemetry; });
  assert.ok(telemetry.imu.acceleration.value[2] < 9.7);
});
test('backend never forwards simulated volume commands to hardware', async t => {
  const server = createServer({ deviceToken: DEVICE, controlToken: CONTROL, allowSimulator: true, heartbeatMs: 50, leaseMs: 1000 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.shutdown());
  const base = `http://127.0.0.1:${server.address().port}`;
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws/device'); t.after(() => ws.terminate());
  await new Promise(resolve => ws.once('open', resolve));
  ws.send(JSON.stringify({ type: 'hello', schema_version: 1, robot_id: 'manta-01', source: 'hardware', token: DEVICE }));
  await new Promise(resolve => ws.once('message', resolve));
  const telemetry = makeTelemetry(); telemetry.source = 'hardware'; delete telemetry.simulation;
  ws.send(JSON.stringify(telemetry));
  await until(async () => !(await fetch(base + '/api/state').then(r => r.json())).stale);
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${CONTROL}` };
  await fetch(base + '/api/control/heartbeat', { method: 'POST', headers, body: '{}' });
  const response = await fetch(base + '/api/commands', { method: 'POST', headers, body: JSON.stringify(command('set_syringe_volume', { volume_ml: 10 })) });
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /simulation-only/);
});
test('camera URLs cannot redirect the backend off the device or to arbitrary paths', () => {
  const t = makeTelemetry(); t.camera.available = true; t.camera.stream_url = 'http://127.0.0.1:8081/stream'; t.camera.snapshot_url = 'http://127.0.0.1:8080/capture'; cameraURLs(t, '::ffff:127.0.0.1');
  for (const url of ['http://example.com:8080/capture', 'http://127.0.0.1:3000/capture', 'http://127.0.0.1:8080/admin', 'http://token@127.0.0.1:8080/capture', 'http://127.0.0.1:8080/capture?url=x']) { t.camera.snapshot_url = url; assert.throws(() => cameraURLs(t, '127.0.0.1')); }
  assert.ok(localIP('192.168.1.4')); assert.ok(!localIP('8.8.8.8')); assert.ok(!localIP('0.0.0.0'));
});
test('authentication, REST, live subscription, applied ACK and bounded history', async t => {
  const f = await fixture(t, { historySize: 3 });
  assert.equal((await f.post('/api/commands', command(), 'wrong')).status, 401);
  assert.equal((await f.post('/api/commands', command())).status, 409); // no lease
  const viewer = new WebSocket(f.ws + '/ws/live'); t.after(() => viewer.terminate());
  const live = await new Promise(resolve => viewer.once('message', raw => resolve(JSON.parse(raw)))); assert.equal(live.telemetry.source, 'simulator');
  assert.equal((await f.post('/api/control/heartbeat', {})).status, 200);
  await delay(70);
  const c = command(); assert.equal((await f.post('/api/commands', c)).status, 202);
  assert.equal((await fetch(`${f.base}/api/commands/${c.id}`)).status, 401);
  const result = await until(async () => { const r = await fetch(`${f.base}/api/commands/${c.id}`, { headers: { Authorization: `Bearer ${CONTROL}` } }).then(r => r.json()); return r.status !== 'pending' && r; });
  assert.equal(result.status, 'applied'); assert.equal(result.action, 'start');
  assert.equal((await f.post('/api/commands', c)).status, 409);
  await until(async () => (await f.get('/api/history')).samples.length === 3);
  assert.equal((await f.get('/api/history')).samples.length, 3);
});
test('CLI translation sends a partial fin update through the authenticated protocol', async t => {
  const f = await fixture(t);
  const { parseCommandLine, buildCommand } = await import('./commands.mjs');
  const s = await f.get('/api/state');
  const { name, params } = parseCommandLine('setfin cr 1.2');
  const translated = buildCommand(name, params, s);
  assert.equal((await f.post('/api/commands', command(translated.action, translated.args))).status, 409);
  await f.post('/api/control/heartbeat', {});
  await delay(70);
  const c = command(translated.action, translated.args);
  assert.equal((await f.post('/api/commands', c)).status, 202);
  const result = await until(async () => {
    const r = await fetch(`${f.base}/api/commands/${c.id}`, { headers: { Authorization: `Bearer ${CONTROL}` } }).then(r => r.json());
    return r.status !== 'pending' && r;
  });
  assert.equal(result.status, 'applied');
  assert.equal(f.sim.control.cycle_hz, 1.2);
  assert.equal(f.sim.control.amplitude_deg, s.telemetry.control.amplitude_deg);
  assert.equal(f.sim.control.centre_deg, s.telemetry.control.centre_deg);
});
test('stale data blocks commands and disconnect stops simulator fins without replay', async t => {
  const f = await fixture(t);
  await f.post('/api/control/heartbeat', {}); await delay(70);
  const c = command(); await f.post('/api/commands', c); await until(() => f.sim.control.flapping);
  f.sim.pauseTelemetry(true);
  await until(async () => (await f.get('/api/state')).stale);
  assert.equal((await f.post('/api/commands', command('stop'))).status, 409);
  await until(() => !f.sim.control.flapping);
  f.sim.pauseTelemetry(false); f.sim.disconnect();
  await until(() => f.events.filter(e => e.type === 'welcome').length >= 2);
  await until(async () => (await f.get('/api/state')).connection === 'live');
  assert.equal(f.events.filter(e => e.type === 'command' && e.id === c.id).length, 1);
  assert.equal((await f.get('/api/state')).control_active, false);
  assert.equal(f.sim.control.flapping, false);
});
test('missing ACK expires, late ACK cannot resurrect it, pending commands fail on reconnect', async t => {
  const f = await fixture(t);
  const status = id => fetch(`${f.base}/api/commands/${id}`, { headers: { Authorization: `Bearer ${CONTROL}` } }).then(r => r.json());
  f.sim.dropAcks(true);
  const c = { ...command('stop'), ttl_ms: 200 }; await f.post('/api/commands', c);
  await until(async () => (await status(c.id)).status === 'expired');
  const pending = command('stop'); await f.post('/api/commands', pending); f.sim.disconnect();
  await until(async () => (await status(pending.id)).status === 'disconnected');
  await until(() => f.events.filter(e => e.type === 'welcome').length >= 2);
  assert.equal(f.events.filter(e => e.type === 'command' && e.id === pending.id).length, 1);
  assert.equal((await f.post('/api/commands', c)).status, 409);
});
test('backend rejects simulator without opt-in and rejects wrong device credentials', async t => {
  const server = createServer({ deviceToken: DEVICE, controlToken: CONTROL }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.shutdown());
  for (const [source, token] of [['hardware', 'wrong'], ['simulator', DEVICE]]) {
    const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/ws/device`);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', schema_version: 1, robot_id: 'manta-01', source, token })));
    const code = await new Promise(resolve => ws.on('close', resolve)); assert.equal(code, 1008);
  }
});
test('camera recovery, timestamped CV sample, calibrated-result contract and stale result', async t => {
  const f = await fixture(t, { sim: { camera: true } });
  const response = await fetch(f.base + '/api/camera/frame'); assert.equal(response.status, 200);
  const bytes = new Uint8Array(await response.arrayBuffer()); assert.equal(bytes[0], 255); assert.equal(bytes[1], 216);
  const metadata = JSON.parse(response.headers.get('x-frame-metadata')); assert.equal(metadata.source, 'simulator'); assert.ok(metadata.captured_uptime_ms >= 0); assert.equal(metadata.calibration_id, null);
  assert.equal((await f.get('/api/cv')).available, false);
  const invalid = await f.post('/api/cv/result', { frame_id: metadata.frame_id, vegetation_cover_pct: 50 }); assert.equal(invalid.status, 400);
  const result = { frame_id: metadata.frame_id, vegetation_cover_pct: 0, method: 'synthetic-test-only', calibration_id: 'test-card-not-real-calibration', confidence: 1 };
  assert.equal((await f.post('/api/cv/result', result)).status, 200);
  assert.equal((await f.get('/api/cv')).result.frame.source, 'simulator');
  f.sim.pauseTelemetry(true); await until(async () => (await f.get('/api/state')).stale);
  assert.equal((await fetch(f.base + '/api/camera/frame')).status, 503);
  f.sim.pauseTelemetry(false); await until(async () => !(await f.get('/api/state')).stale);
  assert.equal((await fetch(f.base + '/api/camera/frame')).status, 200);
});
