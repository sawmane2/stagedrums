/* StageDrums — WebSocket sync client. The relay server (server.js) is the shared clock.
   Host publishes transport anchors in server-time; followers convert to their own AudioContext time. */
(function (global) {
  'use strict';

  class SyncClient {
    constructor(url, role, handlers = {}) {
      this.url = url; this.role = role; this.h = handlers;
      this.offset = 0;       // serverTime - localPerfTime (ms)
      this.rtt = Infinity;
      this.samples = [];
      this.connected = false;
      this._closed = false;
      this._connect();
    }
    _connect() {
      try { this.ws = new WebSocket(this.url); } catch (e) { this._retry(); return; }
      this.ws.onopen = () => {
        this.connected = true; this.samples = [];
        this.send({ type: 'hello', role: this.role });
        this._pingTimer = setInterval(() => this.ping(), 1500);
        for (let i = 0; i < 6; i++) setTimeout(() => this.ping(), i * 120);
        this.h.onStatus && this.h.onStatus(this);
      };
      this.ws.onclose = () => {
        this.connected = false; clearInterval(this._pingTimer);
        this.h.onStatus && this.h.onStatus(this);
        this._retry();
      };
      this.ws.onerror = () => { /* onclose follows */ };
      this.ws.onmessage = (ev) => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.type === 'pong') return this._onPong(m);
        this.h.onMessage && this.h.onMessage(m);
      };
    }
    _retry() { if (!this._closed) setTimeout(() => this._connect(), 1500); }
    close() { this._closed = true; clearInterval(this._pingTimer); this.ws && this.ws.close(); }

    ping() { this.send({ type: 'ping', t0: performance.now() }); }
    _onPong(m) {
      const t2 = performance.now();
      const rtt = t2 - m.t0;
      const offset = m.serverTime - (m.t0 + t2) / 2;
      this.samples.push({ rtt, offset });
      if (this.samples.length > 12) this.samples.shift();
      // use the lowest-RTT samples (most accurate); median of best 3
      const best = [...this.samples].sort((a, b) => a.rtt - b.rtt).slice(0, 3);
      this.offset = best[Math.floor(best.length / 2)].offset;
      this.rtt = best[0].rtt;
      this.h.onStatus && this.h.onStatus(this);
    }
    serverNow() { return performance.now() + this.offset; }
    send(obj) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj)); }
  }

  /** Convert an AudioContext time to server ms and back. */
  function ctxToServer(ctx, sync, ctxTime) {
    return performance.now() + (ctxTime - ctx.currentTime) * 1000 + sync.offset;
  }
  function serverToCtx(ctx, sync, serverMs) {
    return ctx.currentTime + (serverMs - sync.offset - performance.now()) / 1000;
  }

  global.StageDrums.SyncClient = SyncClient;
  global.StageDrums.ctxToServer = ctxToServer;
  global.StageDrums.serverToCtx = serverToCtx;
})(window);
