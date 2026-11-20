'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { WebSocket } = require('ws');
const { createServer } = require('./server');
const { createReadOnlyGateway } = require('./tunnel');

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
