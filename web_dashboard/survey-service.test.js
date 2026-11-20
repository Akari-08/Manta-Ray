'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { promises: fs } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const { createSurveyService, parseCSV } = require('./survey-service');

const pythonCandidates = [
  process.env.SURVEY_TEST_PYTHON,
  path.resolve(__dirname, '..', '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
  'python3.15', 'python3', 'python',
].filter(Boolean);
const python = pythonCandidates.find(candidate => spawnSync(candidate, ['-c', 'import sys; assert sys.version_info >= (3, 11)'], { windowsHide: true }).status === 0);

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'manta-surveys-'));
  await fs.mkdir(path.join(root, 'media'));
  await fs.writeFile(path.join(root, 'media', 'lake.mp4'), 'synthetic input');
  const service = createSurveyService({ root, python, ...options });
  const server = http.createServer(async (req, res) => {
    if (!await service.handle(req, res, new URL(req.url, 'http://localhost'), { authorized: req.headers.authorization === 'Bearer control' })) {
      res.writeHead(404); res.end();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await service.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  const get = async route => {
    const response = await fetch(base + route);
    return { status: response.status, value: await response.json() };
  };
  const post = async (data, authorized = true) => {
    const response = await fetch(base + '/api/surveys/analyze', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(authorized ? { Authorization: 'Bearer control' } : {}) },
      body: JSON.stringify(data),
    });
    return { status: response.status, value: await response.json() };
  };
  return { root, service, base, get, post };
}

async function writeFixture(root, relative, content) {
  const filename = path.join(root, relative);
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, content);
}

async function waitForJob(get, id) {
  for (let attempts = 0; attempts < 200; attempts++) {
    const { value } = await get('/api/surveys/jobs/' + id);
    if (value.status !== 'running') return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Survey job did not finish before the test deadline');
}

test('CSV preserves provenance and quoted text while converting numeric and missing values', () => {
  assert.deepEqual(parseCSV('timestamp_s,tds_ppm,tds_source,tds_calibration_id,vegetation_cover_pct,tds_method\n0,200,simulated,001,,"a,b""c"\n'), [
    { timestamp_s: 0, tds_ppm: 200, tds_source: 'simulated', tds_calibration_id: '001', vegetation_cover_pct: null, tds_method: 'a,b"c' },
  ]);
  assert.throws(() => parseCSV('a,b\n"unterminated'), /unterminated/);
  assert.throws(() => parseCSV('a,b\n1,2,3'), /column count/);
  assert.throws(() => parseCSV('__proto__,b\nx,y'), /Invalid/);
});

test('library discovers recognized outputs and serves only mapped artifacts', async t => {
  const { root, get, base } = await fixture(t);
  const summary = {
    source: { name: 'lake.mp4', type: 'unknown' },
    imagery: { sample_count: 1, candidate_cover_median_pct: 12 },
    water: { source: 'simulated' }, method: { name: 'candidate', command: ['/private/python', '/private/source'] },
  };
  await writeFixture(root, 'outputs/run/ecology/summary.json', JSON.stringify(summary));
  await writeFixture(root, 'outputs/run/ecology/survey.csv', 'timestamp_s,candidate_green_cover_pct,vegetation_cover_pct,tds_source\n0,12,,simulated\n');
  await writeFixture(root, 'outputs/run/ecology/overlays/one.png', Buffer.from([137, 80, 78, 71]));
  await writeFixture(root, 'outputs/run/reconstruction/reconstruction.json', JSON.stringify({ source_clip: 'lake.mp4', status: 'reconstructed', points: 2 }));
  await writeFixture(root, 'outputs/run/reconstruction/point-cloud.ply', 'ply\nend_header\n');
  await writeFixture(root, 'outputs/.temporary/summary.json', JSON.stringify(summary));
  await writeFixture(root, 'outputs/unrelated/summary.json', '{}');
  const listing = (await get('/api/surveys')).value;
  assert.equal(listing.clips.length, 1);
  assert.equal(listing.clips[0].name, 'lake.mp4');
  assert.equal(listing.ecology.length, 1);
  assert.equal(listing.reconstructions.length, 1);
  assert.equal(listing.ecology[0].source_clip, 'lake.mp4');
  assert.equal(listing.ecology[0].method.command, undefined);
  const details = (await get('/api/surveys/ecology/' + listing.ecology[0].id)).value;
  assert.equal(details.rows[0].candidate_green_cover_pct, 12);
  assert.equal(details.rows[0].vegetation_cover_pct, null);
  assert.equal(details.rows[0].tds_source, 'simulated');
  assert.equal(details.overlays.length, 1);
  assert.equal((await fetch(base + details.overlays[0])).status, 200);
  assert.match(await (await fetch(base + details.downloads.csv)).text(), /candidate_green_cover_pct/);
  const reconstruction = (await get('/api/surveys/reconstruction/' + listing.reconstructions[0].id)).value;
  assert.equal(reconstruction.report.points, 2);
  assert.equal(await (await fetch(base + reconstruction.point_cloud_url)).text(), 'ply\nend_header\n');
  assert.equal((await fetch(base + '/api/surveys/artifacts/../../README.md')).status, 404);
  assert.equal((await get('/api/surveys/artifacts/unknown')).status, 404);
  assert.equal((await get('/api/surveys/reconstruction/arbitrary')).status, 404);
  assert.equal((await get('/api/surveys/jobs/arbitrary')).status, 404);
});

test('analyze requires authorization, registered clip IDs and finite simulated TDS', async t => {
  const { get, post } = await fixture(t);
  const clip = (await get('/api/surveys')).value.clips[0];
  assert.equal((await post({ clip_id: clip.id, mode: 'ecology' }, false)).status, 401);
  for (const body of [
    { clip_id: clip.id, mode: 'arbitrary' },
    { clip_id: clip.id, mode: 'ecology', simulated_tds_ppm: -1 },
    { clip_id: clip.id, mode: 'ecology', simulated_tds_ppm: '200' },
    { clip_id: clip.id, mode: 'ecology', path: '../secret.mp4' }, null,
  ]) assert.equal((await post(body)).status, 400);
  assert.equal((await post({ clip_id: '../media/lake.mp4', mode: 'ecology' })).status, 404);
});

test('ecology runs from one clip retain unique sample, interval and ROI labels', async t => {
  const { root, get } = await fixture(t);
  const runs = [
    { directory: 'first', count: 19, interval: 0.5, roi: [0, 0.5, 1, 0.5], median: 10.9306 },
    { directory: 'second', count: 10, interval: 1, roi: null, median: 10.9635 },
  ];
  for (const run of runs) {
    await writeFixture(root, 'outputs/' + run.directory + '/summary.json', JSON.stringify({
      source: { name: 'lake.mp4' },
      imagery: { sample_count: run.count, candidate_cover_median_pct: run.median },
      method: { interval_s: run.interval, roi_normalized: run.roi },
    }));
    await writeFixture(root, 'outputs/' + run.directory + '/survey.csv', 'timestamp_s\n0\n');
  }
  const listing = (await get('/api/surveys')).value;
  assert.equal(listing.ecology.length, 2);
  assert.equal(new Set(listing.ecology.map(item => item.name)).size, 2);
  assert.match(listing.ecology[0].name, /lake\.mp4.*19 samples.*0\.5 s interval.*ROI 0, 0\.5, 1, 0\.5/);
  assert.match(listing.ecology[1].name, /10 samples.*1 s interval.*Full frame/);
  for (const item of listing.ecology) {
    assert.equal(item.name.endsWith(item.id.slice(0, 8)), true);
    assert.equal((await get('/api/surveys/ecology/' + item.id)).status, 200);
  }
});

test('completed point clouds replace extraction-only list options while historical details remain accessible', async t => {
  const { root, get } = await fixture(t);
  const frameReport = { source_clip: 'lake.mp4', source_sha256: 'a'.repeat(64), status: 'frames_extracted', extracted_frames: 29 };
  await writeFixture(root, 'outputs/frames/reconstruction.json', JSON.stringify(frameReport));
  const initial = (await get('/api/surveys')).value.reconstructions;
  assert.equal(initial.length, 1);
  assert.match(initial[0].name, /Frames only — no 3D model/);
  const historicalId = initial[0].id;
  await writeFixture(root, 'outputs/model/reconstruction.json', JSON.stringify({
    ...frameReport, status: 'reconstructed', registered_frames: 29, points: 14273,
  }));
  await writeFixture(root, 'outputs/model/point-cloud.ply', 'ply\nend_header\n');
  const completed = (await get('/api/surveys')).value.reconstructions;
  assert.equal(completed.length, 1);
  assert.equal(completed[0].status, 'reconstructed');
  assert.match(completed[0].name, /29\/29 views registered.*14273 points/);
  assert.equal(completed[0].name.endsWith(completed[0].id.slice(0, 8)), true);
  const historical = await get('/api/surveys/reconstruction/' + historicalId);
  assert.equal(historical.status, 200);
  assert.equal(historical.value.report.status, 'frames_extracted');
  assert.equal(historical.value.point_cloud_url, undefined);
  assert.equal(await fs.readFile(path.join(root, 'outputs/frames/reconstruction.json'), 'utf8'), JSON.stringify(frameReport));
});

test('different source hashes and multiple completed models remain distinct list entries', async t => {
  const { root, get } = await fixture(t);
  for (const [directory, status, source_sha256, points] of [
    ['frames', 'frames_extracted', 'b'.repeat(64), null],
    ['model-1', 'reconstructed', 'a'.repeat(64), 100],
    ['model-2', 'reconstructed', 'a'.repeat(64), 200],
  ]) {
    await writeFixture(root, 'outputs/' + directory + '/reconstruction.json', JSON.stringify({
      source_clip: 'lake.mp4', status, source_sha256, points, extracted_frames: 25, registered_frames: 25,
    }));
    if (status === 'reconstructed') await writeFixture(root, 'outputs/' + directory + '/point-cloud.ply', 'ply\nend_header\n');
  }
  const listing = (await get('/api/surveys')).value.reconstructions;
  assert.equal(listing.length, 3);
  assert.equal(new Set(listing.map(item => item.name)).size, 3);
  assert.equal(listing.filter(item => item.status === 'reconstructed').length, 2);
  assert.equal(listing.filter(item => item.status === 'frames_extracted').length, 1);
});

test('a missing model artifact keeps extraction-only options available', async t => {
  const { root, get } = await fixture(t);
  for (const [directory, status] of [['frames', 'frames_extracted'], ['missing-model', 'reconstructed']]) {
    await writeFixture(root, 'outputs/' + directory + '/reconstruction.json', JSON.stringify({
      source_clip: 'lake.mp4', status, extracted_frames: 25,
    }));
  }
  const listing = (await get('/api/surveys')).value.reconstructions;
  assert.equal(listing.length, 2);
  assert.match(listing.find(item => item.status === 'reconstructed').name, /artifact unavailable/);
});

test('owned Python job fails observably and permits retry after failure', { skip: !python }, async t => {
  const { root, get, post } = await fixture(t);
  await writeFixture(root, 'manta_ray/__init__.py', '');
  await writeFixture(root, 'manta_ray/ecology/__init__.py', '');
  await writeFixture(root, 'manta_ray/ecology/__main__.py', 'raise SystemExit("test workflow failure")\n');
  const clip = (await get('/api/surveys')).value.clips[0];
  const accepted = await post({ clip_id: clip.id, mode: 'ecology' });
  assert.equal(accepted.status, 202);
  const done = await waitForJob(get, accepted.value.id);
  assert.equal(done.status, 'failed');
  assert.match(done.error, /test workflow failure/);
  assert.equal((await post({ clip_id: clip.id, mode: 'ecology' })).status, 202);
});

test('single job concurrency and shutdown kill the owned processing tree', { skip: !python }, async t => {
  const { root, service, get, post } = await fixture(t);
  await writeFixture(root, 'manta_ray/__init__.py', '');
  await writeFixture(root, 'manta_ray/ecology/__init__.py', '');
  await writeFixture(root, 'manta_ray/ecology/__main__.py', 'import time\ntime.sleep(60)\n');
  const clip = (await get('/api/surveys')).value.clips[0];
  const accepted = await post({ clip_id: clip.id, mode: 'ecology' });
  assert.equal(accepted.status, 202);
  assert.equal((await post({ clip_id: clip.id, mode: 'reconstruction' })).status, 409);
  await service.close();
  assert.equal((await get('/api/surveys/jobs/' + accepted.value.id)).value.status, 'cancelled');
  assert.equal((await post({ clip_id: clip.id, mode: 'ecology' })).status, 503);
});

test('both-mode job publishes ecology before reporting reconstruction failure', { skip: !python }, async t => {
  const { root, get, post } = await fixture(t);
  await writeFixture(root, 'manta_ray/__init__.py', '');
  await writeFixture(root, 'manta_ray/ecology/__init__.py', '');
  await writeFixture(root, 'manta_ray/ecology/__main__.py', [
    'import sys,json,pathlib',
    'output=pathlib.Path(sys.argv[sys.argv.index("--output")+1])',
    'output.mkdir()',
    '(output/"summary.json").write_text(json.dumps({"source":{"name":"lake.mp4"},"imagery":{"sample_count":1}}))',
    '(output/"survey.csv").write_text("timestamp_s,tds_source\\n0,missing\\n")',
  ].join('\n'));
  await writeFixture(root, 'manta_ray/reconstruction/__init__.py', '');
  await writeFixture(root, 'manta_ray/reconstruction/__main__.py', 'raise SystemExit("COLMAP stage fixture failure")\n');
  const clip = (await get('/api/surveys')).value.clips[0];
  const accepted = await post({ clip_id: clip.id, mode: 'both' });
  const done = await waitForJob(get, accepted.value.id);
  assert.equal(done.status, 'failed');
  assert.equal(done.stage, 'reconstruction');
  assert.match(done.error, /COLMAP stage fixture failure/);
  assert.equal(typeof done.output.ecology, 'string');
  assert.equal((await get('/api/surveys/ecology/' + done.output.ecology)).status, 200);
});

test('actual FFmpeg ecology CLI publishes results through survey API', {
  skip: !python || spawnSync('ffmpeg', ['-version'], { windowsHide: true }).status !== 0,
}, async t => {
  const { root, get, post, base } = await fixture(t);
  await fs.cp(path.resolve(__dirname, '..', 'manta_ray'), path.join(root, 'manta_ray'), {
    recursive: true, filter: source => !source.includes('__pycache__'),
  });
  const clipPath = path.join(root, 'media', 'lake.mp4');
  const video = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
    'color=c=green:size=160x120:duration=2:rate=12', '-c:v', 'mpeg4', clipPath,
  ], { windowsHide: true });
  assert.equal(video.status, 0, video.stderr?.toString());
  const clip = (await get('/api/surveys')).value.clips[0];
  const response = await post({ clip_id: clip.id, mode: 'ecology', simulated_tds_ppm: 220 });
  assert.equal(response.status, 202);
  const completed = await waitForJob(get, response.value.id);
  assert.equal(completed.status, 'completed', completed.error);
  const details = await get('/api/surveys/ecology/' + completed.output.ecology);
  assert.equal(details.status, 200);
  assert.equal(details.value.summary.source.type, 'unknown');
  assert.equal(details.value.summary.imagery.sample_count, 2);
  assert.equal(details.value.rows[0].tds_source, 'simulated');
  assert.ok(details.value.rows.every(row => row.tds_ppm >= 210 && row.tds_ppm <= 230));
  assert.equal(new Set(details.value.rows.map(row => row.tds_ppm)).size, 2);
  assert.equal(details.value.summary.water.input_dataset_summary.simulated_profile.baseline_ppm, 220);
  assert.equal(details.value.rows[0].vegetation_cover_pct, null);
  assert.equal(details.value.summary.ecological_assessment.method_id, 'benthic_point_cover');
  assert.equal(details.value.summary.ecological_assessment.status, 'awaiting_annotations');
  assert.equal(details.value.summary.review_workflow.point_count, 100);
  const bundle = await fetch(base + details.value.downloads.review_bundle);
  assert.equal(bundle.status, 200);
  assert.equal(bundle.headers.get('content-type'), 'application/zip');
  assert.equal(Buffer.from(await bundle.arrayBuffer()).subarray(0, 2).toString(), 'PK');
  const labels = await fetch(base + details.value.downloads.review_points);
  assert.equal(labels.status, 200);
  const labelRows = parseCSV(await labels.text());
  assert.equal(labelRows.length, 100);
  assert.ok(labelRows.every(row => row.label === null));
});
