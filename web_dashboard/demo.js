'use strict';
const { randomBytes } = require('node:crypto');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

async function assertPortAvailable(port) {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', error => reject(new Error('Demo needs free loopback port ' + port + ': ' + error.code)));
    probe.listen(port, '127.0.0.1', resolve);
  });
  await new Promise(resolve => probe.close(resolve));
}

async function prepareEnvironment() {
  const filename = path.join(__dirname, '.env');
  try {
    await fs.writeFile(filename, [
      'DEVICE_TOKEN=' + randomBytes(32).toString('hex'),
      'CONTROL_TOKEN=' + randomBytes(32).toString('hex'),
      'HOST=127.0.0.1', 'PORT=3000', 'ALLOW_SIMULATOR=1', '',
    ].join('\n'), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  process.loadEnvFile(filename);
  // The unified demonstration always binds to loopback and explicitly enables simulation.
  process.env.HOST = '127.0.0.1';
  process.env.ALLOW_SIMULATOR = '1';
}

async function startDemo() {
  let backend, simulator, python, stopping;
  let pythonExited = false;
  let pythonFailure = null;
  async function stop() {
    if (stopping) return stopping;
    stopping = (async () => {
      await Promise.allSettled([
        simulator ? simulator.stop() : Promise.resolve(),
        backend ? backend.shutdown() : Promise.resolve(),
      ]);
      if (python && !pythonExited) {
        const exited = new Promise(resolve => python.once('exit', resolve));
        python.kill();
        await Promise.race([exited, delay(3000)]);
        if (!pythonExited) python.kill('SIGKILL');
      }
    })();
    return stopping;
  }
  try {
    await prepareEnvironment();
    const port = Number(process.env.PORT || 3000);
    const sitlPort = Number(process.env.SITL_PORT || 8765);
    if (![port, sitlPort].every(value => Number.isInteger(value) && value > 0 && value <= 65535)) {
      throw new Error('PORT and SITL_PORT must be integers from 1 to 65535');
    }
    const ports = [port, sitlPort, 8080, 8081];
    if (new Set(ports).size !== ports.length) throw new Error('Dashboard, SITL and camera ports must be distinct');
    const root = path.resolve(__dirname, '..');
    const pythonPath = path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    await fs.access(pythonPath).catch(() => { throw new Error('Project Python environment missing. Create .venv with the documented offline uv setup.'); });
    // Resolve dependencies before starting any owned process.
    require.resolve('ws');
    for (const file of ['three/build/three.module.js', 'maplibre-gl/dist/maplibre-gl.mjs']) {
      await fs.access(path.join(__dirname, 'node_modules', file));
    }
    const { createServer } = require('./server');
    const { startSimulator } = require('./simulator');
    backend = createServer({
      deviceToken: process.env.DEVICE_TOKEN, controlToken: process.env.CONTROL_TOKEN,
      robotId: process.env.ROBOT_ID || 'manta-01', allowSimulator: true, demoAccess: true,
      sitlEnabled: true, sitlUrl: 'http://127.0.0.1:' + sitlPort,
    });
    for (const candidate of ports) await assertPortAvailable(candidate);
    python = spawn(pythonPath, ['-m', 'manta_ray.connectivity', '--port', String(sitlPort)], {
      cwd: root, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
    });
    python.on('error', error => { pythonFailure = error; pythonExited = true; });
    python.on('exit', (code, signal) => {
      pythonExited = true;
      pythonFailure = new Error('SITL process exited (' + (signal || code) + ')');
      if (simulator && !stopping) {
        console.error('SITL process stopped. Shutting down the demonstration.');
        stop().then(() => { process.exitCode = 1; });
      }
    });
    // Drain diagnostics without logging environment values or accumulating unbounded output.
    python.stderr.on('data', () => {});
    let ready = false;
    for (let attempt = 0; attempt < 50 && !ready; attempt++) {
      if (pythonFailure) throw pythonFailure;
      try {
        const response = await fetch('http://127.0.0.1:' + sitlPort + '/status', { signal: AbortSignal.timeout(300) });
        const status = await response.json();
        ready = response.ok && status.state === 'surveying' && status.depth_m === 2;
      } catch {}
      if (!ready) await delay(100);
    }
    if (!ready) throw new Error('SITL receiver failed to become ready');
    await new Promise((resolve, reject) => {
      backend.once('error', reject);
      backend.listen(port, '127.0.0.1', resolve);
    });
    backend.on('error', error => {
      console.error('Dashboard server failed: ' + error.code);
      stop().then(() => { process.exitCode = 1; });
    });
    simulator = startSimulator({
      url: 'ws://127.0.0.1:' + port + '/ws/device',
      token: process.env.DEVICE_TOKEN, robotId: process.env.ROBOT_ID || 'manta-01',
      camera: true, cameraHost: '127.0.0.1',
      onEvent: event => {
        if (event.type === 'camera_error') {
          console.error('Simulator camera failed. Shutting down the demonstration.');
          stop().then(() => { process.exitCode = 1; });
        }
      },
    });
    console.log('Manta Ray SIMULATION: http://127.0.0.1:' + port);
    console.log('Synthetic motion, test-card camera and separate simulated depth model are running.');
    console.log('Local demo authorization is automatic. Use Enable controls before requesting motion.');
    return { stop, port, sitlPort };
  } catch (error) {
    await stop();
    throw error;
  }
}

if (require.main === module) {
  let demo;
  let interrupted = false;
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, async () => {
      interrupted = true;
      if (demo) await demo.stop();
    });
  }
  startDemo().then(async value => {
    demo = value;
    if (interrupted) await demo.stop();
  }).catch(error => {
    console.error('Cannot start Manta Ray demo: ' + error.message);
    process.exitCode = 1;
  });
}

module.exports = { startDemo };
