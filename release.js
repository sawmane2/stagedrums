#!/usr/bin/env node
/* Bump version.json (and commit + tag when in git). Usage: node release.js 0.9.0 "What changed" */
const fs = require('fs'); const { execSync } = require('child_process');
const [version, ...rest] = process.argv.slice(2);
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) { console.error('Usage: node release.js <x.y.z> "release notes"'); process.exit(1); }
const v = { version, date: new Date().toISOString().slice(0, 10), notes: rest.join(' ') || 'Update' };
fs.writeFileSync(__dirname + '/version.json', JSON.stringify(v, null, 2) + '\n');
console.log('version.json →', v);
try { execSync('git rev-parse --is-inside-work-tree', { cwd: __dirname, stdio: 'ignore' });
  execSync(`git add -A && git commit -qm "Release ${version}: ${v.notes.replace(/"/g, "'")}" && git tag -f v${version}`, { cwd: __dirname, stdio: 'inherit' });
  console.log(`Committed and tagged v${version}. Push with: git push && git push --tags`);
} catch { console.log('Not a git repo (or nothing to commit) — version.json updated only.'); }
