#!/usr/bin/env node
/* StageDrums relay server — zero dependencies.
   Serves the app over HTTP and relays sync messages over WebSocket on the same port.
   Usage: node server.js [port]     (default 8080)
   Open http://<this-computer-ip>:8080 on the computer (Host) and on the iPad (Follower). */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const updater = require('./updater.js');
const { spawn } = require('child_process');
const PORT = +((process.argv.slice(2).find(a => /^\d+$/.test(a))) || process.env.PORT || 8080);

// `node server.js --update` : update from GitHub and exit
if (process.argv.includes('--update')) {
  (async () => {
    const c = await updater.check();
    console.log(`StageDrums ${c.local.version}` + (c.remote ? ` — GitHub has ${c.remote.version}` : '') + (c.error ? `\n${c.error}` : ''));
    if (c.updateAvailable || process.argv.includes('--force')) await updater.apply(m => console.log('  ' + m)); else console.log('Already up to date.');
  })().catch(e => { console.error('Update failed:', e.message); process.exitCode = 1; });
  return;
}
const ROOT = __dirname;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

function isLocal(req) { const a = req.socket.remoteAddress || ''; return /^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/.test(a); }
function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); }
let updating = false;
async function api(req, res, p) {
  if (p === '/api/version') return json(res, 200, { local: updater.localVersion(), config: updater.config(), server: true, canUpdate: isLocal(req) });
  if (p === '/api/update/check') return json(res, 200, Object.assign(await updater.check(), { canUpdate: isLocal(req) }));
  if (p === '/api/update/apply' && req.method === 'POST') {
    if (!isLocal(req)) return json(res, 403, { error: 'Updates can only be started from the computer running the server (open http://localhost:' + PORT + ').' });
    if (updating) return json(res, 409, { error: 'Update already in progress' });
    updating = true; const log = [];
    try {
      const r = await updater.apply(m => { log.push(m); console.log('\n[update] ' + m); });
      json(res, 200, Object.assign(r, { log, restarting: true }));
      broadcast({ type: 'updated', version: r.after.version });
      // restart the server so server-side changes take effect; clients reconnect automatically
      setTimeout(() => {
        const child = spawn(process.execPath, [__filename, String(PORT)], { detached: true, stdio: 'inherit', cwd: ROOT });
        child.unref(); process.exit(0);
      }, 800);
    } catch (e) { updating = false; json(res, 500, { error: e.message, log }); }
    return;
  }
  // Backing-track audio lives in local/audio/ (not in git). List: GET /api/audio  Save: POST /api/audio/<songId>.<ext> (raw body)
  if (p === '/api/audio') {
    const dir = path.join(ROOT, 'local', 'audio'); const files = [];
    const walk = (d, rel) => { if (!fs.existsSync(d)) return; for (const f of fs.readdirSync(d)) { const st = fs.statSync(path.join(d, f)); if (st.isDirectory()) walk(path.join(d, f), rel + f + '/'); else if (/\.(mp3|wav|m4a|ogg|flac)$/i.test(f)) files.push(rel + f); } };
    walk(dir, 'local/audio/');
    return json(res, 200, { files, canUpload: isLocal(req) });
  }
  if (p === '/api/ir') { const dir = path.join(ROOT, 'local', 'ir'); const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /\.(wav|flac|mp3|aif|aiff)$/i.test(f)).map(f => 'local/ir/' + f) : []; return json(res, 200, { files }); }
  const m = p.match(/^\/api\/audio\/((?:[\w-]+\/)?[\w.-]+\.(mp3|wav|m4a|ogg|flac))$/i); // <songId>.mp3 or <songId>/<stem>.mp3
  if (m && req.method === 'POST') {
    if (!isLocal(req)) return json(res, 403, { error: 'Audio files can only be added from the computer running the server.' });
    const dir = path.join(ROOT, 'local', 'audio', path.dirname(m[1])); fs.mkdirSync(dir, { recursive: true });
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > 300 * 1024 * 1024) req.destroy(); else chunks.push(c); });
    req.on('end', () => { fs.writeFileSync(path.join(dir, path.basename(m[1])), Buffer.concat(chunks)); json(res, 200, { file: 'local/audio/' + m[1], bytes: size }); });
    return;
  }
  json(res, 404, { error: 'unknown api' });
}

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p.startsWith('/api/')) { api(req, res, p).catch(e => json(res, 500, { error: e.message })); return; }
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

// ---------- minimal WebSocket implementation ----------
const clients = new Set();
let lastSong = null, lastState = null;

function encodeFrame(str) {
  const payload = Buffer.from(str);
  const len = payload.length;
  let header;
  if (len < 126) { header = Buffer.alloc(2); header[1] = len; }
  else if (len < 65536) { header = Buffer.alloc(4); header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  header[0] = 0x81; // FIN + text
  return Buffer.concat([header, payload]);
}

function wsSend(sock, obj) { if (!sock.destroyed) sock.write(encodeFrame(JSON.stringify(obj))); }
function broadcast(obj, except) { for (const c of clients) if (c !== except) wsSend(c, obj); }

server.on('upgrade', (req, sock) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) return sock.destroy();
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
  sock.setNoDelay(true);
  clients.add(sock); sock.role = '?';
  let buf = Buffer.alloc(0);
  sock.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const fin = buf[0] & 0x80, op = buf[0] & 0x0f, masked = buf[1] & 0x80;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      const maskLen = masked ? 4 : 0;
      if (buf.length < off + maskLen + len) return;
      const mask = masked ? buf.slice(off, off + 4) : null;
      let payload = buf.slice(off + maskLen, off + maskLen + len);
      if (masked) { payload = Buffer.from(payload); for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3]; }
      buf = buf.slice(off + maskLen + len);
      if (op === 8) { sock.end(); return; }
      if (op === 9) { const f = encodeFrame(''); f[0] = 0x8a; sock.write(f); continue; }
      if (op === 1 && fin) handleMessage(sock, payload.toString('utf8'));
    }
  });
  const drop = () => { clients.delete(sock); log(); };
  sock.on('close', drop); sock.on('error', drop); sock.on('end', drop);
  log();
});

function handleMessage(sock, text) {
  let m; try { m = JSON.parse(text); } catch { return; }
  switch (m.type) {
    case 'ping': return wsSend(sock, { type: 'pong', t0: m.t0, serverTime: performance.now() });
    case 'hello':
      sock.role = m.role; log();
      if (m.role === 'follower') { if (lastSong) wsSend(sock, lastSong); if (lastState) wsSend(sock, lastState); }
      return;
    case 'song': lastSong = m; return broadcast(m, sock);
    case 'state': lastState = m; return broadcast(m, sock);
    case 'cmd': // follower → host
      for (const c of clients) if (c.role === 'host') wsSend(c, m);
      return;
    default: return broadcast(m, sock);
  }
}

function localIPs() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces()))
    for (const a of addrs) if (a.family === 'IPv4' && !a.internal) out.push(`${a.address}  (${name})`);
  return out;
}
function log() {
  const roles = [...clients].map(c => c.role).join(', ') || 'none';
  process.stdout.write(`\r\x1b[K[${new Date().toLocaleTimeString()}] connected: ${roles}`);
}

function listen(tries = 20) {
  server.once('error', e => {
    if (e.code === 'EADDRINUSE' && tries > 0) setTimeout(() => listen(tries - 1), 300); // previous instance still shutting down after an update
    else { console.error(e.message); process.exit(1); }
  });
  server.listen(PORT);
}
listen();
server.on('listening', () => {
  const v = updater.localVersion();
  console.log(`StageDrums ${v.version} server running.\n`);
  console.log(`  On this computer:  http://localhost:${PORT}   → choose "Host"`);
  for (const ip of localIPs()) console.log(`  On the iPad:       http://${ip.split(' ')[0]}:${PORT}   → choose "Follower"   ${ip}`);
  console.log(`\n  Follower sync address: ws://<ip>:${PORT}  (filled in automatically when opened from this server)\n`);
});
