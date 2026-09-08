const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--autoplay-policy=no-user-gesture-required'] });
  const errs = [];
  const mk = async () => { const p = await browser.newPage(); p.on('pageerror', e => errs.push(e.message)); p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); }); await p.goto('http://localhost:8099/?t=' + Date.now()); await p.waitForTimeout(1000); await p.evaluate(() => localStorage.clear()); await p.reload(); await p.waitForTimeout(1200); return p; };
  const host = await mk(), fol = await mk();
  await host.evaluate(() => { const li = [...document.querySelectorAll('#songList li')].find(l => /Outside/.test(l.textContent)); li.click(); });
  await host.waitForFunction(() => window.stagedrums.transport.audio, null, { timeout: 120000 });
  await host.evaluate(() => { const s = document.getElementById('roleSelect'); s.value = 'host'; s.dispatchEvent(new Event('change')); });
  await fol.evaluate(() => { const s = document.getElementById('roleSelect'); s.value = 'follower'; s.dispatchEvent(new Event('change')); const d = document.getElementById('dlgSync'); if (d.open) d.close('ok'); });
  await host.waitForTimeout(2000);
  console.log('follower cue master row visible?', await fol.evaluate(() => !document.getElementById('cueMasterRow').hidden));
  // follower click independent of drums
  await fol.evaluate(() => { const c = document.getElementById('cueClick'); c.value = 0.8; c.dispatchEvent(new Event('input')); });
  console.log('follower click bus gain', await fol.evaluate(() => window.stagedrums.kit.bus.click.gain.value), 'drums audible?', await fol.evaluate(() => window.stagedrums.transport.audible));
  // follower moves the host's backing level
  await fol.evaluate(() => { const c = document.getElementById('cueMaster'); c.value = 0.5; c.dispatchEvent(new Event('input')); });
  await host.waitForTimeout(500);
  console.log('host backing level after remote', await host.evaluate(() => [+document.getElementById('volAudio').value, +window.stagedrums.transport._aGain.gain.value.toFixed(2)]));
  // follower fx command reaches host
  await fol.evaluate(() => { window.stagedrums.transport; });
  await fol.evaluate(() => { const r = [...document.querySelectorAll('#stemMix .stem')].find(x => /Vocals/.test(x.textContent)); r.querySelector('.fxbtn').click(); });
  await fol.waitForTimeout(200);
  await fol.selectOption('#fxPreset', 'telephone'); await host.waitForTimeout(800);
  console.log('host vocals chain from follower preset:', await host.evaluate(() => window.stagedrums.transport.audio.fx.vocals && window.stagedrums.transport.audio.fx.vocals.shape), '| follower sees it:', await fol.evaluate(() => JSON.stringify(window.stagedrums.song.audio.fx.vocals.chain.map(e => e.type))));
  // pedal right on the follower asks the host to change song
  await fol.evaluate(() => { document.getElementById('dlgFx').close(); });
  await fol.evaluate(() => { const p = JSON.parse(localStorage.getItem('stagedrums.prefs') || '{}'); p.pedalR = 'KeyW'; localStorage.setItem('stagedrums.prefs', JSON.stringify(p)); });
  await fol.reload(); await fol.waitForTimeout(2500);
  await fol.keyboard.press('KeyW'); await host.waitForTimeout(1500);
  console.log('after follower pedal R: host song', await host.evaluate(() => window.stagedrums.song.title), '| follower song', await fol.evaluate(() => window.stagedrums.song && window.stagedrums.song.title));
  console.log('errors:', errs.length ? errs : 'none');
  await browser.close();
})().catch(e => { console.error('TEST FAILED', e); process.exit(1); });
