const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--autoplay-policy=no-user-gesture-required'] });
  const p = await b.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  p.on('console', m => { if (m.type() === 'error') errs.push('console.error ' + m.text()); });
  await p.goto('http://localhost:8099/?t=' + Date.now()); await p.waitForTimeout(800);
  await p.evaluate(() => localStorage.clear()); await p.reload(); await p.waitForTimeout(1500);
  const names = await p.evaluate(() => [...document.querySelectorAll('#songList li div:first-child')].map(d => d.textContent));
  for (const n of names) {
    if (/Jam in G|12-Bar|Ballad Sketch/.test(n)) continue;
    await p.evaluate(x => { const li = [...document.querySelectorAll('#songList li')].find(l => l.textContent.includes(x)); li.click(); }, n.slice(0, 12));
    await p.waitForFunction(() => { const t = window.stagedrums.transport; return t.audio || /No recording|isn't on/.test(document.getElementById('audioStatus').textContent); }, null, { timeout: 180000 }).catch(() => {});
    await p.evaluate(() => { const t = window.stagedrums.transport; document.getElementById('chkCountIn').checked = false; t._pausedPos = Math.floor(t.tl.total * 0.6); document.getElementById('btnPlay').click(); });
    await p.waitForTimeout(5000);
    const r = await p.evaluate(() => { const t = window.stagedrums.transport; return { bar: t.currentBar(), total: t.tl.total, sec: document.getElementById('nowSection').textContent, chord: document.getElementById('nowChord').textContent, stems: t.audio ? Object.keys(t.audio.gains).length : 0, fills: t.fills ? t.fills.length : 0 }; });
    console.log(`${n.slice(0, 22).padEnd(22)} bar ${r.bar}/${r.total}  ${r.sec} · ${r.chord}  stems ${r.stems} fills ${r.fills}`);
    await p.evaluate(() => document.getElementById('btnPlay').click());
    await p.waitForTimeout(400);
  }
  console.log('errors:', errs.length ? errs.slice(0, 5) : 'none');
  await b.close();
})().catch(e => { console.error('TEST FAILED', e); process.exit(1); });
