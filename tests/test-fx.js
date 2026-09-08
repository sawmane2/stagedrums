const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--autoplay-policy=no-user-gesture-required'] });
  const p = await b.newPage();
  const errs = []; p.on('pageerror', e => errs.push('PAGEERROR ' + e.message)); p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  await p.goto('http://localhost:8099/?t=' + Date.now()); await p.waitForTimeout(800);
  await p.evaluate(() => localStorage.clear()); await p.reload(); await p.waitForTimeout(1500);
  console.log('ctx rate', await p.evaluate(() => window.stagedrums.transport.ctx.sampleRate));
  await p.evaluate(() => { const li = [...document.querySelectorAll('#songList li')].find(l => /Outside/.test(l.textContent)); li.click(); });
  await p.waitForFunction(() => window.stagedrums.transport.audio, null, { timeout: 120000 });
  // open fx on vocals, apply the radio-fuzz preset
  await p.evaluate(() => { [...document.querySelectorAll('#stemMix .stem')].find(r => /Vocals/.test(r.textContent)).querySelector('.fxbtn').click(); });
  await p.waitForTimeout(200);
  await p.selectOption('#fxPreset', 'radio-fuzz-vocal'); await p.waitForTimeout(300);
  const st = await p.evaluate(() => { const t = window.stagedrums.transport; const s = window.stagedrums.song; return { spec: s.audio.fx.vocals, shape: t.audio.fx.vocals && t.audio.fx.vocals.shape, effs: document.querySelectorAll('#fxChain .fxeff').length }; });
  console.log('preset applied', JSON.stringify(st.spec.chain.map(e => e.type)), 'shape', st.shape, 'rows', st.effs);
  // intensity 0 → bypassed (chain disposed), fxIn goes straight to fader
  await p.evaluate(() => { const r = document.getElementById('fxIntensity'); r.value = 0; r.dispatchEvent(new Event('input')); r.dispatchEvent(new Event('change')); });
  await p.waitForTimeout(200);
  console.log('intensity 0 → chain present?', await p.evaluate(() => !!window.stagedrums.transport.audio.fx.vocals));
  await p.evaluate(() => { const r = document.getElementById('fxIntensity'); r.value = 0.8; r.dispatchEvent(new Event('input')); r.dispatchEvent(new Event('change')); });
  await p.waitForTimeout(200);
  console.log('intensity 0.8 → chain present?', await p.evaluate(() => !!window.stagedrums.transport.audio.fx.vocals));
  // offline render check: does the chain change the signal, and is bypass bit-identical?
  const r = await p.evaluate(async () => {
    const SD = window.StageDrums; const sr = 44100, n = sr * 2;
    const render = async (spec) => {
      const oc = new OfflineAudioContext(2, n, sr);
      const buf = oc.createBuffer(2, n, sr); for (let c = 0; c < 2; c++) { const d = buf.getChannelData(c); for (let i = 0; i < n; i++) d[i] = 0.25 * Math.sin(2 * Math.PI * 220 * i / sr) + 0.1 * Math.sin(2 * Math.PI * 3300 * i / sr); }
      const src = oc.createBufferSource(); src.buffer = buf;
      if (spec) { const ch = SD.FX.build(oc, spec); src.connect(ch.input); ch.output.connect(oc.destination); } else src.connect(oc.destination);
      src.start(0); const out = await oc.startRendering(); const d = out.getChannelData(0);
      let s = 0, hi = 0; for (let i = sr; i < n; i++) s += d[i] * d[i]; return { rms: Math.sqrt(s / sr), peak: Math.max(...Array.from(d.subarray(sr, sr + 4000)).map(Math.abs)) };
    };
    const dry = await render(null), fx = await render({ enabled: true, intensity: 0.75, chain: SD.FX.PRESETS['radio-fuzz-vocal'].chain });
    const bypass = await render({ enabled: true, intensity: 0, chain: SD.FX.PRESETS['radio-fuzz-vocal'].chain });
    return { dry, fx, bypass };
  });
  console.log('render', JSON.stringify(r));
  // song switch disposes chains without errors, and fx survives reload
  await p.evaluate(() => { const li = [...document.querySelectorAll('#songList li')].find(l => /Weight/.test(l.textContent)); li.click(); });
  await p.waitForFunction(() => window.stagedrums.transport.audio && window.stagedrums.song.title.includes('Weight'), null, { timeout: 120000 });
  await p.evaluate(() => { const li = [...document.querySelectorAll('#songList li')].find(l => /Outside/.test(l.textContent)); li.click(); });
  await p.waitForFunction(() => window.stagedrums.transport.audio && window.stagedrums.song.title.includes('Outside'), null, { timeout: 120000 });
  console.log('after switching back: chain restored?', await p.evaluate(() => !!window.stagedrums.transport.audio.fx.vocals), 'fx button lit?', await p.evaluate(() => !![...document.querySelectorAll('#stemMix .stem')].find(r => /Vocals/.test(r.textContent)).querySelector('.fxbtn.on')));
  console.log('errors:', errs.length ? errs : 'none');
  await b.close();
})().catch(e => { console.error('TEST FAILED', e); process.exit(1); });
