'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { WebSocket } = require('ws');
const { createServer } = require('./server');
const { startSimulator } = require('./simulator');

const DEVICE = 'demo-device-token-000000000000';
const CONTROL = 'demo-control-token-00000000000';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await delay(25);
  }
  throw new Error('Demo test timed out');
}
async function fixture(t, options = {}, withSimulator = true) {
  const server = createServer({
    deviceToken: DEVICE, controlToken: CONTROL, allowSimulator: true,
    staleMs: 400, deadMs: 5000, heartbeatMs: 50, ...options,
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.shutdown());
  const base = 'http://127.0.0.1:' + server.address().port;
  let sim;
  if (withSimulator) {
    sim = startSimulator({ url: base.replace('http', 'ws') + '/ws/device', token: DEVICE, intervalMs: 50, camera: false });
    t.after(() => sim.stop());
    await until(async () => !(await (await fetch(base + '/api/state')).json()).stale);
  }
  return { server, base, sim };
}
async function rawGet(base, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(base + '/api/demo/access', { headers }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, data: JSON.parse(data) }));
    });
    req.on('error', reject);
  });
}

test('automatic access requires explicit demo opt-in and simulation enablement', async t => {
  const manual = await fixture(t);
  const denied = await rawGet(manual.base);
  assert.equal(denied.status, 404);
  assert.equal(denied.data.control_token, undefined);
  const disabled = await fixture(t, { demoAccess: true, allowSimulator: false }, false);
  assert.equal((await rawGet(disabled.base)).status, 404);
});

test('demo access is localhost same-origin only, fresh and never CORS-enabled', async t => {
  const f = await fixture(t, { demoAccess: true });
  const port = f.server.address().port;
  for (const headers of [
    { Host: 'attacker.example:' + port },
    { Host: '127.0.0.1:' + (port + 1) },
    { Host: '192.168.1.1:' + port },
    { Host: '127.0.0.2:' + port },
    { Origin: 'https://attacker.example' },
    { 'Sec-Fetch-Site': 'cross-site' },
    { 'Sec-Fetch-Site': 'same-site' },
    { Host: 'attacker.example:' + port, Origin: 'http://attacker.example:' + port },
  ]) {
    const response = await rawGet(f.base, headers);
    assert.equal(response.status, 403);
    assert.equal(response.data.control_token, undefined);
    assert.equal(response.headers['access-control-allow-origin'], undefined);
  }
  for (const host of ['127.0.0.1:' + port, 'localhost:' + port]) {
    const response = await rawGet(f.base, { Host: host, Origin: 'http://' + host, 'Sec-Fetch-Site': 'same-origin' });
    assert.equal(response.status, 200);
    assert.equal(response.data.control_token, CONTROL);
    assert.equal(response.data.simulation, true);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['access-control-allow-origin'], undefined);
  }
  f.sim.pauseTelemetry(true);
  await until(async () => (await (await fetch(f.base + '/api/state')).json()).stale);
  assert.equal((await rawGet(f.base)).status, 409);
});

test('demo access waits for initial telemetry and rejects hardware authentication', async t => {
  const f = await fixture(t, { demoAccess: true }, false);
  assert.equal((await rawGet(f.base)).status, 409);
  const ws = new WebSocket(f.base.replace('http', 'ws') + '/ws/device');
  t.after(() => ws.terminate());
  const messages = [];
  ws.on('message', data => messages.push(JSON.parse(data)));
  ws.on('open', () => ws.send(JSON.stringify({
    type: 'hello', schema_version: 1, robot_id: 'manta-01', source: 'hardware', token: DEVICE,
  })));
  const code = await new Promise((resolve, reject) => {
    ws.once('close', resolve);
    ws.once('error', reject);
  });
  assert.equal(code, 1008);
  assert.equal(messages.some(message => message.type === 'welcome'), false);
  assert.equal((await rawGet(f.base)).status, 409);
});

test('automatic token acquisition preserves bearer authentication and explicit motion heartbeat', async t => {
  const f = await fixture(t, { demoAccess: true });
  const { data: access } = await rawGet(f.base);
  const post = (endpoint, payload, token) => fetch(f.base + endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify(payload),
  });
  const command = () => ({ schema_version: 1, id: randomUUID(), action: 'start', args: {}, ttl_ms: 1000 });
  assert.equal((await post('/api/control/heartbeat', {})).status, 401);
  assert.equal((await post('/api/commands', command())).status, 401);
  assert.equal((await post('/api/commands', command(), access.control_token)).status, 409);
  assert.equal(f.sim.control.flapping, false);
  assert.equal((await post('/api/control/heartbeat', {}, access.control_token)).status, 200);
  await delay(75);
  assert.equal((await post('/api/commands', command(), access.control_token)).status, 202);
  await until(() => f.sim.control.flapping);
});

test('manual server still accepts authenticated hardware hello', async t => {
  const f = await fixture(t, { demoAccess: false, allowSimulator: false }, false);
  const ws = new WebSocket(f.base.replace('http', 'ws') + '/ws/device');
  t.after(() => ws.terminate());
  ws.on('open', () => ws.send(JSON.stringify({
    type: 'hello', schema_version: 1, robot_id: 'manta-01', source: 'hardware', token: DEVICE,
  })));
  const message = await new Promise((resolve, reject) => {
    ws.once('message', data => resolve(JSON.parse(data)));
    ws.once('error', reject);
  });
  assert.equal(message.type, 'welcome');
  assert.equal((await rawGet(f.base)).status, 404);
});

test('UI acquires demo token once into memory and enable-control uses token fallback', () => {
  const source = readFileSync(path.join(__dirname, 'app.js'), 'utf8');
  const automatic = source.slice(source.indexOf('async function authorizeLocalDemo'), source.indexOf('const format ='));
  assert.match(automatic, /demoAccessAttempted/);
  assert.match(automatic, /state\.telemetry\?\.source !== 'simulator'/);
  assert.match(automatic, /client\.token = access\.control_token/);
  assert.match(automatic, /\$\('control-token'\)\.disabled = true/);
  assert.match(automatic, /Automatic local demo/);
  assert.doesNotMatch(automatic, /localStorage|console\./);
  assert.match(source, /client\.enable\(\$\('control-token'\)\.value\.trim\(\) \|\| client\.token\)/);
  assert.match(source, /token: \(\) => client\.token \|\|/);
});
