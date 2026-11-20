(function (root) {
  'use strict';
  const fields = ['frame_id', 'point_id', 'timestamp_s', 'image', 'x_px', 'y_px', 'suggested_label', 'label', 'reviewer', 'sampling_unit', 'bottom_confirmed', 'source'];
  function createReview(plan) {
    const rows = plan.frames.flatMap(frame => frame.points.map(point => ({
      frame_id: frame.frame_id, point_id: point.point_id, timestamp_s: frame.timestamp_s,
      image: frame.image, x_px: point.x_px, y_px: point.y_px, suggested_label: point.suggested_label,
      label: '', reviewer: '', sampling_unit: '', bottom_confirmed: 'false', source: 'measured',
    })));
    const lookup = new Map(rows.map(row => [row.frame_id + ':' + row.point_id, row]));
    return {
      rows,
      label(frameId, pointId, label) {
        const row = lookup.get(frameId + ':' + pointId);
        if (!row || !plan.classes.includes(label)) throw new Error('Unknown point or class');
        row.label = label;
      },
      metadata(frameId, metadata) {
        if (!['measured', 'simulated'].includes(metadata.source) || !['true', 'false'].includes(metadata.bottom_confirmed)) throw new Error('Invalid source or bottom declaration');
        for (const row of rows.filter(item => item.frame_id === frameId)) {
          for (const key of ['reviewer', 'sampling_unit', 'bottom_confirmed', 'source']) row[key] = String(metadata[key] || '');
        }
      },
      progress() { return { labeled: rows.filter(row => plan.classes.includes(row.label)).length, total: rows.length }; },
      csv() {
        const escape = value => {
          let text = String(value ?? '');
          if (/^[\s]*[=+\-@]/.test(text)) text = "'" + text;
          return /[",\n\r]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text;
        };
        return fields.join(',') + '\r\n' + rows.map(row => fields.map(key => escape(row[key])).join(',')).join('\r\n') + '\r\n';
      },
    };
  }

  function mount(document, plan) {
    const state = createReview(plan);
    const byId = id => document.getElementById(id);
    let frameIndex = 0, pointIndex = 0, imageGeneration = 0;
    const canvas = byId('image'), context = canvas.getContext('2d');
    let image = null;
    function saveMetadata() {
      const frame = plan.frames[frameIndex];
      if (frame) state.metadata(frame.frame_id, {
        reviewer: byId('reviewer').value, sampling_unit: byId('unit').value,
        bottom_confirmed: String(byId('bottom').checked), source: byId('source').value,
      });
    }
    function draw() {
      context.clearRect(0, 0, 320, 320);
      if (image) context.drawImage(image, 0, 0, 320, 320);
      const frame = plan.frames[frameIndex];
      frame.points.forEach((point, index) => {
        const row = state.rows.find(item => item.frame_id === frame.frame_id && item.point_id === point.point_id);
        context.strokeStyle = index === pointIndex ? '#ff5533' : row.label ? '#55ff88' : '#ffffff';
        context.lineWidth = index === pointIndex ? 2 : 1;
        context.beginPath(); context.arc(point.x_px, point.y_px, index === pointIndex ? 6 : 2, 0, 2 * Math.PI); context.stroke();
      });
      const point = frame.points[pointIndex];
      const row = state.rows.find(item => item.frame_id === frame.frame_id && item.point_id === point.point_id);
      byId('point').textContent = `Point ${pointIndex + 1}/${frame.points.length} · pixel ${point.x_px}, ${point.y_px} · label: ${row.label || 'unlabeled'}`;
      byId('hint').textContent = byId('hints').checked ? `Unvalidated color hint: ${point.suggested_label}` : '';
      const progress = state.progress();
      byId('progress').textContent = `${progress.labeled}/${progress.total} points labeled. Draft CSVs may be saved; packaging requires every point and frame metadata.`;
    }
    function showFrame() {
      const frame = plan.frames[frameIndex];
      const row = state.rows.find(item => item.frame_id === frame.frame_id);
      pointIndex = 0; image = null;
      byId('frame').value = String(frameIndex);
      byId('reviewer').value = row.reviewer;
      byId('unit').value = row.sampling_unit;
      byId('bottom').checked = row.bottom_confirmed === 'true';
      byId('source').value = row.source;
      byId('quality').textContent = `Time ${frame.timestamp_s.toFixed(3)} s · automatic quality: ${frame.quality_status}. Rejected frames remain excluded from cover calculations.`;
      const generation = ++imageGeneration, next = new Image();
      next.onload = () => { if (generation === imageGeneration) { image = next; draw(); } };
      next.onerror = () => { if (generation === imageGeneration) byId('quality').textContent = 'Image unavailable. Extract the entire bundle and preserve its review/ folder.'; };
      next.src = frame.image;
      draw();
    }
    for (const [index, frame] of plan.frames.entries()) {
      const option = document.createElement('option'); option.value = String(index); option.textContent = frame.frame_id;
      byId('frame').append(option);
    }
    for (const label of plan.classes) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = label.replaceAll('_', ' ');
      button.addEventListener('click', () => {
        const frame = plan.frames[frameIndex]; saveMetadata();
        state.label(frame.frame_id, frame.points[pointIndex].point_id, label);
        if (pointIndex < frame.points.length - 1) ++pointIndex;
        draw();
      });
      byId('labels').append(button);
    }
    byId('frame').addEventListener('change', () => { saveMetadata(); frameIndex = Number(byId('frame').value); showFrame(); });
    for (const id of ['reviewer', 'unit', 'bottom', 'source']) byId(id).addEventListener('input', saveMetadata);
    byId('hints').addEventListener('change', draw);
    byId('previous').addEventListener('click', () => { pointIndex = Math.max(0, pointIndex - 1); draw(); });
    byId('next').addEventListener('click', () => { pointIndex = Math.min(plan.frames[frameIndex].points.length - 1, pointIndex + 1); draw(); });
    canvas.addEventListener('click', event => {
      const rect = canvas.getBoundingClientRect(), x = (event.clientX - rect.left) * 320 / rect.width, y = (event.clientY - rect.top) * 320 / rect.height;
      const points = plan.frames[frameIndex].points;
      pointIndex = points.reduce((best, point, index) => Math.hypot(point.x_px - x, point.y_px - y) < Math.hypot(points[best].x_px - x, points[best].y_px - y) ? index : best, 0);
      draw();
    });
    byId('download').addEventListener('click', () => {
      saveMetadata();
      const url = URL.createObjectURL(new Blob([state.csv()], { type: 'text/csv;charset=utf-8' }));
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'review-points.csv'; anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    if (plan.frames.length && plan.frames[0].points.length) showFrame();
    else byId('progress').textContent = 'No eligible points were exported.';
    return state;
  }
  const api = { createReview, mount };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.PointReview = api; mount(document, JSON.parse(document.getElementById('point-plan').textContent)); }
})(typeof globalThis !== 'undefined' ? globalThis : this);
