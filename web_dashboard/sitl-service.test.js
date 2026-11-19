'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createSitlService } = require('./sitl-service');

async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return 'http://127.0.0.1:' + server.address().port;
}
function cleanup(t, server) {
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
}
const vehicle = () => ({ state: 'surfacing', depth_m: 2, forward_speed_mps: 0, events: ['command_received', 'forward_motion_stopped'] });

test('proxy requires authorization and live simulator, preserves receiver retry receipts', async t => {
  let received = 0;
  const receiver = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/status') return res.end(JSON.stringify(vehicle()));
    assert.equal(req.url, '/commands');
    assert.equal(req.method, 'POST');
    let body = ''; for await (const chunk of req) body += chunk;
    assert.deepEqual(JSON.parse(body), { command: 'STOP_AND_SURFACE' });
    received++;
    res.statusCode = received === 1 ? 202 : 200;
    res.end(JSON.stringify({ command: 'STOP_AND_SURFACE', result: received === 1 ? 'accepted' : 'already_requested', status: vehicle() }));
  });
  const baseUrl = await listen(receiver); cleanup(t, receiver);
  const service = createSitlService({ baseUrl, enabled: true, allowSimulator: true });
  let live = { stale: false, connection: 'live', telemetry: { source: 'simulator' } };
  const proxy = http.createServer((req, res) => service.handle(req, res, new URL(req.url, 'http://localhost'), { authorized: req.headers.authorization === 'Bearer test', state: () => live }));
  const url = await listen(proxy); cleanup(t, proxy);
  let response = await fetch(url + '/api/sitl/status');
  assert.deepEqual(await response.json(), { ...vehicle(), available: true, source: 'simulation', simulation: true });
  const command = (token = 'test') => fetch(url + '/api/sitl/stop-and-surface', { method: 'POST', headers: { Authorization: 'Bearer ' + token } });
  assert.equal((await command('bad')).status, 401);
  live.telemetry.source = 'hardware';
  assert.equal((await command()).status, 409);
  live.telemetry.source = 'simulator'; live.stale = true;
  assert.equal((await command()).status, 409);
  assert.equal(received, 0);
  live.stale = false;
  response = await command(); assert.equal(response.status, 202);
  assert.equal((await response.json()).result, 'accepted');
  response = await command(); assert.equal(response.status, 200);
  assert.equal((await response.json()).result, 'already_requested');
  assert.equal(received, 2);
});

test('disabled simulation never contacts receiver; unsupported routes remain unhandled', async () => {
  const service = createSitlService({ enabled: true, allowSimulator: false });
  const res = { writeHead(code) { this.code = code; }, end(body) { this.body = JSON.parse(body); } };
  assert.equal(await service.handle({ method: 'GET' }, res, new URL('http://localhost/other')), false);
  await service.handle({ method: 'GET' }, res, new URL('http://localhost/api/sitl/status'));
  assert.equal(res.body.available, false);
  await service.handle({ method: 'POST' }, res, new URL('http://localhost/api/sitl/stop-and-surface'), { authorized: true });
  assert.equal(res.code, 409);
});

test('unavailable and invalid receiver responses remain visibly unavailable', async t => {
  const receiver = http.createServer((req, res) => res.end('{"state":"hardware"}'));
  const baseUrl = await listen(receiver);
  cleanup(t, receiver);
  const service = createSitlService({ baseUrl, enabled: true, allowSimulator: true });
  const res = { writeHead(code) { this.code = code; }, end(body) { this.body = JSON.parse(body); } };
  await service.handle({ method: 'GET' }, res, new URL('http://localhost/api/sitl/status'));
  assert.equal(res.body.available, false);
  assert.match(res.body.reason, /invalid vehicle status/);
  await new Promise(resolve => { receiver.closeAllConnections(); receiver.close(resolve); });
  await service.handle({ method: 'GET' }, res, new URL('http://localhost/api/sitl/status'));
  assert.equal(res.body.available, false);
  assert.equal(res.body.simulation, true);
  await service.handle({ method: 'POST' }, res, new URL('http://localhost/api/sitl/stop-and-surface'), {
    authorized: true, state: () => ({ stale: false, connection: 'live', telemetry: { source: 'simulator' } }),
  });
  assert.equal(res.code, 503);
});

test('receiver URL is restricted to literal loopback HTTP', () => {
  for (const baseUrl of ['https://127.0.0.1', 'http://192.168.1.1', 'http://localhost', 'http://127.0.0.1/path']) {
    assert.throws(() => createSitlService({ baseUrl }), /loopback/);
  }
});
