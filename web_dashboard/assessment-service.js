'use strict';
const { promises: fs } = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { spawn, execFile } = require('node:child_process');

const REQUEST_LIMIT = 256 * 1024;
const INPUT_LIMIT = 1024 * 1024;
const OUTPUT_LIMIT = 2 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function problem(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(value));
}

function inside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

async function body(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    req.on('data', chunk => {
      length += chunk.length;
      if (length <= REQUEST_LIMIT) chunks.push(chunk);
    });
    req.once('error', reject);
    req.once('end', () => {
      if (length > REQUEST_LIMIT) return reject(problem(400, 'Assessment request exceeds 256 KiB'));
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(problem(400, 'Assessment request must contain JSON')); }
    });
  });
}

function hash(text) {
  return createHash('sha256').update(text).digest('hex');
}

function createAssessmentService({ root, python, loadSurvey } = {}) {
  if (!root || typeof loadSurvey !== 'function') throw new Error('Assessment service requires root and loadSurvey');
  root = path.resolve(root);
  python ||= path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const directory = path.join(root, 'outputs', 'ecological-assessments');
  const active = new Set();
  let closed = false;
  let catalogPromise = null;

  function kill(processChild) {
    if (!processChild.pid || processChild.exitCode !== null) return Promise.resolve();
    if (process.platform === 'win32') {
      return new Promise(resolve => execFile('taskkill.exe', ['/PID', String(processChild.pid), '/T', '/F'], () => resolve()));
    }
    try { process.kill(-processChild.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    return Promise.resolve();
  }

  function engine(payload, catalog = false) {
    if (closed) return Promise.reject(problem(503, 'Assessment service is shutting down'));
    if (active.size >= 2) return Promise.reject(problem(409, 'Two ecological assessments are already running'));
    const input = catalog ? '' : JSON.stringify(payload);
    if (Buffer.byteLength(input) > INPUT_LIMIT) return Promise.reject(problem(400, 'Combined survey and assessment inputs exceed 1 MiB'));
    return new Promise((resolve, reject) => {
      const child = spawn(python, ['-m', 'manta_ray.ecology.assessment', ...(catalog ? ['--catalog'] : [])], {
        cwd: root, shell: false, windowsHide: true, detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = [], bytes = 0, stderr = '', failure = null;
      let resolveFinished;
      const finished = new Promise(done => { resolveFinished = done; });
      const item = { child, finished };
      active.add(item);
      const timeout = setTimeout(() => {
        failure = problem(504, 'Ecological assessment exceeded 30 seconds');
        void kill(child);
      }, 30000);
      timeout.unref();
      child.stdout.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > OUTPUT_LIMIT) {
          failure = problem(502, 'Ecological assessment produced too much output');
          void kill(child);
        } else stdout.push(chunk);
      });
      child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(-4096); });
      // EPIPE is expected if Python rejects input or the service closes while writing.
      child.stdin.on('error', () => {});
      child.once('error', () => { failure = problem(503, 'The configured Python assessment engine could not start'); });
      child.once('close', code => {
        clearTimeout(timeout);
        active.delete(item);
        resolveFinished();
        if (closed) return reject(problem(503, 'Assessment service shut down'));
        if (failure) return reject(failure);
        if (code !== 0) return reject(problem(400, stderr.trim() || 'Assessment inputs were rejected by the engine'));
        try {
          const result = JSON.parse(Buffer.concat(stdout).toString('utf8'));
          if (!result || typeof result !== 'object') throw new Error('Invalid engine report');
          resolve(result);
        } catch { reject(problem(502, 'The assessment engine returned an invalid JSON report')); }
      });
      child.stdin.end(input);
    });
  }

  function catalog() {
    if (!catalogPromise) catalogPromise = engine(null, true).catch(error => { catalogPromise = null; throw error; });
    return catalogPromise;
  }

  async function persist(surveyId, request, summary, rows, report) {
    if (closed) throw problem(503, 'Assessment service shut down');
    await fs.mkdir(directory, { recursive: true });
    if (!inside(await fs.realpath(root), await fs.realpath(directory))) throw problem(500, 'Assessment storage resolves outside the repository');
    const id = randomUUID();
    const inputText = JSON.stringify({ request, summary, rows });
    const wrapper = {
      assessment_id: id, created_utc: new Date().toISOString(), survey_id: surveyId,
      input_sha256: hash(inputText), request, assessment: report,
      report_url: '/api/ecology/assessments/' + id,
      request_url: '/api/ecology/assessments/' + id + '/request',
      audit_url: '/api/ecology/assessments/' + id + '/audit',
    };
    const reportText = JSON.stringify(wrapper, null, 2) + '\n';
    if (Buffer.byteLength(reportText) > OUTPUT_LIMIT) throw problem(502, 'Assessment report and request exceed the supported audit size');
    const temporary = await fs.mkdtemp(path.join(directory, '.assessment-'));
    try {
      await fs.writeFile(path.join(temporary, 'input.json'), inputText + '\n');
      await fs.writeFile(path.join(temporary, 'report.json'), reportText);
      await fs.rename(temporary, path.join(directory, id));
    } finally {
      await fs.rm(temporary, { recursive: true, force: true });
    }
    return wrapper;
  }

  async function saved(id, mode) {
    if (!UUID.test(id)) throw problem(404, 'Unknown ecological assessment');
    const folder = path.join(directory, id);
    try {
      const stat = await fs.lstat(folder);
      if (!stat.isDirectory() || stat.isSymbolicLink() || !inside(await fs.realpath(root), await fs.realpath(folder))) throw problem(404, 'Unknown ecological assessment');
      async function read(name) {
        const filename = path.join(folder, name);
        const stat = await fs.lstat(filename);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > OUTPUT_LIMIT) throw problem(404, 'Unknown ecological assessment');
        return JSON.parse(await fs.readFile(filename, 'utf8'));
      }
      const report = await read('report.json');
      if (report.assessment_id !== id) throw problem(404, 'Unknown ecological assessment');
      if (!mode) return report;
      const inputs = await read('input.json');
      if (hash(JSON.stringify(inputs)) !== report.input_sha256) throw problem(409, 'Assessment audit inputs no longer match their recorded hash');
      return mode === 'request' ? inputs : { assessment: report, inputs };
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes(error.code)) throw problem(404, 'Unknown ecological assessment');
      throw error;
    }
  }

  async function handle(req, res, url, { authorized = false } = {}) {
    const assessment = /^\/api\/surveys\/ecology\/([a-f0-9]{32})\/assessment$/.exec(url.pathname);
    const stored = /^\/api\/ecology\/assessments\/([^/]+)(?:\/(audit|request))?$/.exec(url.pathname);
    const standalone = url.pathname === '/api/ecology/assessments';
    if (url.pathname !== '/api/ecology/methods' && !assessment && !stored && !standalone) return false;
    try {
      if (closed) throw problem(503, 'Assessment service is shutting down');
      if (req.method === 'GET' && url.pathname === '/api/ecology/methods') {
        json(res, 200, await catalog()); return true;
      }
      if (req.method === 'GET' && stored) {
        json(res, 200, await saved(stored[1], stored[2])); return true;
      }
      if (req.method === 'GET' && assessment) {
        if ([...url.searchParams.keys()].some(key => !['method', 'simulate_tds', 'include_simulated'].includes(key))) throw problem(400, 'Unknown assessment query parameter');
        const request = { method: url.searchParams.get('method') || 'camera_tds', include_simulated: false };
        const include = url.searchParams.get('include_simulated');
        if (include !== null && include !== '1') throw problem(400, 'Use include_simulated=1 to include existing simulated values');
        request.include_simulated = include === '1';
        const simulated = url.searchParams.get('simulate_tds');
        if (simulated !== null && simulated !== '1') throw problem(400, 'Use simulate_tds=1 for the demo scenario');
        if (simulated === '1') {
          request.include_simulated = true;
          request.simulate_tds = { seed: 42, baseline_ppm: 150, variation_ppm: 10 };
        }
        const survey = await loadSurvey(assessment[1]);
        if (!survey) throw problem(404, 'Unknown ecological survey');
        const result = await engine({ request, summary: survey.summary, rows: survey.rows });
        json(res, 200, {
          assessment: result, assessment_id: null, report_url: null, request_url: null,
          survey_id: assessment[1],
        }); return true;
      }
      if (req.method === 'POST' && (assessment || standalone)) {
        const permitted = typeof authorized === 'function' ? authorized(req) : authorized;
        if (!permitted) throw problem(401, 'Valid control bearer token required');
        const request = await body(req);
        if (!request || Array.isArray(request) || typeof request !== 'object' || typeof request.method !== 'string'
            || request.method.length > 120 || (request.include_simulated !== undefined && typeof request.include_simulated !== 'boolean')) {
          throw problem(400, 'Provide an assessment method and valid assessment inputs');
        }
        if (standalone && request.method !== 'multispectral_ndci') throw problem(400, 'Standalone assessments require the multispectral_ndci method');
        if (Array.isArray(request.measurements) && request.measurements.length > 5000) throw problem(400, 'At most 5000 measurements are supported');
        const survey = standalone ? { summary: {}, rows: [] } : await loadSurvey(assessment[1]);
        if (!survey) throw problem(404, 'Unknown ecological survey');
        const payload = { request, summary: survey.summary, rows: survey.rows };
        const report = await engine(payload);
        json(res, 200, await persist(standalone ? null : assessment[1], request, survey.summary, survey.rows, report));
        return true;
      }
      throw problem(405, 'Method not supported for this assessment endpoint');
    } catch (error) {
      if (!res.headersSent) json(res, error.status || 500, { error: error.status ? error.message : 'Ecological assessment could not be completed' });
      else res.end();
      return true;
    }
  }

  async function close() {
    closed = true;
    const running = [...active];
    await Promise.all(running.map(item => kill(item.child)));
    await Promise.all(running.map(item => item.finished));
  }

  return { handle, close };
}

module.exports = { createAssessmentService };
