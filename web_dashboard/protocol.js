'use strict';
const VERSION = 1;
const LIMITS = Object.freeze({ amplitude_deg: [0, 45], cycle_hz: [0.1, 2], centre_deg: [90, 180], syringe_deg: [0, 180], syringe_ml: [0, 20] });
const fail = message => { throw new Error(message); };
function keys(v, required, name) {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some(k => !required.includes(k)) || required.some(k => !Object.hasOwn(v, k))) fail(`${name}: unexpected or missing fields`);
}
function text(v, name, max = 160) { if (typeof v !== 'string' || !v.length || v.length > max) fail(`${name}: expected text`); }
function number(v, name, min, max) { if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) fail(`${name}: expected ${min}..${max}`); }
function integer(v, name, min = 0, max = Number.MAX_SAFE_INTEGER) { number(v, name, min, max); if (!Number.isSafeInteger(v)) fail(`${name}: expected integer`); }
function choice(v, choices, name) { if (!choices.includes(v)) fail(`${name}: expected ${choices.join(', ')}`); }
function boolean(v, name) { if (typeof v !== 'boolean') fail(`${name}: expected boolean`); }
function reading(v, unit, name, min, max, vector = false) {
  keys(v, ['value', 'unit', 'reason'], name);
  if (v.unit !== unit) fail(`${name}: expected unit ${unit}`);
  if (v.value === null) text(v.reason, `${name}.reason`);
  else {
    if (v.reason !== null) fail(`${name}: valid reading needs null reason`);
    if (vector) { if (!Array.isArray(v.value) || v.value.length !== 3) fail(`${name}: expected xyz`); v.value.forEach(n => number(n, name, min, max)); }
    else number(v.value, name, min, max);
  }
}
const missing = (unit, reason) => ({ value: null, unit, reason });
const measured = (value, unit) => ({ value, unit, reason: null });
function validateTelemetry(t) {
  keys(t, ['schema_version', 'type', 'robot_id', 'firmware_version', 'seq', 'uptime_ms', 'source', 'device_time', 'wifi', 'imu', 'water', 'control', 'camera', 'faults', 'mode', ...(Object.hasOwn(t, 'simulation') ? ['simulation'] : [])], 'telemetry');
  if (t.schema_version !== VERSION || t.type !== 'telemetry') fail('unsupported telemetry schema');
  text(t.robot_id, 'robot_id', 48); if (!/^[a-zA-Z0-9_-]+$/.test(t.robot_id)) fail('invalid robot_id');
  text(t.firmware_version, 'firmware_version', 48); integer(t.seq, 'seq'); integer(t.uptime_ms, 'uptime_ms');
  choice(t.source, ['hardware', 'simulator'], 'source'); choice(t.mode, ['bench', 'autonomous'], 'mode');
  if (Object.hasOwn(t, 'simulation')) {
    if (t.source !== 'simulator') fail('simulation fields require simulator source');
    keys(t.simulation, ['syringe_volume_ml', 'depth_m'], 'simulation');
    number(t.simulation.syringe_volume_ml, 'syringe_volume_ml', 0, 20);
    number(t.simulation.depth_m, 'depth_m', 0, 100);
  }
  reading(t.device_time, 'unix_ms', 'device_time', 0, Number.MAX_SAFE_INTEGER);
  keys(t.wifi, ['rssi', 'reconnects'], 'wifi'); reading(t.wifi.rssi, 'dBm', 'wifi.rssi', -127, 0); integer(t.wifi.reconnects, 'reconnects');
  keys(t.imu, ['acceleration', 'angular_velocity', 'roll_estimate', 'pitch_estimate', 'calibration_state'], 'imu');
  reading(t.imu.acceleration, 'm/s^2', 'acceleration', -160, 160, true); reading(t.imu.angular_velocity, 'deg/s', 'angular_velocity', -2000, 2000, true);
  reading(t.imu.roll_estimate, 'deg', 'roll_estimate', -180, 180); reading(t.imu.pitch_estimate, 'deg', 'pitch_estimate', -90, 90);
  choice(t.imu.calibration_state, ['uncalibrated', 'configured', 'unavailable', 'simulated'], 'imu.calibration_state');
  keys(t.water, ['temperature', 'tds_raw', 'tds_estimate', 'calibration_id'], 'water');
  reading(t.water.temperature, 'degC', 'temperature', -50, 150); reading(t.water.tds_raw, 'ADC_count', 'tds_raw', 0, 65535); reading(t.water.tds_estimate, 'ppm', 'tds_estimate', 0, 100000);
  if (t.water.calibration_id !== null) text(t.water.calibration_id, 'water.calibration_id');
  if (t.water.tds_estimate.value !== null && t.water.calibration_id === null) fail('TDS estimate requires calibration_id');
  keys(t.control, ['flapping', 'outputs_enabled', 'amplitude_deg', 'cycle_hz', 'centre_deg', 'left_command', 'right_command', 'syringe_command', 'actuator_state', 'disconnect_policy', 'heartbeat_timeout_ms'], 'control');
  boolean(t.control.flapping, 'flapping'); boolean(t.control.outputs_enabled, 'outputs_enabled');
  for (const k of ['amplitude_deg', 'cycle_hz', 'centre_deg']) number(t.control[k], k, ...LIMITS[k]);
  reading(t.control.left_command, 'deg', 'left_command', 0, 270); reading(t.control.right_command, 'deg', 'right_command', 0, 270); reading(t.control.syringe_command, 'deg', 'syringe_command', 0, 180);
  choice(t.control.actuator_state, ['disabled', 'holding', 'commanded'], 'actuator_state'); choice(t.control.disconnect_policy, ['stop', 'continue'], 'disconnect_policy'); integer(t.control.heartbeat_timeout_ms, 'heartbeat_timeout_ms', 500, 10000);
  keys(t.camera, ['available', 'reason', 'stream_url', 'snapshot_url', 'fps', 'calibration_id'], 'camera'); boolean(t.camera.available, 'camera.available'); reading(t.camera.fps, 'fps', 'camera.fps', 0, 60);
  if (t.camera.calibration_id !== null) text(t.camera.calibration_id, 'camera.calibration_id');
  if (t.camera.available) { if (t.camera.reason !== null) fail('available camera needs null reason'); text(t.camera.stream_url, 'stream_url', 200); text(t.camera.snapshot_url, 'snapshot_url', 200); }
  else { text(t.camera.reason, 'camera.reason'); if (t.camera.stream_url !== null || t.camera.snapshot_url !== null) fail('unavailable camera URLs must be null'); }
  if (!Array.isArray(t.faults) || t.faults.length > 16) fail('faults must be bounded'); t.faults.forEach(f => text(f, 'fault'));
  return t;
}
function validateCommand(c) {
  keys(c, ['schema_version', 'id', 'action', 'args', 'ttl_ms'], 'command');
  if (c.schema_version !== VERSION) fail('unsupported command schema');
  if (typeof c.id !== 'string' || !/^[a-zA-Z0-9_-]{8,64}$/.test(c.id)) fail('invalid command id');
  integer(c.ttl_ms, 'ttl_ms', 200, 2000); choice(c.action, ['start', 'stop', 'set_fin', 'set_syringe', 'set_syringe_volume'], 'action');
  const names = c.action === 'set_fin' ? ['amplitude_deg', 'cycle_hz', 'centre_deg'] : c.action === 'set_syringe' ? ['target_deg'] : c.action === 'set_syringe_volume' ? ['volume_ml'] : [];
  keys(c.args, names, 'args'); for (const k of names) number(c.args[k], k, ...(k === 'target_deg' ? LIMITS.syringe_deg : k === 'volume_ml' ? LIMITS.syringe_ml : LIMITS[k]));
  return c;
}
function validateAck(a) {
  keys(a, ['schema_version', 'type', 'session_id', 'id', 'status', 'reason'], 'ack');
  if (a.schema_version !== VERSION || a.type !== 'ack') fail('unsupported ack'); text(a.session_id, 'session_id', 64); text(a.id, 'id', 64);
  choice(a.status, ['applied', 'rejected', 'expired'], 'ack.status');
  if (a.status === 'applied') { if (a.reason !== null) fail('applied ack reason must be null'); } else text(a.reason, 'ack.reason');
  return a;
}
module.exports = { VERSION, LIMITS, validateTelemetry, validateCommand, validateAck, missing, measured };
