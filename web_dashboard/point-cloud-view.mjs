import * as THREE from '/vendor/three.module.js';
import { PLYLoader } from '/vendor/PLYLoader.js';
import { OrbitControls } from '/vendor/OrbitControls.js';

export async function createPointCloudView(stage, url, { signal } = {}) {
  const timeout = AbortSignal.timeout(45000);
  const activeSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const response = await fetch(url, { cache: 'no-store', signal: activeSignal });
  if (!response.ok) throw new Error(`Point cloud request failed (${response.status}).`);
  const maximumBytes = 64 * 1024 * 1024;
  const length = Number(response.headers.get('Content-Length'));
  if (length > maximumBytes) throw new Error('Point cloud exceeds the 64 MB browser limit. Download the PLY for a desktop viewer.');
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > maximumBytes) throw new Error('Point cloud exceeds the 64 MB browser limit.');
  const geometry = new PLYLoader().parse(bytes);
  const positions = geometry.getAttribute('position');
  if (!positions || !positions.count) { geometry.dispose(); throw new Error('The file contains no reconstructed points.'); }
  for (let index = 0; index < positions.array.length; index++) {
    if (!Number.isFinite(positions.array[index])) { geometry.dispose(); throw new Error('The file contains nonfinite point coordinates.'); }
  }
  geometry.computeBoundingSphere();
  const { center, radius } = geometry.boundingSphere;
  if (!Number.isFinite(radius) || radius <= 0) { geometry.dispose(); throw new Error('The point cloud has no spatial extent.'); }
  geometry.translate(-center.x, -center.y, -center.z);
  geometry.scale(1 / radius, 1 / radius, 1 / radius);
  let renderer;
  try { renderer = new THREE.WebGLRenderer({ antialias: true }); }
  catch { geometry.dispose(); throw new Error('WebGL is unavailable in this browser.'); }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x0a1915, 1);
  renderer.domElement.setAttribute('aria-label', 'Reconstructed lakebed point cloud');
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
  const material = new THREE.PointsMaterial({
    size: 0.012, sizeAttenuation: true, vertexColors: geometry.hasAttribute('color'),
    color: geometry.hasAttribute('color') ? 0xffffff : 0xcae998,
  });
  const cloud = new THREE.Points(geometry, material);
  scene.add(cloud);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.minDistance = 0.05;
  controls.maxDistance = 30;
  controls.listenToKeyEvents(stage);
  function reset() {
    camera.position.set(1.8, 1.2, 2.4);
    controls.target.set(0, 0, 0);
    controls.update();
    controls.saveState();
  }
  reset();
  stage.replaceChildren(renderer.domElement);
  let disposed = false;
  let frame;
  let width = 0;
  let height = 0;
  function draw() {
    if (disposed) return;
    if (stage.clientWidth !== width || stage.clientHeight !== height) {
      width = stage.clientWidth;
      height = stage.clientHeight;
      if (width && height) {
        renderer.setSize(width, height, false);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
      }
    }
    if (!document.hidden && width && height) { controls.update(); renderer.render(scene, camera); }
    frame = requestAnimationFrame(draw);
  }
  draw();
  return {
    pointCount: positions.count,
    reset,
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(frame);
      controls.dispose();
      geometry.dispose();
      material.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
