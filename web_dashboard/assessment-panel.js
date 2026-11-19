const element = id => document.getElementById(id);
const title = value => String(value).replaceAll('_', ' ');
const researchMetadataFields = ['site_id', 'period', 'context'];

function researchMetadata(input) {
  return Object.fromEntries(researchMetadataFields.filter(key => Object.hasOwn(input, key)).map(key => [key, input[key]]));
}

async function fetchAssessment(url, options = {}) {
  const response = await fetch(url, { cache: 'no-store', ...options, signal: AbortSignal.timeout(15000) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || data.reason || `Assessment request failed (${response.status}).`);
  return data;
}

function textBlock(tag, text) {
  const node = document.createElement(tag);
  node.textContent = text;
  return node;
}

function valuesList(data, target, prefix = '') {
  if (!data || typeof data !== 'object') return;
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || key === 'label') continue;
    const name = prefix ? `${prefix} · ${title(key)}` : title(key);
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      valuesList(value, target, name);
    } else {
      const row = document.createElement('div');
      const formatted = typeof value === 'number' ? new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 }).format(value) :
        value === null ? 'Unavailable' : Array.isArray(value) ? JSON.stringify(value) : String(value);
      const displayName = name === 'imagery · vegetation validation' ? 'Plant-cover validation' : name;
      const displayValue = name === 'imagery · vegetation validation' && value === 'independent labels required'
        ? 'Not yet validated against independently labeled images.' : formatted;
      row.append(textBlock('dt', displayName), textBlock('dd', displayValue));
      target.append(row);
    }
  }
}

function evidenceSection(target, heading, content) {
  if (content === undefined || content === null) return;
  const section = document.createElement('section');
  section.append(textBlock('h5', heading));
  if (Array.isArray(content)) {
    if (!content.length) section.append(textBlock('p', 'None recorded.'));
    for (const item of content) {
      if (typeof item === 'string') section.append(textBlock('p', item));
      else {
        const list = document.createElement('dl');
        list.className = 'assessment-values';
        valuesList(item, list);
        section.append(list);
      }
    }
  } else if (typeof content === 'object') {
    const list = document.createElement('dl');
    list.className = 'assessment-values';
    valuesList(content, list);
    section.append(list);
  } else section.append(textBlock('p', String(content)));
  target.append(section);
}

function renderReport(payload) {
  const report = payload.assessment || payload;
  element('assessment-report').hidden = false;
  element('assessment-status').textContent = title(report.status || 'unavailable');
  element('assessment-origin').textContent = report.scenario ?
    `SIMULATED SCENARIO · ${title(report.data_origin || 'simulated')} inputs` :
    `${title(report.data_origin || 'none')} inputs · ${report.method_name || 'Assessment'}`;
  element('assessment-origin').dataset.scenario = String(!!report.scenario);
  const result = report.result || {};
  const parts = [result.label || report.method_name, typeof result.score === 'number' ? new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(result.score) : null, result.category ? title(result.category) : null];
  element('assessment-result').textContent = parts.filter(Boolean).join(' · ');
  element('assessment-values').replaceChildren();
  const summaryValues = Object.fromEntries(Object.entries(result).filter(([key]) =>
    !['tds_observations', 'tests', 'objectives'].includes(key) &&
    !(key === 'score' && report.method_id === 'camera_tds')));
  valuesList(summaryValues, element('assessment-values'));
  const evidence = element('assessment-evidence');
  evidence.replaceChildren();
  for (const [heading, value] of [
    ['Input summary', report.input_summary], ['Components', report.components],
    ['Calculation steps', report.steps], ['Excluded inputs', report.excluded_inputs],
    ['Missing inputs', report.missing_inputs], ['Assumptions', report.assumptions],
    ['Limitations', report.limitations], ['Recommendations', report.recommendations],
  ]) evidenceSection(evidence, heading, value);
  evidenceSection(evidence, 'Method record', { engine_version: report.engine_version, input_sha256: report.input_sha256 });
  const downloads = element('assessment-downloads');
  downloads.replaceChildren();
  for (const [label, href] of [['DOWNLOAD ASSESSMENT', payload.report_url], ['DOWNLOAD INPUTS', payload.request_url]]) {
    if (!href) continue;
    try {
      const url = new URL(href, location.origin);
      if (url.origin !== location.origin || !['http:', 'https:'].includes(url.protocol)) continue;
      const anchor = textBlock('a', label);
      anchor.href = url.href;
      anchor.download = '';
      downloads.append(anchor);
    } catch {}
  }
}

export function initAssessmentPanel({ token, onReport = () => {} }) {
  let selected = null;
  let methods = [];
  let generation = 0;
  let disposed = false;
  let calculating = false;
  const feedback = message => { element('assessment-feedback').textContent = message; };

  function controls() {
    element('assessment-calculate').disabled = calculating || !selected || !methods.length;
    const camera = element('assessment-method').value === 'camera_tds';
    element('assessment-tds-controls').hidden = !camera;
    element('assessment-tds-options').hidden = !element('assessment-simulate-tds').checked;
  }

  function invalidate() {
    ++generation;
    calculating = false;
    element('assessment-report').hidden = true;
    element('assessment-status').textContent = 'Ready to calculate';
    controls();
  }

  async function calculate() {
    if (!selected || !methods.length || disposed) return;
    const method = element('assessment-method').value;
    const current = ++generation;
    const id = selected;
    calculating = true;
    controls();
    feedback('Calculating assessment…');
    element('assessment-status').textContent = 'Calculating';
    element('assessment-report').hidden = true;
    try {
      let payload;
      const url = `/api/surveys/ecology/${encodeURIComponent(id)}/assessment`;
      const input = JSON.parse(element('assessment-inputs').value);
      if (!input || Array.isArray(input) || typeof input !== 'object') throw new Error('Research inputs must be a JSON object.');
      if (!Array.isArray(input.measurements || []) || !Array.isArray(input.objectives || [])) throw new Error('Measurements and objectives must be JSON arrays.');
      const metadata = researchMetadata(input);
      const hasMetadata = Object.values(metadata).some(value => value !== null && value !== undefined &&
        (typeof value !== 'string' || value.trim().length > 0));
      const hasResearchInputs = (input.measurements?.length || input.objectives?.length || input.tds_reference || hasMetadata);
      const customSimulation = element('assessment-simulate-tds').checked &&
        (Number(element('assessment-seed').value) !== 42 || Number(element('assessment-baseline').value) !== 150 || Number(element('assessment-variation').value) !== 10);
      if (!token() && !hasResearchInputs && !customSimulation) {
        const query = new URLSearchParams({ method });
        if (element('assessment-include-simulated').checked) query.set('include_simulated', '1');
        if (method === 'camera_tds' && element('assessment-simulate-tds').checked) {
          if (!element('assessment-include-simulated').checked) throw new Error('Enable the simulated scenario checkbox to include generated TDS.');
          query.set('simulate_tds', '1');
        }
        payload = await fetchAssessment(`${url}?${query}`);
      } else {
        const accessToken = token();
        if (!accessToken) throw new Error('Enter a control token in Vehicle interface to calculate with research inputs or custom simulation settings.');
        const include = element('assessment-include-simulated').checked;
        const body = { ...metadata, method, include_simulated: include, measurements: input.measurements || [], objectives: input.objectives || [] };
        if (input.tds_reference) body.tds_reference = input.tds_reference;
        if (method === 'camera_tds' && element('assessment-simulate-tds').checked) {
          if (!include) throw new Error('Enable the simulated scenario checkbox to include generated TDS.');
          const seed = Number(element('assessment-seed').value);
          const baseline = Number(element('assessment-baseline').value);
          const variation = Number(element('assessment-variation').value);
          if (!Number.isSafeInteger(seed) || seed < 0 || seed > 4294967295 || !Number.isFinite(baseline) || baseline < 0 || !Number.isFinite(variation) || variation < 0) {
            throw new Error('Simulation requires an integer seed and finite nonnegative baseline and variation.');
          }
          body.simulate_tds = { seed, baseline_ppm: baseline, variation_ppm: variation };
        }
        payload = await fetchAssessment(url, {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` }, body: JSON.stringify(body),
        });
      }
      if (disposed || current !== generation || selected !== id) return;
      renderReport(payload);
      onReport(payload.assessment || payload);
      feedback('Assessment calculated. Expand the trace to review inputs and exclusions.');
    } catch (error) {
      if (!disposed && current === generation) {
        element('assessment-status').textContent = 'Calculation unavailable';
        feedback(error.message);
      }
    } finally {
      if (!disposed && current === generation) { calculating = false; controls(); }
    }
  }

  function methodChanged() {
    invalidate();
    const method = methods.find(item => item.id === element('assessment-method').value);
    element('assessment-description').textContent = method ? `${method.scope} · ${method.description}` : '';
    element('assessment-required').textContent = method ? `Required inputs — ${Array.isArray(method.required_inputs) ? method.required_inputs.join(', ') : method.required_inputs}` : '';
    const sources = element('assessment-sources');
    sources.replaceChildren();
    for (const [index, href] of (method?.reference_urls || []).entries()) {
      try {
        const url = new URL(href);
        if (url.protocol !== 'https:') continue;
        const anchor = textBlock('a', `Method reference ${index + 1}`);
        anchor.href = url.href;
        anchor.target = '_blank';
        anchor.rel = 'noopener noreferrer';
        sources.append(anchor);
      } catch {}
    }
    feedback(selected ? 'Choose inputs and calculate the selected method.' : 'Select a saved image analysis.');
    if (selected) calculate();
  }

  element('assessment-method').addEventListener('change', methodChanged);
  element('assessment-form').addEventListener('submit', event => { event.preventDefault(); calculate(); });
  for (const id of ['assessment-include-simulated', 'assessment-simulate-tds', 'assessment-seed', 'assessment-baseline', 'assessment-variation', 'assessment-inputs']) {
    element(id).addEventListener('input', invalidate);
  }
  element('assessment-example').addEventListener('click', () => {
    const method = methods.find(item => item.id === element('assessment-method').value);
    const example = method?.example || {};
    element('assessment-inputs').value = JSON.stringify({
      ...researchMetadata(example),
      measurements: example.measurements || [], objectives: example.objectives || [],
      ...(example.tds_reference ? { tds_reference: example.tds_reference } : {}),
    }, null, 2);
    // Loading sample values does not authorize their inclusion in a computed scenario.
    element('assessment-include-simulated').checked = false;
    invalidate();
    feedback('Simulated example loaded. Review the JSON and explicitly enable simulated inputs to calculate a scenario.');
  });

  fetchAssessment('/api/ecology/methods').then(data => {
    if (disposed) return;
    methods = Array.isArray(data) ? data : data.methods || [];
    const select = element('assessment-method');
    select.replaceChildren(...methods.map(item => {
      const option = textBlock('option', item.name);
      option.value = item.id;
      return option;
    }));
    select.disabled = !methods.length;
    if (methods.some(item => item.id === 'camera_tds')) select.value = 'camera_tds';
    methodChanged();
  }).catch(error => { if (!disposed) feedback(error.message); });

  return {
    selectSurvey(id, detail) {
      selected = id || null;
      invalidate();
      if (!selected) { feedback('Select a saved image analysis.'); return; }
      const type = detail?.summary?.source?.type || 'unknown';
      const simulated = type === 'stock' || type === 'unknown' || type === 'synthetic';
      element('assessment-simulate-tds').checked = simulated;
      element('assessment-include-simulated').checked = simulated;
      controls();
      if (methods.length) {
        calculate();
      }
    },
    dispose() { disposed = true; ++generation; },
  };
}
