const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('./server');

test('serves only dashboard assets', async (t) => {
  const server = createServer({ deviceToken: 'test-device-token-000000000000', controlToken: 'test-control-token-00000000000' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.shutdown());
  const base = `http://127.0.0.1:${server.address().port}`;

  for (const [path, type] of [['/', 'text/html'], ['/styles.css', 'text/css'], ['/app.js', 'text/javascript'], ['/commands.mjs', 'text/javascript'], ['/motion-model.mjs', 'text/javascript'], ['/fish-view.mjs', 'text/javascript'], ['/location-map.mjs', 'text/javascript'], ['/vendor/three.module.js', 'text/javascript'], ['/vendor/three.core.js', 'text/javascript'], ['/vendor/maplibre-gl.mjs', 'text/javascript'], ['/vendor/maplibre-gl-worker.mjs', 'text/javascript'], ['/vendor/maplibre-gl.css', 'text/css']]) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), new RegExp(type));
    assert.ok((await response.text()).length > 0);
  }
  assert.equal((await fetch(`${base}/server.js`)).status, 404);
  assert.equal((await fetch(`${base}/`, { method: 'POST' })).status, 404);
});
