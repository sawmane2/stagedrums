const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage();
  page.on('pageerror', e => console.log('PAGEERROR', e.message));
  page.on('console', m => { if (m.type() === 'error') console.log('console.error', m.text()); });
  await page.goto('http://localhost:8099/?t=' + Date.now());
  await page.waitForTimeout(1000);
  await page.evaluate(() => localStorage.clear());
  await page.reload(); await page.waitForTimeout(1500);
  await page.evaluate(() => { const li = [...document.querySelectorAll('#songList li')].find(l => /Weight/.test(l.textContent)); li.click(); });
  await page.waitForFunction(() => window.stagedrums.transport.audio, null, { timeout: 120000 });
  console.log('fills', await page.evaluate(() => window.stagedrums.transport.fills));
  console.log('drum keys', await page.evaluate(() => window.stagedrums.transport._drumKeys()));
  console.log('toggle visible?', await page.evaluate(() => !document.getElementById('loopFillsRow').hidden), await page.evaluate(() => document.getElementById('loopFillsCount').textContent));
  // Lead intro = bars 12..27; hold it and watch the last bar (27) splice a fill into the drum stem
  await page.evaluate(() => { const t = window.stagedrums.transport; document.getElementById('chkCountIn').checked = false; t._pausedPos = 25; document.getElementById('btnPlay').click(); t.setHold(true);
    window.__starts = []; const orig = t._aStart.bind(t); t._aStart = (w, o, k) => { window.__starts.push({ bar: t._bar, off: +o.toFixed(2), keys: k ? k.join('+') : 'all' }); return orig(w, o, k); }; });
  await page.waitForTimeout(11000);
  console.log('starts', JSON.stringify(await page.evaluate(() => window.__starts)));
  console.log('bar now', await page.evaluate(() => window.stagedrums.transport.currentBar()), 'fill active', await page.evaluate(() => window.stagedrums.transport._aFill));
  await page.waitForTimeout(4000);
  console.log('after wrap', JSON.stringify(await page.evaluate(() => ({ bar: window.stagedrums.transport.currentBar(), starts: window.__starts }))));
  await browser.close();
})().catch(e => { console.error('TEST FAILED', e); process.exit(1); });
