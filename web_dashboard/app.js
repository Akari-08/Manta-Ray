import { initSurveyPanel } from './survey-panel.js';
import { LiveClient } from './live-client.js';
import { parseCommandLine, buildCommand, finSettingsConfirmed } from './commands.mjs';
import { createFishView } from './fish-view.mjs';
import { createLocationMap } from './location-map.mjs';
const grid = document.querySelector('#dashboard-grid');
const announcement = document.querySelector('#layout-announcement');
const panels = [...grid.querySelectorAll('.panel')];
const storageKey = 'manta-ray-panel-order';

function updateLayout(message) {
  const ordered = [...grid.children];
  ordered.forEach((panel, index) => {
    panel.querySelector('[data-direction="-1"]').disabled = index === 0;
    panel.querySelector('[data-direction="1"]').disabled = index === ordered.length - 1;
  });
  try {
    localStorage.setItem(storageKey, JSON.stringify(ordered.map((panel) => panel.dataset.panel)));
  } catch {
    // The dashboard remains usable when browser storage is unavailable.
  }
  if (message) announcement.textContent = message;
}

try {
  const saved = JSON.parse(localStorage.getItem(storageKey));
  if (Array.isArray(saved) && new Set(saved).size === saved.length && saved.every((id) => panels.some((panel) => panel.dataset.panel === id))) {
    saved.forEach((id) => grid.append(panels.find((panel) => panel.dataset.panel === id)));
    panels.filter((panel) => !saved.includes(panel.dataset.panel)).forEach((panel) => grid.append(panel));
  }
} catch {
  // Ignore unavailable or invalid saved layouts.
}
updateLayout();

grid.addEventListener('click', (event) => {
  const button = event.target.closest('.move-panel');
  if (!button) return;
  const panel = button.closest('.panel');
  const direction = Number(button.dataset.direction);
  const neighbor = direction < 0 ? panel.previousElementSibling : panel.nextElementSibling;
  if (!neighbor) return;
  if (direction < 0) grid.insertBefore(panel, neighbor);
  else grid.insertBefore(neighbor, panel);
  updateLayout(`${panel.querySelector('h2').textContent} moved to position ${[...grid.children].indexOf(panel) + 1}.`);
  if (button.disabled) panel.querySelector(`[data-direction="${-direction}"]`).focus();
});

let draggedPanel = null;
grid.addEventListener('dragstart', (event) => {
  if (event.target.closest('button')) {
    event.preventDefault();
    return;
  }
  const header = event.target.closest('.panel-header');
  if (!header) return;
  draggedPanel = header.closest('.panel');
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', draggedPanel.dataset.panel);
  draggedPanel.classList.add('dragging');
});
grid.addEventListener('dragover', (event) => {
  if (!draggedPanel) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  const target = event.target.closest('.panel');
  panels.forEach((panel) => panel.classList.toggle('drop-target', panel === target && panel !== draggedPanel));
});
grid.addEventListener('drop', (event) => {
  if (!draggedPanel) return;
  event.preventDefault();
  const target = event.target.closest('.panel');
  if (target && target !== draggedPanel) {
    const ordered = [...grid.children];
    if (ordered.indexOf(draggedPanel) < ordered.indexOf(target)) grid.insertBefore(draggedPanel, target.nextSibling);
    else grid.insertBefore(draggedPanel, target);
    updateLayout(`${draggedPanel.querySelector('h2').textContent} moved to position ${[...grid.children].indexOf(draggedPanel) + 1}.`);
  }
});
grid.addEventListener('dragend', () => {
  panels.forEach((panel) => panel.classList.remove('dragging', 'drop-target'));
  draggedPanel = null;
});

const fileInput = document.querySelector('#video-file');
const video = document.querySelector('#survey-video');
let videoUrl;
document.querySelectorAll('.file-trigger').forEach((button) => {
  button.addEventListener('click', () => fileInput.click());
});
fileInput.addEventListener('change', () => {
  const file = fileInput.files[0];
  if (!file) return;
  recording = true;
  document.querySelector('#live-camera').hidden = true;
  document.querySelector('#camera-status').textContent = 'RECORDING / NOT LIVE';
  if (videoUrl) URL.revokeObjectURL(videoUrl);
  videoUrl = URL.createObjectURL(file);
  video.src = videoUrl;
  video.hidden = false;
  document.querySelector('#video-placeholder').hidden = true;
  document.querySelector('#video-source').textContent = file.name;
});

const tabs = [...document.querySelectorAll('[role="tab"]')];
function selectTab(tab) {
  tabs.forEach((item) => {
    const selected = item === tab;
    item.classList.toggle('active', selected);
    item.setAttribute('aria-selected', String(selected));
    item.tabIndex = selected ? 0 : -1;
    document.getElementById(item.getAttribute('aria-controls')).hidden = !selected;
  });
}
tabs.forEach((tab, index) => {
  tab.addEventListener('click', () => selectTab(tab));
  tab.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    selectTab(tabs[next]);
    tabs[next].focus();
  });
});

const client = new LiveClient();
const $ = id => document.getElementById(id);
const fishView = createFishView($('fish-stage'), $('model-badge'), $('model-readout'));
const missionMap = createLocationMap(() => client.token || $('control-token').value.trim());
let recording = false, transport = 'connecting', lastState = null, samples = [], lastSeq = null, lastUptime = null, cameraBusy = false, frameUrl = null, lastRayFrameId = null, pending = false, finSync = null, localLogId = 0;
let demoAccessAttempted = false;

async function authorizeLocalDemo(state) {
  if (demoAccessAttempted || state.stale || state.telemetry?.source !== 'simulator') return;
  demoAccessAttempted = true;
  try {
    const response = await fetch('/api/demo/access', { cache: 'no-store', signal: AbortSignal.timeout(4000) });
    if (!response.ok) return;
    const access = await response.json();
    if (access.simulation !== true || typeof access.control_token !== 'string' || access.control_token.length < 24 ||
        lastState?.stale || lastState?.telemetry?.source !== 'simulator') return;
    client.token = access.control_token;
    $('control-token').value = '';
    $('control-token').disabled = true;
    $('control-token').placeholder = 'Automatic local demo';
    const hint = document.querySelector('.interface-sidebar p');
    if (hint) hint.textContent = 'Local demo authorization is automatic. Enable controls before commanding motion and keep this tab visible.';
    $('survey-source-note').textContent = 'Stock recordings have unknown water conditions. Optional TDS values are labeled simulated. Local demo processing is authorized automatically.';
    $('command-feedback').textContent = 'Local demo authorized. Enable controls to activate the motion heartbeat.';
    renderControls();
  } catch {
    // Manual authorization remains available when the local demo endpoint is unavailable.
  }
}
const format = r => r?.value === null || !r ? `Unavailable: ${r?.reason || 'no telemetry'}` : `${Array.isArray(r.value) ? r.value.map(v => v.toFixed(2)).join(' / ') : r.value.toFixed(2)} ${r.unit}`;
const commandLines = new Map();
function logCommand(c) {
  const previous = commandLines.get(c.id);
  const label = c.label || previous?.label || c.action;
  commandLines.set(c.id, { label, status: c.status, text: `${label} · ${c.id.slice(0, 8)} · ${c.status}${c.reason ? `: ${c.reason}` : ''}` });
  while (commandLines.size > 20) commandLines.delete(commandLines.keys().next().value);
  $('terminal-output').replaceChildren(...[...commandLines.values()].reverse().map(({ text }) => { const p = document.createElement('p'); p.textContent = text; return p; }));
}
function checkFinSync(s) {
  if (!finSync) return;
  if (s?.stale || !s?.telemetry) { finSync = null; return; }
  if (finSettingsConfirmed(s, finSync.seq, finSync.args)) finSync = null;
}
function renderControls() {
  const fresh = transport === 'connected' && lastState && !lastState.stale;
  const enabled = fresh && client.active && lastState.telemetry?.control.outputs_enabled && !pending;
  document.querySelectorAll('[data-motion]').forEach(button => { button.disabled = !enabled; });
  $('stop-flapping').disabled = !fresh || !client.token || pending;
  $('set-syringe').disabled = !enabled || lastState.telemetry?.control.actuator_state === 'disabled';
  $('set-syringe-volume').disabled = !enabled || lastState.telemetry?.source !== 'simulator' || !lastState.telemetry?.simulation;
  $('enable-control').disabled = !fresh || client.active;
  $('disable-control').disabled = !client.active;
  $('control-status').textContent = client.active ? 'HEARTBEAT ACTIVE' : 'CONTROLS LOCKED';
}
function renderStatus() {
  const s = lastState, simulated = s?.telemetry?.source === 'simulator';
  $('source-mode').textContent = s?.telemetry ? simulated ? 'SIMULATOR / SYNTHETIC' : 'HARDWARE' : 'AWAITING DEVICE';
  document.body.classList.toggle('simulation', !!simulated);
  $('connection-status').textContent = transport !== 'connected' ? `BACKEND ${transport.toUpperCase()}` : `ROBOT ${s?.connection.toUpperCase()}`;
  const warnings = [];
  if (simulated) warnings.push('SIMULATION — synthetic motion and camera imagery. No hardware measurements.');
  if (transport !== 'connected') warnings.push('Backend unavailable. Displayed values may be old. Controls locked.');
  else if (s?.stale) warnings.push('Telemetry stale or robot disconnected. Displayed values are historical. Controls locked.');
  $('data-warning').textContent = warnings.join(' ') || 'Hardware telemetry connected. Positions below are commanded, without servo feedback.';
  $('data-warning').classList.toggle('healthy', !warnings.length);
  $('last-update').textContent = s?.received_at ? `${new Date(s.received_at).toLocaleTimeString()} · ${((s.age_ms || 0) / 1000).toFixed(1)} s old` : 'No telemetry received';
  fishView.update(s, transport === 'connected');
  missionMap.updateState(s, transport === 'connected');
  renderControls();
}
function chart() {
  const svg = $('attitude-chart'), ns = 'http://www.w3.org/2000/svg'; svg.replaceChildren();
  if (!samples.length) return;
  const end = Date.parse(samples.at(-1).received_at), start = end - 60000;
  const values = samples.flatMap(s => [s.telemetry.imu.roll_estimate.value, s.telemetry.imu.pitch_estimate.value]).filter(v => v !== null);
  const range = Math.max(10, ...values.map(Math.abs));
  for (const [key, color] of [['roll_estimate', '#cae998'], ['pitch_estimate', '#82c8dd']]) {
    let d = '', previous = null;
    for (const sample of samples) {
      const time = Date.parse(sample.received_at), value = sample.telemetry.imu[key].value;
      if (value === null || time < start) { previous = null; continue; }
      const x = 35 + (time - start) / 60000 * 455, y = 60 - value / range * 45;
      d += `${previous === null || time - previous > 2000 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)} `; previous = time;
    }
    const line = document.createElementNS(ns, 'path'); line.setAttribute('d', d); line.setAttribute('fill', 'none'); line.setAttribute('stroke', color); line.setAttribute('stroke-width', '2'); svg.append(line);
  }
  for (const [label, x, y] of [[`${range.toFixed(0)}°`, 0, 15], ['0°', 0, 64], [`−${range.toFixed(0)}°`, 0, 110], ['−60 s', 35, 128], ['now', 460, 128]]) {
    const text = document.createElementNS(ns, 'text'); text.setAttribute('x', x); text.setAttribute('y', y); text.textContent = label; svg.append(text);
  }
  $('history-caption').textContent = values.length ? 'Roll: lime / pitch: blue. Acceleration-derived estimates; fin motion can bias them.' : 'No valid attitude samples. Missing data is not plotted as zero.';
}
function render(s) {
  lastState = s; checkFinSync(s); renderStatus(); const t = s.telemetry; if (!t) return;
  authorizeLocalDemo(s);
  $('robot-identity').textContent = `${t.robot_id} · ${t.firmware_version} · #${t.seq}`;
  $('wifi-reading').textContent = `Wi-Fi ${format(t.wifi.rssi)} · uptime ${(t.uptime_ms / 1000).toFixed(1)} s · reconnects ${t.wifi.reconnects}`;
  $('operating-mode').textContent = t.mode.toUpperCase();
  for (const [id, reading] of [['acceleration', t.imu.acceleration], ['gyro', t.imu.angular_velocity], ['temperature', t.water.temperature], ['tds-raw', t.water.tds_raw], ['tds-estimate', t.water.tds_estimate]]) $(id).textContent = format(reading);
  $('attitude').textContent = `${format(t.imu.roll_estimate)} / ${format(t.imu.pitch_estimate)}`;
  $('imu-calibration').textContent = `${t.imu.calibration_state}${s.imu_source === 'roblox' ? ' · ROBLOX IMU' : ''}`;
  $('faults').replaceChildren(...(t.faults.length ? t.faults : ['No reported device faults']).map(f => { const li = document.createElement('li'); li.textContent = f; return li; }));
  const c = t.control;
  $('commanded-state').textContent = `${c.flapping ? 'FLAPPING' : 'STOPPED'} · amplitude ${c.amplitude_deg}° · ${c.cycle_hz} Hz · centre ${c.centre_deg}°. Commanded left: ${format(c.left_command)}; right: ${format(c.right_command)}; syringe: ${format(c.syringe_command)}.`;
  $('syringe-reason').textContent = `Actuator: ${c.actuator_state}${c.syringe_command.reason ? ` — ${c.syringe_command.reason}` : ''}`;
  $('simulated-depth').textContent = t.source === 'simulator' && t.simulation ? `SIMULATED · ${t.simulation.syringe_volume_ml.toFixed(1)} mL · depth ${t.simulation.depth_m.toFixed(2)} m (npm model)` : 'Simulator only · depth unavailable';
  $('disconnect-policy').textContent = `${c.disconnect_policy === 'stop' ? `Stop flapping after ${c.heartbeat_timeout_ms / 1000} s without an active control heartbeat` : 'Autonomous policy: continue local flapping after disconnect'}. Hold last fin/syringe targets; no automatic syringe move. Software stop does not cut power. Outputs ${c.outputs_enabled ? 'enabled' : 'disabled in firmware'}.`;
  const result = s.cv.result;
  $('cv-result').textContent = result ? `${s.cv.stale ? 'STALE · ' : ''}${result.frame.source === 'simulator' ? 'SIMULATION · ' : ''}${result.vegetation_cover_pct.toFixed(1)}% · confidence ${result.confidence.toFixed(2)} · ${result.method} · calibration ${result.calibration_id} · frame uptime ${result.frame.captured_uptime_ms} ms` : `Unavailable: ${s.cv.reason}`;
  if (lastUptime !== null && t.uptime_ms < lastUptime) { samples = []; lastSeq = null; }
  if (lastSeq !== t.seq) { samples.push({ received_at: s.received_at, telemetry: t }); samples = samples.slice(-600); lastSeq = t.seq; lastUptime = t.uptime_ms; chart(); }
  if (!recording && (s.stale || transport !== 'connected' || (!t.camera.available && !s.roblox_camera))) {
    $('live-camera').hidden = true; $('video-placeholder').hidden = false; $('camera-status').textContent = 'UNAVAILABLE'; $('camera-reason').textContent = s.stale ? 'Telemetry stale; camera hidden.' : t.camera.reason;
  }
}
async function frame() {
  const ray = lastState?.telemetry?.source === 'simulator' ? lastState?.roblox_camera : null;
  if (recording || cameraBusy || transport !== 'connected' || lastState?.stale || (!ray && !lastState?.telemetry?.camera.available) || document.hidden) return;
  if (ray && ray.frame_id === lastRayFrameId && frameUrl && !$('live-camera').hidden) return;
  cameraBusy = true;
  try {
    const response = await fetch(ray ? '/api/roblox/camera/frame' : '/api/camera/frame', { cache: 'no-store', signal: AbortSignal.timeout(3500) });
    if (!response.ok) throw new Error('Camera frame unavailable; retrying');
    const metadata = ray || JSON.parse(response.headers.get('x-frame-metadata')), blob = await response.blob();
    if (recording || lastState.stale || (ray && lastState.roblox_camera?.frame_id !== ray.frame_id) || (!ray && lastState.roblox_camera)) return;
    if (frameUrl) URL.revokeObjectURL(frameUrl); frameUrl = URL.createObjectURL(blob);
    lastRayFrameId = ray?.frame_id || null;
    $('live-camera').src = frameUrl; $('live-camera').hidden = false; $('video-placeholder').hidden = true;
    $('camera-status').textContent = ray ? 'SIMULATED RAYCAST' : metadata.source === 'simulator' ? 'SIMULATED CAMERA' : 'LIVE JPEG';
    $('video-source').textContent = ray ? 'Roblox simulated raycast · 128 × 72 · about every 1 s' : `${metadata.source === 'simulator' ? 'Simulated test card' : 'ESP32 camera'} · sampled up to 2 fps`;
    $('frame-info').textContent = ray ? `Synthetic first-person scene · received ${new Date(metadata.received_at).toLocaleTimeString()}` : `Image uptime ${metadata.captured_uptime_ms} ms · received ${new Date(metadata.received_at).toLocaleTimeString()} · calibration ${metadata.calibration_id || 'unavailable'}`;
  } catch (error) { $('live-camera').hidden = true; $('video-placeholder').hidden = false; $('camera-reason').textContent = error.message; $('camera-status').textContent = 'CAMERA RETRYING'; }
  finally { cameraBusy = false; }
}
$('live-view').addEventListener('click', () => { recording = false; video.pause(); video.hidden = true; $('video-placeholder').hidden = false; frame(); });
client.addEventListener('state', e => render(e.detail));
client.addEventListener('transport', e => { transport = e.detail; renderStatus(); if (transport !== 'connected' && !recording) { $('live-camera').hidden = true; $('video-placeholder').hidden = false; $('camera-reason').textContent = 'Backend unavailable'; } });
client.addEventListener('control', renderControls);
client.addEventListener('error', e => { $('command-feedback').textContent = e.detail; });
client.addEventListener('command', e => logCommand(e.detail));
client.addEventListener('sent', e => { const current = commandLines.get(e.detail.id); if (!current || current.status === 'sending') logCommand(e.detail); });
$('enable-control').addEventListener('click', async () => { try { await client.enable($('control-token').value.trim() || client.token); $('command-feedback').textContent = 'Heartbeat enabled. No movement requested.'; } catch (error) { $('command-feedback').textContent = error.message; } });
$('disable-control').addEventListener('click', () => client.disable());
async function command(action, args = {}, label = action) {
  if (pending) { logCommand({ id: `local-${++localLogId}`, action, label, status: 'not sent', reason: 'Wait for the pending command' }); return; }
  const id = [...crypto.getRandomValues(new Uint8Array(16))].map(v => v.toString(16).padStart(2, '0')).join('');
  const seq = lastState?.telemetry?.seq;
  logCommand({ id, action, label, status: 'sending' });
  pending = true; renderControls(); $('command-feedback').textContent = `${action}: sending; awaiting device acknowledgement…`;
  try {
    const result = await client.command(action, args, id); logCommand(result);
    if (action === 'set_fin' && result.status === 'applied' && Number.isSafeInteger(seq)) { finSync = { seq, args }; checkFinSync(lastState); }
    $('command-feedback').textContent = `${result.action}: ${result.status}${result.reason ? ` — ${result.reason}` : ' (command accepted by controller; physical motion is not measured)'}`;
  }
  catch (error) { logCommand({ id, action, status: 'error', reason: `${error.message}. If delivery is uncertain, check telemetry before retrying` }); $('command-feedback').textContent = error.message; }
  finally { pending = false; renderControls(); }
}
$('start-flapping').addEventListener('click', () => command('start'));
$('stop-flapping').addEventListener('click', () => command('stop'));
$('fin-form').addEventListener('submit', event => { event.preventDefault(); command('set_fin', { amplitude_deg: Number($('amplitude').value), cycle_hz: Number($('cycle-rate').value), centre_deg: Number($('centre').value) }); });
$('syringe-form').addEventListener('submit', event => { event.preventDefault(); command('set_syringe', { target_deg: Number($('syringe-target').value) }); });
$('syringe-volume-form').addEventListener('submit', event => { event.preventDefault(); command('set_syringe_volume', { volume_ml: Number($('syringe-volume').value) }); });
$('command-line-form').addEventListener('submit', async event => {
  event.preventDefault();
  const input = $('command-line'), line = input.value.trim();
  if (!line) return;
  input.value = '';
  try {
    const { name, params } = parseCommandLine(line);
    if (name === 'startpath') {
      const plan = await missionMap.startPath();
      logCommand({ id: `local-${++localLogId}`, action: name, label: line, status: 'preview created', reason: `${plan.waypoints.length} waypoints; simulation only` });
      return;
    }
    const fresh = transport === 'connected' && lastState && !lastState.stale;
    if (!fresh || !client.token) throw new Error('Fresh telemetry and a control token are required');
    if (name !== 'stopflap' && (!client.active || !lastState.telemetry?.control.outputs_enabled)) throw new Error('Enable controls and configured servo outputs first');
    if (name === 'setfin' && finSync) throw new Error('Waiting for telemetry to confirm the last applied fin settings');
    const { action, args } = buildCommand(name, params, lastState);
    command(action, args, line);
  } catch (error) { logCommand({ id: `local-${++localLogId}`, action: 'command', label: line, status: 'not sent', reason: error.message }); }
});
document.addEventListener('visibilitychange', () => { if (document.hidden) client.disable(); });
window.addEventListener('pagehide', () => client.stop());
client.start(); setInterval(frame, 500);
initSurveyPanel({
  token: () => client.token || $('control-token').value.trim(),
  onStop: () => {
    client.token = $('control-token').value.trim() || client.token;
    return client.command('stop');
  },
});
