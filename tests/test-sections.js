const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage();
  page.on('pageerror', e => console.log('PAGEERROR', e.message));
  page.on('console', m => { if (m.type() === 'error') console.log('console.error', m.text()); });
  await page.goto('http://localhost:8099/?t=' + Date.now());
  await page.waitForTimeout(1500);
  await page.evaluate(() => localStorage.removeItem('sd-songs'));
  await page.reload(); await page.waitForTimeout(1500);
  await page.evaluate(() => { const li = [...document.querySelectorAll('#songList li')].find(l => /Weight/.test(l.textContent)); li.click(); });
  await page.waitForFunction(() => window.stagedrums.transport.audio, null, { timeout: 60000 });
  console.log('scope options', await page.evaluate(() => [...document.getElementById('stemScope').options].map(o => o.value + ':' + o.textContent)));
  // set "Chorus 1" (section 3) to guitar 0.2, drums 1.4
  await page.selectOption('#stemScope', '3');
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#stemMix .stem')];
    const set = (name, v) => { const r = rows.find(x => x.textContent.includes(name)); const i = r.querySelector('input'); i.value = v; i.dispatchEvent(new Event('input')); i.dispatchEvent(new Event('change')); };
    set('Guitars', 0.2); set('Drums', 1.4);
  });
  await page.waitForTimeout(300);
  console.log('section overrides', await page.evaluate(() => JSON.stringify(window.stagedrums.song.sections.map(s => s.stems).filter(Boolean))));
  console.log('scope labels now', await page.evaluate(() => [...document.getElementById('stemScope').options].map(o => o.textContent)));
  // play into the section before the chorus and check the gains switch at the chorus (bar 44)
  await page.evaluate(() => { const t = window.stagedrums.transport; document.getElementById('chkCountIn').checked = false; t._pausedPos = 42; document.getElementById('btnPlay').click(); });
  await page.waitForTimeout(2500);
  const before = await page.evaluate(() => { const t = window.stagedrums.transport; return { bar: t.currentBar(), g: Object.fromEntries(Object.entries(t.audio.gains).map(([k, v]) => [k, +v.gain.value.toFixed(2)])) }; });
  console.log('before chorus', JSON.stringify(before));
  await page.waitForTimeout(8000);
  const after = await page.evaluate(() => { const t = window.stagedrums.transport; return { bar: t.currentBar(), g: Object.fromEntries(Object.entries(t.audio.gains).map(([k, v]) => [k, +v.gain.value.toFixed(2)])) }; });
  console.log('in chorus  ', JSON.stringify(after));
  // "live" scope should show the chorus values
  await page.selectOption('#stemScope', 'live');
  await page.waitForTimeout(300);
  console.log('live faders', await page.evaluate(() => [...document.querySelectorAll('#stemMix .stem')].map(r => r.querySelector('span').textContent.trim() + '=' + r.querySelector('input').value)));
  // reset section
  await page.evaluate(() => { const b = [...document.querySelectorAll('#stemMix button')].find(x => /Use the song mix/.test(x.textContent)); if (b) b.click(); });
  await page.waitForTimeout(1500);
  console.log('after reset', await page.evaluate(() => JSON.stringify([window.stagedrums.song.sections.map(s => s.stems).filter(Boolean), Object.fromEntries(Object.entries(window.stagedrums.transport.audio.gains).map(([k, v]) => [k, +v.gain.value.toFixed(2)]))])));
  await browser.close();
})().catch(e => { console.error('TEST FAILED', e); process.exit(1); });
