import { initAssessmentPanel } from './assessment-panel.js';

import { withSimulatedTds, observationsCsv } from './survey-observations.mjs';
const SVG_NS = 'http://www.w3.org/2000/svg';
const byId = id => document.getElementById(id);
const isNumber = value => typeof value === 'number' && Number.isFinite(value);
const numberText = (value, digits = 1) => isNumber(value) ? value.toFixed(digits) : 'Unavailable';

async function request(url, options = {}) {
  const response = await fetch(url, { cache: 'no-store', ...options, signal: AbortSignal.timeout(12000) });
  let body;
  try { body = await response.json(); }
  catch { throw new Error(`The service returned an unreadable response (${response.status}).`); }
  if (!response.ok) throw new Error(body.error || body.reason || `Request failed (${response.status}).`);
  return body;
}

function fileUrl(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value, location.origin);
    return url.origin === location.origin && ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

function link(label, value) {
  const url = fileUrl(value);
  if (!url) return null;
  const anchor = document.createElement('a');
  anchor.textContent = label;
  anchor.href = url;
  anchor.download = '';
  return anchor;
}

function svgElement(kind, attributes = {}, text) {
  const element = document.createElementNS(SVG_NS, kind);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  if (text !== undefined) element.textContent = text;
  return element;
}

function plot(svg, rows, field, series, maximum) {
  svg.replaceChildren();
  const timed = rows.filter(row => isNumber(row.timestamp_s));
  const valid = timed.filter(row => isNumber(row[field]));
  if (!valid.length) {
    svg.append(svgElement('text', { x: 45, y: 75 }, 'No observations available'));
    return;
  }
  const start = Math.min(...timed.map(row => row.timestamp_s));
  const end = Math.max(...timed.map(row => row.timestamp_s));
  const timeSpan = end - start || 1;
  const top = maximum || Math.max(1, ...valid.map(row => row[field])) * 1.1;
  const x = time => 45 + (time - start) / timeSpan * 535;
  const y = value => 117 - value / top * 100;
  for (const value of [0, top / 2, top]) {
    svg.append(svgElement('line', { x1: 45, x2: 580, y1: y(value), y2: y(value), stroke: '#283b32', 'stroke-width': 1 }));
    svg.append(svgElement('text', { x: 0, y: y(value) + 4 }, value.toFixed(0)));
  }
  svg.append(svgElement('text', { x: 45, y: 145 }, `${start.toFixed(1)} s`));
  svg.append(svgElement('text', { x: 580, y: 145, 'text-anchor': 'end' }, `${end.toFixed(1)} s`));
  for (const { color, include } of series) {
    let path = '', continuing = false;
    const points = [];
    for (const row of timed) {
      if (!isNumber(row[field]) || !include(row)) { continuing = false; continue; }
      const px = x(row.timestamp_s), py = y(row[field]);
      path += `${continuing ? 'L' : 'M'}${px.toFixed(2)},${py.toFixed(2)} `;
      continuing = true;
      points.push({ px, py, row });
    }
    if (path) svg.append(svgElement('path', { d: path, stroke: color, 'stroke-width': 1.8, fill: 'none' }));
    const stride = Math.max(1, Math.ceil(points.length / 150));
    for (let index = 0; index < points.length; index += stride) {
      const { px, py, row } = points[index];
      const point = svgElement('circle', { cx: px, cy: py, r: 2.4, fill: color });
      point.append(svgElement('title', {}, `${row.timestamp_s.toFixed(2)} s · ${row[field].toFixed(2)}${row.tds_source ? ` · ${field === 'tds_ppm' ? row.tds_source : row.status}` : ''}`));
      svg.append(point);
    }
  }
}

function populate(select, items, placeholder, preferred) {
  const previous = preferred || select.value;
  const options = items.map(item => {
    const option = document.createElement('option');
    option.value = item.id;
    option.textContent = item.name || item.source_clip || item.id;
    return option;
  });
  const empty = document.createElement('option');
  empty.value = '';
  empty.textContent = placeholder;
  select.replaceChildren(empty, ...options);
  select.disabled = !items.length;
  if (items.some(item => item.id === previous)) select.value = previous;
}

function renderEcology(detail) {
  const summary = detail.summary || {};
  const rows = Array.isArray(detail.rows) ? detail.rows : [];
  const imagery = summary.imagery || {};
  const sources = new Set(rows.map(row => row.tds_source).filter(source => source && source !== 'missing'));
  const sourceLabel = sources.size ? [...sources].map(value => value === 'simulated' ? 'Simulated' : value === 'measured' ? 'Measured' : value).join(' + ') : 'No observations';
  const sourceType = summary.source?.type || 'unknown';
  const roi = summary.method?.roi_normalized ? 'Selected image region' : 'Full image view';
  const site = summary.source?.site_id ? ` · site ${summary.source.site_id}` : '';
  byId('survey-ecology-source').textContent = `${summary.source?.name || 'Recorded survey'} · ${sourceType} source${site} · ${roi}`;
  byId('survey-green-cover').textContent = isNumber(imagery.candidate_cover_median_pct) ? `${imagery.candidate_cover_median_pct.toFixed(1)}% median` : 'Unavailable';
  byId('survey-usable').textContent = `${numberText(imagery.usable_view_pct)}% · ${Number.isSafeInteger(imagery.sample_count) ? imagery.sample_count : rows.length} samples`;
  byId('survey-tds-source').textContent = sourceLabel;
  const life = summary.aquatic_life || {};
  byId('survey-life-status').textContent = life.status === 'completed' ?
    `Automatic fish detection: ${life.frames_with_fish}/${life.sampled_frames} sampled frames contain candidates · maximum visible together: ${life.maximum_simultaneous_fish} · threshold ${Math.round(life.confidence_threshold * 100)}%. Unreviewed; not unique animals or species identification.` :
    `Automatic fish detection: ${life.status || 'not run'} · ${life.reason || 'Run a new image analysis to use the installed model.'}`;
  plot(byId('survey-cover-chart'), rows, 'candidate_green_cover_pct', [{ color: '#cae998', include: () => true }], 100);
  plot(byId('survey-tds-chart'), rows, 'tds_ppm', [
    { color: '#82c8dd', include: row => row.tds_source === 'measured' },
    { color: '#e8bd80', include: row => row.tds_source === 'simulated' },
  ]);
  const tableRows = rows.slice(-12).map(row => {
    const tr = document.createElement('tr');
    for (const value of [numberText(row.timestamp_s, 2), row.status || 'Unknown', numberText(row.candidate_green_cover_pct), numberText(row.tds_ppm), row.tds_source || 'missing']) {
      const cell = document.createElement('td');
      cell.textContent = value;
      tr.append(cell);
    }
    return tr;
  });
  byId('survey-observation-rows').replaceChildren(...tableRows);
  byId('survey-downloads').replaceChildren(...[
    link('DOWNLOAD CSV', detail.downloads?.csv), link('DOWNLOAD SUMMARY', detail.downloads?.summary),
    link('DOWNLOAD REVIEW BUNDLE', detail.downloads?.review_bundle),
    link('DOWNLOAD POINT LABELS', detail.downloads?.review_points),
    link('DOWNLOAD FISH DETECTIONS', detail.downloads?.animals),
  ].filter(Boolean));
  const overlays = Array.isArray(detail.overlays) ? detail.overlays : [];
  byId('survey-overlay-downloads').replaceChildren(...overlays.map((url, index) => link(`Overlay ${index + 1}`, url)).filter(Boolean));
  byId('survey-overlay-downloads').parentElement.hidden = overlays.length === 0;
  byId('survey-ecology-empty').hidden = true;
  byId('survey-ecology-detail').hidden = false;
}

export function initSurveyPanel({ token, onStop }) {
  const panel = document.querySelector('[data-panel="recorded"]');
  if (!panel || panel.dataset.initialized === 'true') return;
  panel.dataset.initialized = 'true';
  let savedEcology = null;
  let scenarioCsvUrl = null;
  const assessment = initAssessmentPanel({ token, onReport: showScenario });
  let closed = false;
  let busy = false;
  let activeJob = null;
  let pollingJob = null;
  let jobAttempts = 0;
  let pollingSitl = null;
  let ecologyRequest = 0;
  let reconstructionRequest = 0;
  let selectedCloud = null;
  let cloudView = null;
  let cloudGeneration = 0;
  let cloudAbort = null;
  let sitlRequest = 0;
  let availableSitl = false;
  let stopping = false;

  function showScenario(report) {
    if (!savedEcology) return;
    if (scenarioCsvUrl) { URL.revokeObjectURL(scenarioCsvUrl); scenarioCsvUrl = null; }
    if (!report.generated_tds?.length) {
      renderEcology(savedEcology);
      return;
    }
    const rows = withSimulatedTds(savedEcology.rows, report.generated_tds);
    renderEcology({ ...savedEcology, rows });
    byId('survey-tds-source').textContent += ' · displayed scenario';
    const download = document.createElement('a');
    scenarioCsvUrl = URL.createObjectURL(new Blob([observationsCsv(rows)], { type: 'text/csv;charset=utf-8' }));
    download.href = scenarioCsvUrl;
    download.download = 'survey-simulated-tds.csv';
    download.textContent = 'DOWNLOAD DISPLAYED SCENARIO CSV';
    const original = byId('survey-downloads').querySelector('a');
    if (original) original.textContent = 'DOWNLOAD ORIGINAL SAVED CSV';
    byId('survey-downloads').prepend(download);
  }

  function feedback(message, error = false) {
    byId('survey-feedback').textContent = message;
    byId('survey-feedback').dataset.error = String(error);
  }

  function controls() {
    byId('survey-run').disabled = busy || !byId('survey-clip').value;
    byId('survey-stop-surface').disabled = stopping || !availableSitl || !token();
    byId('survey-run-form').setAttribute('aria-busy', String(busy));
  }

  async function loadEcology() {
    const sequence = ++ecologyRequest;
    const id = byId('survey-ecology-result').value;
    savedEcology = null;
    if (scenarioCsvUrl) { URL.revokeObjectURL(scenarioCsvUrl); scenarioCsvUrl = null; }
    assessment.selectSurvey(null);
    byId('survey-ecology-detail').hidden = true;
    byId('survey-ecology-empty').hidden = false;
    byId('survey-ecology-empty').textContent = id ? 'Loading image measurements…' : 'Process a recording or choose a saved analysis.';
    if (!id) return;
    try {
      const detail = await request(`/api/surveys/ecology/${encodeURIComponent(id)}`);
      if (!closed && sequence === ecologyRequest) {
        savedEcology = detail;
        renderEcology(detail);
        assessment.selectSurvey(id, detail);
      }
    } catch (error) {
      if (!closed && sequence === ecologyRequest) byId('survey-ecology-empty').textContent = error.message;
    }
  }

  function clearCloud() {
    ++cloudGeneration;
    cloudAbort?.abort();
    cloudAbort = null;
    cloudView?.dispose();
    cloudView = null;
    byId('survey-reset-cloud').hidden = true;
    const placeholder = document.createElement('p');
    placeholder.textContent = 'Select View reconstruction to load the 3D points.';
    byId('survey-point-cloud').replaceChildren(placeholder);
  }

  async function loadReconstruction() {
    const sequence = ++reconstructionRequest;
    const id = byId('survey-reconstruction-result').value;
    selectedCloud = null;
    clearCloud();
    byId('survey-view-cloud').disabled = true;
    byId('survey-download-cloud').hidden = true;
    byId('survey-reconstruction-summary').textContent = id ? 'Loading registration results…' : 'Choose a saved reconstruction to see registration results.';
    if (!id) return;
    try {
      const detail = await request(`/api/surveys/reconstruction/${encodeURIComponent(id)}`);
      if (closed || sequence !== reconstructionRequest) return;
      const report = detail.report || {};
      const parts = [report.source_clip || 'Recorded reconstruction', String(report.status || 'unknown').replaceAll('_', ' ')];
      if (Number.isSafeInteger(report.registered_frames)) parts.push(`${report.registered_frames} registered views`);
      if (Number.isSafeInteger(report.points)) parts.push(`${report.points.toLocaleString()} points`);
      const reprojection = report.model_analysis?.mean_reprojection_error_pixels;
      if (isNumber(reprojection)) parts.push(`${reprojection.toFixed(3)} px mean reprojection error`);
      if (!detail.point_cloud_url) parts.push('No PLY point cloud available');
      byId('survey-reconstruction-summary').textContent = parts.join(' · ');
      selectedCloud = fileUrl(detail.point_cloud_url);
      byId('survey-view-cloud').disabled = !selectedCloud;
      if (selectedCloud) {
        byId('survey-download-cloud').href = selectedCloud;
        byId('survey-download-cloud').hidden = false;
      }
    } catch (error) {
      if (!closed && sequence === reconstructionRequest) byId('survey-reconstruction-summary').textContent = error.message;
    }
  }

  async function refresh(preferred = {}) {
    byId('survey-refresh').disabled = true;
    try {
      const data = await request('/api/surveys');
      if (closed) return;
      const clips = Array.isArray(data.clips) ? data.clips : [];
      populate(byId('survey-clip'), clips, clips.length ? 'Choose a recording' : 'No local recordings found');
      populate(byId('survey-ecology-result'), data.ecology || [], 'Choose image analysis', preferred.ecology);
      populate(byId('survey-reconstruction-result'), data.reconstructions || [], 'Choose reconstruction', preferred.reconstruction);
      if (!busy) feedback(`${clips.length} local recording${clips.length === 1 ? '' : 's'} available. Choose a source or open a saved result.`);
      await Promise.all([loadEcology(), loadReconstruction()]);
    } catch (error) { if (!closed) feedback(error.message, true); }
    finally { if (!closed) { byId('survey-refresh').disabled = false; controls(); } }
  }

  async function pollJob() {
    if (!activeJob || closed) return;
    if (++jobAttempts > 900) {
      activeJob = null;
      busy = false;
      feedback('Status polling stopped after 30 minutes. Refresh saved results to check completion.', true);
      controls();
      return;
    }
    try {
      const job = await request(`/api/surveys/jobs/${encodeURIComponent(activeJob)}`);
      if (closed) return;
      if (job.status === 'completed') {
        activeJob = null;
        busy = false;
        await refresh(job.output || {});
        feedback('Processing complete. Saved results are ready.');
        controls();
        return;
      }
      if (['failed', 'cancelled'].includes(job.status)) {
        activeJob = null;
        busy = false;
        await refresh(job.output || {});
        feedback(`Processing ${job.status}${job.stage ? ` during ${job.stage}` : ''}. ${job.error || 'See saved results for completed stages.'}`, true);
        controls();
        return;
      }
      feedback(`Processing ${job.stage ? job.stage.replaceAll('_', ' ') : 'recording'}…`);
    } catch (error) {
      if (!closed) feedback(`Status temporarily unavailable. ${error.message} Retrying.`, true);
    }
    if (!closed && activeJob) pollingJob = setTimeout(pollJob, 2000);
  }

  async function refreshSitl() {
    if (closed) return;
    const sequence = ++sitlRequest;
    try {
      const state = await request('/api/sitl/status');
      if (closed || sequence !== sitlRequest) return;
      availableSitl = state.available === true;
      if (availableSitl) {
        byId('survey-sitl-state').textContent = `Simulation · ${String(state.state || 'unknown').replaceAll('_', ' ')} · depth ${numberText(state.depth_m, 2)} m · forward ${numberText(state.forward_speed_mps, 2)} m/s`;
        const eventLabels = { command_received: 'Command received', forward_motion_stopped: 'Forward motion stopped', surface_reached: 'Surface reached' };
        byId('survey-sitl-events').replaceChildren(...(Array.isArray(state.events) ? state.events : []).map(name => {
          const li = document.createElement('li');
          li.textContent = eventLabels[name] || String(name).replaceAll('_', ' ');
          return li;
        }));
      } else {
        byId('survey-sitl-state').textContent = state.reason || 'Depth simulator unavailable. Start the local SITL receiver to test surfacing.';
        byId('survey-sitl-events').replaceChildren();
      }
    } catch (error) {
      if (!closed && sequence === sitlRequest) {
        availableSitl = false;
        byId('survey-sitl-state').textContent = `Depth simulator unavailable. ${error.message}`;
        byId('survey-sitl-events').replaceChildren();
      }
    } finally {
      if (!closed && sequence === sitlRequest) {
        controls();
        pollingSitl = setTimeout(refreshSitl, document.hidden ? 10000 : 3000);
      }
    }
  }

  byId('survey-run-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (busy) return;
    const accessToken = token();
    if (!accessToken) { feedback('Enter a control token in Vehicle interface before processing a recording.', true); return; }
    const body = { clip_id: byId('survey-clip').value, mode: byId('survey-mode').value };
    const tds = byId('survey-demo-tds').value.trim();
    if (tds) {
      const value = Number(tds);
      if (!Number.isFinite(value) || value < 0) { feedback('Simulated TDS must be a finite, nonnegative number.', true); return; }
      body.simulated_tds_ppm = value;
    }
    busy = true;
    controls();
    feedback('Starting recorded survey processing…');
    try {
      const job = await request('/api/surveys/analyze', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` }, body: JSON.stringify(body),
      });
      if (!job.id) throw new Error('The service did not return a processing job identifier.');
      activeJob = job.id;
      jobAttempts = 0;
      await pollJob();
    } catch (error) {
      if (!closed) { busy = false; feedback(error.message, true); controls(); }
    }
  });
  byId('survey-clip').addEventListener('change', controls);
  byId('survey-ecology-result').addEventListener('change', loadEcology);
  byId('survey-reconstruction-result').addEventListener('change', loadReconstruction);
  byId('survey-refresh').addEventListener('click', () => refresh());
  byId('survey-reset-cloud').addEventListener('click', () => cloudView?.reset());
  byId('survey-view-cloud').addEventListener('click', async () => {
    if (!selectedCloud) return;
    const url = selectedCloud;
    clearCloud();
    const sequence = cloudGeneration;
    cloudAbort = new AbortController();
    byId('survey-view-cloud').disabled = true;
    byId('survey-cloud-feedback').textContent = 'Loading reconstructed points…';
    try {
      const { createPointCloudView } = await import('./point-cloud-view.mjs');
      if (closed || sequence !== cloudGeneration) return;
      const view = await createPointCloudView(byId('survey-point-cloud'), url, { signal: cloudAbort.signal });
      if (closed || sequence !== cloudGeneration) { view.dispose(); return; }
      cloudView = view;
      byId('survey-reset-cloud').hidden = false;
      byId('survey-cloud-feedback').textContent = `${view.pointCount.toLocaleString()} reconstructed points · arbitrary scale. Drag to orbit, scroll to zoom, and use arrow keys to pan.`;
    } catch (error) {
      if (!closed && sequence === cloudGeneration) byId('survey-cloud-feedback').textContent = `3D view unavailable. ${error.message} The PLY download remains available.`;
    } finally {
      if (!closed && sequence === cloudGeneration) byId('survey-view-cloud').disabled = !selectedCloud;
    }
  });
  byId('survey-stop-surface').addEventListener('click', async () => {
    if (stopping || !availableSitl) return;
    const accessToken = token();
    if (!accessToken) return;
    stopping = true;
    controls();
    byId('survey-sitl-feedback').textContent = 'Requesting fin stop…';
    try {
      const stopped = await onStop();
      if (stopped?.status && stopped.status !== 'applied') throw new Error(`Fin stop ${stopped.status}. Check vehicle telemetry.`);
      byId('survey-sitl-feedback').textContent = 'Fin stop acknowledged. Requesting simulated ascent…';
      await request('/api/sitl/stop-and-surface', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` }, body: '{}',
      });
      byId('survey-sitl-feedback').textContent = 'Stop-and-surface accepted by the simulation. Follow depth and event status above.';
      clearTimeout(pollingSitl);
      await refreshSitl();
    } catch (error) { if (!closed) byId('survey-sitl-feedback').textContent = error.message; }
    finally { if (!closed) { stopping = false; controls(); } }
  });
  window.addEventListener('pagehide', () => {
    closed = true;
    assessment.dispose();
    if (scenarioCsvUrl) URL.revokeObjectURL(scenarioCsvUrl);
    clearTimeout(pollingJob);
    clearTimeout(pollingSitl);
    ++cloudGeneration;
    cloudAbort?.abort();
    cloudView?.dispose();
  }, { once: true });
  refresh();
  refreshSitl();
}
