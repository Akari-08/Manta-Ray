const { test } = require('node:test');
const assert = require('node:assert/strict');

test('displayed and exported scenario values vary without altering measured data or saved rows', async () => {
  const { withSimulatedTds, observationsCsv } = await import('./survey-observations.mjs');
  const rows = [{timestamp_s:0,tds_ppm:150,tds_source:'simulated'},
    {timestamp_s:0.5,tds_ppm:201,tds_source:'measured'}, {timestamp_s:1,tds_ppm:150,tds_source:'simulated'}];
  const originals = structuredClone(rows);
  const values = [145.2,146.1,147.3].map((value,index)=>({timestamp_s:index/2,value,source:'simulated',method:'test profile'}));
  const displayed = withSimulatedTds(rows,values);
  assert.deepEqual(rows,originals);
  assert.deepEqual(displayed.map(row=>row.tds_ppm),[145.2,201,147.3]);
  assert.equal(displayed[1].tds_source,'measured');
  const csv = observationsCsv(displayed);
  assert.ok(csv.includes('145.2') && csv.includes('147.3') && csv.includes('201'));
  assert.ok(!csv.includes('"150"'));
  assert.throws(()=>withSimulatedTds(rows,[{timestamp_s:0,value:NaN,source:'simulated'}]));
});

test('CSV quotes text, preserves missing values and neutralizes spreadsheet formulas', async () => {
  const {observationsCsv}=await import('./survey-observations.mjs');
  const csv=observationsCsv([{sample:'a,"b"',value:null,note:'=1+1'}]);
  assert.ok(csv.includes('"a,""b"""'));
  assert.ok(csv.includes('""'));
  assert.ok(csv.includes('"\'=1+1"'));
});
