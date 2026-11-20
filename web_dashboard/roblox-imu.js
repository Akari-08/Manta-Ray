'use strict';
const { measured } = require('./protocol');

function validateRobloxImu(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data) ||
      Object.keys(data).filter(key => key !== 'position').sort().join(',') !== 'acceleration,angular_velocity,pitch_deg,roll_deg,seq,session_id,yaw_deg')
    throw new Error('Invalid Roblox IMU fields');
  if (typeof data.session_id !== 'string' || !/^[a-fA-F0-9-]{16,64}$/.test(data.session_id) ||
      !Number.isSafeInteger(data.seq) || data.seq < 0) throw new Error('Invalid Roblox IMU session or sequence');
  const scalar = (value, max) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= max;
  const vector = (value, max) => Array.isArray(value) && value.length === 3 && value.every(n => scalar(n, max));
  if (!vector(data.acceleration, 160) || !vector(data.angular_velocity, 2000) ||
      !scalar(data.roll_deg, 180) || !scalar(data.pitch_deg, 90) || !scalar(data.yaw_deg, 180))
    throw new Error('Invalid Roblox IMU values');
  if (Object.hasOwn(data, 'position')) {
    const p = data.position;
    if (!p || typeof p !== 'object' || Array.isArray(p) || Object.keys(p).sort().join(',') !== 'east_m,mission_id,north_m' ||
        typeof p.mission_id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(p.mission_id) ||
        !scalar(p.east_m, 1001) || !scalar(p.north_m, 1001)) throw new Error('Invalid Roblox position');
  }
  return {
    session_id: data.session_id, seq: data.seq, yaw_deg: data.yaw_deg,
    position: data.position || null,
    imu: {
      acceleration: measured(data.acceleration, 'm/s^2'),
      angular_velocity: measured(data.angular_velocity, 'deg/s'),
      roll_estimate: measured(data.roll_deg, 'deg'),
      pitch_estimate: measured(data.pitch_deg, 'deg'),
      calibration_state: 'simulated',
    },
  };
}
module.exports = { validateRobloxImu };
