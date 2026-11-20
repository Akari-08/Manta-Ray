import * as THREE from '/vendor/three.module.js';
import { createMotionTracker, finAngles } from './motion-model.mjs';

export function createFishView(stage, badge, readout) {
  let renderer;
  try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }); }
  catch { badge.textContent = '3D UNAVAILABLE'; readout.textContent = 'WebGL is unavailable in this browser.'; return { update() {} }; }
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.setClearColor(0x0a1915, 1); stage.append(renderer.domElement);
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
  camera.position.set(5.2, 3.2, 6.2); camera.lookAt(0, 0, 0);
  scene.add(new THREE.HemisphereLight(0xe5ffd3, 0x1c3b30, 2));
  const light = new THREE.DirectionalLight(0xf3f9df, 2); light.position.set(4, 7, 3); scene.add(light);
  const grid = new THREE.GridHelper(8, 16, 0x355548, 0x203a30); grid.position.y = -1.35; scene.add(grid);
  const fish = new THREE.Group(); scene.add(fish);
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x8eaf81, roughness: 0.62, metalness: 0.06 });
  const finMat = new THREE.MeshStandardMaterial({ color: 0xb8d5a0, roughness: 0.7, side: THREE.DoubleSide });
  const eyeMat = new THREE.MeshStandardMaterial({ color: 0x0b1c19 });
  const sphere = new THREE.SphereGeometry(1, 24, 16);
  const body = new THREE.Mesh(sphere, bodyMat); body.scale.set(1.45, 0.48, 0.54); fish.add(body);
  const nose = new THREE.Mesh(sphere, bodyMat); nose.position.set(1.1, -0.02, 0); nose.scale.set(0.5, 0.31, 0.37); fish.add(nose);
  for (const side of [-1, 1]) { const eye = new THREE.Mesh(sphere, eyeMat); eye.scale.setScalar(0.08); eye.position.set(1.18, 0.15, side * 0.32); fish.add(eye); }
  function triangle(points, material) {
    const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(points.flat(), 3)); geometry.computeVertexNormals();
    return new THREE.Mesh(geometry, material);
  }
  const tail = triangle([[-1.15, 0, 0], [-2.0, 0.55, 0], [-2.0, -0.55, 0]], finMat); fish.add(tail);
  const dorsal = triangle([[-0.6, 0.35, 0], [-0.1, 1.0, 0], [0.35, 0.4, 0]], finMat); fish.add(dorsal);
  function fin(side) {
    const pivot = new THREE.Group(); pivot.position.set(0.1, 0, side * 0.38);
    pivot.add(triangle([[0.45, 0, 0], [-0.45, 0, 0], [-0.8, 0, side * 1.1], [0.45, 0, 0], [-0.8, 0, side * 1.1], [0.1, 0, side * 1.25]], finMat));
    fish.add(pivot); return pivot;
  }
  const left = fin(1), right = fin(-1);
  const arrow = new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0.65, 0), 1, 0x80cee1, 0.22, 0.12); fish.add(arrow); arrow.visible = false;
  const tracker = createMotionTracker(); let current = { live: false }, lastWidth = 0, lastHeight = 0;
  function update(state, connected) {
    current = tracker.update(state, connected);
    if (!current.live) { badge.textContent = 'STALE / NO DATA'; readout.textContent = 'No fresh telemetry. Model frozen; motion is unknown.'; arrow.visible = false; return; }
    badge.textContent = current.roll === null || current.pitch === null ? 'IMU UNAVAILABLE' : current.simulated ? 'SIMULATED' : 'LIVE ESTIMATE';
    const fmt = n => n === null ? 'unavailable' : `${n.toFixed(1)}°`;
    const mag = current.acceleration ? Math.hypot(...current.acceleration) : null;
    readout.textContent = `Roll ${fmt(current.roll)} · pitch ${fmt(current.pitch)} · ${current.robloxImu ? 'Roblox simulated yaw' : 'relative Z gyro rotation'} ${fmt(current.yaw)}${current.robloxImu ? '' : ' (drifts)'} · acceleration ${mag === null ? 'unavailable' : `${mag.toFixed(2)} m/s² including gravity`} · fins ${finAngles(current.control, 0).mode}.`;
    if (current.roll !== null && current.pitch !== null) fish.rotation.set(THREE.MathUtils.degToRad(current.roll), THREE.MathUtils.degToRad(current.yaw || 0), THREE.MathUtils.degToRad(current.pitch), 'YZX');
    else fish.rotation.set(0, 0, 0);
    if (current.acceleration && mag > 0.001) {
      const [x, y, z] = current.acceleration;
      arrow.setDirection(new THREE.Vector3(x, z, y).normalize()); arrow.setLength(Math.min(2.5, mag / 9.81), 0.2, 0.11); arrow.visible = true;
    } else arrow.visible = false;
  }
  function draw(now) {
    const width = stage.clientWidth, height = stage.clientHeight;
    if (width && height && (width !== lastWidth || height !== lastHeight)) { renderer.setSize(width, height, false); camera.aspect = width / height; camera.updateProjectionMatrix(); lastWidth = width; lastHeight = height; }
    if (current.live) {
      const angles = finAngles(current.control, now / 1000);
      left.rotation.x += (THREE.MathUtils.degToRad(angles.left) - left.rotation.x) * 0.22;
      right.rotation.x += (THREE.MathUtils.degToRad(angles.right) - right.rotation.x) * 0.22;
    }
    renderer.render(scene, camera); requestAnimationFrame(draw);
  }
  requestAnimationFrame(draw);
  return { update };
}
