const { test } = require('node:test');
const assert = require('node:assert/strict');
const { LIMITS, validateCommand } = require('./protocol');

const modulePromise = import('./commands.mjs');
const state = () => ({ stale: false, limits: LIMITS, telemetry: { control: { amplitude_deg: 20, cycle_hz: 0.5, centre_deg: 135 } } });

test('CLI and structured commands share the same translation and protocol contract', async () => {
  const { parseCommandLine, buildCommand } = await modulePromise;
  for (const [line, expected] of [
    ['setfin amplitude 35', { action: 'set_fin', args: { amplitude_deg: 35, cycle_hz: 0.5, centre_deg: 135 } }],
    ['SETFIN cr 1.25', { action: 'set_fin', args: { amplitude_deg: 20, cycle_hz: 1.25, centre_deg: 135 } }],
    ['setfin center 150', { action: 'set_fin', args: { amplitude_deg: 20, cycle_hz: 0.5, centre_deg: 150 } }],
    ['setfin centre 90', { action: 'set_fin', args: { amplitude_deg: 20, cycle_hz: 0.5, centre_deg: 90 } }],
    ['setsyringe 180', { action: 'set_syringe', args: { target_deg: 180 } }],
    ['startflap', { action: 'start', args: {} }],
    ['stopflap', { action: 'stop', args: {} }],
  ]) {
    const { name, params } = parseCommandLine(line);
    const result = buildCommand(name, params, state());
    assert.deepEqual(result, expected);
    validateCommand({ ...result, schema_version: 1, id: 'test-id-1234', ttl_ms: 1500 });
  }
  assert.deepEqual(buildCommand('setfin', { parameter: 'cr', value: 2 }, state()).args, { amplitude_deg: 20, cycle_hz: 2, centre_deg: 135 });
});

test('rejects malformed input, invalid ranges and unsafe fin snapshots', async () => {
  const { parseCommandLine, buildCommand } = await modulePromise;
  for (const line of ['bogus', 'setfin', 'startflap 1', 'setsyringe', 'setfin cr NaN', 'setsyringe Infinity', 'setfin cr 0x1', 'setsyringe 12foo']) assert.throws(() => parseCommandLine(line));
  for (const line of ['setfin unknown 1', 'setfin amplitude 46', 'setfin cr 0', 'setfin center 181', 'setsyringe -1', 'setsyringe 181']) {
    const { name, params } = parseCommandLine(line);
    assert.throws(() => buildCommand(name, params, state()));
  }
  assert.throws(() => buildCommand('setfin', { parameter: 'amplitude', value: 1 }, { ...state(), stale: true }), /Fresh/);
  assert.throws(() => buildCommand('setfin', { parameter: 'amplitude', value: 1 }, { ...state(), telemetry: { control: { amplitude_deg: 20 } } }), /cycle_hz/);
  assert.throws(() => buildCommand('setfin', { parameter: 'cr', value: '1' }, state()));
  assert.throws(() => buildCommand('startflap', { extra: 1 }, state()));
});

test('fin settings require newer matching fresh telemetry, allowing firmware float rounding', async () => {
  const { finSettingsConfirmed } = await modulePromise;
  const args = { amplitude_deg: 20, cycle_hz: 1.2, centre_deg: 135 };
  const s = state(); s.telemetry.seq = 10; s.telemetry.control.cycle_hz = 1.20000005;
  assert.equal(finSettingsConfirmed(s, 9, args), true);
  assert.equal(finSettingsConfirmed(s, 10, args), false);
  assert.equal(finSettingsConfirmed({ ...s, stale: true }, 9, args), false);
  s.telemetry.control.cycle_hz = 1.3;
  assert.equal(finSettingsConfirmed(s, 9, args), false);
});
