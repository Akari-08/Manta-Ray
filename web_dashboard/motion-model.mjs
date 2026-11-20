const vector = reading => Array.isArray(reading?.value) && reading.value.length === 3 && reading.value.every(Number.isFinite) ? reading.value : null;
const scalar = reading => Number.isFinite(reading?.value) ? reading.value : null;

// Relative Z rotation is only a short-term gyro integral, not compass heading.
export function createMotionTracker() {
  let lastSeq = null, lastUptime = null, lastSource = null, yaw = 0;
  return {
    update(state, connected) {
      if (!connected || !state || state.stale || !state.telemetry) {
        lastSeq = lastUptime = lastSource = null; yaw = 0;
        return { live: false };
      }
      const t = state.telemetry, gyro = vector(t.imu.angular_velocity);
      const source = state.imu_source || t.source;
      if (source !== lastSource) { lastSeq = lastUptime = null; yaw = 0; lastSource = source; }
      if (t.seq !== lastSeq) {
        const dt = lastUptime === null ? 0 : (t.uptime_ms - lastUptime) / 1000;
        if (!gyro || dt < 0 || dt > 0.5) yaw = 0;
        else if (dt > 0) yaw = ((yaw + gyro[2] * dt + 180) % 360 + 360) % 360 - 180;
        lastSeq = t.seq; lastUptime = t.uptime_ms;
      }
      const robloxYaw = state.imu_source === 'roblox' && Number.isFinite(state.roblox_yaw_deg) ? state.roblox_yaw_deg : null;
      return { live: true, roll: scalar(t.imu.roll_estimate), pitch: scalar(t.imu.pitch_estimate), yaw: robloxYaw ?? (gyro ? yaw : null), robloxImu: robloxYaw !== null, acceleration: vector(t.imu.acceleration), gyro, control: t.control, simulated: t.source === 'simulator' };
    },
  };
}

// Flapping is an illustration: the protocol does not report the oscillator phase
// or measured fin positions. When stopped, retain the last commanded angles.
export function finAngles(control, seconds) {
  if (!control) return { left: 0, right: 0, mode: 'unavailable' };
  if (control.flapping && Number.isFinite(control.amplitude_deg) && Number.isFinite(control.cycle_hz)) {
    const flap = Math.sin(seconds * Math.PI * 2 * control.cycle_hz) * control.amplitude_deg;
    return { left: flap, right: -flap, mode: 'flapping (estimated)' };
  }
  const left = scalar(control.left_command), right = scalar(control.right_command);
  if (left !== null && right !== null && Number.isFinite(control.centre_deg)) return { left: left - control.centre_deg, right: right - control.centre_deg, mode: 'stopped (holding commanded angles)' };
  return { left: 0, right: 0, mode: control.flapping ? 'settings unavailable' : 'stopped' };
}
