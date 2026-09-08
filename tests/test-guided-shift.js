const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--autoplay-policy=no-user-gesture-required'] });
  const p = await b.newPage(); p.on('pageerror', e => console.log('PAGEERROR', e.message));
  await p.goto('http://localhost:8099/?t=' + Date.now()); await p.waitForTimeout(1200);
  const r = await p.evaluate(async () => {
    const ctx = window.stagedrums.transport.ctx, sr = ctx.sampleRate, n = sr * 10;
    const noise = new Float32Array(n); for (let i = 0; i < n; i++) noise[i] = (Math.random() * 2 - 1) * 0.3;
    // A = noise; B = the same noise delayed by 100 samples, half amplitude (so the mix's decisions aren't trivially A's)
    const A = ctx.createBuffer(2, n, sr), B = ctx.createBuffer(2, n, sr);
    for (let c = 0; c < 2; c++) { A.getChannelData(c).set(noise); const d = B.getChannelData(c); for (let i = 100; i < n; i++) d[i] = 0.5 * noise[i - 100]; }
    const sh = new window.StageDrums.Shifter();
    const out = await sh.render(ctx, { A, B }, { semitones: -1, tempo: 1 });
    const a = out.A.getChannelData(0), bb = out.B.getChannelData(0);
    const res = [];
    for (let s = sr; s < n - sr; s += sr) { let best = 0, bv = -1e9; for (let lag = 0; lag <= 200; lag++) { let c = 0; for (let i = s; i < s + 4000; i++) c += a[i] * bb[i + lag]; if (c > bv) { bv = c; best = lag; } } res.push(best); }
    sh.dispose(); return res;
  });
  console.log('best lag B vs A per second (should be 100 everywhere):', r.join(' '));
  await b.close();
})().catch(e => { console.error('TEST FAILED', e); process.exit(1); });
