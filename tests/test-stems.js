const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--autoplay-policy=no-user-gesture-required'] });
  const mk = async () => { const p = await browser.newPage(); p.on('pageerror', e => console.log('PAGEERROR', e.message)); p.on('console', m => { if (m.type() === 'error') console.log('console.error', m.text()); }); await p.goto('http://localhost:8099/?t=' + Date.now()); await p.waitForTimeout(1200); return p; };
  const host = await mk(), fol = await mk();
  await host.evaluate(() => { const li = [...document.querySelectorAll('#songList li')].find(l => /Weight/.test(l.textContent)); li.click(); });
  await host.waitForFunction(() => window.stagedrums.transport.audio, null, { timeout: 60000 });
  console.log('status', await host.evaluate(() => document.getElementById('audioStatus').textContent));
  console.log('stems', await host.evaluate(() => { const a = window.stagedrums.transport.audio; return Object.fromEntries(Object.entries(a.gains).map(([k, g]) => [k, g.gain.value])); }));
  console.log('faders', await host.evaluate(() => [...document.querySelectorAll('#stemMix .stem')].map(r => r.querySelector('span').textContent + '=' + r.querySelector('input').value)));
  await host.evaluate(() => { const s = document.getElementById('roleSelect'); s.value = 'host'; s.dispatchEvent(new Event('change')); });
  await fol.evaluate(() => { const s = document.getElementById('roleSelect'); s.value = 'follower'; s.dispatchEvent(new Event('change')); const d = document.getElementById('dlgSync'); if (d.open) d.close('ok'); });
  await host.waitForTimeout(2500);
  await host.evaluate(() => { window.stagedrums.transport._pausedPos = 12; document.getElementById('btnPlay').click(); });
  await host.waitForTimeout(4000);
  console.log('host sources', await host.evaluate(() => window.stagedrums.transport._aSrc.length));
  // host: move guitars fader to 0.3 ; follower: mute drums
  await host.evaluate(() => { const r = [...document.querySelectorAll('#stemMix .stem')].find(x => /Guitars/.test(x.textContent)).querySelector('input'); r.value = 0.3; r.dispatchEvent(new Event('input')); r.dispatchEvent(new Event('change')); });
  console.log('fol faders', await fol.evaluate(() => [...document.querySelectorAll('#stemMix .stem')].map(r => r.querySelector('span').textContent + '=' + r.querySelector('input').value)));
  await fol.evaluate(() => { [...document.querySelectorAll('#stemMix .stem')].find(x => /Drums/.test(x.textContent)).querySelector('button').click(); });
  await host.waitForTimeout(800);
  console.log('host gains after', await host.evaluate(() => { const a = window.stagedrums.transport.audio; return Object.fromEntries(Object.entries(a.gains).map(([k, g]) => [k, +g.gain.value.toFixed(2)])); }));
  console.log('host song mix', await host.evaluate(() => JSON.stringify([window.stagedrums.song.audio.mix, window.stagedrums.song.audio.mute])));
  console.log('fol faders after', await fol.evaluate(() => [...document.querySelectorAll('#stemMix .stem')].map(r => r.querySelector('span').textContent + '=' + r.querySelector('input').value + (r.querySelector('button').classList.contains('on') ? ' (M)' : ''))));
  console.log('fol still playing/bar', await fol.evaluate(() => [window.stagedrums.transport.playing, window.stagedrums.transport.currentBar()]), 'host bar', await host.evaluate(() => window.stagedrums.transport.currentBar()));
  await browser.close();
})().catch(e => { console.error('TEST FAILED', e); process.exit(1); });
