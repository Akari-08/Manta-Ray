'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { promises: fs, existsSync } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const { createAssessmentService } = require('./assessment-service');
const { createSurveyService } = require('./survey-service');

const python = [
  process.env.SURVEY_TEST_PYTHON,
  path.resolve(__dirname, '..', '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
  'python3.15', 'python3', 'python',
].filter(Boolean).find(candidate => spawnSync(candidate, ['-c', 'import sys; assert sys.version_info >= (3,11)'], { windowsHide: true }).status === 0);
const SURVEY_ID = 'a'.repeat(32);

async function write(root, name, content) {
  const filename = path.join(root, name);
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, content);
}

async function fixture(t, { real = false, loadSurvey } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'manta-assessment-'));
  if (real) {
    await fs.cp(path.resolve(__dirname, '..', 'manta_ray'), path.join(root, 'manta_ray'), {
      recursive: true, filter: source => !source.includes('__pycache__'),
    });
  } else {
    await write(root, 'manta_ray/__init__.py', '');
    await write(root, 'manta_ray/ecology/__init__.py', '');
    await write(root, 'manta_ray/ecology/assessment.py', [
      'import sys,json,time,pathlib',
      'if "--catalog" in sys.argv:',
      '    print(json.dumps([{"id":"camera_tds","label":"Camera and TDS"},{"id":"carlson_tsi"},{"id":"ccme_wqi"}]))',
      '    raise SystemExit(0)',
      'data=json.load(sys.stdin)',
      'method=data["request"]["method"]',
      'if method=="bad_output":',
      '    print("not json"); raise SystemExit(0)',
      'if method=="unsupported":',
      '    raise SystemExit("Unsupported assessment method")',
      'if method=="large_output":',
      '    print(json.dumps({"large":"x"*3000000})); raise SystemExit(0)',
      'if method=="slow": time.sleep(2)',
      'print(json.dumps({"method":method,"inputs":data,"status":"insufficient_data"}))',
    ].join('\n'));
  }
  const survey = {
    summary: { source: { name: 'stock.mp4', type: 'stock' }, imagery: { sample_count: 1 }, method: { name: 'green_excess_rgb_v1' } },
    rows: [{ timestamp_s: 0, candidate_green_cover_pct: 12, vegetation_cover_pct: null, tds_ppm: 150, tds_source: 'simulated' }],
  };
  const service = createAssessmentService({
    root, python, loadSurvey: loadSurvey || (async id => id === SURVEY_ID ? structuredClone(survey) : null),
  });
  const server = http.createServer(async (req, res) => {
    const result = await service.handle(req, res, new URL(req.url, 'http://localhost'), { authorized: req.headers.authorization === 'Bearer control' });
    if (!result) { res.writeHead(404); res.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await service.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  async function get(route) {
    const response = await fetch(base + route);
    return { status: response.status, value: await response.json() };
  }
  async function post(data, authorized = true, route = '/api/surveys/ecology/' + SURVEY_ID + '/assessment') {
    const response = await fetch(base + route, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(authorized ? { Authorization: 'Bearer control' } : {}) },
      body: JSON.stringify(data),
    });
    return { status: response.status, value: await response.json() };
  }
  return { root, service, get, post, base };
}

test('catalog and readonly method selection preserve source evidence and exclude simulation by default', { skip: !python }, async t => {
  const { root, get } = await fixture(t);
  const catalog = await get('/api/ecology/methods');
  assert.equal(catalog.status, 200);
  assert.equal(catalog.value[0].id, 'camera_tds');
  const response = await get('/api/surveys/ecology/' + SURVEY_ID + '/assessment?method=carlson_tsi');
  assert.equal(response.status, 200);
  assert.equal(response.value.assessment.method, 'carlson_tsi');
  assert.equal(response.value.assessment.inputs.request.include_simulated, false);
  assert.equal(response.value.assessment.inputs.rows[0].vegetation_cover_pct, null);
  assert.equal(response.value.assessment_id, null);
  assert.equal(existsSync(path.join(root, 'outputs', 'ecological-assessments')), false);
  const include = await get('/api/surveys/ecology/' + SURVEY_ID + '/assessment?include_simulated=1');
  assert.equal(include.value.assessment.inputs.request.include_simulated, true);
  const scenario = await get('/api/surveys/ecology/' + SURVEY_ID + '/assessment?simulate_tds=1');
  assert.equal(scenario.value.assessment.inputs.request.include_simulated, true);
  assert.equal(scenario.value.assessment.inputs.request.simulate_tds.seed, 42);
  assert.equal(scenario.value.assessment.inputs.request.simulate_tds.baseline_ppm, 150);
  assert.equal(scenario.value.assessment.inputs.request.simulate_tds.variation_ppm, 10);
  assert.equal((await get('/api/surveys/ecology/' + SURVEY_ID + '/assessment?arbitrary=1')).status, 400);
  await fs.unlink(path.join(root, 'manta_ray', 'ecology', 'assessment.py'));
  assert.equal((await get('/api/ecology/methods')).status, 200);
});

test('authenticated assessments persist auditable inputs and survive service recreation', { skip: !python }, async t => {
  const { root, get, post } = await fixture(t);
  const request = { method: 'camera_tds', include_simulated: true, measurements: [] };
  const result = await post(request);
  assert.equal(result.status, 200);
  assert.equal(result.value.assessment.method, 'camera_tds');
  assert.equal(typeof result.value.assessment_id, 'string');
  assert.match(result.value.input_sha256, /^[a-f0-9]{64}$/);
  const saved = await get(result.value.report_url);
  assert.deepEqual(saved.value, result.value);
  const reopened = createAssessmentService({ root, python, loadSurvey: async () => null });
  let restoredStatus, restored;
  await reopened.handle({ method: 'GET' }, {
    writeHead(status) { restoredStatus = status; },
    end(text) { restored = JSON.parse(text); },
  }, new URL(result.value.report_url, 'http://localhost'));
  await reopened.close();
  assert.equal(restoredStatus, 200);
  assert.deepEqual(restored, result.value);
  const inputs = await get(result.value.request_url);
  assert.deepEqual(inputs.value.request, request);
  assert.equal(inputs.value.rows[0].tds_source, 'simulated');
  const id = result.value.assessment_id;
  await fs.writeFile(path.join(root, 'outputs', 'ecological-assessments', id, 'input.json'), '{"changed":true}');
  assert.equal((await get(result.value.request_url)).status, 409);
  assert.equal((await get('/api/ecology/assessments/not-a-valid-id')).status, 404);
  assert.equal((await post(request, false)).status, 401);
});

test('invalid inputs, unknown survey and invalid CLI JSON fail cleanly', { skip: !python }, async t => {
  const { post, get, base } = await fixture(t);
  for (const request of [null, [], { method: 'camera_tds', include_simulated: 1 }, { method: 'camera_tds', measurements: Array(5001).fill(1) }]) {
    assert.equal((await post(request)).status, 400);
  }
  assert.equal((await post({ method: 'unsupported' })).status, 400);
  assert.equal((await post({ method: 'bad_output' })).status, 502);
  assert.equal((await post({ method: 'large_output' })).status, 502);
  assert.equal((await post({ method: 'camera_tds', extra: 'x'.repeat(270000) })).status, 400);
  assert.equal((await get('/api/surveys/ecology/' + 'b'.repeat(32) + '/assessment')).status, 404);
  const response = await fetch(base + '/api/surveys/ecology/' + SURVEY_ID + '/assessment', {
    method: 'POST', headers: { Authorization: 'Bearer control' }, body: '{bad',
  });
  assert.equal(response.status, 400);
});

test('combined saved survey input is bounded before invoking Python', { skip: !python }, async t => {
  const { post } = await fixture(t, {
    loadSurvey: async () => ({ summary: {}, rows: [{ note: 'x'.repeat(1100000) }] }),
  });
  const response = await post({ method: 'camera_tds' });
  assert.equal(response.status, 400);
  assert.match(response.value.error, /1 MiB/);
});

test('assessment worker concurrency is bounded and shutdown cancels owned processes', { skip: !python }, async t => {
  const { service, get } = await fixture(t);
  const url = '/api/surveys/ecology/' + SURVEY_ID + '/assessment?method=slow';
  const first = get(url), second = get(url);
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal((await get(url)).status, 409);
  await service.close();
  assert.equal((await first).status, 503);
  assert.equal((await second).status, 503);
});

test('survey public ecologyDetail reuses registered IDs and CSV provenance', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'manta-assessment-survey-'));
  const surveys = createSurveyService({ root });
  t.after(async () => { await surveys.close(); await fs.rm(root, { recursive: true, force: true }); });
  await write(root, 'outputs/run/summary.json', JSON.stringify({ source: { name: 'lake.mp4' }, imagery: { sample_count: 1 } }));
  await write(root, 'outputs/run/survey.csv', 'timestamp_s,vegetation_cover_pct,tds_source\n0,,simulated\n');
  const listing = await surveys.library();
  const detail = await surveys.ecologyDetail(listing.ecology[0].id);
  assert.equal(detail.rows[0].vegetation_cover_pct, null);
  assert.equal(detail.rows[0].tds_source, 'simulated');
  assert.equal(await surveys.ecologyDetail('../arbitrary'), null);
});

test('real Python scientific engine catalog and assessment execute through HTTP', {
  skip: !python || !existsSync(path.resolve(__dirname, '..', 'manta_ray', 'ecology', 'assessment.py')),
}, async t => {
  const { get, post } = await fixture(t, { real: true });
  const catalog = await get('/api/ecology/methods');
  assert.equal(catalog.status, 200);
  assert.equal(catalog.value.length, 4);
  assert.deepEqual(new Set(catalog.value.map(item => item.id)), new Set(['benthic_point_cover', 'video_maxn', 'camera_tds', 'multispectral_ndci']));
  const result = await post({ method: 'camera_tds', include_simulated: false });
  assert.equal(result.status, 200, JSON.stringify(result.value));
  assert.equal(typeof result.value.assessment, 'object');
  assert.equal(result.value.assessment.scenario, false);
  const simulation = await get('/api/surveys/ecology/' + SURVEY_ID + '/assessment?simulate_tds=1');
  assert.equal(simulation.status, 200, JSON.stringify(simulation.value));
  assert.equal(simulation.value.assessment.scenario, true);
  assert.equal(simulation.value.assessment.result.tds_observations.some(record => record.provenance === 'generated_scenario'), true);
  for (const method of catalog.value.filter(item => item.id !== 'camera_tds')) {
    const computed = await post(method.example);
    assert.equal(computed.status, 200, JSON.stringify(computed.value));
    assert.equal(computed.value.assessment.method_id, method.id);
    assert.equal(computed.value.assessment.status, 'computed');
    assert.equal(computed.value.assessment.scenario, true);
    assert.equal(computed.value.assessment.result.score, null);
    if (method.id !== 'multispectral_ndci') assert.equal(computed.value.assessment.result.category, 'observations');
  }
});

test('reviewed image observations persist through HTTP and reject the wrong video hash', { skip: !python }, async t => {
  const sourceHash = 'a'.repeat(64);
  const { post, get } = await fixture(t, { real: true, loadSurvey: async () => ({
    summary: { source: { name: 'fixture.mp4', type: 'synthetic', sha256: sourceHash } }, rows: [],
  }) });
  const request = { method: 'benthic_point_cover', point_frames: [{
    frame_id: 'frame_000000', timestamp_s: 0, sampling_unit: 'quadrat-1', source: 'measured',
    source_sha256: sourceHash, image_sha256: 'b'.repeat(64), reviewer: 'test reviewer',
    annotation_method: 'human_point_intercept', quality_status: 'usable', bottom_confirmed: true,
    points: [{ point_id: 1, x_px: 10, y_px: 10, label: 'macrophyte' },
             { point_id: 2, x_px: 20, y_px: 20, label: 'rock' }],
  }] };
  const computed = await post(request);
  assert.equal(computed.status, 200, JSON.stringify(computed.value));
  assert.equal(computed.value.assessment.result.macrophyte_cover_pct_classified, 50);
  assert.equal(computed.value.assessment.result.score, null);
  const persisted = await get(computed.value.report_url);
  assert.equal(persisted.value.assessment.result.macrophyte_cover_pct_classified, 50);
  const audit = await get(computed.value.audit_url);
  assert.equal(audit.status, 200);
  request.point_frames[0].source_sha256 = 'c'.repeat(64);
  const mismatch = await post(request);
  assert.equal(mismatch.status, 400);
  assert.match(mismatch.value.error, /different source video/);
});

function spectralRequest(source = 'measured') {
  return {
    method: 'multispectral_ndci', include_simulated: false,
    multispectral: {
      capture_id: 'capture-1', captured_at: '2026-01-01T00:00:00Z', site_id: 'lake-a', sensor_id: 'camera-a',
      source, geometry: 'above_water_surface', radiometry: 'water_leaving_reflectance',
      calibration: { id: 'panel-1', method: 'vendor correction + panel', reference: 'calibration record', surface_reflection_correction: 'synthetic corrected fixture' },
      registration: { verified: true, method: 'aligned bands' },
      quality_mask: { reviewed: true, method: 'reviewed valid water exclusions', values: [0, 0, 2, 0] },
      width: 2, height: 2,
      bands: {
        red: { center_nm: 665, fwhm_nm: 10, values: [0.02, 0.03, 0.02, 0.04] },
        red_edge: { center_nm: 705, fwhm_nm: 10, values: [0.03, 0.03, 0.08, 0.02] },
      },
    },
  };
}

test('standalone multispectral API needs authorization, preserves limits and requires its own method', { skip: !python }, async t => {
  const { get, post } = await fixture(t, { loadSurvey: async () => { throw new Error('No RGB survey should be loaded'); } });
  const route = '/api/ecology/assessments';
  assert.equal((await post(spectralRequest(), false, route)).status, 401);
  assert.equal((await get(route)).status, 405);
  for (const request of [null, [], { method: 'camera_tds' }, { method: 'unknown' }, { method: 'multispectral_ndci', include_simulated: 1 }]) {
    assert.equal((await post(request, true, route)).status, 400);
  }
  const oversized = await post({ method: 'multispectral_ndci', note: 'x'.repeat(270000) }, true, route);
  assert.equal(oversized.status, 400);
  assert.match(oversized.value.error, /256 KiB/);
  const response = await post(spectralRequest(), true, route);
  assert.equal(response.status, 200, JSON.stringify(response.value));
  assert.equal(response.value.survey_id, null);
  assert.deepEqual(response.value.assessment.inputs.summary, {});
  assert.deepEqual(response.value.assessment.inputs.rows, []);
});

test('real multispectral capture executes without RGB, persists provenance and cannot infer toxins or lake health', { skip: !python }, async t => {
  const { get, post } = await fixture(t, { real: true, loadSurvey: async () => { throw new Error('No RGB survey should be loaded'); } });
  const route = '/api/ecology/assessments';
  const request = spectralRequest();
  const response = await post(request, true, route);
  assert.equal(response.status, 200, JSON.stringify(response.value));
  assert.equal(response.value.survey_id, null);
  assert.equal(response.value.assessment.method_id, 'multispectral_ndci');
  assert.equal(response.value.assessment.status, 'computed');
  assert.equal(response.value.assessment.scenario, false);
  assert.equal(response.value.assessment.result.pixel_quality.valid_pixels, 3);
  assert.ok(Math.abs(response.value.assessment.result.ndci.mean - (-2 / 45)) < 1e-12);
  assert.equal(response.value.assessment.result.score, null);
  assert.equal(response.value.assessment.result.chlorophyll_a_ug_l, null);
  assert.equal(response.value.assessment.result.toxin_status, 'not_measured');
  assert.equal(response.value.assessment.result.overall_ecological_health, 'not_determined');
  const audit = await get(response.value.audit_url);
  assert.equal(audit.status, 200);
  assert.deepEqual(audit.value.inputs.request, request);
  assert.deepEqual(audit.value.inputs.summary, {});
  assert.deepEqual(audit.value.inputs.rows, []);
  assert.deepEqual((await get(response.value.report_url)).value, response.value);
  const simulation = spectralRequest('simulated');
  const excluded = await post(simulation, true, route);
  assert.equal(excluded.status, 200, JSON.stringify(excluded.value));
  assert.notEqual(excluded.value.assessment.status, 'computed');
  simulation.include_simulated = true;
  const included = await post(simulation, true, route);
  assert.equal(included.status, 200, JSON.stringify(included.value));
  assert.equal(included.value.assessment.scenario, true);
  const malformed = spectralRequest();
  malformed.multispectral.bands.red.values = [0.02];
  assert.equal((await post(malformed, true, route)).status, 400);
});
