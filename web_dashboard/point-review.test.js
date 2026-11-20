'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createReview } = require('../manta_ray/ecology/point_review.js');
const plan = { classes: ['macrophyte', 'rock', 'unknown'], frames: [
  { frame_id: 'A', timestamp_s: 0, image: 'review/a.png', points: [{ point_id: 1, x_px: 10, y_px: 20, suggested_label: 'green_candidate' }, { point_id: 2, x_px: 15, y_px: 30, suggested_label: 'not_green_candidate' }] },
  { frame_id: 'B', timestamp_s: 1, image: 'review/b.png', points: [{ point_id: 1, x_px: 30, y_px: 40, suggested_label: 'green_candidate' }] },
] };
test('review state never promotes color hints to accepted biological labels', () => {
  const state = createReview(plan);
  assert.deepEqual(state.progress(), { labeled: 0, total: 3 });
  assert.ok(state.rows.every(row => row.label === ''));
  state.label('A', 1, 'unknown');
  assert.deepEqual(state.progress(), { labeled: 1, total: 3 });
  assert.throws(() => state.label('A', 1, 'green_candidate'));
  assert.throws(() => state.label('A', 3, 'rock'));
});
test('review metadata is frame-scoped and all planned points survive CSV export', () => {
  const state = createReview(plan);
  state.label('A', 1, 'macrophyte');
  state.metadata('A', { reviewer: 'Reviewer, A', sampling_unit: 'transect-1', bottom_confirmed: 'true', source: 'measured' });
  assert.equal(state.rows[1].reviewer, 'Reviewer, A');
  assert.equal(state.rows[2].reviewer, '');
  const csv = state.csv();
  assert.ok(csv.includes('"Reviewer, A"'));
  assert.equal(csv.trim().split('\r\n').length, 4);
  assert.ok(csv.includes('green_candidate,macrophyte'));
  assert.ok(csv.includes('not_green_candidate,,"Reviewer, A"'));
  assert.throws(() => state.metadata('A', { source: 'invented', bottom_confirmed: 'true' }));
});
test('CSV export neutralizes formula text without changing numeric coordinates', () => {
  const state = createReview(plan);
  state.metadata('A', { reviewer: '=SUM(A1)', sampling_unit: 'unit', bottom_confirmed: 'false', source: 'measured' });
  assert.ok(state.csv().includes("'=SUM(A1)"));
  assert.ok(state.csv().includes('A,1,0,review/a.png,10,20'));
});
