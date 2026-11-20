'use strict';

// A separate loopback gateway prevents the public tunnel from reaching control
// routes or impersonating a device, even if a control token is supplied.
const http = require('node:http');
const { spawn } = require('node:child_process');
const { WebSocket, WebSocketServer } = require('ws');

function allowedPath(pathname) {
  if (!pathname.startsWith('/api/')) return true; // The backend has its own static-file allowlist.
  return ['/api/state', '/api/history', '/api/cv', '/api/camera/frame',
    '/api/sitl/status', '/api/surveys', '/api/ecology/methods'].includes(pathname)
    || /^\/api\/surveys\/(jobs|artifacts|ecology|reconstruction)\/[^/]+(?:\/assessment)?$/.test(pathname)
    || /^\/api\/ecology\/assessments\/[^/]+(?:\/(?:audit|request))?$/.test(pathname);
}

function createReadOnlyGateway(backendPort, backendHost = '127.0.0.1') {
  const hostHeader = `${backendHost.includes(':') ? `[${backendHost}]` : backendHost}:${backendPort}`;
  const server = http.createServer((req, res) => {
    let pathname;
    try { pathname = new URL(req.url, 'http://localhost').pathname; }
    catch { res.writeHead(400).end(); return; }
    if (req.method !== 'GET' || !allowedPath(pathname)) {
      res.writeHead(403, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: 'Public tunnel is read-only' }));
      return;
    }
    const upstream = http.request({
      hostname: backendHost, port: backendPort, method: 'GET', path: req.url,
      headers: { host: hostHeader },
    }, response => {
      res.writeHead(response.statusCode, response.headers);
      response.pipe(res);
    });
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Local dashboard unavailable' }));
    });
    res.on('close', () => upstream.destroy());
    upstream.end();
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
  const gateway = createReadOnlyGateway(backendPort, options.backendHost);
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
      console.log(`Public read-only dashboard: ${match[0]}`);
      console.log(`Roblox telemetry endpoint: ${match[0]}/api/state`);
      console.log('Anyone with this link can view dashboard data and camera images. Do not share sensitive data.');
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
