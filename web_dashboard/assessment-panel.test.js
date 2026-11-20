'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class Element {
  constructor(id = '', tag = 'div') {
    this.id = id; this.tag = tag; this.value = ''; this.checked = false;
    this.hidden = false; this.disabled = false; this.dataset = {}; this.children = [];
    this.listeners = new Map(); this.textContent = ''; this.files = [];
  }
  addEventListener(name, callback) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(callback);
  }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) {
    this.children = nodes;
    if (this.id === 'assessment-method') this.value = nodes[0]?.value || '';
  }
  async emit(name) {
    const event = { target: this, preventDefault() {} };
    for (const callback of this.listeners.get(name) || []) await callback(event);
  }
}

const settle = () => new Promise(resolve => setImmediate(resolve));

async function panel({ token = 'control' } = {}) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, new Element(id));
    return elements.get(id);
  };
  const spectral = { capture_id: 'capture-1', source: 'measured', calibration: { surface_reflection_correction: 'synthetic corrected fixture' }, bands: { red: { values: [0.02] }, red_edge: { values: [0.03] } } };
  const methods = [
    { id: 'benthic_point_cover', name: 'Reviewed cover', required_inputs: [], example: {} },
    { id: 'multispectral_ndci', name: 'Multispectral', required_inputs: [],
      example: { method: 'multispectral_ndci', include_simulated: true, multispectral: { ...spectral, source: 'simulated' } } },
  ];
  const requests = [];
  const context = vm.createContext({
    document: { getElementById: element, createElement: tag => new Element('', tag) },
    location: { origin: 'http://localhost:3000' }, URL, URLSearchParams, AbortSignal,
    fetch: async (url, options = {}) => {
      if (url === '/api/ecology/methods') return { ok: true, json: async () => methods };
      requests.push({ url, options, body: JSON.parse(options.body) });
      return { ok: true, json: async () => ({
        assessment: { method_id: 'multispectral_ndci', method_name: 'Multispectral', status: 'computed', data_origin: 'measured', scenario: false,
          steps: [{ name: 'NDCI', denominator_epsilon: 1e-12 }],
          result: { label: 'Relative chlorophyll', score: null, category: null, overall_ecological_health: 'not_determined', ndci: { mean: 0.2 }, pixel_quality: { total_pixels: 4, valid_pixels: 3 }, index_map: Array(1000).fill(0.2) } },
      }) };
    },
  });
  element('assessment-inputs').value = '{}';
  element('assessment-seed').value = '42';
  element('assessment-baseline').value = '150';
  element('assessment-variation').value = '10';
  const source = fs.readFileSync(path.join(__dirname, 'assessment-panel.js'), 'utf8');
  const initialize = new vm.Script(source.replace('export function initAssessmentPanel', 'function initAssessmentPanel') + '\ninitAssessmentPanel;').runInContext(context);
  const instance = initialize({ token: () => token });
  await settle();
  return { element, requests, instance, spectral };
}

async function importRequest(ui, request) {
  const input = ui.element('assessment-import');
  const text = JSON.stringify(request);
  input.files = [{ size: Buffer.byteLength(text), text: async () => text }];
  await input.emit('change');
  await settle();
}

test('a calibrated capture imports and calculates independently of RGB, with no TDS or automatic simulation opt-in', async () => {
  const ui = await panel();
  assert.equal(ui.element('assessment-calculate').disabled, true);
  ui.element('assessment-include-simulated').checked = true;
  ui.element('assessment-simulate-tds').checked = true;
  await importRequest(ui, { request: { method: 'multispectral_ndci', include_simulated: true, multispectral: ui.spectral } });
  assert.equal(ui.element('assessment-method').value, 'multispectral_ndci');
  assert.equal(ui.element('assessment-calculate').disabled, false);
  assert.equal(ui.element('assessment-tds-controls').hidden, true);
  assert.equal(ui.element('assessment-include-simulated').checked, false);
  assert.equal(ui.requests.length, 0);
  await ui.element('assessment-form').emit('submit');
  await settle();
  assert.equal(ui.requests.length, 1);
  assert.equal(ui.requests[0].url, '/api/ecology/assessments');
  assert.equal(ui.requests[0].options.method, 'POST');
  assert.equal(ui.requests[0].options.headers.Authorization, 'Bearer control');
  assert.deepEqual(ui.requests[0].body.multispectral, ui.spectral);
  assert.equal(ui.requests[0].body.include_simulated, false);
  assert.equal(Object.hasOwn(ui.requests[0].body, 'simulate_tds'), false);
  assert.equal(ui.element('assessment-report').hidden, false);
  assert.equal(ui.element('assessment-values').children.some(row => row.children[0]?.textContent === 'ndci · mean'), true);
  assert.equal(ui.element('assessment-values').children.some(row => row.children[0]?.textContent === 'pixel quality · valid pixels'), true);
  assert.equal(ui.element('assessment-values').children.some(row => row.children[0]?.textContent === 'index map'), false);
});

test('the simulated example remains opt-in, and switching RGB surveys does not enable simulation for a spectral capture', async () => {
  const ui = await panel();
  await importRequest(ui, { method: 'multispectral_ndci', multispectral: ui.spectral });
  await ui.element('assessment-example').emit('click');
  const request = JSON.parse(ui.element('assessment-inputs').value);
  assert.equal(request.multispectral.source, 'simulated');
  assert.equal(ui.element('assessment-include-simulated').checked, false);
  ui.instance.selectSurvey('rgb-recording', { summary: { source: { type: 'stock' } } });
  assert.equal(ui.element('assessment-include-simulated').checked, false);
  assert.equal(ui.requests.length, 0);
  ui.element('assessment-include-simulated').checked = true;
  await ui.element('assessment-form').emit('submit');
  await settle();
  assert.equal(ui.requests[0].url, '/api/ecology/assessments');
  assert.equal(ui.requests[0].body.include_simulated, true);
});

test('missing authorization and invalid imports fail before submitting a spectral capture', async () => {
  const ui = await panel({ token: '' });
  await importRequest(ui, { method: 'multispectral_ndci', multispectral: ui.spectral });
  await ui.element('assessment-form').emit('submit');
  await settle();
  assert.equal(ui.requests.length, 0);
  assert.match(ui.element('assessment-feedback').textContent, /control token/);
  await importRequest(ui, { method: 'unknown', multispectral: ui.spectral });
  assert.match(ui.element('assessment-feedback').textContent, /unknown observation method/);
  const input = ui.element('assessment-import');
  input.files = [{ size: 256 * 1024 + 1, text: async () => { throw new Error('Must not read oversized file'); } }];
  await input.emit('change');
  assert.match(ui.element('assessment-feedback').textContent, /256 KiB/);
});


test('a stale file read preserves newer edits and clears the chooser for re-import', async () => {
  const ui = await panel();
  const input = ui.element('assessment-import');
  let finishRead;
  input.value = 'capture.json';
  input.files = [{ size: 100, text: () => new Promise(resolve => { finishRead = resolve; }) }];
  const importing = input.emit('change');
  await settle();
  ui.element('assessment-inputs').value = '{"operator_edit":true}';
  await ui.element('assessment-inputs').emit('input');
  finishRead(JSON.stringify({ method: 'multispectral_ndci', multispectral: ui.spectral }));
  await importing;
  assert.equal(input.value, '');
  assert.equal(ui.element('assessment-method').value, 'benthic_point_cover');
  assert.equal(ui.element('assessment-inputs').value, '{"operator_edit":true}');
  assert.equal(ui.requests.length, 0);
  await importRequest(ui, { method: 'multispectral_ndci', multispectral: ui.spectral });
  assert.equal(ui.element('assessment-method').value, 'multispectral_ndci');
});

test('importing reviewed RGB observations requires an explicit calculate action', async () => {
  const ui = await panel();
  ui.instance.selectSurvey('rgb-recording', { summary: { source: { type: 'measured' } } });
  await settle();
  ui.requests.length = 0;
  const frames = [{ frame_id: 'reviewed-frame', points: [{ point_id: 1, label: 'macrophyte' }] }];
  await importRequest(ui, { method: 'benthic_point_cover', point_frames: frames });
  await settle();
  assert.equal(ui.requests.length, 0);
  assert.deepEqual(JSON.parse(ui.element('assessment-inputs').value).point_frames, frames);
  assert.equal(ui.element('assessment-report').hidden, true);
  assert.equal(ui.element('assessment-include-simulated').checked, false);
  await ui.element('assessment-form').emit('submit');
  await settle();
  assert.equal(ui.requests.length, 1);
  assert.equal(ui.requests[0].url, '/api/surveys/ecology/rgb-recording/assessment');
  assert.deepEqual(ui.requests[0].body.point_frames, frames);
});


test('research traces preserve small nonzero numbers and spectral summaries omit null scores only', async () => {
  const ui = await panel();
  await importRequest(ui, { method: 'multispectral_ndci', multispectral: ui.spectral });
  await ui.element('assessment-form').emit('submit');
  await settle();
  const rows = ui.element('assessment-values').children;
  assert.equal(rows.some(row => ['score', 'category'].includes(row.children[0]?.textContent)), false);
  const health = rows.find(row => row.children[0]?.textContent === 'overall ecological health');
  assert.equal(health.children[1].textContent, 'not_determined');
  function descendants(node) { return [node, ...node.children.flatMap(descendants)]; }
  const guard = descendants(ui.element('assessment-evidence')).find(node => node.children[0]?.textContent === 'denominator epsilon');
  assert.ok(guard, 'Calculation trace should show its denominator guard');
  assert.notEqual(guard.children[1].textContent, '0');
  assert.match(guard.children[1].textContent, /E[-\u2212]12/i);
});
