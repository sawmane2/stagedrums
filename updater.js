/* StageDrums — self-updater used by server.js. Zero dependencies.
   Strategy: if the folder is a git checkout and git is installed → `git pull --ff-only`;
   otherwise download the GitHub tarball of the configured branch and extract it over the folder.
   update.config.json and anything in `local/` are never overwritten. */
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const ROOT = __dirname;
const KEEP = new Set(['update.config.json']);          // files never overwritten by an update
const KEEP_DIRS = ['local'];                           // folders never touched

function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8')); } catch { return fallback; } }
function localVersion() { return readJson('version.json', { version: '0.0.0' }); }
function config() {
  const c = readJson('update.config.json', {});
  // fallback: the repository field in package.json ("github:owner/name" or a github URL)
  let pkgRepo = '';
  const pr = readJson('package.json', {}).repository; const prs = typeof pr === 'string' ? pr : (pr && pr.url) || '';
  const m = /github(?:\.com[/:]|:)([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(prs); if (m) pkgRepo = m[1];
  return { repo: process.env.STAGEDRUMS_REPO || c.repo || pkgRepo || '', branch: process.env.STAGEDRUMS_BRANCH || c.branch || 'main',
    versionUrl: process.env.STAGEDRUMS_VERSION_URL || c.versionUrl || '', tarballUrl: process.env.STAGEDRUMS_TARBALL_URL || c.tarballUrl || '' };
}
function cmpVersion(a, b) {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0), pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; }
  return 0;
}

function fetch(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('http:') ? require('http') : https;
    mod.get(url, { headers: { 'User-Agent': 'StageDrums-updater' } }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) { res.resume(); return resolve(fetch(res.headers.location, redirects - 1)); }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} for ${url}`)); }
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve(Buffer.concat(chunks))); res.on('error', reject);
    }).on('error', reject);
  });
}

function hasGit() { try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return fs.existsSync(path.join(ROOT, '.git')); } catch { return false; } }

async function check() {
  const { repo, branch, versionUrl } = config();
  const local = localVersion();
  if (!repo && !versionUrl) return { local, remote: null, updateAvailable: false, repo, branch, error: 'No repository configured. Put your GitHub "owner/name" in update.config.json.' };
  try {
    const buf = await fetch(versionUrl || `https://raw.githubusercontent.com/${repo}/${branch}/version.json`);
    const remote = JSON.parse(buf.toString('utf8'));
    return { local, remote, repo, branch, updateAvailable: cmpVersion(remote.version, local.version) > 0, method: hasGit() ? 'git' : 'download' };
  } catch (e) { return { local, remote: null, repo, branch, updateAvailable: false, error: e.message }; }
}

// ---- tar extraction (ustar/pax, as produced by GitHub) ----
function extractTarGz(gz, destRoot, log) {
  const tar = zlib.gunzipSync(gz);
  let off = 0, paxPath = null, written = 0;
  const str = (b, s, l) => b.toString('utf8', s, s + l).replace(/\0.*$/s, '');
  while (off + 512 <= tar.length) {
    const hdr = tar.subarray(off, off + 512);
    if (hdr.every(b => b === 0)) break;
    let name = str(hdr, 0, 100);
    const size = parseInt(str(hdr, 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(hdr[156]);
    const prefix = str(hdr, 345, 155);
    if (prefix) name = prefix + '/' + name;
    if (paxPath) { name = paxPath; paxPath = null; }
    const data = tar.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') { // pax extended header: may carry a long path
      const m = /\d+ path=([^\n]+)\n/.exec(data.toString('utf8')); if (m) paxPath = m[1]; continue;
    }
    if (type === 'g' || type === 'L') continue;
    // strip the leading "repo-branch/" folder
    const rel = name.split('/').slice(1).join('/');
    if (!rel) continue;
    if (KEEP.has(rel) || KEEP_DIRS.some(d => rel === d || rel.startsWith(d + '/'))) continue;
    const dest = path.join(destRoot, rel);
    if (!dest.startsWith(destRoot)) continue; // safety
    if (type === '5') { fs.mkdirSync(dest, { recursive: true }); continue; }
    if (type === '0' || type === '\0' || type === '') {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, data);
      if (rel.endsWith('.command') || rel.endsWith('.sh')) { try { fs.chmodSync(dest, 0o755); } catch {} }
      written++;
    }
  }
  log && log(`extracted ${written} files`);
  return written;
}

async function apply(log = () => {}) {
  const { repo, branch, tarballUrl } = config();
  const before = localVersion().version;
  if (hasGit()) {
    log('git pull --ff-only');
    const out = execFileSync('git', ['pull', '--ff-only', 'origin', branch], { cwd: ROOT, encoding: 'utf8' });
    log(out.trim());
  } else {
    if (!repo && !tarballUrl) throw new Error('No repository configured in update.config.json');
    const url = tarballUrl || `https://codeload.github.com/${repo}/tar.gz/refs/heads/${branch}`;
    log(`downloading ${url}`);
    const gz = await fetch(url);
    log(`downloaded ${(gz.length / 1024).toFixed(0)} KB`);
    // backup current version first (cheap insurance)
    const bak = path.join(ROOT, 'local', 'backup-' + before);
    try { fs.mkdirSync(bak, { recursive: true }); for (const f of fs.readdirSync(ROOT)) if (/\.(js|html|css|json|md)$/.test(f)) fs.copyFileSync(path.join(ROOT, f), path.join(bak, f)); log(`backup in local/backup-${before}`); } catch {}
    extractTarGz(gz, ROOT, log);
  }
  const after = localVersion();
  log(`now at version ${after.version}`);
  return { before, after };
}

module.exports = { check, apply, localVersion, config, cmpVersion, extractTarGz };

if (require.main === module) {
  (async () => {
    const c = await check();
    console.log(`Local ${c.local.version}` + (c.remote ? `, GitHub ${c.remote.version}` : '') + (c.error ? `\n${c.error}` : ''));
    if (c.updateAvailable || process.argv.includes('--force')) { await apply(m => console.log('  ' + m)); }
    else console.log('Already up to date.');
  })().catch(e => { console.error('Update failed:', e.message); process.exit(1); });
}
