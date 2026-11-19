// Reusable browser client. Tokens stay in memory; commands are never retried.
export class LiveClient extends EventTarget {
  constructor(base = location.origin) {
    super(); this.base = base; this.token = ''; this.active = false; this.stopped = false; this.retryMs = 500; this.lastMessage = 0;
  }
  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  async request(path, method = 'GET', body) {
    const response = await fetch(this.base + path, { method, cache: 'no-store', signal: AbortSignal.timeout(4000), headers: { ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const result = await response.json(); if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`); return result;
  }
  start() {
    this.connect();
    this.watchdog = setInterval(() => { if (this.lastMessage && Date.now() - this.lastMessage > 2000) { this.disable(); this.emit('transport', 'stale'); this.socket?.close(); } }, 500);
    this.leaseTimer = setInterval(async () => {
      if (!this.active || this.leaseBusy) return; this.leaseBusy = true;
      try { await this.request('/api/control/heartbeat', 'POST'); }
      catch (error) { this.disable(); this.emit('error', error.message); }
      finally { this.leaseBusy = false; }
    }, 500);
  }
  connect() {
    if (this.stopped) return;
    this.emit('transport', 'connecting');
    this.socket = new WebSocket(this.base.replace(/^http/, 'ws') + '/ws/live');
    this.socket.onmessage = event => {
      try {
        const data = JSON.parse(event.data); this.lastMessage = Date.now(); this.retryMs = 500;
        if (data.type === 'state') { if (data.stale) this.disable(); this.state = data; this.emit('transport', 'connected'); this.emit('state', data); }
        else if (data.type === 'command_result') this.emit('command', data.command);
      } catch { this.emit('error', 'Invalid backend update'); }
    };
    this.socket.onclose = () => { this.disable(); this.emit('transport', 'disconnected'); if (!this.stopped) { this.retryTimer = setTimeout(() => this.connect(), this.retryMs + Math.random() * 200); this.retryMs = Math.min(10000, this.retryMs * 2); } };
    this.socket.onerror = () => this.socket.close();
  }
  async enable(token) {
    this.token = token; await this.request('/api/control/heartbeat', 'POST'); this.active = true; this.emit('control', true);
  }
  disable() {
    if (!this.active) return;
    this.active = false; this.emit('control', false);
    this.request('/api/control/heartbeat', 'DELETE').catch(() => {});
  }
  async command(action, args = {}) {
    const id = [...crypto.getRandomValues(new Uint8Array(16))].map(v => v.toString(16).padStart(2, '0')).join('');
    const command = { schema_version: 1, id, action, args, ttl_ms: 1500 };
    const sent = await this.request('/api/commands', 'POST', command);
    this.emit('sent', sent);
    // Poll status as a fallback if an acknowledgement's live event is lost.
    for (let i = 0; i < 12; i++) {
      await new Promise(resolve => setTimeout(resolve, 200));
      const result = await this.request(`/api/commands/${id}`);
      if (result.status !== 'pending') return result;
    }
    throw new Error('Command outcome unknown. Check telemetry; do not assume movement stopped.');
  }
  stop() { this.stopped = true; this.disable(); clearTimeout(this.retryTimer); clearInterval(this.watchdog); clearInterval(this.leaseTimer); this.socket?.close(); }
}
