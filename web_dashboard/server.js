'use strict';
const http = require('node:http');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, timingSafeEqual } = require('node:crypto');
const { isIP } = require('node:net');
const { WebSocketServer, WebSocket } = require('ws');
const { VERSION, LIMITS, validateTelemetry, validateCommand, validateAck } = require('./protocol');
const { createSurveyService } = require('./survey-service');
const { createSitlService } = require('./sitl-service');
const { createAssessmentService } = require('./assessment-service');
const files = { '/': ['index.html', 'text/html'], '/styles.css': ['styles.css', 'text/css'], '/app.js': ['app.js', 'text/javascript'], '/live-client.js': ['live-client.js', 'text/javascript'], '/commands.mjs': ['commands.mjs', 'text/javascript'], '/motion-model.mjs': ['motion-model.mjs', 'text/javascript'], '/fish-view.mjs': ['fish-view.mjs', 'text/javascript'], '/location-map.mjs': ['location-map.mjs', 'text/javascript'], '/vendor/three.module.js': ['node_modules/three/build/three.module.js', 'text/javascript'], '/vendor/three.core.js': ['node_modules/three/build/three.core.js', 'text/javascript'], '/vendor/maplibre-gl.mjs': ['node_modules/maplibre-gl/dist/maplibre-gl.mjs', 'text/javascript'], '/vendor/maplibre-gl-worker.mjs': ['node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs', 'text/javascript'], '/vendor/maplibre-gl.css': ['node_modules/maplibre-gl/dist/maplibre-gl.css', 'text/css'] };
Object.assign(files, {
  '/survey-panel.js': ['survey-panel.js', 'text/javascript'],
  '/assessment-panel.js': ['assessment-panel.js', 'text/javascript'],
  '/survey-observations.mjs': ['survey-observations.mjs', 'text/javascript'],
  '/point-cloud-view.mjs': ['point-cloud-view.mjs', 'text/javascript'],
  '/survey-panel.css': ['survey-panel.css', 'text/css'],
  '/vendor/PLYLoader.js': ['node_modules/three/examples/jsm/loaders/PLYLoader.js', 'text/javascript'],
  '/vendor/OrbitControls.js': ['node_modules/three/examples/jsm/controls/OrbitControls.js', 'text/javascript'],
});
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length > 0 && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const normalizeIP = ip => ip?.replace(/^::ffff:/, '');
function localIP(ip) {
  ip = normalizeIP(ip);
  if (!isIP(ip || '')) return false;
  return ip === '::1' || /^127\./.test(ip) || /^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
}
function cameraURLs(t, peer) {
  if (!t.camera.available) return;
  for (const [key, endpoint, port] of [['stream_url', '/stream', t.source === 'hardware' ? '81' : '8081'], ['snapshot_url', '/capture', t.source === 'hardware' ? '80' : '8080']]) {
    const u = new URL(t.camera[key]);
    if (u.protocol !== 'http:' || normalizeIP(u.hostname) !== normalizeIP(peer) || (u.port || '80') !== port || u.pathname !== endpoint || u.username || u.password || u.search || u.hash) throw new Error('Camera URL must use the publishing device and documented port/path');
  }
}
function createServer(options = {}) {
  const cfg = { deviceToken: process.env.DEVICE_TOKEN, controlToken: process.env.CONTROL_TOKEN, robotId: process.env.ROBOT_ID || 'manta-01', allowSimulator: process.env.ALLOW_SIMULATOR === '1', demoAccess: false, staleMs: 2000, deadMs: 5000, heartbeatMs: 500, leaseMs: 2000, historySize: 600, now: Date.now, ...options };
  if (!cfg.deviceToken || cfg.deviceToken.length < 24 || !cfg.controlToken || cfg.controlToken.length < 24 || equal(cfg.deviceToken, cfg.controlToken) || cfg.deviceToken.startsWith('replace-') || cfg.controlToken.startsWith('replace-')) throw new Error('Set distinct random DEVICE_TOKEN and CONTROL_TOKEN (at least 24 characters each; replace example values)');
  const survey = createSurveyService({ root: cfg.surveyRoot || path.resolve(__dirname, '..'), python: cfg.python, colmap: cfg.colmap });
  const assessments = createAssessmentService({ root: cfg.surveyRoot || path.resolve(__dirname, '..'), python: cfg.python, loadSurvey: id => survey.ecologyDetail(id) });
  const sitl = createSitlService({ baseUrl: cfg.sitlUrl, enabled: cfg.sitlEnabled ?? process.env.ENABLE_SITL === '1', allowSimulator: cfg.allowSimulator });
  let device = null, latest = null, receivedAt = null, controlUntil = 0, shuttingDown = false;
  let history = [], commandLog = new Map(), captureRequests = 0;
  const viewers = new Set(), sockets = new Set(), frames = new Map();
  let cv = { available: false, reason: 'No live CV worker result. Offline green-cover screening is not validated vegetation coverage.', result: null };
  const json = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(data)); };
  const authorized = req => equal(req.headers.authorization, `Bearer ${cfg.controlToken}`);
  function state() {
    const age = receivedAt === null ? null : Math.max(0, cfg.now() - receivedAt);
    return { schema_version: VERSION, type: 'state', robot_id: cfg.robotId, backend_time: new Date(cfg.now()).toISOString(), received_at: receivedAt === null ? null : new Date(receivedAt).toISOString(), age_ms: age, connection: !device ? 'disconnected' : !latest || age > cfg.staleMs ? 'stale' : 'live', stale: !device || age === null || age > cfg.staleMs, control_active: !!device && cfg.now() < controlUntil, telemetry: latest, limits: LIMITS, cv: { ...cv, stale: !device || !cv.result || cfg.now() - Date.parse(cv.result.received_at) > 5000 } };
  }
  function send(ws, data) {
    if (ws.readyState !== WebSocket.OPEN) return false;
    if (ws.bufferedAmount > 65536) { ws.terminate(); return false; }
    ws.send(JSON.stringify(data)); return true;
  }
  function publish() { const s = state(); for (const ws of viewers) send(ws, s); }
  function publicRecord(r) { const { timer, ...data } = r; return data; }
  function finish(r, status, reason = null) {
    clearTimeout(r.timer); r.status = status; r.reason = reason; r.finished_at = new Date(cfg.now()).toISOString();
    for (const ws of viewers) send(ws, { type: 'command_result', command: publicRecord(r) });
  }
  function lost(ws) {
    if (device?.ws !== ws) return;
    device = null; controlUntil = 0;
    for (const r of commandLog.values()) if (r.status === 'pending') finish(r, 'disconnected', 'Device disconnected; outcome unknown. Command will never be replayed.');
    publish();
  }
  async function body(req) {
    if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw new Error('Expected application/json');
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 8192) throw new Error('Body exceeds 8192 bytes'); chunks.push(chunk); }
    return JSON.parse(Buffer.concat(chunks));
  }
  async function capture(res) {
    if (state().stale || !latest?.camera.available) return json(res, 503, { error: 'Camera unavailable or telemetry stale' });
    const session = device.sessionId, source = latest.source, calibrationId = latest.camera.calibration_id;
    // Authenticated peer only, fixed camera ports/paths; redirects are forbidden.
    const upstream = await fetch(latest.camera.snapshot_url, { signal: AbortSignal.timeout(2500), redirect: 'error' });
    if (!upstream.ok || !upstream.headers.get('content-type')?.startsWith('image/jpeg')) throw new Error('Camera did not return JPEG');
    let size = 0; const chunks = [];
    for await (const chunk of upstream.body) { size += chunk.length; if (size > 262144) throw new Error('Frame exceeds size limit'); chunks.push(Buffer.from(chunk)); }
    const jpeg = Buffer.concat(chunks);
    if (jpeg[0] !== 255 || jpeg[1] !== 216) throw new Error('Invalid JPEG header');
    const uptime = Number(upstream.headers.get('x-capture-uptime-ms'));
    if (!upstream.headers.has('x-capture-uptime-ms') || !Number.isSafeInteger(uptime) || uptime < 0 || device?.sessionId !== session) throw new Error('Missing image timestamp or changed device session');
    const id = randomUUID(), metadata = { frame_id: id, robot_id: cfg.robotId, source, captured_uptime_ms: uptime, received_at: new Date(cfg.now()).toISOString(), calibration_id: calibrationId, session_id: session };
    frames.set(id, metadata); while (frames.size > 32) frames.delete(frames.keys().next().value);
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', 'X-Frame-Metadata': JSON.stringify(metadata) }); res.end(jpeg);
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      if (!localIP(req.socket.remoteAddress)) return json(res, 403, { error: 'Private LAN only' });
      const u = new URL(req.url, 'http://localhost');
      if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return json(res, 403, { error: 'Cross-origin requests disabled' });
      if (u.pathname === '/api/demo/access') {
        if (!cfg.demoAccess || !cfg.allowSimulator) return json(res, 404, { error: 'Local demo authorization disabled' });
        const peer = normalizeIP(req.socket.remoteAddress);
        const port = server.address()?.port;
        const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
        if (port === 80) hosts.push('127.0.0.1', 'localhost');
        if (!(peer === '::1' || /^127\./.test(peer || '')) || !hosts.includes(req.headers.host) ||
            (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site']))) {
          return json(res, 403, { error: 'Same-origin localhost demo access required' });
        }
        if (req.method !== 'GET') return json(res, 405, { error: 'GET required' });
        const current = state();
        if (current.stale || current.telemetry?.source !== 'simulator') return json(res, 409, { error: 'Fresh simulator telemetry required' });
        return json(res, 200, { control_token: cfg.controlToken, simulation: true });
      }
      if (await assessments.handle(req, res, u, { authorized: authorized(req) })) return;
      if (await survey.handle(req, res, u, { authorized: authorized(req) })) return;
      if (await sitl.handle(req, res, u, { authorized: authorized(req), state })) return;
      if (req.method === 'GET' && Object.hasOwn(files, u.pathname)) {
        const [file, type] = files[u.pathname];
        let content = await readFile(path.join(__dirname, file));
        if (file.startsWith('node_modules/three/examples/jsm/')) {
          content = Buffer.from(content.toString('utf8').replaceAll("from 'three'", "from '/vendor/three.module.js'"));
        }
        res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Content-Security-Policy': "default-src 'self'; script-src 'self'; worker-src 'self'; style-src 'self'; img-src 'self' http: blob: data:; media-src 'self' blob:; connect-src 'self' https://tiles.openfreemap.org; frame-ancestors 'none'; base-uri 'none'", 'Cache-Control': 'no-cache' }); res.end(content); return;
      }
      if (req.method === 'GET' && u.pathname === '/api/state') return json(res, 200, state());
      if (req.method === 'GET' && u.pathname === '/api/history') return json(res, 200, { schema_version: VERSION, samples: history });
      if (req.method === 'GET' && u.pathname === '/api/cv') return json(res, 200, state().cv);
      if (req.method === 'GET' && u.pathname === '/api/camera/frame') {
        if (captureRequests >= 2) return json(res, 429, { error: 'Camera busy; at most two captures in flight' });
        captureRequests++; try { await capture(res); } finally { captureRequests--; } return;
      }
      if (u.pathname.startsWith('/api/commands') || u.pathname.startsWith('/api/control/') || u.pathname === '/api/cv/result') {
        if (!authorized(req)) return json(res, 401, { error: 'Valid control bearer token required' });
        if (req.method === 'POST' && u.pathname === '/api/control/heartbeat') {
          if (state().stale) return json(res, 409, { error: 'Fresh device telemetry required' });
          controlUntil = cfg.now() + cfg.leaseMs;
          send(device.ws, { schema_version: VERSION, type: 'heartbeat', session_id: device.sessionId, control_active: true });
          return json(res, 200, { active: true, expires_in_ms: cfg.leaseMs });
        }
        if (req.method === 'DELETE' && u.pathname === '/api/control/heartbeat') { controlUntil = 0; return json(res, 200, { active: false }); }
        if (req.method === 'GET' && u.pathname.startsWith('/api/commands/')) {
          const record = commandLog.get(u.pathname.split('/').at(-1)); return json(res, record ? 200 : 404, record ? publicRecord(record) : { error: 'Unknown command' });
        }
        if (req.method === 'POST' && u.pathname === '/api/commands') {
          const c = validateCommand(await body(req)), existing = commandLog.get(c.id);
          if (existing) return json(res, 409, { error: 'Command ID already used; not replayed', command: publicRecord(existing) });
          const s = state();
          if (s.stale) return json(res, 409, { error: 'Device disconnected or stale; commands never queued' });
          if (c.action !== 'stop' && !s.control_active) return json(res, 409, { error: 'Enable control heartbeat before movement' });
          if (c.action !== 'stop' && !latest.control.outputs_enabled) return json(res, 409, { error: 'Servo outputs disabled in firmware configuration' });
          if (c.action === 'set_syringe' && latest.control.actuator_state === 'disabled') return json(res, 409, { error: 'Syringe model, limits and output not configured' });
          if ([...commandLog.values()].some(r => r.status === 'pending')) return json(res, 409, { error: 'Wait for pending command acknowledgement or expiry' });
          const r = { ...c, status: 'pending', reason: null, session_id: device.sessionId, sent_at: new Date(cfg.now()).toISOString(), expires_uptime_ms: latest.uptime_ms + c.ttl_ms };
          commandLog.set(c.id, r); while (commandLog.size > 256) commandLog.delete(commandLog.keys().next().value);
          r.timer = setTimeout(() => { if (r.status === 'pending') finish(r, 'expired', 'Acknowledgement deadline elapsed; outcome unknown. Not replayed.'); }, c.ttl_ms);
          if (!send(device.ws, { ...c, type: 'command', session_id: device.sessionId, expires_uptime_ms: r.expires_uptime_ms })) finish(r, 'disconnected', 'Transport unavailable; not replayed');
          return json(res, 202, publicRecord(r));
        }
        if (req.method === 'POST' && u.pathname === '/api/cv/result') {
          const result = await body(req), frame = frames.get(result.frame_id);
          if (!frame || frame.session_id !== device?.sessionId || cfg.now() - Date.parse(frame.received_at) > 5000) throw new Error('Unknown or stale frame');
          if (Object.keys(result).sort().join(',') !== 'calibration_id,confidence,frame_id,method,vegetation_cover_pct' || typeof result.method !== 'string' || !result.method.length || result.method.length > 120 || typeof result.calibration_id !== 'string' || !result.calibration_id.length || result.calibration_id.length > 120 || !Number.isFinite(result.confidence) || result.confidence < 0 || result.confidence > 1 || !Number.isFinite(result.vegetation_cover_pct) || result.vegetation_cover_pct < 0 || result.vegetation_cover_pct > 100) throw new Error('CV needs method, calibration ID, confidence 0..1, coverage 0..100');
          cv = { available: true, reason: null, result: { ...result, frame, received_at: new Date(cfg.now()).toISOString() } }; frames.delete(result.frame_id); publish(); return json(res, 200, cv);
        }
      }
      json(res, 404, { error: 'Not found' });
    } catch (error) { if (!res.headersSent) json(res, 400, { error: error.message }); else res.end(); }
  });
  server.requestTimeout = 5000; server.headersTimeout = 5000;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16384, perMessageDeflate: false });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (!localIP(req.socket.remoteAddress) || !['/ws/device', '/ws/live'].includes(pathname) || (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) || wss.clients.size >= 16) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => {
      ws.on('error', () => {});
      if (pathname === '/ws/live') { viewers.add(ws); send(ws, state()); ws.on('close', () => viewers.delete(ws)); return; }
      let authenticated = false, lastSeq = -1, lastUptime = -1, rateStart = cfg.now(), count = 0;
      const authTimeout = setTimeout(() => ws.close(1008, 'Authentication required'), 3000);
      ws.on('close', () => { clearTimeout(authTimeout); lost(ws); });
      ws.on('message', (raw, binary) => {
        try {
          if (binary) throw new Error('JSON text required');
          if (cfg.now() - rateStart >= 1000) { rateStart = cfg.now(); count = 0; } if (++count > 40) throw new Error('Message rate exceeded');
          const msg = JSON.parse(raw.toString());
          if (!authenticated) {
            if (msg.type !== 'hello' || msg.schema_version !== VERSION || msg.robot_id !== cfg.robotId || !equal(msg.token, cfg.deviceToken) || !['hardware', 'simulator'].includes(msg.source) || (msg.source === 'simulator' && !cfg.allowSimulator) || (cfg.demoAccess && msg.source !== 'simulator')) throw new Error('Device authentication or source rejected');
            if (device) throw new Error('Robot already connected');
            authenticated = true; clearTimeout(authTimeout); latest = null; receivedAt = null; history = []; frames.clear(); cv = { available: false, reason: 'No live CV worker result for this session', result: null };
            device = { ws, sessionId: randomUUID(), source: msg.source, lastSeen: cfg.now() }; controlUntil = 0;
            send(ws, { schema_version: VERSION, type: 'welcome', session_id: device.sessionId }); publish(); return;
          }
          if (device?.ws !== ws) throw new Error('Session replaced');
          if (msg.type === 'telemetry') {
            validateTelemetry(msg); cameraURLs(msg, req.socket.remoteAddress);
            if (msg.robot_id !== cfg.robotId || msg.source !== device.source || msg.seq <= lastSeq || msg.uptime_ms < lastUptime) throw new Error('Identity mismatch or out-of-order telemetry');
            lastSeq = msg.seq; lastUptime = msg.uptime_ms; device.lastSeen = cfg.now(); latest = msg; receivedAt = cfg.now();
            history.push({ received_at: new Date(receivedAt).toISOString(), telemetry: msg }); if (history.length > cfg.historySize) history.shift(); publish();
          } else if (msg.type === 'ack') {
            validateAck(msg); const r = commandLog.get(msg.id);
            if (msg.session_id !== device.sessionId) throw new Error('Wrong acknowledgement session');
            if (r?.status === 'pending' && r.session_id === device.sessionId) {
              if (cfg.now() - Date.parse(r.sent_at) >= r.ttl_ms) finish(r, 'expired', 'Late acknowledgement; outcome unknown'); else finish(r, msg.status, msg.reason);
            }
          } else throw new Error('Unsupported message type');
        } catch (error) { send(ws, { type: 'error', error: error.message }); ws.close(1008, 'Invalid device message'); lost(ws); }
      });
    });
  });
  const heartbeat = setInterval(() => {
    if (device && cfg.now() - device.lastSeen > cfg.deadMs) { const ws = device.ws; lost(ws); ws.terminate(); }
    if (device) send(device.ws, { schema_version: VERSION, type: 'heartbeat', session_id: device.sessionId, control_active: cfg.now() < controlUntil }); publish();
  }, cfg.heartbeatMs);
  heartbeat.unref();
  server.shutdown = async () => {
    if (shuttingDown) return; shuttingDown = true; clearInterval(heartbeat); for (const r of commandLog.values()) clearTimeout(r.timer);
    await assessments.close();
    await survey.close();
    for (const ws of wss.clients) ws.terminate(); wss.close(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve));
  };
  return server;
}
if (require.main === module) {
  try { process.loadEnvFile(path.join(__dirname, '.env')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const port = Number(process.env.PORT || 3000), host = process.env.HOST || '127.0.0.1';
  if (!localIP(host) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('HOST must be a specific private LAN/loopback IP; PORT must be 1..65535');
  const server = createServer(); server.listen(port, host, () => console.log(`Manta Ray dashboard: http://${host}:${port} (LAN only; simulator ${process.env.ALLOW_SIMULATOR === '1' ? 'enabled' : 'disabled'})`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.shutdown().then(() => process.exit(0)));
}
module.exports = { createServer, cameraURLs, localIP };
