const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeTelemetry } = require('./simulator');
const modulePromise = import('./motion-model.mjs');
const reading = value => ({ value });

test('motion tracker uses fresh IMU samples and resets relative gyro rotation on disconnect or a gap', async () => {
  const { createMotionTracker } = await modulePromise;
  const tracker = createMotionTracker();
  const t = makeTelemetry({ uptime: 1000, seq: 1 });
  t.imu.angular_velocity = reading([0, 0, 20]);
  t.imu.acceleration = reading([1, 2, 9]);
  t.imu.roll_estimate = reading(12); t.imu.pitch_estimate = reading(-5);
  const state = { stale: false, telemetry: t };
  let motion = tracker.update(state, true);
  assert.deepEqual(motion.acceleration, [1, 2, 9]); assert.equal(motion.roll, 12); assert.equal(motion.pitch, -5); assert.equal(motion.yaw, 0);
  t.seq++; t.uptime_ms += 100; motion = tracker.update(state, true); assert.equal(motion.yaw, 2);
  assert.equal(tracker.update(state, true).yaw, 2); // repeated state is not integrated twice
  assert.equal(tracker.update({ ...state, stale: true }, true).live, false);
  t.seq++; t.uptime_ms += 100; assert.equal(tracker.update(state, true).yaw, 0);
  t.seq++; t.uptime_ms += 1000; assert.equal(tracker.update(state, true).yaw, 0);
  t.seq++; t.imu.angular_velocity = reading(null); t.imu.acceleration = reading(null);
  motion = tracker.update(state, true); assert.equal(motion.yaw, null); assert.equal(motion.acceleration, null);
  assert.equal(tracker.update(state, false).live, false);
});

test('fin model animates confirmed flapping, even without individual angles', async () => {
  const { finAngles } = await modulePromise;
  const c = { flapping: true, centre_deg: 135, amplitude_deg: 20, cycle_hz: 1, left_command: reading(150), right_command: reading(120) };
  assert.deepEqual(finAngles(c, 0.25), { left: 20, right: -20, mode: 'flapping (estimated)' });
  c.left_command = reading(null); c.right_command = reading(null);
  assert.deepEqual(finAngles(c, 0.25), { left: 20, right: -20, mode: 'flapping (estimated)' });
  assert.deepEqual(finAngles(c, 0.75), { left: -20, right: 20, mode: 'flapping (estimated)' });
  c.amplitude_deg = 0;
  assert.equal(finAngles(c, 0.25).left, 0);
  assert.equal(finAngles(c, 0.25).mode, 'flapping (estimated)');
  c.flapping = false; assert.deepEqual(finAngles(c, 0.25), { left: 0, right: 0, mode: 'stopped' });
  c.left_command = reading(150); c.right_command = reading(120);
  assert.deepEqual(finAngles(c, 0.25), { left: 15, right: -15, mode: 'stopped (holding commanded angles)' });
});
