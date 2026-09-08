const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--autoplay-policy=no-user-gesture-required'] });
  const errs = [];
  const mk = async (iPad) => {
    const ctx = iPad ? await browser.newContext({ viewport: { width: 1024, height: 768 }, isMobile: true, hasTouch: true }) : await browser.newContext();
    const p = await ctx.newPage(); p.on('pageerror', e => errs.push(e.message)); p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
    await p.goto('http://localhost:8099/?t=' + Date.now()); await p.waitForTimeout(1000); await p.evaluate(() => localStorage.clear()); await p.reload(); await p.waitForTimeout(1500); return p;
  };
  const host = await mk(false), pad = await mk(true);
  await host.evaluate(() => { const s = document.getElementById('roleSelect'); s.value = 'host'; s.dispatchEvent(new Event('change')); });
  await pad.evaluate(() => { const s = document.getElementById('roleSelect'); s.value = 'follower'; s.dispatchEvent(new Event('change')); const d = document.getElementById('dlgSync'); if (d.open) d.close('ok'); });
  await host.waitForTimeout(2500);
  // iPad taps a song in the list → the computer changes song
  const target = await pad.evaluate(() => { const li = [...document.querySelectorAll('#songList li')].find(l => /Sunshine/.test(l.textContent)); li.click(); return li.textContent; });
  await host.waitForTimeout(1500);
  console.log('iPad tapped:', target.slice(0, 22), '| host song now:', await host.evaluate(() => window.stagedrums.song.title), '| iPad song:', await pad.evaluate(() => window.stagedrums.song.title));
  // sidebar must scroll vertically only
  const geo = await pad.evaluate(() => { const el = document.querySelector('.sidebar'); const st = getComputedStyle(el); el.scrollLeft = 200; return { overflowX: st.overflowX, overflowY: st.overflowY, touchAction: st.touchAction, scrollLeftAfter: el.scrollLeft, scrollW: el.scrollWidth, clientW: el.clientWidth, bodyScrollW: document.body.scrollWidth, bodyClientW: document.body.clientWidth }; });
  console.log('sidebar:', JSON.stringify(geo));
  console.log('Paste lyrics button opens attach mode:', await host.evaluate(() => { document.getElementById('btnLyrics').click(); const r = { open: document.getElementById('dlgImport').open, attach: document.getElementById('impAttach').checked, ph: document.getElementById('impText').placeholder.slice(0, 40) }; document.getElementById('dlgImport').close(); return JSON.stringify(r); }));
  console.log('errors:', errs.length ? errs : 'none');
  await browser.close();
})().catch(e => { console.error('TEST FAILED', e.message); process.exit(1); });
