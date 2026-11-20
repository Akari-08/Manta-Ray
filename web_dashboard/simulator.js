'use strict';
// Software test double, never a source of hardware or environmental evidence.
const { WebSocket } = require('ws');
const http = require('node:http');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { validateCommand, missing, measured } = require('./protocol');
const { localIP } = require('./server');

function makeTelemetry({ robotId = 'manta-01', seq = 0, uptime = 0, control = {}, camera = null, reconnects = 0, buoyancy = { volume: 10, depth: 0.5, acceleration: 0 } } = {}) {
  const roll = Math.sin(uptime / 2000) * 8, pitch = Math.cos(uptime / 2500) * 4;
  return {
    schema_version: 1, type: 'telemetry', robot_id: robotId, firmware_version: 'simulator-1.0', seq, uptime_ms: Math.floor(uptime), source: 'simulator', device_time: missing('unix_ms', 'Simulator uses uptime only'),
    wifi: { rssi: measured(-50 - Math.round(Math.sin(uptime / 4000) * 5), 'dBm'), reconnects },
    imu: { acceleration: measured([Math.sin(pitch * Math.PI / 180) * 9.80665, Math.sin(roll * Math.PI / 180) * 9.80665, 9.7 - buoyancy.acceleration], 'm/s^2'), angular_velocity: measured([4 * Math.cos(uptime / 2000), -1.6 * Math.sin(uptime / 2500), 0], 'deg/s'), roll_estimate: measured(roll, 'deg'), pitch_estimate: measured(pitch, 'deg'), calibration_state: 'simulated' },
    simulation: { syringe_volume_ml: buoyancy.volume, depth_m: buoyancy.depth },
    water: { temperature: missing('degC', 'Temperature sensor model unconfirmed'), tds_raw: missing('ADC_count', 'Analog interface and voltage range unconfirmed'), tds_estimate: missing('ppm', 'TDS calibration unavailable'), calibration_id: null },
    control: { flapping: false, outputs_enabled: true, amplitude_deg: 20, cycle_hz: 0.5, centre_deg: 135, left_command: missing('deg', 'No command since startup'), right_command: missing('deg', 'No command since startup'), syringe_command: missing('deg', 'Syringe model unconfirmed'), actuator_state: 'disabled', disconnect_policy: 'stop', heartbeat_timeout_ms: 3000, ...control },
    camera: camera || { available: false, reason: 'Simulator camera disabled', stream_url: null, snapshot_url: null, fps: missing('fps', 'No frames measured'), calibration_id: null },
    faults: ['SIMULATED DATA: not hardware measurements'], mode: 'bench',
  };
}

// Damped depth response, in metres and seconds. Positive velocity is downward.
function stepBuoyancy(state, dt) {
  const target = 0.05 + (20 - state.volume) / 20 * 0.9;
  const acceleration = 0.4 * (target - state.depth) - 1.3 * state.velocity;
  state.velocity += acceleration * dt;
  state.depth = Math.max(0.05, Math.min(0.95, state.depth + state.velocity * dt));
  if ((state.depth === 0.05 && state.velocity < 0) || (state.depth === 0.95 && state.velocity > 0)) state.velocity = 0;
  state.acceleration = acceleration;
}

function startSimulator(options = {}) {
  const cfg = { url: 'ws://127.0.0.1:3000/ws/device', token: process.env.DEVICE_TOKEN, robotId: 'manta-01', intervalMs: 100, heartbeatTimeoutMs: 3000, reconnectMinMs: 500, reconnectMaxMs: 10000, camera: false, cameraHost: '127.0.0.1', ...options };
  if (!cfg.token || cfg.token.length < 24) throw new Error('Simulator requires DEVICE_TOKEN');
  const destination = new URL(cfg.url);
  if (destination.protocol !== 'ws:' || !localIP(destination.hostname)) throw new Error('Simulator backend must be a private LAN ws:// IP');
  const start = performance.now(), uptime = () => Math.floor(performance.now() - start);
  let ws, session = null, seq = 0, stopped = false, reconnectTimer, reconnects = 0, backoff = cfg.reconnectMinMs, lastControl = -Infinity, phase = 0;
  let control = makeTelemetry().control, pauseTelemetry = false, dropAcks = false;
  const buoyancy = { volume: 10, depth: 0.5, velocity: 0, acceleration: 0 };
  let lastPhysics = performance.now();
  const seen = new Set(), cameraServers = [], streams = new Set();
  const report = cfg.onEvent || (() => {});
  let frameCount = 0, fps = null, lastFrames = 0;
  if (cfg.camera) {
    if (!localIP(cfg.cameraHost)) throw new Error('Camera simulator binds only to private IP');
    const jpeg = readFileSync(path.join(__dirname, 'simulator-camera.jpg'));
    const snapshot = http.createServer((req, res) => {
      if (req.url !== '/capture') { res.writeHead(404); res.end(); return; }
      frameCount++; res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', 'X-Capture-Uptime-Ms': String(uptime()) }); res.end(jpeg);
    });
    const stream = http.createServer((req, res) => {
      if (req.url !== '/stream' || streams.size >= 2) { res.writeHead(503); res.end(); return; }
      streams.add(res); res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=frame', 'Cache-Control': 'no-store' });
      const timer = setInterval(() => {
        // Drop stale frames instead of queuing behind a slow reader.
        if (res.writableLength > 65536) { res.destroy(); return; }
        frameCount++;
        res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\nX-Capture-Uptime-Ms: ${uptime()}\r\n\r\n`); res.write(jpeg); res.write('\r\n');
      }, 500);
      res.on('close', () => { clearInterval(timer); streams.delete(res); });
    });
    for (const [server, port] of [[snapshot, 8080], [stream, 8081]]) { server.on('error', error => { report({ type: 'camera_error', error: error.message }); cfg.camera = false; }); server.listen(port, cfg.cameraHost); cameraServers.push(server); }
  }
  const cameraStats = setInterval(() => { fps = (frameCount - lastFrames) / 2; lastFrames = frameCount; }, 2000);
  function connect() {
    if (stopped) return;
    ws = new WebSocket(cfg.url, { maxPayload: 8192, perMessageDeflate: false, handshakeTimeout: 3000 });
    ws.on('error', () => {});
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', schema_version: 1, robot_id: cfg.robotId, source: 'simulator', token: cfg.token })));
    ws.on('message', raw => {
      const msg = JSON.parse(raw);
      if (msg.type === 'welcome') { session = msg.session_id; seen.clear(); backoff = cfg.reconnectMinMs; report(msg); }
      if (msg.type === 'heartbeat' && msg.session_id === session && msg.control_active) lastControl = uptime();
      if (msg.type !== 'command') return;
      report(msg);
      let status = 'applied', reason = null;
      try {
        validateCommand({ schema_version: msg.schema_version, id: msg.id, action: msg.action, args: msg.args, ttl_ms: msg.ttl_ms });
        if (msg.session_id !== session || seen.has(msg.id)) throw new Error('Session mismatch or duplicate command');
        if (!Number.isSafeInteger(msg.expires_uptime_ms) || msg.expires_uptime_ms < uptime() || msg.expires_uptime_ms > uptime() + 2000) { status = 'expired'; throw new Error('Command expired or invalid deadline'); }
        if (msg.action !== 'stop' && uptime() - lastControl > cfg.heartbeatTimeoutMs) throw new Error('Control heartbeat expired');
        seen.add(msg.id); if (seen.size > 64) seen.delete(seen.values().next().value);
        if (msg.action === 'start') control.flapping = true;
        if (msg.action === 'stop') control.flapping = false;
        if (msg.action === 'set_fin') Object.assign(control, msg.args);
        if (msg.action === 'set_syringe') throw new Error('Syringe model unconfirmed; disabled');
        if (msg.action === 'set_syringe_volume') buoyancy.volume = msg.args.volume_ml;
      } catch (error) { if (status !== 'expired') status = 'rejected'; reason = error.message; }
      if (!dropAcks) ws.send(JSON.stringify({ schema_version: 1, type: 'ack', session_id: session, id: msg.id, status, reason }));
    });
    ws.on('close', () => {
      session = null; reconnects++;
      if (!stopped) { reconnectTimer = setTimeout(connect, backoff); backoff = Math.min(cfg.reconnectMaxMs, backoff * 2); }
    });
  }
  const controlTimer = setInterval(() => {
    const now = performance.now(), dt = Math.min((now - lastPhysics) / 1000, 0.1); lastPhysics = now;
    stepBuoyancy(buoyancy, dt);
    if (uptime() - lastControl > cfg.heartbeatTimeoutMs) control.flapping = false;
    if (control.flapping) {
      phase += 2 * Math.PI * control.cycle_hz * 0.02;
      control.left_command = measured(control.centre_deg + control.amplitude_deg * Math.sin(phase), 'deg');
      control.right_command = measured(control.centre_deg - control.amplitude_deg * Math.sin(phase), 'deg');
    }
  }, 20);
  const telemetryTimer = setInterval(() => {
    if (pauseTelemetry || !session || ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > 8192) return;
    const camera = cfg.camera ? { available: true, reason: null, stream_url: `http://${cfg.cameraHost}:8081/stream`, snapshot_url: `http://${cfg.cameraHost}:8080/capture`, fps: fps === null ? missing('fps', 'Measuring simulated output') : measured(fps, 'fps'), calibration_id: null } : null;
    ws.send(JSON.stringify(makeTelemetry({ robotId: cfg.robotId, seq: seq++, uptime: uptime(), control: { ...control, heartbeat_timeout_ms: cfg.heartbeatTimeoutMs }, camera, reconnects, buoyancy })));
  }, cfg.intervalMs);
  connect();
  return {
    get control() { return structuredClone(control); },
    pauseTelemetry(value) { pauseTelemetry = value; }, dropAcks(value) { dropAcks = value; }, disconnect() { ws.terminate(); },
    async stop() { stopped = true; clearTimeout(reconnectTimer); clearInterval(controlTimer); clearInterval(telemetryTimer); clearInterval(cameraStats); ws.terminate(); for (const stream of streams) stream.destroy(); await Promise.all(cameraServers.map(server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }))); },
  };
}
if (require.main === module) {
  try { process.loadEnvFile(path.join(__dirname, '.env')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  console.log('ESP32 SIMULATOR — synthetic motion and test-card camera; no hardware attached.');
  const sim = startSimulator({ url: process.env.BACKEND_WS || `ws://${process.env.HOST || '127.0.0.1'}:${process.env.PORT || 3000}/ws/device`, robotId: process.env.ROBOT_ID || 'manta-01', camera: true, cameraHost: process.env.SIMULATOR_HOST || process.env.HOST || '127.0.0.1', onEvent: event => { if (event.type === 'camera_error') console.error(event.error); } });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => sim.stop().then(() => process.exit(0)));
}
module.exports = { startSimulator, makeTelemetry, stepBuoyancy };
