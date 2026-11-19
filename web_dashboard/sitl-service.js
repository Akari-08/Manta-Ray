'use strict';
const { isIP } = require('node:net');

function createSitlService({ baseUrl = 'http://127.0.0.1:8765', enabled = false, allowSimulator = false } = {}) {
  const endpoint = new URL(baseUrl);
  if (endpoint.protocol !== 'http:' || !isIP(endpoint.hostname) || !endpoint.hostname.startsWith('127.') ||
      endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/') {
    throw new Error('SITL URL must be a loopback http://127.x.x.x address');
  }
  const json = (res, code, payload) => {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ...payload, source: 'simulation', simulation: true }));
  };
  function status(data) {
    if (!data || !['surveying', 'surfacing', 'surfaced'].includes(data.state) ||
        !Number.isFinite(data.depth_m) || data.depth_m < 0 ||
        !Number.isFinite(data.forward_speed_mps) || data.forward_speed_mps < 0 ||
        !Array.isArray(data.events) || data.events.some(event => typeof event !== 'string')) {
      throw new Error('SITL returned invalid vehicle status');
    }
    return { state: data.state, depth_m: data.depth_m, forward_speed_mps: data.forward_speed_mps, events: data.events };
  }
  async function upstream(route, command = false) {
    const response = await fetch(new URL(route, endpoint), {
      method: command ? 'POST' : 'GET',
      ...(command ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command: 'STOP_AND_SURFACE' }) } : {}),
      signal: AbortSignal.timeout(2500), redirect: 'error',
    });
    if (!response.ok) throw new Error('SITL receiver rejected the request');
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 16384) throw new Error('SITL response exceeds size limit');
      chunks.push(Buffer.from(chunk));
    }
    return { code: response.status, data: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
  }
  return {
    async handle(req, res, url, { authorized = false, state } = {}) {
      if (!['/api/sitl/status', '/api/sitl/stop-and-surface'].includes(url.pathname)) return false;
      const command = url.pathname.endsWith('/stop-and-surface');
      if (req.method !== (command ? 'POST' : 'GET')) {
        json(res, 405, { available: false, error: 'Method not allowed' });
        return true;
      }
      if (command && !authorized) {
        json(res, 401, { available: false, error: 'Valid control bearer token required' });
        return true;
      }
      if (!enabled || !allowSimulator) {
        json(res, command ? 409 : 200, { available: false, reason: 'SITL simulation disabled' });
        return true;
      }
      if (command) {
        const current = state?.();
        if (!current || current.stale || current.connection !== 'live' || current.telemetry?.source !== 'simulator') {
          json(res, 409, { available: false, error: 'Fresh simulator telemetry required' });
          return true;
        }
      }
      try {
        const { code, data } = await upstream(command ? '/commands' : '/status', command);
        if (command) {
          if (!['accepted', 'already_requested'].includes(data.result) || data.command !== 'STOP_AND_SURFACE') throw new Error('Invalid SITL command receipt');
          json(res, code, { available: true, command: data.command, result: data.result, status: status(data.status) });
        } else json(res, 200, { available: true, ...status(data) });
      } catch (error) {
        json(res, command ? 503 : 200, { available: false, reason: error.message });
      }
      return true;
    },
  };
}

module.exports = { createSitlService };
