import { LiveClient } from './live-client.js';
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
  if (Array.isArray(saved) && saved.length === panels.length && new Set(saved).size === panels.length && saved.every((id) => panels.some((panel) => panel.dataset.panel === id))) {
    saved.forEach((id) => grid.append(panels.find((panel) => panel.dataset.panel === id)));
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
let recording = false, transport = 'connecting', lastState = null, samples = [], lastSeq = null, lastUptime = null, cameraBusy = false, frameUrl = null, pending = false;
const format = r => r?.value === null || !r ? `Unavailable: ${r?.reason || 'no telemetry'}` : `${Array.isArray(r.value) ? r.value.map(v => v.toFixed(2)).join(' / ') : r.value.toFixed(2)} ${r.unit}`;
const commandLines = new Map();
function logCommand(c) {
  commandLines.set(c.id, `${c.action} · ${c.id.slice(0, 8)} · ${c.status}${c.reason ? `: ${c.reason}` : ''}`);
  while (commandLines.size > 20) commandLines.delete(commandLines.keys().next().value);
  $('terminal-output').replaceChildren(...[...commandLines.values()].reverse().map(text => { const p = document.createElement('p'); p.textContent = text; return p; }));
}
function renderControls() {
  const fresh = transport === 'connected' && lastState && !lastState.stale;
  const enabled = fresh && client.active && lastState.telemetry?.control.outputs_enabled && !pending;
  document.querySelectorAll('[data-motion]').forEach(button => { button.disabled = !enabled; });
  $('stop-flapping').disabled = !fresh || !client.token || pending;
  $('set-syringe').disabled = !enabled || lastState.telemetry?.control.actuator_state === 'disabled';
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
  if (simulated) warnings.push('SIMULATION — synthetic motion and test-card camera. No hardware measurements.');
  if (transport !== 'connected') warnings.push('Backend unavailable. Displayed values may be old. Controls locked.');
  else if (s?.stale) warnings.push('Telemetry stale or robot disconnected. Displayed values are historical. Controls locked.');
  $('data-warning').textContent = warnings.join(' ') || 'Hardware telemetry connected. Positions below are commanded, without servo feedback.';
  $('data-warning').classList.toggle('healthy', !warnings.length);
  $('last-update').textContent = s?.received_at ? `${new Date(s.received_at).toLocaleTimeString()} · ${((s.age_ms || 0) / 1000).toFixed(1)} s old` : 'No telemetry received';
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
  lastState = s; renderStatus(); const t = s.telemetry; if (!t) return;
  $('robot-identity').textContent = `${t.robot_id} · ${t.firmware_version} · #${t.seq}`;
  $('wifi-reading').textContent = `Wi-Fi ${format(t.wifi.rssi)} · uptime ${(t.uptime_ms / 1000).toFixed(1)} s · reconnects ${t.wifi.reconnects}`;
  $('operating-mode').textContent = t.mode.toUpperCase();
  for (const [id, reading] of [['acceleration', t.imu.acceleration], ['gyro', t.imu.angular_velocity], ['temperature', t.water.temperature], ['tds-raw', t.water.tds_raw], ['tds-estimate', t.water.tds_estimate]]) $(id).textContent = format(reading);
  $('attitude').textContent = `${format(t.imu.roll_estimate)} / ${format(t.imu.pitch_estimate)}`;
  $('imu-calibration').textContent = t.imu.calibration_state;
  $('faults').replaceChildren(...(t.faults.length ? t.faults : ['No reported device faults']).map(f => { const li = document.createElement('li'); li.textContent = f; return li; }));
  const c = t.control;
  $('commanded-state').textContent = `${c.flapping ? 'FLAPPING' : 'STOPPED'} · amplitude ${c.amplitude_deg}° · ${c.cycle_hz} Hz · centre ${c.centre_deg}°. Commanded left: ${format(c.left_command)}; right: ${format(c.right_command)}; syringe: ${format(c.syringe_command)}.`;
  $('syringe-reason').textContent = `Actuator: ${c.actuator_state}${c.syringe_command.reason ? ` — ${c.syringe_command.reason}` : ''}`;
  $('disconnect-policy').textContent = `${c.disconnect_policy === 'stop' ? `Stop flapping after ${c.heartbeat_timeout_ms / 1000} s without an active control heartbeat` : 'Autonomous policy: continue local flapping after disconnect'}. Hold last fin/syringe targets; no automatic syringe move. Software stop does not cut power. Outputs ${c.outputs_enabled ? 'enabled' : 'disabled in firmware'}.`;
  const result = s.cv.result;
  $('cv-result').textContent = result ? `${s.cv.stale ? 'STALE · ' : ''}${result.frame.source === 'simulator' ? 'SIMULATION · ' : ''}${result.vegetation_cover_pct.toFixed(1)}% · confidence ${result.confidence.toFixed(2)} · ${result.method} · calibration ${result.calibration_id} · frame uptime ${result.frame.captured_uptime_ms} ms` : `Unavailable: ${s.cv.reason}`;
  if (lastUptime !== null && t.uptime_ms < lastUptime) { samples = []; lastSeq = null; }
  if (lastSeq !== t.seq) { samples.push({ received_at: s.received_at, telemetry: t }); samples = samples.slice(-600); lastSeq = t.seq; lastUptime = t.uptime_ms; chart(); }
  if (!recording && (s.stale || transport !== 'connected' || !t.camera.available)) {
    $('live-camera').hidden = true; $('video-placeholder').hidden = false; $('camera-status').textContent = 'UNAVAILABLE'; $('camera-reason').textContent = s.stale ? 'Telemetry stale; camera hidden.' : t.camera.reason;
  }
}
async function frame() {
  if (recording || cameraBusy || transport !== 'connected' || lastState?.stale || !lastState?.telemetry?.camera.available || document.hidden) return;
  cameraBusy = true;
  try {
    const response = await fetch('/api/camera/frame', { cache: 'no-store', signal: AbortSignal.timeout(3500) });
    if (!response.ok) throw new Error('Camera frame unavailable; retrying');
    const metadata = JSON.parse(response.headers.get('x-frame-metadata')), blob = await response.blob();
    if (recording || lastState.stale) return;
    if (frameUrl) URL.revokeObjectURL(frameUrl); frameUrl = URL.createObjectURL(blob);
    $('live-camera').src = frameUrl; $('live-camera').hidden = false; $('video-placeholder').hidden = true;
    $('camera-status').textContent = metadata.source === 'simulator' ? 'SIMULATED CAMERA' : 'LIVE JPEG';
    $('video-source').textContent = `${metadata.source === 'simulator' ? 'Simulated test card' : 'ESP32 camera'} · sampled up to 2 fps`;
    $('frame-info').textContent = `Image uptime ${metadata.captured_uptime_ms} ms · received ${new Date(metadata.received_at).toLocaleTimeString()} · calibration ${metadata.calibration_id || 'unavailable'}`;
  } catch (error) { $('live-camera').hidden = true; $('video-placeholder').hidden = false; $('camera-reason').textContent = error.message; $('camera-status').textContent = 'CAMERA RETRYING'; }
  finally { cameraBusy = false; }
}
$('live-view').addEventListener('click', () => { recording = false; video.pause(); video.hidden = true; $('video-placeholder').hidden = false; frame(); });
client.addEventListener('state', e => render(e.detail));
client.addEventListener('transport', e => { transport = e.detail; renderStatus(); if (transport !== 'connected' && !recording) { $('live-camera').hidden = true; $('video-placeholder').hidden = false; $('camera-reason').textContent = 'Backend unavailable'; } });
client.addEventListener('control', renderControls);
client.addEventListener('error', e => { $('command-feedback').textContent = e.detail; });
client.addEventListener('command', e => logCommand(e.detail));
client.addEventListener('sent', e => { if (!commandLines.has(e.detail.id)) logCommand(e.detail); });
$('enable-control').addEventListener('click', async () => { try { await client.enable($('control-token').value.trim()); $('command-feedback').textContent = 'Heartbeat enabled. No movement requested.'; } catch (error) { $('command-feedback').textContent = error.message; } });
$('disable-control').addEventListener('click', () => client.disable());
async function command(action, args) {
  pending = true; renderControls(); $('command-feedback').textContent = `${action}: sending; awaiting device acknowledgement…`;
  try { const result = await client.command(action, args); logCommand(result); $('command-feedback').textContent = `${result.action}: ${result.status}${result.reason ? ` — ${result.reason}` : ' (command accepted by controller; physical motion is not measured)'}`; }
  catch (error) { $('command-feedback').textContent = error.message; }
  finally { pending = false; renderControls(); }
}
$('start-flapping').addEventListener('click', () => command('start'));
$('stop-flapping').addEventListener('click', () => command('stop'));
$('fin-form').addEventListener('submit', event => { event.preventDefault(); command('set_fin', { amplitude_deg: Number($('amplitude').value), cycle_hz: Number($('cycle-rate').value), centre_deg: Number($('centre').value) }); });
$('syringe-form').addEventListener('submit', event => { event.preventDefault(); command('set_syringe', { target_deg: Number($('syringe-target').value) }); });
document.addEventListener('visibilitychange', () => { if (document.hidden) client.disable(); });
window.addEventListener('pagehide', () => client.stop());
client.start(); setInterval(frame, 500);
