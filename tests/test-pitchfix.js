const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--autoplay-policy=no-user-gesture-required'] });
  const p = await b.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message)); p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  await p.goto('http://localhost:8099/?t=' + Date.now()); await p.waitForTimeout(1200);
  const r = await p.evaluate(async () => {
    const sr = 44100, dur = 3, n = sr * dur;
    const run = async (f0, opts) => {
      const oc = new OfflineAudioContext(1, n, sr);
      await oc.audioWorklet.addModule('pitch-worklet.js');
      // a "voice": pulse train at f0 with slow vibrato, through two formant resonances
      // harmonic series with a 1/k spectrum (like a glottal source), slow vibrato, then two formant peaks
      const buf = oc.createBuffer(1, n, sr), d = buf.getChannelData(0); let ph = 0;
      for (let i = 0; i < n; i++) { const f = f0 * (1 + 0.006 * Math.sin(2 * Math.PI * 5.5 * i / sr)); ph += f / sr; let v = 0; for (let k = 1; k <= 20; k++) v += Math.sin(2 * Math.PI * k * ph) / k; d[i] = v * 0.25; }
      const src = oc.createBufferSource(); src.buffer = buf;
      const f1 = oc.createBiquadFilter(); f1.type = 'peaking'; f1.frequency.value = 700; f1.Q.value = 3; f1.gain.value = 12;
      const f2 = oc.createBiquadFilter(); f2.type = 'peaking'; f2.frequency.value = 1200; f2.Q.value = 4; f2.gain.value = 9;
      const mixg = oc.createGain();
      src.connect(f1); f1.connect(f2); f2.connect(mixg);
      const node = new AudioWorkletNode(oc, 'stagedrums-pitchfix', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      for (const [k, v] of Object.entries(opts)) node.parameters.get(k).value = v;
      let stats = null; node.port.onmessage = e => { stats = e.data; };
      mixg.connect(node); node.connect(oc.destination); src.start(0);
      const out = (await oc.startRendering()).getChannelData(0);
      // measure pitch by autocorrelation over the last 2 s
      const seg = out.subarray(sr, n); let best = 0, bv = -1; for (let lag = Math.floor(sr / 400); lag <= Math.floor(sr / 100); lag++) { let s = 0; for (let i = 0; i < 30000; i += 1) s += seg[i] * seg[i + lag]; if (s > bv) { bv = s; best = lag; } }
      // refine with parabolic interpolation
      const c = lag => { let s = 0; for (let i = 0; i < 30000; i++) s += seg[i] * seg[i + lag]; return s; }; const a = c(best - 1), bb = c(best), cc = c(best + 1); const off = (a - 2 * bb + cc) ? 0.5 * (a - cc) / (a - 2 * bb + cc) : 0;
      const pitch = sr / (best + off);
      // spectral centroid (timbre check)
      const cent = (x) => { let num = 0, den = 0; const N = 4096; for (let k = 1; k < 60; k++) { const f = k * sr / N; let re = 0, im = 0; for (let i = 0; i < N; i++) { const v = x[sr + i]; re += v * Math.cos(2 * Math.PI * k * i / N); im -= v * Math.sin(2 * Math.PI * k * i / N); } const m = Math.sqrt(re * re + im * im); num += f * m; den += m; } return num / den; };
      let rms = 0; for (let i = sr; i < n; i++) rms += out[i] * out[i]; rms = Math.sqrt(rms / (n - sr));
      return { pitch: +pitch.toFixed(2), centroid: +cent(out).toFixed(0), rms: +rms.toFixed(4), cpu: stats && +(stats.cpu * 100).toFixed(2), reported: stats && +stats.pitch.toFixed(1), cents: stats && +stats.cents.toFixed(0), latencyMs: stats && Math.round(stats.latency * 1000), ratio: stats && +stats.ratio.toFixed(4), grains: stats && stats.grains, period: stats && +stats.period.toFixed(1) };
    };
    const tb = performance.now(); const bypass = await run(224, { bypass: 1 }); bypass.renderMs = Math.round(performance.now() - tb);
    const tf = performance.now(); const fixed = await run(224, { bypass: 0, amount: 1, retune: 0.05, scale: 0, root: 0 }); fixed.renderMs = Math.round(performance.now() - tf);
    const gentle = await run(224, { bypass: 0, amount: 1, retune: 0.3, scale: 0, root: 0 });
    const inkey = await run(224, { bypass: 0, amount: 1, retune: 0.05, scale: 1, root: 0 }); // C major: nearest scale note to 226 Hz (A3 +47¢) is A3 220 or A#? A# not in C major → A 220
    return { bypass, fixed, gentle, inkey };
  });
  console.log('input 224 Hz (A3 + 31 cents, with 5.5 Hz vibrato); 3 s renders');
  for (const [k, v] of Object.entries(r)) console.log(`  ${k.padEnd(7)} ${JSON.stringify(v)}`);
  console.log('errors:', errs.length ? errs : 'none');
  await b.close();
})().catch(e => { console.error('TEST FAILED', e); process.exit(1); });
