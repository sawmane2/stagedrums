const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-device-for-media-stream'] }).catch(async e => {
    console.log('fallback launch', e.message.split('\n')[0]);
    return chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  });
  const page = await browser.newPage();
  const logs = [];
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') logs.push(m.type() + ': ' + m.text()); });
  page.on('pageerror', e => logs.push('PAGEERROR: ' + e.message));
  await page.goto('http://localhost:8099/?t=' + Date.now());
  await page.waitForTimeout(1500);
  // pick the Weight of Love song
  await page.evaluate(() => { const li = [...document.querySelectorAll('#songList li')].find(l => /Weight/.test(l.textContent)); li.click(); });
  await page.waitForFunction(() => /Playing|isn't|Loading/.test(document.getElementById('audioStatus').textContent), null, { timeout: 20000 });
  await page.waitForFunction(() => window.stagedrums && window.stagedrums.transport.audio, null, { timeout: 30000 }).catch(() => {});
  console.log('status:', await page.evaluate(() => document.getElementById('audioStatus').textContent));
  const info = await page.evaluate(() => { const t = window.stagedrums.transport; return { audio: !!t.audio, bt: t.audio && t.audio.barTimes.slice(0, 3), total: t.tl.total, ctxState: t.ctx.state, dur: t.audio && t.audio.buffer.duration }; });
  console.log(info);
  // instrument bar events
  await page.evaluate(() => { const t = window.stagedrums.transport; window.__bars = []; const ob = t.onBar; t.onBar = (b, x) => { window.__bars.push([b, +t.ctx.currentTime.toFixed(2)]); ob && ob(b, x); }; document.getElementById('chkCountIn').checked = true; });
  // jump to bar 12 (drums come in) and play
  await page.evaluate(() => { window.stagedrums.transport._pausedPos = 12; document.getElementById('btnPlay').click(); });
  await page.waitForTimeout(9000);
  let snap = await page.evaluate(() => { const t = window.stagedrums.transport; return { pos: t.position(), bar: t.currentBar(), bars: window.__bars, playing: t.playing, segs: t._aSegs }; });
  console.log('after 9s', JSON.stringify(snap));
  // hold current section, then check it loops; then go now
  await page.evaluate(() => document.getElementById('btnHold').click());
  await page.evaluate(() => { const t = window.stagedrums.transport; window.__bars = []; t.queueSection(3, true); });
  await page.waitForTimeout(5000);
  snap = await page.evaluate(() => { const t = window.stagedrums.transport; return { pos: t.position().toFixed(2), bar: t.currentBar(), bars: window.__bars, hold: t.hold, queued: t.queued, segs: t._aSegs.map(s => [s.ctx.toFixed(2), s.offset.toFixed(2)]), bt: [t.audio.barTimes[t.tl.sections[3].start]] }; });
  console.log('after queue now section 3 + hold', JSON.stringify(snap));
  // hold test: jump to the last bar of section 8 (Ending, 1 bar) - use section 7 'Outro' start+15 = bar 127, hold on → should loop back to 112
  await page.evaluate(() => { const t = window.stagedrums.transport; window.__bars = []; t.jumpTo(126); t.setHold(true); });
  await page.waitForTimeout(11000);
  snap = await page.evaluate(() => { const t = window.stagedrums.transport; return { bar: t.currentBar(), bars: window.__bars, hold: t.hold, segs: t._aSegs.map(s => [s.ctx.toFixed(2), s.offset.toFixed(2)]) }; });
  console.log('hold at end of Outro (112-127)', JSON.stringify(snap));
  await page.evaluate(() => document.getElementById('btnPlay').click());
  await page.waitForTimeout(300);
  snap = await page.evaluate(() => { const t = window.stagedrums.transport; return { playing: t.playing, paused: t._pausedPos, src: !!t._aSrc }; });
  console.log('stopped', JSON.stringify(snap));
  // synth mode switch
  await page.selectOption('#backingMode', 'synth');
  await page.waitForTimeout(300);
  console.log('synth status:', await page.evaluate(() => document.getElementById('audioStatus').textContent), await page.evaluate(() => !!window.stagedrums.transport.audio));
  console.log('console issues:', logs.slice(0, 10));
  await browser.close();
})().catch(e => { console.error('TEST FAILED', e); process.exit(1); });
