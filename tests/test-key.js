const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--autoplay-policy=no-user-gesture-required'] });
  const p = await b.newPage();
  const errs = []; p.on('pageerror', e => errs.push('PAGEERROR ' + e.message)); p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  await p.goto('http://localhost:8099/?t=' + Date.now()); await p.waitForTimeout(800);
  await p.evaluate(() => localStorage.clear()); await p.reload(); await p.waitForTimeout(1500);
  console.log('transpose:', await p.evaluate(() => [window.StageDrums.transpose('Am7/G', 2), window.StageDrums.transpose('Bb', 1), window.StageDrums.transpose('D/F#', -1), window.StageDrums.transposeLine('G D . . Em7 C', 3), window.StageDrums.transposeLine('E7 . . B7', -2)]));
  await p.evaluate(() => { const li = [...document.querySelectorAll('#songList li')].find(l => /Outside/.test(l.textContent)); li.click(); });
  await p.waitForFunction(() => window.stagedrums.transport.audio, null, { timeout: 120000 });
  const before = await p.evaluate(() => ({ len: window.stagedrums.transport.audio.stems.drums.length, bt: window.stagedrums.transport.audio.barTimes.slice(0, 3), chord: document.getElementById('nowChord').textContent }));
  console.log('before', JSON.stringify(before), 'key row visible', await p.evaluate(() => !document.getElementById('keyRow').hidden));
  // calibrate lag directly
  const lag = await p.evaluate(async () => { const sh = new window.StageDrums.Shifter(); const l = await sh.calibrate(window.stagedrums.transport.ctx.sampleRate, { semitones: -1, tempo: 1 }); sh.dispose(); return l; });
  console.log('measured lag (samples) at -1 semitone:', lag);
  const t0 = Date.now();
  await p.selectOption('#keyShift', '-1');
  await p.waitForFunction(() => /different key/.test(document.getElementById('audioStatus').textContent), null, { timeout: 300000 });
  console.log('rendered in', ((Date.now() - t0) / 1000).toFixed(1), 's');
  const after = await p.evaluate(() => ({ len: window.stagedrums.transport.audio.stems.drums.length, bt: window.stagedrums.transport.audio.barTimes.slice(0, 3), chord: document.getElementById('nowChord').textContent, status: document.getElementById('audioStatus').textContent }));
  console.log('after -1', JSON.stringify(after));
  // does the shifted drum stem still line up? correlate onset envelopes around bar lines 20..24
  const align = await p.evaluate(async () => {
    const t = window.stagedrums.transport; const a = t.audio.stems.drums.getChannelData(0); const sr = t.audio.stems.drums.sampleRate;
    const r = await fetch('local/audio/cream-outside-woman-blues/drums.mp3'); const orig = (await t.ctx.decodeAudioData(await r.arrayBuffer())).getChannelData(0);
    const env = (x, s, e) => { const o = []; for (let i = s; i < e; i += 64) { let m = 0; for (let k = 0; k < 64; k++) m = Math.max(m, Math.abs(x[i + k] || 0)); o.push(m); } return o; };
    const s = Math.floor(t.audio.barTimes[20] * sr), e = Math.floor(t.audio.barTimes[24] * sr);
    const A = env(orig, s, e); let best = 0, bv = -1;
    for (let lag = -60; lag <= 60; lag++) { const B = env(a, s + lag * 64, e + lag * 64); let c = 0; for (let i = 0; i < A.length; i++) c += A[i] * B[i]; if (c > bv) { bv = c; best = lag; } }
    return best * 64 / sr * 1000;
  });
  console.log('drum onsets offset after shift: %s ms (0 = perfectly aligned)', align.toFixed(1));
  // play and check chart tracks; then back to original
  await p.evaluate(() => { const t = window.stagedrums.transport; document.getElementById('chkCountIn').checked = false; t._pausedPos = 16; document.getElementById('btnPlay').click(); });
  await p.waitForTimeout(4000);
  console.log('playing shifted: bar', await p.evaluate(() => [window.stagedrums.transport.currentBar(), document.getElementById('nowChord').textContent]));
  await p.selectOption('#keyShift', '0'); await p.waitForFunction(() => window.stagedrums.transport.audio && !/different key/.test(document.getElementById('audioStatus').textContent), null, { timeout: 60000 });
  console.log('back to original: len', await p.evaluate(() => window.stagedrums.transport.audio.stems.drums.length), 'chord', await p.evaluate(() => document.getElementById('nowChord').textContent));
  console.log('errors:', errs.length ? errs : 'none');
  await b.close();
})().catch(e => { console.error('TEST FAILED', e); process.exit(1); });
