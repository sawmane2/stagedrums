const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  const p = await b.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message)); p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  await p.goto('http://localhost:8099/?t=' + Date.now()); await p.waitForTimeout(1500);
  await p.evaluate(() => { const li = [...document.querySelectorAll('#songList li')].find(l => /Outside/.test(l.textContent)); li.click(); });
  await p.waitForTimeout(500);
  await p.click('#btnMixer'); await p.waitForTimeout(2500);
  const r = await p.evaluate(() => { const m = window.stagedrums.mixer; return { pitchOk: m.pitchOk, channels: m.channels.length, hasPitchNode: m.channels.map(c => !!(c.pitch && c.pitch.parameters)), songKey: m.songKey, strips: document.querySelectorAll('.strip .skey').length, params: m.channels[0] && m.channels[0].pitch.parameters ? { root: m.channels[0].pitch.parameters.get('root').value, scale: m.channels[0].pitch.parameters.get('scale').value, bypass: m.channels[0].pitch.parameters.get('bypass').value } : null }; });
  console.log(JSON.stringify(r));
  await p.evaluate(() => { const c = document.querySelector('.strip input[data-k="pitchOn"]'); c.checked = true; c.dispatchEvent(new Event('change')); });
  await p.waitForTimeout(600);
  console.log('after enabling:', await p.evaluate(() => ({ bypass: window.stagedrums.mixer.channels[0].pitch.parameters.get('bypass').value, readout: document.querySelector('.pfx-read').textContent })));
  console.log('errors:', errs.length ? errs : 'none');
  await b.close();
})().catch(e => { console.error('TEST FAILED', e); process.exit(1); });
