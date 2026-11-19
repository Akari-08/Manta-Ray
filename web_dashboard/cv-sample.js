'use strict';
// Computer-side CV integration point. Saves one real/simulated JPEG and provenance.
// A calibrated worker may POST /api/cv/result; this sampler invents no CV result.
const { mkdir, writeFile } = require('node:fs/promises');
const path = require('node:path');
async function main() {
  try { process.loadEnvFile(path.join(__dirname, '.env')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const base = `http://${process.env.HOST || '127.0.0.1'}:${process.env.PORT || 3000}`;
  const response = await fetch(`${base}/api/camera/frame`, { signal: AbortSignal.timeout(4000) });
  if (!response.ok) throw new Error(await response.text());
  const metadata = JSON.parse(response.headers.get('x-frame-metadata'));
  const directory = path.resolve(__dirname, '../outputs/live-camera'); await mkdir(directory, { recursive: true });
  // One bounded latest-frame slot. Copy elsewhere explicitly when collecting a dataset.
  await writeFile(path.join(directory, 'latest.jpg'), Buffer.from(await response.arrayBuffer()));
  await writeFile(path.join(directory, 'latest.json'), JSON.stringify({ ...metadata, confidence: null, vegetation_cover_pct: null, reason: 'No calibrated live CV model configured' }, null, 2));
  console.log(`Saved ${metadata.source} JPEG and timestamps in ${directory}`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
