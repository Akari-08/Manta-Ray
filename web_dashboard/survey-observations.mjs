export function withSimulatedTds(rows, generated) {
  const samples = new Map();
  for (const sample of generated) {
    if (!Number.isFinite(sample.timestamp_s) || !Number.isFinite(sample.value) || sample.value < 0 || sample.source !== 'simulated') {
      throw new Error('Invalid simulated TDS observation');
    }
    samples.set(sample.timestamp_s, sample);
  }
  return rows.map(row => {
    const sample = samples.get(row.timestamp_s);
    if (!sample || row.tds_source === 'measured') return { ...row };
    return { ...row, tds_ppm: sample.value, simulated_tds_ppm: sample.value,
      tds_source: 'simulated', tds_method: sample.method,
      tds_sample_timestamp_s: sample.timestamp_s, tds_time_offset_s: 0,
      tds_calibration_id: null, tds_temperature_c: null, tds_comparison: 'simulation_scenario' };
  });
}

export function observationsCsv(rows) {
  if (!rows.length) return '';
  const columns = Object.keys(rows[0]);
  const cell = value => {
    if (value === null || value === undefined) return '""';
    let text = String(value);
    if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = "'" + text;
    return '"' + text.replaceAll('"', '""') + '"';
  };
  return [columns.map(cell).join(','), ...rows.map(row => columns.map(key => cell(row[key])).join(','))].join('\r\n') + '\r\n';
}
