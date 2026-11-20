// Pure command translation shared by the dashboard and future adapters (e.g. MCP).
// Sending, authentication and the control heartbeat remain the caller's responsibility.
export const COMMANDS = Object.freeze({
  setfin: 'setfin <amplitude|cr|center> <value>',
  setsyringe: 'setsyringe <volume-ml>',
  startflap: 'startflap',
  stopflap: 'stopflap',
  startpath: 'startpath',
});

const finFields = Object.freeze({ amplitude: 'amplitude_deg', cr: 'cycle_hz', center: 'centre_deg', centre: 'centre_deg' });

export function finSettingsConfirmed(state, seq, args) {
  const telemetry = state?.telemetry;
  return !!telemetry && !state.stale && telemetry.seq > seq && ['amplitude_deg', 'cycle_hz', 'centre_deg'].every(key => {
    const actual = telemetry.control?.[key], expected = args[key];
    return Number.isFinite(actual) && Number.isFinite(expected) && Math.abs(actual - expected) <= 0.00001 * Math.max(1, Math.abs(expected));
  });
}

export function parseCommandLine(line) {
  const parts = line.trim().split(/\s+/);
  const name = parts[0].toLowerCase();
  if (!Object.hasOwn(COMMANDS, name)) throw new Error(`Unknown command. Available: ${Object.keys(COMMANDS).join(', ')}`);
  const count = name === 'setfin' ? 3 : name === 'setsyringe' ? 2 : 1;
  if (parts.length !== count) throw new Error(`Usage: ${COMMANDS[name]}`);
  if (name === 'setfin' || name === 'setsyringe') {
    const raw = parts.at(-1);
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw) || !Number.isFinite(Number(raw))) throw new Error('Value must be a finite decimal number');
    return { name, params: name === 'setfin' ? { parameter: parts[1].toLowerCase(), value: Number(raw) } : { volume_ml: Number(raw) } };
  }
  return { name, params: {} };
}

// Accept structured parameters independently of the CLI, so an adapter need not
// parse text. Limits and the fin snapshot come from the live server state.
export function buildCommand(name, params, state) {
  if (!Object.hasOwn(COMMANDS, name)) throw new Error('Unknown command');
  if (name === 'startpath') throw new Error('startpath is a local simulation preview, not a device command');
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('Invalid parameters');
  const expected = name === 'setfin' ? ['parameter', 'value'] : name === 'setsyringe' ? ['volume_ml'] : [];
  if (Object.keys(params).length !== expected.length || expected.some(key => !Object.hasOwn(params, key))) throw new Error(`Usage: ${COMMANDS[name]}`);
  if (name === 'startflap' || name === 'stopflap') return { action: name === 'startflap' ? 'start' : 'stop', args: {} };
  if (!state || state.stale || !state.telemetry?.control || !state.limits) throw new Error('Fresh robot telemetry and limits are required');
  const checked = (value, key, label) => {
    const range = state.limits[key];
    if (!Array.isArray(range) || range.length !== 2 || !range.every(Number.isFinite)) throw new Error(`Limits unavailable for ${label}`);
    if (typeof value !== 'number' || !Number.isFinite(value) || value < range[0] || value > range[1]) throw new Error(`${label} must be ${range[0]}..${range[1]}`);
    return value;
  };
  if (name === 'setsyringe') {
    if (state.telemetry.source !== 'simulator') throw new Error('Syringe volume is simulation-only');
    return { action: 'set_syringe_volume', args: { volume_ml: checked(params.volume_ml, 'syringe_ml', 'Syringe volume') } };
  }
  if (typeof params.parameter !== 'string' || !Object.hasOwn(finFields, params.parameter)) throw new Error(`Usage: ${COMMANDS.setfin}`);
  const field = finFields[params.parameter], control = state.telemetry.control;
  const args = {};
  for (const key of ['amplitude_deg', 'cycle_hz', 'centre_deg']) args[key] = checked(key === field ? params.value : control[key], key, key);
  return { action: 'set_fin', args };
}
