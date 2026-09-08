const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--autoplay-policy=no-user-gesture-required'] });
  const p = await b.newPage();
  const errs = []; p.on('pageerror', e => errs.push('PAGEERROR ' + e.message)); p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  await p.goto('http://localhost:8099/?t=' + Date.now()); await p.waitForTimeout(800);
  await p.evaluate(() => { localStorage.clear(); localStorage.setItem('stagedrums.prefs', JSON.stringify({ tapTempo: true, countIn: false, voice: false })); });
  await p.reload(); await p.waitForTimeout(1500);
  await p.evaluate(() => { const li = [...document.querySelectorAll('#songList li')].find(l => /Outside/.test(l.textContent)); li.click(); });
  await p.waitForFunction(() => window.stagedrums.transport.audio, null, { timeout: 120000 });
  console.log('tempo row visible?', await p.evaluate(() => !document.getElementById('tempoRow').hidden), '|', await p.evaluate(() => document.getElementById('tapInfo').textContent));
  const before = await p.evaluate(() => ({ len: window.stagedrums.transport.audio.stems.drums.length, end: window.stagedrums.transport.audio.barTimes.at(-1), b20: window.stagedrums.transport.audio.barTimes[20] }));
  // tap 5 times at 1.05× the record's tempo
  const bpm = await p.evaluate(() => { const bt = window.stagedrums.song.audio.barTimes; return 60 * 4 / ((bt.at(-1) - bt[0]) / (bt.length - 1)); });
  const interval = 60000 / (bpm * 1.05);
  for (let i = 0; i < 5; i++) { await p.click('#btnTap'); await p.waitForTimeout(interval - 15); }
  console.log('after taps:', await p.evaluate(() => document.getElementById('tapInfo').textContent), '| apply visible', await p.evaluate(() => !document.getElementById('btnTapApply').hidden));
  const t0 = Date.now();
  await p.click('#btnTapApply');
  await p.waitForFunction(() => /tempo/.test(document.getElementById('audioStatus').textContent) && window.stagedrums.transport.audio, null, { timeout: 300000 });
  console.log('rendered in', ((Date.now() - t0) / 1000).toFixed(1), 's');
  const after = await p.evaluate(() => ({ ratio: window.stagedrums.song.audio.tempo.ratio, len: window.stagedrums.transport.audio.stems.drums.length, end: window.stagedrums.transport.audio.barTimes.at(-1), b20: window.stagedrums.transport.audio.barTimes[20], info: document.getElementById('tapInfo').textContent }));
  console.log('before', JSON.stringify(before)); console.log('after ', JSON.stringify(after));
  console.log('length ratio', (before.len / after.len).toFixed(4), 'barTimes ratio', (before.end / after.end).toFixed(4), 'expected', after.ratio);
  // the drum hits should still sit on the (rescaled) bar lines: onset strength at bar lines vs off-beat
  const onGrid = await p.evaluate(() => { const t = window.stagedrums.transport, d = t.audio.stems.drums.getChannelData(0), sr = t.audio.stems.drums.sampleRate, bt = t.audio.barTimes;
    const e = (s) => { let m = 0; for (let i = s; i < s + 600; i++) m = Math.max(m, Math.abs(d[i] || 0)); return m; };
    let on = 0, off = 0; for (let b = 8; b < 60; b++) { const s = Math.floor(bt[b] * sr), q = Math.floor((bt[b + 1] - bt[b]) * sr / 8); on += e(s - 100); off += e(s + 3 * q); } return (on / off).toFixed(2); });
  console.log('drum energy at bar lines vs off-beat (>1 means the grid still fits):', onGrid);
  await p.evaluate(() => { const t = window.stagedrums.transport; t._pausedPos = 20; document.getElementById('btnPlay').click(); });
  await p.waitForTimeout(4200);
  console.log('playing: bar', await p.evaluate(() => window.stagedrums.transport.currentBar()), '(expected ~22)');
  await p.click('#btnTapReset'); await p.waitForFunction(() => window.stagedrums.transport.audio && !/tempo/.test(document.getElementById('audioStatus').textContent), null, { timeout: 60000 });
  console.log('reset: len', await p.evaluate(() => window.stagedrums.transport.audio.stems.drums.length), 'end', await p.evaluate(() => window.stagedrums.transport.audio.barTimes.at(-1)));
  console.log('errors:', errs.length ? errs : 'none');
  await b.close();
})().catch(e => { console.error('TEST FAILED', e); process.exit(1); });
