'use strict';

// Public reads remain available; selected writes require the control token.
// Hardware motion and /ws/device remain inaccessible through this gateway.
const http = require('node:http');
const { spawn } = require('node:child_process');
const { timingSafeEqual } = require('node:crypto');
const { WebSocket, WebSocketServer } = require('ws');

function allowedPath(pathname) {
  if (!pathname.startsWith('/api/')) return true; // The backend has its own static-file allowlist.
  return ['/api/state', '/api/history', '/api/cv', '/api/camera/frame', '/api/roblox/camera/frame', '/api/mission',
    '/api/sitl/status', '/api/surveys', '/api/ecology/methods'].includes(pathname)
    || /^\/api\/surveys\/(jobs|artifacts|ecology|reconstruction)\/[^/]+(?:\/assessment)?$/.test(pathname)
    || /^\/api\/ecology\/assessments\/[^/]+(?:\/(?:audit|request))?$/.test(pathname);
}

function controlRoute(method, path) {
  return (method === 'GET' && /^\/api\/commands\/[a-zA-Z0-9_-]{8,64}$/.test(path)) ||
    (method === 'POST' && ['/api/commands', '/api/control/heartbeat', '/api/mission', '/api/surveys/analyze', '/api/sitl/stop-and-surface', '/api/cv/result'].includes(path)) ||
    (method === 'DELETE' && path === '/api/control/heartbeat') ||
    (method === 'POST' && /^\/api\/surveys\/ecology\/[a-f0-9]{32}\/assessment$/.test(path));
}
function tokenEqual(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a.length > 0 &&
    Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
function createReadOnlyGateway(backendPort, backendHost = '127.0.0.1', options = {}) {
  const hostHeader = `${backendHost.includes(':') ? `[${backendHost}]` : backendHost}:${backendPort}`;
  const writable = typeof options.controlToken === 'string' && options.controlToken.length >= 24 &&
    typeof options.tunnelSecret === 'string' && options.tunnelSecret.length >= 24;
  let failures = 0, failureWindow = Date.now();
  const server = http.createServer((req, res) => {
    let pathname;
    try { pathname = new URL(req.url, 'http://localhost').pathname; }
    catch { res.writeHead(400).end(); return; }
    const imuUpload = req.method === 'POST' && ['/api/roblox/imu', '/api/roblox/camera'].includes(pathname) && !req.headers.origin;
    const protectedRoute = writable && controlRoute(req.method, pathname);
    if (protectedRoute) {
      if ((req.headers.origin && req.headers.origin !== `https://${req.headers.host}`) ||
          req.headers['sec-fetch-site'] === 'cross-site') {
        res.writeHead(403, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error: 'Cross-origin control requests are forbidden' })); return;
      }
      if (!tokenEqual(req.headers.authorization, `Bearer ${options.controlToken}`)) {
        if (Date.now() - failureWindow >= 60000) { failures = 0; failureWindow = Date.now(); }
        failures++;
        res.writeHead(failures > 30 ? 429 : 401, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error: 'Valid control bearer token required' })); return;
      }
    }
    if (!imuUpload && !protectedRoute && (req.method !== 'GET' || !allowedPath(pathname))) {
      res.writeHead(403, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: 'Public tunnel allows only authenticated simulator telemetry and raycast uploads; other writes are blocked' }));
      return;
    }
    const upstream = http.request({
      hostname: backendHost, port: backendPort, method: imuUpload || protectedRoute ? req.method : 'GET', path: req.url,
      headers: imuUpload || protectedRoute ? { host: hostHeader, 'content-type': req.headers['content-type'] || '', authorization: req.headers.authorization || '', ...(protectedRoute ? { 'x-manta-tunnel': options.tunnelSecret } : {}) } : { host: hostHeader },
    }, response => {
      res.writeHead(response.statusCode, response.headers);
      response.pipe(res);
    });
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Local dashboard unavailable' }));
    });
    res.on('close', () => upstream.destroy());
    if (imuUpload || protectedRoute) {
      req.setTimeout(10000, () => req.destroy());
      req.once('end', () => req.setTimeout(0));
      req.pipe(upstream);
    } else upstream.end();
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16384 });
  server.on('upgrade', (req, socket, head) => {
    let pathname;
    try { pathname = new URL(req.url, 'http://localhost').pathname; }
    catch { socket.destroy(); return; }
    // Only browser viewers are bridged; never forward /ws/device.
    if (pathname !== '/ws/live' || wss.clients.size >= 16 ||
        (req.headers.origin && req.headers.origin !== `https://${req.headers.host}`)) {
      socket.destroy(); return;
    }
    wss.handleUpgrade(req, socket, head, client => {
      const upstream = new WebSocket(`ws://${hostHeader}/ws/live`);
      client.on('error', () => upstream.terminate());
      client.on('close', () => upstream.terminate());
      upstream.on('error', () => client.terminate());
      upstream.on('close', () => client.close());
      upstream.on('message', (data, binary) => {
        if (client.readyState === WebSocket.OPEN && client.bufferedAmount < 65536) {
          client.send(data, { binary });
        } else client.terminate();
      });
    });
  });
  server.shutdown = async () => {
    for (const client of wss.clients) client.terminate();
    wss.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  };
  return server;
}

async function startTunnel(backendPort, options = {}) {
  const gateway = createReadOnlyGateway(backendPort, options.backendHost, options);
  await new Promise((resolve, reject) => {
    gateway.once('error', reject);
    gateway.listen(0, '127.0.0.1', resolve);
  });
  const child = (options.spawn || spawn)('cloudflared', [
    'tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${gateway.address().port}`,
  ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let printed = false, pending = '';
  function output(chunk) {
    pending = (pending + chunk.toString()).slice(-8192);
    const match = pending.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/i);
    if (match && !printed) {
      printed = true;
      console.log(`Public dashboard: ${match[0]}`);
      console.log(`Roblox telemetry endpoint: ${match[0]}/api/state`);
      console.log('Anyone with this link can view dashboard data and camera images. Do not share sensitive data.');
      if (options.controlToken && options.tunnelSecret) console.log('Remote writes require the control token; remote vehicle control is simulator-only.');
    }
  }
  child.stdout.on('data', output);
  child.stderr.on('data', output);
  child.on('error', error => console.error(`Tunnel unavailable: ${error.message}. The local dashboard remains available.`));
  child.on('exit', (code, signal) => {
    if (!child.killed) console.error(`Tunnel stopped (${signal || code}); the local dashboard remains available.`);
  });
  return {
    async stop() {
      if (!child.killed) child.kill();
      await gateway.shutdown();
    },
  };
}

module.exports = { allowedPath, createReadOnlyGateway, startTunnel };
