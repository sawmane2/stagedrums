const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--autoplay-policy=no-user-gesture-required'] });
  const p = await b.newPage();
  const errs = []; p.on('pageerror', e => errs.push('PAGEERROR ' + e.message)); p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  await p.goto('http://localhost:8099/?t=' + Date.now()); await p.waitForTimeout(800);
  await p.evaluate(() => { localStorage.clear(); localStorage.setItem('stagedrums.prefs', JSON.stringify({ pedalL: 'KeyQ', pedalR: 'KeyW', countIn: false, voice: false })); });
  await p.reload(); await p.waitForTimeout(1500);
  await p.evaluate(() => { const li = [...document.querySelectorAll('#songList li')].find(l => /Outside/.test(l.textContent)); li.click(); });
  await p.waitForFunction(() => window.stagedrums.transport.audio, null, { timeout: 120000 });
  console.log('pedal labels', await p.evaluate(() => [document.getElementById('pedalKeyL').textContent, document.getElementById('pedalKeyR').textContent]));
  // fade: set 6 s, start at bar 64 of 68 (~12 s from the end)
  await p.evaluate(() => { const f = document.getElementById('fadeOut'); f.value = 6; f.dispatchEvent(new Event('change')); });
  console.log('fadeOut on transport', await p.evaluate(() => window.stagedrums.transport.fadeOut), 'saved', await p.evaluate(() => JSON.stringify(window.stagedrums.song.audio.fade)));
  await p.evaluate(() => { const t = window.stagedrums.transport; t._pausedPos = 64; document.getElementById('btnPlay').click(); });
  await p.waitForTimeout(9000);
  console.log('near the end: fading?', await p.evaluate(() => [window.stagedrums.transport._fading, +window.stagedrums.transport._aGain.gain.value.toFixed(3), window.stagedrums.transport.currentBar()]));
  // pedal left = hold → the wrap seek must restore the level
  await p.keyboard.press('KeyQ'); await p.waitForTimeout(100);
  console.log('after pedal L: hold?', await p.evaluate(() => window.stagedrums.transport.hold));
  await p.waitForTimeout(5000);
  console.log('after wrap: bar', await p.evaluate(() => window.stagedrums.transport.currentBar()), 'gain', await p.evaluate(() => +window.stagedrums.transport._aGain.gain.value.toFixed(3)), 'fading', await p.evaluate(() => window.stagedrums.transport._fading));
  // repeat guard: two quick presses toggle once
  await p.keyboard.press('KeyQ'); await p.keyboard.press('KeyQ'); await p.waitForTimeout(100);
  console.log('after two quick L presses: hold?', await p.evaluate(() => window.stagedrums.transport.hold));
  // pedal right = next song
  await p.keyboard.press('KeyW'); await p.waitForTimeout(500);
  console.log('after pedal R: song', await p.evaluate(() => window.stagedrums.song.title), 'playing', await p.evaluate(() => window.stagedrums.transport.playing));
  // pedal ignored while a dialog is open
  await p.evaluate(() => document.getElementById('dlgSync').showModal());
  await p.keyboard.press('KeyW'); await p.waitForTimeout(200);
  console.log('with dialog open, R pressed: song still', await p.evaluate(() => window.stagedrums.song.title));
  console.log('errors:', errs.length ? errs : 'none');
  await b.close();
})().catch(e => { console.error('TEST FAILED', e); process.exit(1); });
