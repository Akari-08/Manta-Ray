'use strict';

const { promises: fs, createReadStream } = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { spawn, execFile } = require('node:child_process');

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.mkv', '.avi', '.webm', '.m4v']);
const NUMERIC_COLUMNS = new Set([
  'timestamp_s', 'candidate_green_cover_pct', 'vegetation_cover_pct', 'valid_pixels',
  'median_luma', 'contrast_p90_p10', 'dark_pixel_pct', 'clipped_pixel_pct',
  'mean_gradient', 'tds_ppm', 'tds_sample_timestamp_s', 'tds_time_offset_s',
  'tds_temperature_c', 'simulated_tds_ppm',
]);

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

function inside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

function opaque(kind, relative) {
  return createHash('sha256').update(kind + '\0' + relative).digest('hex').slice(0, 32);
}

async function smallText(filename) {
  const stat = await fs.stat(filename);
  if (stat.size > MAX_FILE_BYTES) throw new Error('Survey file exceeds the supported size');
  return fs.readFile(filename, 'utf8');
}

function parseCSV(text) {
  const records = [];
  let record = [], field = '', quoted = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') { field += '"'; index++; }
      else quoted = !quoted;
    } else if (character === ',' && !quoted) { record.push(field); field = ''; }
    else if (character === '\n' && !quoted) {
      record.push(field.replace(/\r$/, '')); records.push(record); record = []; field = '';
    } else field += character;
  }
  if (quoted) throw new Error('Survey CSV has an unterminated quoted field');
  if (field || record.length) { record.push(field.replace(/\r$/, '')); records.push(record); }
  if (!records.length) return [];
  const columns = records.shift();
  if (columns.includes('__proto__') || columns.includes('constructor') || columns.includes('prototype')) throw new Error('Invalid survey CSV columns');
  return records.filter(values => values.some(value => value !== '')).map(values => {
    if (values.length !== columns.length) throw new Error('Survey CSV column count mismatch');
    return Object.fromEntries(columns.map((column, index) => {
      const value = values[index];
      if (value === '') return [column, null];
      if (NUMERIC_COLUMNS.has(column)) {
        const number = Number(value);
        return [column, Number.isFinite(number) ? number : null];
      }
      return [column, value];
    }));
  });
}

async function requestBody(req) {
  let length = 0;
  const chunks = [];
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 16384) throw new Error('Request body exceeds 16 KiB');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function publicSummary(summary) {
  const result = structuredClone(summary);
  if (result.method) delete result.method.command;
  return result;
}

function ecologyName(id, summary) {
  const count = summary.imagery.sample_count ?? 'Unknown';
  const method = summary.method || {};
  const interval = Number.isFinite(method.interval_s) ? method.interval_s + ' s interval' : 'Interval unspecified';
  const roi = Array.isArray(method.roi_normalized) ? 'ROI ' + method.roi_normalized.join(', ') : 'Full frame';
  return [summary.source.name, count + ' samples', interval, roi, id.slice(0, 8)].join(' · ');
}

function sameSource(first, second) {
  if (typeof first.source_sha256 === 'string' && first.source_sha256.length
      && typeof second.source_sha256 === 'string' && second.source_sha256.length) {
    return first.source_sha256.toLowerCase() === second.source_sha256.toLowerCase();
  }
  return first.source_clip === second.source_clip;
}

function reconstructionName(id, report, hasPointCloud) {
  if (report.status === 'frames_extracted') return [report.source_clip, 'Frames only — no 3D model', id.slice(0, 8)].join(' · ');
  const views = (report.registered_frames ?? '?') + '/' + (report.extracted_frames ?? '?') + ' views registered';
  const points = (report.points ?? '?') + ' points';
  const label = [report.source_clip, views, points, id.slice(0, 8)];
  if (!hasPointCloud) label.splice(1, 0, '3D model artifact unavailable');
  return label.join(' · ');
}

function createSurveyService({ root, python, colmap } = {}) {
  if (!root) throw new Error('Survey service requires a repository root');
  root = path.resolve(root);
  python ||= path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  colmap ||= path.join(root, '.tools', 'colmap', 'bin', process.platform === 'win32' ? 'colmap.exe' : 'colmap');
  let closed = false;
  let activeJob = null;
  let activePromise = null;
  let child = null;
  const jobs = new Map();
  const clips = new Map();
  const ecology = new Map();
  const reconstructions = new Map();
  const artifacts = new Map();

  async function safeFile(filename, parent = root) {
    try {
      const stat = await fs.lstat(filename);
      if (!stat.isFile() || stat.isSymbolicLink()) return false;
      const [realParent, realFile] = await Promise.all([fs.realpath(parent), fs.realpath(filename)]);
      return inside(realParent, realFile);
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes(error.code)) return false;
      throw error;
    }
  }

  async function walk(directory, depth, visitor) {
    if (depth < 0) return;
    let entries;
    try {
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return;
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes(error.code)) return;
      throw error;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(filename, depth - 1, visitor);
      else if (entry.isFile()) await visitor(filename);
    }
  }

  function artifact(filename, type) {
    const id = opaque('artifact', path.relative(root, filename));
    artifacts.set(id, { filename, type });
    return '/api/surveys/artifacts/' + id;
  }

  async function library() {
    // New maps are published together after discovery so concurrent readers never see a partial scan.
    const nextClips = new Map(), nextEcology = new Map(), nextReconstructions = new Map();
    for (const directory of [path.join(root, 'media'), path.join(root, 'data', 'input')]) {
      await walk(directory, 3, async filename => {
        if (!VIDEO_EXTENSIONS.has(path.extname(filename).toLowerCase()) || !await safeFile(filename)) return;
        const id = opaque('clip', path.relative(root, filename));
        nextClips.set(id, { id, name: path.basename(filename), filename });
      });
    }
    await walk(path.join(root, 'outputs'), 5, async filename => {
      const name = path.basename(filename);
      if (!['summary.json', 'reconstruction.json'].includes(name) || !await safeFile(filename)) return;
      try {
        const report = JSON.parse(await smallText(filename));
        if (!report || Array.isArray(report) || typeof report !== 'object') return;
        const directory = path.dirname(filename);
        if (name === 'summary.json' && report.imagery && report.source && typeof report.source.name === 'string'
            && await safeFile(path.join(directory, 'survey.csv'), directory)) {
          const id = opaque('ecology', path.relative(root, directory));
          nextEcology.set(id, { id, directory, summary: publicSummary(report) });
        }
        if (name === 'reconstruction.json' && ['reconstructed', 'frames_extracted'].includes(report.status)
            && typeof report.source_clip === 'string') {
          const id = opaque('reconstruction', path.relative(root, directory));
          const hasPointCloud = report.status === 'reconstructed' && await safeFile(path.join(directory, 'point-cloud.ply'), directory);
          nextReconstructions.set(id, { id, directory, report, hasPointCloud });
        }
      } catch (error) {
        // Interrupted writes or unrelated summary files are omitted from the survey library.
        if (!['EACCES', 'EPERM'].includes(error.code)) return;
        throw error;
      }
    });
    clips.clear(); ecology.clear(); reconstructions.clear();
    for (const [id, value] of nextClips) clips.set(id, value);
    for (const [id, value] of nextEcology) ecology.set(id, value);
    for (const [id, value] of nextReconstructions) reconstructions.set(id, value);
    const reconstructionRuns = [...reconstructions.values()];
    const completedModels = reconstructionRuns.filter(item => item.hasPointCloud);
    return {
      clips: [...clips.values()].map(({ id, name }) => ({ id, name })),
      ecology: [...ecology.values()].map(({ id, summary }) => ({
        ...summary, id, source_clip: summary.source.name, name: ecologyName(id, summary),
      })),
      reconstructions: reconstructionRuns
        .filter(item => item.report.status !== 'frames_extracted' || !completedModels.some(model => sameSource(item.report, model.report)))
        .map(({ id, report, hasPointCloud }) => ({ ...report, id, name: reconstructionName(id, report, hasPointCloud) })),
    };
  }

  function publicJob(job) {
    return { id: job.id, status: job.status, stage: job.stage, error: job.error, output: { ...job.output } };
  }

  function killChild(processChild) {
    if (!processChild?.pid || processChild.exitCode !== null) return Promise.resolve();
    if (process.platform === 'win32') {
      return new Promise(resolve => execFile('taskkill.exe', ['/PID', String(processChild.pid), '/T', '/F'], () => resolve()));
    }
    try { process.kill(-processChild.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    return Promise.resolve();
  }

  function runPython(arguments_) {
    return new Promise((resolve, reject) => {
      if (closed) return reject(new Error('Survey service is shutting down'));
      const processing = spawn(python, arguments_, {
        cwd: root, shell: false, windowsHide: true, detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child = processing;
      let detail = '', timedOut = false;
      const capture = chunk => { detail = (detail + chunk.toString('utf8')).slice(-65536); };
      processing.stdout.on('data', capture); processing.stderr.on('data', capture);
      const timeout = setTimeout(() => { timedOut = true; void killChild(processing); }, 30 * 60 * 1000);
      timeout.unref();
      processing.once('error', reject);
      processing.once('close', code => {
        clearTimeout(timeout);
        if (child === processing) child = null;
        if (code === 0 && !timedOut) resolve();
        else reject(new Error(timedOut ? 'Survey processing exceeded 30 minutes' : detail.trim().slice(-4000) || 'Python workflow failed'));
      });
    });
  }

  async function processJob(job, clip, tds) {
    try {
      const parent = path.join(root, 'outputs', 'dashboard-surveys');
      await fs.mkdir(parent, { recursive: true });
      if (!inside(await fs.realpath(root), await fs.realpath(parent))) throw new Error('Survey output directory resolves outside the repository');
      const output = path.join(parent, job.id);
      await fs.mkdir(output);
      if (job.mode !== 'reconstruction') {
        job.stage = 'ecology';
        const destination = path.join(output, 'ecology');
        const args = ['-m', 'manta_ray.ecology', clip.filename, '--output', destination, '--max-samples', '30', '--interval', '1', '--video-source', 'unknown', '--export-review', '--review-points', '50', '--animal-detection'];
        if (tds !== undefined) args.push('--simulated-tds-ppm', String(tds));
        await runPython(args);
        job.output.ecology = opaque('ecology', path.relative(root, destination));
      }
      if (job.mode !== 'ecology') {
        job.stage = 'reconstruction';
        const destination = path.join(output, 'reconstruction');
        const args = ['-m', 'manta_ray.reconstruction', clip.filename, '--output', destination, '--max-frames', '30', '--max-size', '1000'];
        if (await safeFile(colmap, path.dirname(colmap))) args.push('--colmap', colmap);
        await runPython(args);
        job.output.reconstruction = opaque('reconstruction', path.relative(root, destination));
      }
      if (closed) throw new Error('Survey service shut down');
      job.status = 'completed'; job.stage = null;
    } catch (error) {
      job.status = closed ? 'cancelled' : 'failed'; job.error = error.message;
    } finally {
      if (activeJob === job) activeJob = null;
    }
  }

  async function ecologyDetail(id) {
    await library();
    const item = ecology.get(id);
    if (!item) return null;
    const csv = path.join(item.directory, 'survey.csv');
    const rows = parseCSV(await smallText(csv));
    const overlays = [];
    await walk(path.join(item.directory, 'overlays'), 0, async filename => {
      if (path.extname(filename).toLowerCase() === '.png' && await safeFile(filename, item.directory)) overlays.push(artifact(filename, 'image/png'));
    });
    const reviewDownloads = {};
    for (const [key, filename, type] of [
      ['review_bundle', 'review-bundle.zip', 'application/zip'],
      ['review_points', 'review-points.csv', 'text/csv'],
      ['point_plan', 'point-plan.json', 'application/json'],
      ['animals', 'animals.json', 'application/json'],
    ]) {
      const candidate = path.join(item.directory, filename);
      if (await safeFile(candidate, item.directory)) reviewDownloads[key] = artifact(candidate, type);
    }
    return { summary: item.summary, rows, overlays, downloads: {
      csv: artifact(csv, 'text/csv'),
      summary: artifact(path.join(item.directory, 'summary.json'), 'application/json'),
      ...reviewDownloads,
    } };
  }

  async function handle(req, res, url, { authorized = false } = {}) {
    if (!url.pathname.startsWith('/api/surveys')) return false;
    const parts = url.pathname.split('/').filter(Boolean);
    try {
      if (req.method === 'GET' && url.pathname === '/api/surveys') {
        json(res, 200, await library()); return true;
      }
      if (req.method === 'GET' && parts.length === 4 && parts[2] === 'jobs') {
        const job = jobs.get(parts[3]);
        json(res, job ? 200 : 404, job ? publicJob(job) : { error: 'Unknown survey job' }); return true;
      }
      if (req.method === 'GET' && parts.length === 4 && parts[2] === 'artifacts') {
        const item = artifacts.get(parts[3]);
        if (!item || !await safeFile(item.filename)) { json(res, 404, { error: 'Unknown survey artifact' }); return true; }
        const stat = await fs.stat(item.filename);
        res.writeHead(200, { 'Content-Type': item.type, 'Content-Length': stat.size, 'X-Content-Type-Options': 'nosniff' });
        const stream = createReadStream(item.filename);
        stream.on('error', () => res.destroy()); stream.pipe(res); return true;
      }
      if (req.method === 'GET' && parts.length === 4 && ['ecology', 'reconstruction'].includes(parts[2])) {
        if (parts[2] === 'ecology') {
          const detail = await ecologyDetail(parts[3]);
          json(res, detail ? 200 : 404, detail || { error: 'Unknown ecological survey' }); return true;
        }
        await library();
        const item = reconstructions.get(parts[3]);
        if (!item) { json(res, 404, { error: 'Unknown reconstruction' }); return true; }
        const response = { report: item.report };
        const cloud = path.join(item.directory, 'point-cloud.ply');
        if (item.report.status === 'reconstructed' && await safeFile(cloud, item.directory)) response.point_cloud_url = artifact(cloud, 'application/octet-stream');
        json(res, 200, response); return true;
      }
      if (req.method === 'POST' && url.pathname === '/api/surveys/analyze') {
        const permitted = typeof authorized === 'function' ? authorized(req) : authorized;
        if (!permitted) { json(res, 401, { error: 'Valid control bearer token required' }); return true; }
        if (closed) { json(res, 503, { error: 'Survey service is shutting down' }); return true; }
        const data = await requestBody(req);
        if (!data || Array.isArray(data) || typeof data !== 'object'
            || Object.keys(data).some(key => !['clip_id', 'mode', 'simulated_tds_ppm'].includes(key))
            || typeof data.clip_id !== 'string' || !['ecology', 'reconstruction', 'both'].includes(data.mode)
            || (data.simulated_tds_ppm !== undefined && (!Number.isFinite(data.simulated_tds_ppm) || data.simulated_tds_ppm < 0))) {
          json(res, 400, { error: 'Provide clip_id, mode and optional nonnegative simulated_tds_ppm' }); return true;
        }
        await library();
        const clip = clips.get(data.clip_id);
        if (!clip) { json(res, 404, { error: 'Unknown input clip' }); return true; }
        if (activeJob) { json(res, 409, { error: 'A survey job is already running', id: activeJob.id }); return true; }
        const job = { id: randomUUID(), status: 'running', stage: null, error: null, output: {}, mode: data.mode };
        activeJob = job; jobs.set(job.id, job);
        while (jobs.size > 32) jobs.delete(jobs.keys().next().value);
        json(res, 202, publicJob(job));
        activePromise = processJob(job, clip, data.simulated_tds_ppm);
        return true;
      }
      json(res, 404, { error: 'Unknown survey endpoint' }); return true;
    } catch (error) {
      if (!res.headersSent) json(res, 400, { error: error.message }); else res.end();
      return true;
    }
  }

  async function close() {
    closed = true;
    if (activeJob) { activeJob.status = 'cancelled'; activeJob.error = 'Survey service shut down'; }
    await killChild(child);
    await activePromise;
  }

  return { handle, close, library, ecologyDetail };
}

module.exports = { createSurveyService, parseCSV };
