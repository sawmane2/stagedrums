/* StageDrums — UI, song library, chart tracking, voice cues, sync roles. */
(function () {
  'use strict';
  const SD = window.StageDrums;
  const $ = (id) => document.getElementById(id);
  const LS_SONGS = 'stagedrums.songs', LS_PREFS = 'stagedrums.prefs';

  // ---------- audio ----------
  const ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
  const kit = new SD.DrumKit(ctx);
  const transport = new SD.Transport(kit);
  const unlock = () => { if (ctx.state === 'suspended') ctx.resume(); };
  ['pointerdown', 'touchstart', 'keydown'].forEach(ev => document.addEventListener(ev, unlock, { passive: true }));

  // ---------- state ----------
  let songs = [], song = null, tl = null;
  let role = 'solo', sync = null;
  let prefs = Object.assign({ voice: true, countIn: true, followerAudio: false, syncUrl: '' }, JSON.parse(localStorage.getItem(LS_PREFS) || '{}'));
  let currentBarEl = null, currentSectionIdx = -1, lastSpokenBar = null;
  let wakeLock = null;

  function savePrefs() { localStorage.setItem(LS_PREFS, JSON.stringify(prefs)); }

  // ---------- songs ----------
  async function loadSongs() {
    const local = JSON.parse(localStorage.getItem(LS_SONGS) || 'null');
    let shipped = []; try { shipped = await (await fetch('songs/index.json', { cache: 'no-store' })).json(); } catch {}
    if (local && local.length) {
      songs = local;
      // an update may ship a newer revision of a built-in song: take it, but keep any lyrics/sheet the user attached
      for (const sh of shipped) {
        const i = songs.findIndex(s => s.id === sh.id);
        if (i < 0) { songs.push(sh); continue; }
        if ((sh.rev || 0) > (songs[i].rev || 0)) {
          const old = songs[i]; const merged = JSON.parse(JSON.stringify(sh));
          merged.sections.forEach((sec, k) => { const o = old.sections.find(x => x.name === sec.name) || old.sections[k];
            if (o) { if (o.sheet && !sec.sheet) sec.sheet = o.sheet; if (o.lyrics && !sec.lyrics) sec.lyrics = o.lyrics; } });
          if (old.audio && !merged.audio) merged.audio = old.audio; // keep a recording the user attached
          songs[i] = merged;
        }
      }
    } else songs = shipped;
    persistSongs();
    renderSongList();
    const lastId = prefs.lastSong;
    selectSong(songs.find(s => s.id === lastId) || songs[0]);
  }
  function persistSongs() { localStorage.setItem(LS_SONGS, JSON.stringify(songs)); }
  function renderSongList() {
    const ul = $('songList'); ul.innerHTML = '';
    for (const s of songs) {
      const li = document.createElement('li');
      li.innerHTML = `<div>${esc(s.title)}</div><div class="artist">${esc(s.artist || '')} · ${s.bpm} bpm · ${s.time || '4/4'}</div>`;
      li.className = song && s.id === song.id ? 'active' : '';
      li.onclick = () => { if (role === 'follower') return; transport.stop(); selectSong(s); broadcastSong(); };
      ul.appendChild(li);
    }
  }
  function selectSong(s) {
    if (!s) { song = null; tl = null; $('chart').innerHTML = '<p class="hint" style="padding:20px">Import a song to get started.</p>'; return; }
    song = s; transport.setSong(s); tl = transport.tl;
    prefs.lastSong = s.id; savePrefs();
    $('bpm').value = transport.bpm;
    renderSongList(); renderChart(); renderBeats(); renderPads(); syncBandUI();
    updateNow(0, true);
    applyBacking();
  }

  // ---------- chart ----------
  function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  // ---------- sheet view (chords over lyrics, like a UG chords page) ----------
  function hasSheet() { return !!(song && song.sections.some(s => s.sheet)); }
  function viewMode() { return prefs.view === 'grid' || !hasSheet() ? 'grid' : 'sheet'; }
  /** Build sheet lines for a section with each chord token mapped to a timeline bar index. */
  function sheetLines(secIdx) {
    const secDef = song.sections[secIdx], sec = tl.sections[secIdx];
    const raw = String(secDef.sheet || '').split('\n');
    const lines = []; // {chordLine, text, tokens:[{col,name}]}
    for (let i = 0; i < raw.length; i++) {
      const l = raw[i]; if (!l.trim()) continue;
      if (SD.isChordLine(l.trim())) {
        const tokens = []; const re = /\S+/g; let m; while ((m = re.exec(l))) if (!/^\(?x\d\)?$/i.test(m[0])) tokens.push({ col: m.index, name: m[0] });
        const next = raw[i + 1]; const hasText = next != null && next.trim() && !SD.isChordLine(next.trim());
        lines.push({ chordLine: l, text: hasText ? next : '', tokens }); if (hasText) i++;
      } else lines.push({ chordLine: '', text: l, tokens: [] });
    }
    // map tokens → bars: sequential when the token count equals the bar count, else proportional per chord line
    const chordLines = lines.filter(l => l.tokens.length); const nTok = chordLines.reduce((n, l) => n + l.tokens.length, 0);
    const perRepeat = secDef.bars.length;
    if (Array.isArray(secDef.sheetBars) && secDef.sheetBars.length === chordLines.length) { // explicit bars per chord line
      let start = 0;
      chordLines.forEach((l, li) => { const lb = secDef.sheetBars[li]; const n = l.tokens.length, base = Math.floor(lb / n), rem = lb - base * n; let b = start;
        l.tokens.forEach((t, i) => { t.bar = sec.start + Math.min(perRepeat - 1, n > lb ? start + Math.floor(i * lb / n) : b); b += base + (i === 0 ? rem : 0); }); start += lb; });
    } else if (nTok === perRepeat) { let b = 0; for (const l of chordLines) for (const t of l.tokens) t.bar = sec.start + b++; }
    else {
      const per = perRepeat / Math.max(1, chordLines.length); let start = 0;
      chordLines.forEach((l, li) => { const lb = Math.round((li + 1) * per) - Math.round(li * per);
        const n = l.tokens.length, base = Math.floor(lb / n), rem = lb - base * n; let b = start;
        l.tokens.forEach((t, i) => { t.bar = sec.start + Math.min(perRepeat - 1, n > lb ? start + Math.floor(i * lb / n) : b); b += base + (i === 0 ? rem : 0); });
        start += lb; });
    }
    return lines;
  }
  function renderSheetSection(sec, div) {
    const lines = sheetLines(sec.index);
    const wrap = document.createElement('div'); wrap.className = 'sheet';
    for (const l of lines) {
      const row = document.createElement('div'); row.className = 'sl';
      if (l.tokens.length) {
        const ch = document.createElement('div'); ch.className = 'sl-ch'; let pos = 0;
        for (const t of l.tokens) {
          ch.appendChild(document.createTextNode(l.chordLine.slice(pos, t.col)));
          const b = document.createElement('span'); b.className = 'chd'; b.textContent = t.name; b.dataset.bar = t.bar; b.onclick = () => transport.playing ? queueSection(tl.bars[t.bar].section, false) : jumpTo(t.bar);
          ch.appendChild(b); pos = t.col + t.name.length;
        }
        row.appendChild(ch);
        row.dataset.from = Math.min(...l.tokens.map(t => t.bar));
      }
      const tx = document.createElement('div'); tx.className = 'sl-tx'; tx.textContent = l.text || ' '; row.appendChild(tx);
      wrap.appendChild(row);
    }
    div.appendChild(wrap);
  }
  function updateSheetHighlight(barIdx) {
    if (viewMode() !== 'sheet') return;
    const secIdx = tl.bars[barIdx].section; const secEl = document.querySelector(`.section[data-section="${secIdx}"]`); if (!secEl) return;
    // active chord token = last token whose bar <= current (within this section)
    let best = null; secEl.querySelectorAll('.chd').forEach(c => { const b = +c.dataset.bar; if (b <= barIdx && (!best || b >= +best.dataset.bar)) best = c; });
    document.querySelectorAll('.chd.on').forEach(c => { if (c !== best) c.classList.remove('on'); });
    document.querySelectorAll('.sl.now').forEach(r => r.classList.remove('now'));
    if (best) { best.classList.add('on'); const row = best.closest('.sl'); if (row) { row.classList.add('now'); const ch = $('chart'); const top = row.offsetTop - ch.offsetTop; if (top < ch.scrollTop + 60 || top > ch.scrollTop + ch.clientHeight - 140) ch.scrollTo({ top: top - ch.clientHeight * 0.35, behavior: 'smooth' }); } }
  }
  $('btnView').onclick = () => { prefs.view = viewMode() === 'sheet' ? 'grid' : 'sheet'; savePrefs(); renderChart(); updateNow(transport.currentBar(), true); };

  function renderChart() {
    const chart = $('chart'); chart.innerHTML = '';
    $('btnView').textContent = viewMode() === 'sheet' ? 'View: Sheet' : 'View: Grid'; $('btnView').hidden = !hasSheet();
    tl.sections.forEach(sec => {
      const secDef = song.sections[sec.index];
      const div = document.createElement('div'); div.className = 'section'; div.dataset.section = sec.index;
      const rep = secDef.repeat > 1 ? ` ×${secDef.repeat}` : '';
      div.innerHTML = `<div class="section-head"><span class="name">${esc(sec.name)}</span>
        <span class="meta">${sec.count} bars${rep} · ${esc(secDef.groove || song.groove || 'rock')}</span>
        <span class="jump">tap to jump</span></div>`;
      div.querySelector('.section-head').onclick = () => transport.playing ? queueSection(sec.index, false) : jumpTo(sec.start);
      if (viewMode() === 'sheet' && secDef.sheet) { renderSheetSection(sec, div); if (secDef.notes) { const nt = document.createElement('div'); nt.className = 'notes'; nt.textContent = secDef.notes; div.appendChild(nt); } chart.appendChild(div); return; }
      const bars = document.createElement('div'); bars.className = 'bars';
      bars.style.gridTemplateColumns = `repeat(${Math.min(4, Math.max(2, secDef.bars.length >= 4 ? 4 : secDef.bars.length))}, 1fr)`;
      for (let i = sec.start; i < sec.end; i++) {
        const b = tl.bars[i];
        const el = document.createElement('div'); el.className = 'bar' + (b.custom ? ' midi-bar' : ''); el.dataset.bar = i;
        el.innerHTML = `<span class="num">${b.barInSection + 1}${b.repeat ? `·${b.repeat + 1}` : ''}</span>` +
          b.chords.map((c, ci) => `<span class="chord" data-ci="${ci}">${esc(c.name)}</span>`).join('') +
          (b.fill ? '<span class="fill">fill</span>' : '');
        el.onclick = () => jumpTo(i);
        bars.appendChild(el);
      }
      div.appendChild(bars);
      if (secDef.notes) { const nt = document.createElement('div'); nt.className = 'notes'; nt.textContent = secDef.notes; div.appendChild(nt); }
      if (secDef.lyrics) { const ly = document.createElement('div'); ly.className = 'lyric'; ly.textContent = secDef.lyrics; div.appendChild(ly); }
      chart.appendChild(div);
    });
  }
  function renderBeats() {
    const b = $('beats'); b.innerHTML = '';
    for (let i = 0; i < tl.sig.beats; i++) { const d = document.createElement('div'); d.className = 'beat' + (i === 0 ? ' one' : ''); b.appendChild(d); }
  }

  /** Lines of a section's lyrics mapped to bars: an explicit per-bar array ("lyricBars"), or lines spread evenly across the section. */
  function lyricForBar(barIdx) {
    const bar = tl.bars[barIdx]; if (!bar) return ['', ''];
    const secDef = song.sections[bar.section]; const sec = tl.sections[bar.section];
    let lines = Array.isArray(secDef.lyricBars) ? secDef.lyricBars : null;
    if (!lines) {
      const raw = String(secDef.lyrics || '').split('\n').map(s => s.trim()).filter(Boolean);
      if (!raw.length) return ['', ''];
      lines = new Array(secDef.bars.length).fill('');
      raw.forEach((l, i) => { const b = Math.min(secDef.bars.length - 1, Math.floor(i * secDef.bars.length / raw.length)); lines[b] = lines[b] ? lines[b] + ' / ' + l : l; });
    }
    const bi = bar.barInSection;
    let cur = ''; for (let i = bi; i >= 0; i--) if (lines[i]) { cur = lines[i]; break; }
    let next = ''; for (let i = bi + 1; i < lines.length; i++) if (lines[i]) { next = lines[i]; break; }
    if (!next) { const ns = song.sections[bar.section + 1]; if (ns && ns.lyrics) next = String(ns.lyrics).split('\n').map(s => s.trim()).filter(Boolean)[0] || ''; }
    return [cur, next];
  }

  // Called every animation frame while playing, and on jumps
  function updateNow(pos, force) {
    if (!tl) return;
    const beatsPerBar = tl.sig.beats;
    if (pos < 0) { // count-in
      $('nowSection').textContent = 'Count-in'; currentSectionIdx = -1;
      const first = tl.bars[Math.floor(transport._countFrom || 0)];
      $('nowChord').textContent = first ? first.chords[0].name : '—';
      const beat = Math.floor((pos + 1) * beatsPerBar);
      setBeat(beat);
      $('barCounter').textContent = `Bar — / ${tl.total}`;
      return;
    }
    const barIdx = Math.min(tl.total - 1, Math.floor(pos));
    const bar = tl.bars[barIdx];
    if (!bar) return;
    const beatInBar = (pos - barIdx) * beatsPerBar;
    setBeat(Math.floor(beatInBar));
    // current chord within bar
    let chord = bar.chords[0];
    for (const c of bar.chords) if (beatInBar >= c.at - 1e-6) chord = c;
    $('nowChord').textContent = chord.name;
    const sec = tl.sections[bar.section];
    if (bar.section !== currentSectionIdx || force) {
      currentSectionIdx = bar.section;
      $('nowSection').textContent = sec.name;
      document.querySelectorAll('.section.current').forEach(e => e.classList.remove('current'));
      const se = document.querySelector(`.section[data-section="${bar.section}"]`);
      if (se) { se.classList.add('current'); if (viewMode() !== 'sheet') { const ch = $('chart'); ch.scrollTo({ top: se.offsetTop - ch.offsetTop - 8, behavior: 'smooth' }); } }
      renderLive();
      if ($('stemScope').value === 'live') renderStemMix(); // faders follow the section that's playing
    }
    const barsLeft = sec.end - barIdx;
    $('nextIn').textContent = `in ${barsLeft} bar${barsLeft === 1 ? '' : 's'}`;
    $('barCounter').textContent = `Bar ${barIdx + 1} / ${tl.total}  ·  ${sec.name} ${bar.barInSection + 1}/${sec.count}`;
    const [lyr, lyrNext] = lyricForBar(barIdx);
    if ($('nowLyric').textContent !== lyr) $('nowLyric').textContent = lyr;
    if ($('nextLyric').textContent !== lyrNext) $('nextLyric').textContent = lyrNext;
    // bar highlighting
    const el = document.querySelector(`.bar[data-bar="${barIdx}"]`);
    if (el !== currentBarEl || force) {
      if (currentBarEl) currentBarEl.classList.remove('now');
      document.querySelectorAll('.bar.done').forEach(e => e.classList.remove('done'));
      for (let i = 0; i < barIdx; i++) { const d = document.querySelector(`.bar[data-bar="${i}"]`); if (d && tl.bars[i].section === bar.section) d.classList.add('done'); }
      if (currentBarEl) currentBarEl.querySelectorAll('.chord.on').forEach(c => c.classList.remove('on'));
      currentBarEl = el; if (el) el.classList.add('now');
      updateSheetHighlight(barIdx);
    }
    if (el) el.querySelectorAll('.chord').forEach((c, i) => c.classList.toggle('on', bar.chords[i] === chord));
  }
  let lastBeat = -1;
  function setBeat(beat) {
    if (beat === lastBeat) return; lastBeat = beat;
    $('beats').querySelectorAll('.beat').forEach((d, i) => d.classList.toggle('on', i === beat));
  }

  function raf() {
    if (transport.playing) updateNow(transport.position());
    requestAnimationFrame(raf);
  }
  requestAnimationFrame(raf);

  // ---------- voice cues ----------
  function speak(text) {
    if (!prefs.voice || !('speechSynthesis' in window)) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text); u.rate = 1.15; u.volume = 1;
    speechSynthesis.speak(u);
  }
  transport.onBar = (barIdx) => {
    if (!tl) return;
    if (barIdx < 0) { lastSpokenBar = null; const s = tl.bars[transport._countFrom || 0]; if (s) speak(tl.sections[s.section].name); return; }
    if (barIdx === lastSpokenBar) return; lastSpokenBar = barIdx;
    const bar = tl.bars[barIdx]; if (!bar) return;
    const sec = tl.sections[bar.section];
    // announce the upcoming section one bar early (or two bars early for long sections)
    const lead = sec.count >= 8 ? 2 : 1;
    if (barIdx === sec.end - lead) {
      const n = transport.predictNext(bar.section);
      if (n === bar.section) speak(transport.hold ? 'Again' : 'One more');
      else if (n >= 0) speak(tl.sections[n].name);
      else speak('Ending');
    }
  };
  transport.onLive = () => renderLive();
  transport.onStop = () => { updateNow(transport._pausedPos || 0, true); setPlayUI(); setBeat(-1); releaseWake(); };

  // ---------- controls ----------
  function setPlayUI() { $('btnPlay').textContent = transport.playing ? '■ Stop' : '▶ Play'; $('btnPlay').classList.toggle('primary', !transport.playing); }
  // Hard jump (restarts with count-in when playing). Used when stopped, or for tapping a specific bar.
  function jumpTo(bar) {
    if (role === 'follower') return sendCmd({ cmd: 'jump', bar });
    transport.jumpTo(bar); updateNow(bar, true);
  }
  // ---- live arrangement (Prime-style) ----
  function queueSection(section, now) {
    if (!tl) return;
    if (role === 'follower') return sendCmd({ cmd: 'queue', section, now: !!now });
    if (!transport.playing) { transport.queueSection(section); updateNow(tl.sections[section].start, true); renderLive(); return; }
    if (transport.queued && transport.queued.section === section && !now) transport.clearQueue(); // tap again to un-queue
    else transport.queueSection(section, now);
  }
  function setHold(on) { if (role === 'follower') return sendCmd({ cmd: 'hold', on }); transport.setHold(on); }
  function addExtra() { if (role === 'follower') return sendCmd({ cmd: 'extra' }); transport.addExtra(1); }
  function goNow() { if (role === 'follower') return sendCmd({ cmd: 'go' }); transport.goNow(); }
  function renderPads() {
    const p = $('pads'); p.innerHTML = '';
    tl.sections.forEach(sec => {
      const b = document.createElement('button'); b.className = 'pad'; b.dataset.section = sec.index;
      b.innerHTML = `<span class="pname">${esc(sec.name)}</span><span class="pmeta">${sec.count} bars</span>`;
      b.onclick = () => queueSection(sec.index, false);
      // long-press (or right-click) = go at the next bar
      let timer; b.onpointerdown = () => { timer = setTimeout(() => { timer = null; queueSection(sec.index, true); }, 550); };
      b.onpointerup = b.onpointerleave = () => { if (timer) clearTimeout(timer); };
      b.oncontextmenu = e => { e.preventDefault(); queueSection(sec.index, true); };
      p.appendChild(b);
    });
    renderLive();
  }
  function renderLive() {
    if (!tl) return;
    const cur = tl.bars[transport.currentBar()] ? tl.bars[transport.currentBar()].section : 0;
    document.querySelectorAll('.pad').forEach(el => {
      const i = +el.dataset.section;
      el.classList.toggle('current', i === cur);
      el.classList.toggle('held', i === cur && (transport.hold || transport.extra > 0));
      el.classList.toggle('queued', !!transport.queued && transport.queued.section === i);
      el.classList.toggle('done', i < cur && !(transport.queued && transport.queued.section === i));
      const meta = el.querySelector('.pmeta'); const sec = tl.sections[i];
      meta.textContent = `${sec.count} bars` + (i === cur && transport.extra > 0 ? ` · +${transport.extra}` : '') + (transport.queued && transport.queued.section === i ? (transport.queued.now ? ' · next bar' : ' · queued') : '');
    });
    const curPad = document.querySelector('.pad.current'); if (curPad) curPad.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
    $('btnHold').classList.toggle('on', transport.hold);
    $('btnExtra').textContent = transport.extra > 0 ? `+${transport.extra} pass${transport.extra > 1 ? 'es' : ''}` : '+1 pass';
    $('btnExtra').classList.toggle('on', transport.extra > 0);
    $('btnGo').classList.toggle('armed', !!transport.queued && transport.queued.now);
    // "Next:" readout
    const n = transport.predictNext(cur);
    $('nextSection').textContent = n === cur ? (transport.hold ? `${tl.sections[cur].name} (hold)` : `${tl.sections[cur].name} again`) : n >= 0 ? tl.sections[n].name : 'End';
  }
  $('btnHold').onclick = () => setHold(!transport.hold);
  $('btnExtra').onclick = addExtra;
  $('btnGo').onclick = goNow;
  function play() {
    if (!tl) return;
    if (role === 'follower') return sendCmd({ cmd: transport.playing ? 'stop' : 'play' });
    if (transport.playing) transport.stop();
    else { transport.countIn = $('chkCountIn').checked; transport.start(transport._pausedPos || 0); requestWake(); }
    setPlayUI();
  }
  function sectionStep(dir) {
    if (!tl) return;
    const cur = tl.bars[transport.currentBar()].section;
    const target = Math.min(tl.sections.length - 1, Math.max(0, cur + dir));
    if (transport.playing) queueSection(target, true); else jumpTo(tl.sections[target].start);
  }
  $('btnPlay').onclick = play;
  $('btnPrev').onclick = () => sectionStep(-1);
  $('btnNext').onclick = () => sectionStep(1);
  $('chkCountIn').checked = prefs.countIn; $('chkCountIn').onchange = () => { prefs.countIn = $('chkCountIn').checked; savePrefs(); };
  $('chkVoice').checked = prefs.voice; $('chkVoice').onchange = () => { prefs.voice = $('chkVoice').checked; savePrefs(); };
  $('chkFollowerAudio').checked = prefs.followerAudio; $('chkFollowerAudio').onchange = () => { prefs.followerAudio = $('chkFollowerAudio').checked; savePrefs(); applyRoleAudio(); };
  function setBpm(v) {
    if (role === 'follower') return sendCmd({ cmd: 'bpm', bpm: v });
    transport.setBpm(v); $('bpm').value = transport.bpm; if (song) { song.bpm = transport.bpm; persistSongs(); }
  }
  $('bpm').onchange = () => setBpm(+$('bpm').value);
  $('tempoDown').onclick = () => setBpm(transport.bpm - 2);
  $('tempoUp').onclick = () => setBpm(transport.bpm + 2);
  document.addEventListener('keydown', e => {
    if (e.target.matches('input,textarea,select')) return;
    if (e.code === 'Space') { e.preventDefault(); play(); }
    else if (e.key === 'ArrowRight') sectionStep(1);
    else if (e.key === 'ArrowLeft') sectionStep(-1);
    else if (e.key === 'l' || e.key === 'h') setHold(!transport.hold);
    else if (e.key === '+' || e.key === '=') addExtra();
    else if (e.key === 'Enter') goNow();
    else if (/^[1-9]$/.test(e.key) && tl && tl.sections[+e.key - 1]) queueSection(+e.key - 1, e.shiftKey);
    else if (e.key === 'f') document.body.classList.toggle('perform');
  });
  // double-tap the now-bar to hide the sidebar (performance mode)
  let lastTap = 0; $('nowSection').parentElement.addEventListener('click', () => { const t = Date.now(); if (t - lastTap < 350) document.body.classList.toggle('perform'); lastTap = t; });

  // mix
  const mixMap = { volKick: 'kick', volSnare: 'snare', volHat: 'hat', volCym: 'cym', volTom: 'tom', volPerc: 'perc', volClick: 'click' };
  for (const [id, bus] of Object.entries(mixMap)) {
    const el = $(id); if (prefs[id] != null) el.value = prefs[id];
    kit.setLevel(bus, +el.value);
    el.oninput = () => { kit.setLevel(bus, +el.value); prefs[id] = +el.value; savePrefs(); };
  }
  if (prefs.volMaster != null) $('volMaster').value = prefs.volMaster;
  kit.setMaster(+$('volMaster').value);
  $('volMaster').oninput = () => { kit.setMaster(+$('volMaster').value); prefs.volMaster = +$('volMaster').value; savePrefs(); };

  // wake lock (keeps iPad/laptop screen on)
  async function requestWake() { try { if ('wakeLock' in navigator && !wakeLock) wakeLock = await navigator.wakeLock.request('screen'); } catch {} }
  function releaseWake() { try { wakeLock && wakeLock.release(); } catch {} wakeLock = null; }

  // ---------- import / edit / export ----------
  const grooveNames = Object.keys(SD.GROOVES);
  $('impGroove').innerHTML = grooveNames.map(g => `<option value="${g}">${g} — ${SD.GROOVES[g].desc}</option>`).join('');
  $('grooveList').textContent = grooveNames.join(', ');
  $('btnNewSong').onclick = () => { $('dlgImport').showModal(); };
  $('dlgImport').addEventListener('close', () => {
    if ($('dlgImport').returnValue !== 'ok') return;
    const text = $('impText').value.trim(); if (!text) return;
    try {
      if ($('impAttach').checked && song) {
        const n = SD.attachSheet(song, text); persistSongs(); prefs.view = 'sheet'; savePrefs(); selectSong(song); broadcastSong();
        $('impText').value = ''; alert(n ? `Attached lyrics and chords to ${n} section${n === 1 ? '' : 's'} of "${song.title}".` : 'No sections matched — check the [Verse]/[Chorus] headers.');
        return;
      }
      let s;
      if (text.startsWith('{')) { s = JSON.parse(text); s.id = s.id || 'song-' + Date.now().toString(36); }
      else s = SD.parseChordSheet(text, { title: $('impTitle').value, artist: $('impArtist').value, bpm: +$('impBpm').value, time: $('impTime').value, groove: $('impGroove').value, barsPerLine: +$('impBarsPerLine').value });
      if ($('impTitle').value) s.title = $('impTitle').value;
      if ($('impArtist').value) s.artist = $('impArtist').value;
      songs.push(s); persistSongs(); transport.stop(); selectSong(s); broadcastSong();
      $('impText').value = ''; $('impTitle').value = ''; $('impArtist').value = '';
    } catch (e) { alert('Import failed: ' + e.message); }
  });
  $('btnAiPrompt').onclick = async () => {
    const p = SD.aiPrompt($('impText').value, { title: $('impTitle').value, artist: $('impArtist').value });
    try { await navigator.clipboard.writeText(p); alert('Prompt copied. Paste it (with the chord sheet) into Claude/ChatGPT, then paste the JSON it returns back here and Import.'); }
    catch { prompt('Copy this prompt:', p); }
  };
  $('btnEdit').onclick = () => { if (!song) return; $('editText').value = JSON.stringify(song, null, 2); $('dlgEdit').showModal(); };
  $('dlgEdit').addEventListener('close', () => {
    if ($('dlgEdit').returnValue !== 'ok') return;
    try {
      const s = JSON.parse($('editText').value); s.id = song.id;
      songs[songs.indexOf(song)] = s; persistSongs(); transport.stop(); selectSong(s); broadcastSong();
    } catch (e) { alert('Invalid JSON: ' + e.message); }
  });
  $('btnExport').onclick = () => {
    if (!song) return;
    const blob = new Blob([JSON.stringify(song, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = song.title.replace(/[^\w]+/g, '_') + '.json'; a.click();
  };
  $('btnDelete').onclick = () => {
    if (!song || !confirm(`Delete "${song.title}"?`)) return;
    songs = songs.filter(s => s !== song); persistSongs(); transport.stop(); selectSong(songs[0]);
  };

  // ---------- MIDI ----------
  const midiOut = new SD.MidiOut();
  async function initMidi() {
    try {
      const outs = await midiOut.init(ctx);
      const sel = $('midiOut');
      sel.innerHTML = '<option value="">MIDI out: off</option>' + outs.map(o => `<option value="${o.id}">${esc(o.name)}</option>`).join('');
      if (prefs.midiOut && outs.some(o => o.id === prefs.midiOut)) { sel.value = prefs.midiOut; midiOut.select(prefs.midiOut); transport.midi = midiOut; }
      midiOut.access.onstatechange = () => initMidi();
    } catch (e) { $('midiOut').innerHTML = '<option value="">MIDI out: unavailable</option>'; $('midiOut').title = e.message; }
  }
  $('midiOut').onchange = () => {
    prefs.midiOut = $('midiOut').value; savePrefs();
    midiOut.select(prefs.midiOut); transport.midi = midiOut.port ? midiOut : null;
  };
  $('midiOut').addEventListener('pointerdown', () => { if (!midiOut.access) initMidi(); }, { once: true });
  $('chkMidiNotes').onchange = () => { midiOut.sendNotes = $('chkMidiNotes').checked; };
  $('chkMidiClock').onchange = () => { midiOut.sendClock = $('chkMidiClock').checked; };
  $('btnMidiExport').onclick = () => {
    if (!song) return;
    const bytes = SD.exportMidi(song);
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([bytes], { type: 'audio/midi' }));
    a.download = song.title.replace(/[^\w]+/g, '_') + '.mid'; a.click();
  };
  $('btnMidiImport').onclick = () => { if (song) $('midiFile').click(); };
  $('midiFile').onchange = async () => {
    const f = $('midiFile').files[0]; if (!f) return;
    try {
      const parsed = SD.parseMidi(await f.arrayBuffer());
      const res = SD.midiToBars(parsed, song.time);
      const filled = res.bars.filter(Boolean).length;
      if (!filled) throw new Error('No drum notes found (looked for GM drum notes 35–59).');
      const useTempo = res.bpm && res.bpm !== song.bpm && confirm(`MIDI file tempo is ${res.bpm} BPM (song is ${song.bpm}). Use ${res.bpm}?`);
      song.midiBars = res.bars; if (useTempo) song.bpm = res.bpm;
      persistSongs(); transport.stop(); selectSong(song); broadcastSong();
      $('midiInfo').textContent = `Imported ${filled} bars of drums from ${f.name} (${res.bars.length} bars total; song has ${tl.total}). Bars marked ♪ play the imported part; others fall back to grooves.`;
    } catch (e) { alert('MIDI import failed: ' + e.message); }
    $('midiFile').value = '';
  };
  $('btnMidiClear').onclick = () => { if (song && song.midiBars) { delete song.midiBars; persistSongs(); transport.stop(); selectSong(song); broadcastSong(); } };

  // ---------- sync roles ----------
  function setSyncStatus(text, cls) { const p = $('syncStatus'); p.textContent = text; p.className = 'pill ' + (cls || ''); }
  function defaultWsUrl() {
    if (location.protocol.startsWith('http') && location.hostname && location.hostname !== '' && !/github\.io|pages\.dev|netlify/.test(location.hostname))
      return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
    return prefs.syncUrl || '';
  }
  function applyRoleAudio() { transport.audible = role !== 'follower' || prefs.followerAudio; }
  function connect(url) {
    if (sync) sync.close(); sync = null;
    if (!url) { setSyncStatus('offline'); return; }
    prefs.syncUrl = url; savePrefs();
    sync = new SD.SyncClient(url, role, {
      onStatus: (s) => setSyncStatus(s.connected ? `${role} · ±${(s.rtt / 2).toFixed(0)}ms` : 'reconnecting…', s.connected ? 'ok' : 'warn'),
      onMessage: onSyncMessage,
    });
    setSyncStatus('connecting…', 'warn');
    if (role === 'host') setTimeout(() => { broadcastSong(); broadcastState(); }, 1200);
  }
  function broadcastSong() { if (sync && role === 'host' && song) sync.send({ type: 'song', song }); }
  let lastState = null;
  function broadcastState() { if (lastState && sync && role === 'host') sync.send(lastState); }
  transport.onAnchor = (st) => {
    if (role !== 'host') return;
    lastState = { type: 'state', songId: song && song.id, playing: st.playing, bpm: st.bpm, hold: st.hold, extra: st.extra, queued: st.queued, pausedPos: st.pausedPos,
      anchorBar: st.anchorBar, anchorServerMs: sync ? SD.ctxToServer(ctx, sync, st.anchorCtxTime) : 0, countIn: st.countIn, barSec: st.barSec, audio: st.audio };
    if (sync && sync.connected) sync.send(lastState);
  };
  function onSyncMessage(m) {
    if (m.type === 'updated') { showBanner(m.version); return; }
    if (role === 'host' && m.type === 'cmd') {
      switch (m.cmd) {
        case 'play': if (!transport.playing) play(); break;
        case 'stop': if (transport.playing) play(); break;
        case 'jump': jumpTo(m.bar); break;
        case 'bpm': setBpm(m.bpm); break;
        case 'hold': setHold(!!m.on); break;
        case 'extra': addExtra(); break;
        case 'go': goNow(); break;
        case 'queue': queueSection(m.section, m.now); break;
        case 'stem': if (song && song.audio) { const a = song.audio; a.mix = a.mix || {}; a.mute = a.mute || {};
            if (m.section != null) { const sc = song.sections[m.section]; if (sc) { sc.stems = sc.stems || {}; sc.stems[m.k] = m.level; } }
            else a.mix[m.k] = m.level;
            a.mute[m.k] = !!m.mute; applyStemsNow(); persistSongs(); renderStemMix(); broadcastSong(); } break;
      }
      return;
    }
    if (role !== 'follower') return;
    if (m.type === 'song') {
      const s = m.song; const i = songs.findIndex(x => x.id === s.id);
      if (i >= 0) songs[i] = s; else songs.push(s); persistSongs();
      const noAudio = x => JSON.stringify(Object.assign({}, x, { audio: null, sections: x.sections.map(sc => Object.assign({}, sc, { stems: null })) }));
      if (song && s.id === song.id && noAudio(s) === noAudio(song)) { // only the stem mix changed: keep playing, just update the faders
        song.audio = s.audio; s.sections.forEach((sc, i) => { if (sc.stems) song.sections[i].stems = sc.stems; else delete song.sections[i].stems; });
        renderStemMix(); return; }
      selectSong(s); return;
    }
    if (m.type === 'state') {
      if (song && m.songId && m.songId !== song.id) { const s = songs.find(x => x.id === m.songId); if (s) selectSong(s); }
      if (!tl) return;
      transport.syncTo(m, SD.serverToCtx(ctx, sync, m.anchorServerMs));
      $('bpm').value = transport.bpm; setPlayUI(); renderLive();
      if (!m.playing) { updateNow(m.pausedPos || 0, true); setBeat(-1); }
      else requestWake();
    }
  }
  function sendCmd(c) { if (sync) sync.send(Object.assign({ type: 'cmd' }, c)); }

  $('roleSelect').value = prefs.role || 'solo';
  $('roleSelect').onchange = () => {
    role = $('roleSelect').value; prefs.role = role; savePrefs(); applyRoleAudio();
    transport.stop(true); setPlayUI(); applyBacking();
    if (role === 'solo') { connect(null); return; }
    const url = defaultWsUrl();
    if (url && role === 'host') { connect(url); return; }
    $('syncUrl').value = url;
    if (location.protocol === 'https:') alert('Heads up: this page is loaded over HTTPS, so the browser will block a ws:// connection to your computer. For synced shows, open the app from the computer\'s own server (http://<computer-ip>:8080) on both devices instead.');
    $('dlgSync').showModal();
  };
  $('dlgSync').addEventListener('close', () => {
    if ($('dlgSync').returnValue !== 'ok') { $('roleSelect').value = 'solo'; role = 'solo'; return; }
    connect($('syncUrl').value.trim());
  });
  role = prefs.role || 'solo'; applyRoleAudio();
  if (role !== 'solo') { const u = defaultWsUrl(); if (u) connect(u); else { role = 'solo'; $('roleSelect').value = 'solo'; } }

  // ---------- band (bass / keys / guitar) ----------
  const band = new SD.Band(ctx, kit.comp); transport.band = band; // band joins after the drum saturation, before the bus compressor
  const fillSel = (id, obj) => { $(id).innerHTML = Object.keys(obj).map(k => `<option value="${k}">${k}</option>`).join(''); };
  fillSel('bandBass', SD.BASS_PATTERNS); fillSel('bandKeys', SD.KEYS_KINDS); fillSel('bandGtr', SD.GTR_PATTERNS);
  function syncBandUI() { const b = Object.assign({ bass: 'off', keys: 'off', gtr: 'off' }, song && song.band || {}); $('bandBass').value = b.bass; $('bandKeys').value = b.keys; $('bandGtr').value = b.gtr; }
  for (const [id, k] of [['bandBass', 'bass'], ['bandKeys', 'keys'], ['bandGtr', 'gtr']]) $(id).onchange = () => { if (!song) return; song.band = Object.assign({}, song.band || {}, { [k]: $(id).value }); persistSongs(); broadcastSong(); };
  for (const [id, k] of [['volBass', 'bass'], ['volKeys', 'keys'], ['volGtr', 'gtr']]) { const el = $(id); if (prefs[id] != null) el.value = prefs[id]; band.setLevel(k, +el.value); el.oninput = () => { band.setLevel(k, +el.value); prefs[id] = +el.value; savePrefs(); }; }

  // ---------- backing track: a real recording (e.g. the record with the vocals removed) instead of synth drums + band ----------
  const audioCache = {}; let audioLoadToken = 0;
  const STEM_LABELS = { drums: 'Drums', bass: 'Bass', other: 'Other', guitar: 'Guitar', rhythm: 'Rhythm guitar', lead: 'Lead guitar', acoustic: 'Acoustic guitar',
    piano: 'Piano', keys: 'Keys', organ: 'Organ', vocals: 'Vocals', backing: 'Backing vocals', mix: 'Recording',
    kick: 'Kick', snare: 'Snare', toms: 'Toms', hats: 'Hi-hat', cymbals: 'Cymbals', perc: 'Percussion', center: 'Guitar (centre)', sides: 'Guitar (wide)' };
  const STEM_ORDER = ['mix', 'drums', 'kick', 'snare', 'toms', 'hats', 'cymbals', 'perc', 'bass', 'guitar', 'rhythm', 'lead', 'acoustic', 'center', 'sides', 'piano', 'keys', 'organ', 'other', 'vocals', 'backing'];
  const stemSort = (a, b) => { const i = STEM_ORDER.indexOf(a), j = STEM_ORDER.indexOf(b); return (i < 0 ? 99 : i) - (j < 0 ? 99 : j) || a.localeCompare(b); };
  const stemLabel = k => STEM_LABELS[k] || k.replace(/^\w/, c => c.toUpperCase());
  /** The files a song's audio refers to: {stemName: url}. A single file counts as one stem called "mix". */
  function audioFiles(a) {
    let f = a ? (a.stems && Object.keys(a.stems).length ? a.stems : (a.file ? { mix: a.file } : {})) : {};
    if (a && a.kit && Object.keys(a.kit).length && a.splitDrums) { f = Object.assign({}, f, a.kit); delete f.drums; } // kit parts replace the drums stem
    const out = {}; for (const k of Object.keys(f).sort(stemSort)) out[k] = f[k]; return out; // kit parts first, vocals last
  }
  function audioName(a) { const f = audioFiles(a); const ks = Object.keys(f); return ks.length === 1 && ks[0] === 'mix' ? f.mix.split('/').pop() : ks.length + ' stems (' + ks.map(stemLabel).join(', ') + ')'; }
  function setAudioStatus(msg) {
    if (msg) { $('audioStatus').textContent = msg; return; }
    const a = song && song.audio, has = Object.keys(audioFiles(a)).length > 0;
    if (transport.audio) { const d = transport.audio.duration; $('audioStatus').textContent = `Playing ${audioName(a)} (${Math.floor(d / 60)}:${String(Math.round(d % 60)).padStart(2, '0')}). Chart follows the recording; drums & band are muted.`; }
    else if (has && (prefs.backing || 'audio') !== 'audio') $('audioStatus').textContent = 'Synth drums + band (a recording is available — switch Source to use it).';
    else if (role === 'follower') $('audioStatus').textContent = 'Follower: the host plays the recording.';
    else $('audioStatus').textContent = 'No recording for this song — using synth drums + band. Add the song with "Load audio file…", or separated stems (drums / bass / vocals / other) with "Load stems…" to mix them on stage.';
    $('bpm').disabled = !!transport.audio;
  }
  /**
   * Per-stem faders + mute buttons. Levels live in `song.audio.mix` (whole song) and `section.stems` (per-section
   * overrides, applied automatically at the bar line when that section starts); `song.audio.mute` is a global kill.
   * The "Mixing" selector says which of those the faders are editing.
   */
  function scopeIdx() { // null = whole song; otherwise a section index
    const v = $('stemScope').value;
    if (v === 'song') return null;
    if (v === 'live') return song ? tl.bars[Math.max(0, Math.min(tl.total - 1, transport.currentBar()))].section : null;
    return +v;
  }
  function renderStemScope() {
    const sel = $('stemScope'), keep = sel.value || 'song';
    const secs = song ? song.sections : [];
    sel.innerHTML = `<option value="song">the whole song</option><option value="live">the section playing now</option>`
      + secs.map((sc, i) => `<option value="${i}">${esc(sc.name || 'Section ' + (i + 1))}${sc.stems && Object.keys(sc.stems).length ? ' •' : ''}</option>`).join('');
    sel.value = [...sel.options].some(o => o.value === keep) ? keep : 'song';
  }
  function renderStemMix() {
    const box = $('stemMix'); box.innerHTML = '';
    const a = song && song.audio, files = audioFiles(a); const keys = Object.keys(files);
    const show = keys.length > 1 || (keys.length === 1 && keys[0] !== 'mix');
    box.classList.toggle('has', show); $('stemScopeRow').hidden = !show;
    const hasKit = !!(a && a.kit && Object.keys(a.kit).length);
    $('splitDrumsRow').hidden = !hasKit; $('chkSplitDrums').checked = !!(a && a.splitDrums);
    if (!show) return;
    a.mix = a.mix || {}; a.mute = a.mute || {};
    renderStemScope();
    const si = scopeIdx(), sec = si == null ? null : song.sections[si];
    if (sec && !sec.stems) sec.stems = {};
    for (const k of keys) {
      const base = a.mix[k] ?? (k === 'vocals' ? 0 : 1);
      const lvl = sec ? (sec.stems[k] ?? base) : base;
      const row = document.createElement('div'); row.className = 'stem';
      const over = sec && sec.stems[k] != null;
      row.innerHTML = `<span>${esc(stemLabel(k))}${over ? ' <b title="set for this section">•</b>' : ''}</span>`
        + `<input type="range" min="0" max="1.5" step="0.01" value="${lvl}">`
        + `<button class="small ${a.mute[k] ? 'on' : ''}" title="${sec ? 'Silence this stem in this section' : 'Mute everywhere'}">M</button>`;
      const range = row.querySelector('input'), mute = row.querySelector('button');
      const push = () => { if (role === 'follower') sendCmd({ cmd: 'stem', k, level: +range.value, mute: !!a.mute[k], section: si }); else { applyStemsNow(); persistSongs(); } };
      range.oninput = () => { if (sec) sec.stems[k] = +range.value; else a.mix[k] = +range.value; if (role !== 'follower') applyStemsNow(); };
      range.onchange = () => { push(); if (role !== 'follower') { broadcastSong(); renderStemMix(); } };
      mute.onclick = () => {
        if (sec) { sec.stems[k] = sec.stems[k] > 0 || sec.stems[k] == null ? 0 : base; }
        else a.mute[k] = !a.mute[k];
        if (role !== 'follower') { applyStemsNow(); persistSongs(); broadcastSong(); }
        else sendCmd({ cmd: 'stem', k, level: sec ? sec.stems[k] : +range.value, mute: !!a.mute[k], section: si });
        renderStemMix();
      };
      box.appendChild(row);
    }
    if (sec && Object.keys(sec.stems).length) {
      const b = document.createElement('button'); b.className = 'small'; b.textContent = 'Use the song mix for ' + (sec.name || 'this section');
      b.onclick = () => { delete sec.stems; if (role !== 'follower') { applyStemsNow(); persistSongs(); broadcastSong(); } renderStemMix(); };
      box.appendChild(b);
    }
  }
  $('chkSplitDrums').onchange = () => {
    if (!song || !song.audio) return;
    song.audio.splitDrums = $('chkSplitDrums').checked; persistSongs(); broadcastSong();
    applyBacking(); // the set of stems changed, so the buffers are reloaded
  };
  $('stemScope').onchange = () => { prefs.stemScope = $('stemScope').value; savePrefs(); renderStemMix(); };
  if (prefs.stemScope) { const o = document.createElement('option'); o.value = prefs.stemScope; $('stemScope').appendChild(o); $('stemScope').value = prefs.stemScope; }
  /** Levels for a bar: song mix, overridden by the section's own stems, with global mutes on top. */
  function mixForBar(bar) {
    const a = song && song.audio; if (!a) return {};
    const sec = tl && tl.bars[bar] ? song.sections[tl.bars[bar].section] : null;
    const m = {};
    for (const k of Object.keys(audioFiles(a))) {
      let v = (a.mix && a.mix[k]) ?? (k === 'vocals' ? 0 : 1);
      if (sec && sec.stems && sec.stems[k] != null) v = sec.stems[k];
      m[k] = (a.mute && a.mute[k]) ? 0 : v;
    }
    return m;
  }
  /** Apply the mix for wherever we are right now (used when a fader moves mid-song). */
  function applyStemsNow() {
    if (!transport.audio) return;
    const m = mixForBar(transport.playing ? transport.currentBar() : (transport._pausedPos || 0));
    for (const k of Object.keys(m)) transport.setStemGain(k, m[k]);
  }
  transport.stemMixFor = bar => mixForBar(bar);
  async function applyBacking() {
    const token = ++audioLoadToken;
    transport.setAudio(null);
    $('backingMode').value = prefs.backing || 'audio';
    const a = song && song.audio, files = audioFiles(a);
    renderStemMix();
    if (!Object.keys(files).length || role === 'follower' || (prefs.backing || 'audio') !== 'audio') { setAudioStatus(); return; }
    setAudioStatus('Loading recording…');
    const missing = [];
    try {
      const stems = {};
      await Promise.all(Object.entries(files).map(async ([k, url]) => {
        let buf = audioCache[url];
        if (!buf) { try { const r = await fetch(url); if (!r.ok) throw new Error('missing'); buf = await ctx.decodeAudioData(await r.arrayBuffer()); audioCache[url] = buf; } catch { missing.push(url.split('/').pop()); return; } }
        stems[k] = buf;
      }));
      if (token !== audioLoadToken) return;
      if (!Object.keys(stems).length) throw new Error('missing');
      transport.setAudio({ stems, mix: mixForBar(transport._pausedPos || 0), barTimes: a.barTimes, offset: a.offset || 0, gain: +$('volAudio').value, name: audioName(a) });
      setAudioStatus(); if (missing.length) setAudioStatus($('audioStatus').textContent + ` Missing on this computer: ${missing.join(', ')}.`);
    } catch (e) {
      setAudioStatus(`${audioName(a)} isn't on this computer — using synth drums + band. Add it with "Load audio file…" / "Load stems…" (files go in drum-daw/local/audio/).`);
    }
  }
  $('backingMode').onchange = () => { prefs.backing = $('backingMode').value; savePrefs(); transport.stop(true); setPlayUI(); applyBacking(); };
  if (prefs.volAudio != null) $('volAudio').value = prefs.volAudio;
  $('volAudio').oninput = () => { prefs.volAudio = +$('volAudio').value; savePrefs(); transport.setAudioGain(prefs.volAudio); };
  const hostOnly = () => { if (!song) return false; if (role === 'follower') { alert('Load the recording on the host computer (it plays the audio).'); return false; } return true; };
  $('btnAudioLoad').onclick = () => { if (hostOnly()) $('audioFile').click(); };
  $('btnStemsLoad').onclick = () => { if (hostOnly()) $('stemFiles').click(); };
  /** Where the music starts in a buffer (first onset) — the chart's bpm grid is laid from there when no bar times are known. */
  function firstOnset(buf) { const ch = buf.getChannelData(0); let pk = 0; for (let i = 0; i < ch.length; i += 4) pk = Math.max(pk, Math.abs(ch[i])); let on = 0; while (on < ch.length && Math.abs(ch[on]) < pk * 0.08) on++; return on / buf.sampleRate; }
  async function saveAudio(file, bytes) { try { const r = await fetch('/api/' + file.replace(/^local\//, ''), { method: 'POST', body: bytes }); return r.ok; } catch { return false; } }
  function stemNameFor(filename) {
    const n = filename.toLowerCase();
    for (const k of ['kick', 'snare', 'toms', 'hats', 'cymbals', 'rhythm', 'lead', 'acoustic', 'drums', 'bass', 'vocals', 'guitar', 'piano', 'keys', 'other']) if (n.includes(k)) return k;
    if (/bombo|bass ?drum|\bbd\b/.test(n)) return 'kick'; if (/redoblante|snr/.test(n)) return 'snare'; if (/platillos|cymbal|ride|crash/.test(n)) return 'cymbals'; if (/hi-?hat|hh/.test(n)) return 'hats';
    if (/drum|kit/.test(n)) return 'drums'; if (/perc/.test(n)) return 'perc'; if (/vox|vocal|voice|sing/.test(n)) return 'vocals'; if (/gtr|guit/.test(n)) return 'guitar'; if (/key|organ|synth|pad/.test(n)) return 'keys';
    return filename.replace(/\.\w+$/, '').replace(/[^\w-]/g, '_').slice(0, 20);
  }
  $('audioFile').onchange = async () => {
    const f = $('audioFile').files[0]; $('audioFile').value = ''; if (!f || !song) return;
    const ext = (f.name.match(/\.(\w+)$/) || [, 'mp3'])[1].toLowerCase();
    const file = 'local/audio/' + song.id.replace(/[^\w-]/g, '_') + '.' + ext;
    setAudioStatus('Reading ' + f.name + '…');
    try {
      const bytes = await f.arrayBuffer();
      const buf = await ctx.decodeAudioData(bytes.slice(0));
      const keep = song.audio && song.audio.barTimes && song.audio.file === file; // re-loading the same file keeps hand-fitted bar times
      song.audio = Object.assign({}, song.audio || {}, { file, offset: keep ? song.audio.offset : firstOnset(buf) });
      delete song.audio.stems; if (!keep) delete song.audio.barTimes;
      audioCache[file] = buf;
      const saved = await saveAudio(file, bytes);
      persistSongs(); broadcastSong(); prefs.backing = 'audio'; savePrefs();
      await applyBacking();
      if (!saved) setAudioStatus($('audioStatus').textContent + ' (Not saved: run the app from its own server on this computer to keep it for next time.)');
    } catch (e) { setAudioStatus('Could not read that file: ' + e.message); }
  };
  $('stemFiles').onchange = async () => {
    const list = [...$('stemFiles').files]; $('stemFiles').value = ''; if (!list.length || !song) return;
    const dir = 'local/audio/' + song.id.replace(/[^\w-]/g, '_') + '/';
    setAudioStatus(`Reading ${list.length} stems…`);
    try {
      const a = song.audio = Object.assign({}, song.audio || {}); delete a.file;
      const sameSet = a.stems && Object.values(a.stems).every(u => u.startsWith(dir));
      a.stems = sameSet ? a.stems : {}; let unsaved = 0, longest = null;
      for (const f of list) {
        const ext = (f.name.match(/\.(\w+)$/) || [, 'mp3'])[1].toLowerCase(), k = stemNameFor(f.name), file = dir + k + '.' + ext;
        const bytes = await f.arrayBuffer(); const buf = await ctx.decodeAudioData(bytes.slice(0));
        audioCache[file] = buf; a.stems[k] = file; if (!longest || buf.duration > longest.duration) longest = buf;
        if (!await saveAudio(file, bytes)) unsaved++;
      }
      if (!a.barTimes && longest) a.offset = firstOnset(longest);
      persistSongs(); broadcastSong(); prefs.backing = 'audio'; savePrefs();
      await applyBacking();
      if (unsaved) setAudioStatus($('audioStatus').textContent + ` (${unsaved} not saved: run the app from its own server on this computer to keep them.)`);
    } catch (e) { setAudioStatus('Could not read those files: ' + e.message); }
  };
  function nudgeAudio(d) {
    if (!song || !song.audio) return;
    song.audio.offset = +((song.audio.offset || 0) + d).toFixed(3);
    if (song.audio.barTimes) song.audio.barTimes = song.audio.barTimes.map(t => +(t + d).toFixed(3));
    transport.nudgeAudio(d); persistSongs(); broadcastSong();
    setAudioStatus(`Chart moved ${d > 0 ? 'later' : 'earlier'} by ${Math.round(Math.abs(d) * 1000)} ms (offset ${song.audio.offset.toFixed(3)} s).`);
  }
  $('btnAudioNudgeL').onclick = () => nudgeAudio(-0.05);
  $('btnAudioNudgeR').onclick = () => nudgeAudio(0.05);
  $('btnAudioClear').onclick = () => { if (!song || !song.audio) return; if (!confirm('Remove the recording from this song? (The files stay in local/audio/.)')) return; delete song.audio; persistSongs(); broadcastSong(); applyBacking(); };

  // ---------- drum kit (samples) ----------
  let kits = [];
  async function loadKit(id) {
    const k = kits.find(x => x.id === id) || kits[0];
    if (!k || !k.url) { kit.setMode('synth'); $('kitStatus').textContent = 'Synthesized drums'; return; }
    $('kitStatus').textContent = 'Loading ' + k.name + '…';
    try { await kit.loadSamples(k.url); kit.setMode('acoustic'); $('kitStatus').textContent = kit.kitName; }
    catch (e) { console.warn('kit load failed', e); kit.setMode('synth'); $('kitStatus').textContent = 'Kit unavailable — using synth'; }
  }
  $('kitSelect').onchange = () => { prefs.kit = $('kitSelect').value; savePrefs(); loadKit(prefs.kit); };
  $('chkVintage').checked = prefs.vintage !== false; kit.setBus($('chkVintage').checked ? 'vintage' : 'clean');
  $('chkVintage').onchange = () => { prefs.vintage = $('chkVintage').checked; savePrefs(); kit.setBus(prefs.vintage ? 'vintage' : 'clean'); };
  (async () => {
    try { kits = await (await fetch('kits/index.json')).json(); } catch { kits = [{ id: 'synth', name: 'Synth kit' }]; }
    $('kitSelect').innerHTML = kits.map(k => `<option value="${k.id}">${esc(k.name)}</option>`).join('');
    const want = kits.some(k => k.id === prefs.kit) ? prefs.kit : kits[0].id;
    $('kitSelect').value = want; loadKit(want);
  })();

  // ---------- version & updates ----------
  let localVersion = null, hasServer = false, updateInfo = null;
  async function loadVersion() {
    try { localVersion = await (await fetch('version.json?t=' + Date.now(), { cache: 'no-store' })).json(); } catch { localVersion = { version: '?' }; }
    $('btnVersion').textContent = 'v' + localVersion.version;
    try { const r = await fetch('/api/version', { cache: 'no-store' }); hasServer = r.ok && (await r.json()).server === true; } catch { hasServer = false; }
    if (hasServer && role !== 'follower') checkUpdates(true);
  }
  async function checkUpdates(quiet) {
    $('updLocal').textContent = 'v' + (localVersion ? localVersion.version : '?');
    $('updNotes').textContent = localVersion && localVersion.notes ? localVersion.notes : '';
    $('updApply').hidden = true; $('updReload').hidden = true;
    if (!quiet) $('updStatus').textContent = 'Checking for updates…';
    try {
      if (hasServer) {
        updateInfo = await (await fetch('/api/update/check', { cache: 'no-store' })).json();
        if (updateInfo.error && !updateInfo.remote) { $('updStatus').textContent = updateInfo.error; return; }
        if (updateInfo.updateAvailable) {
          $('updStatus').innerHTML = `<b>Version ${esc(updateInfo.remote.version)} is available</b> (${esc(updateInfo.remote.date || '')}) — ${esc(updateInfo.remote.notes || '')}<br>Method: ${updateInfo.method === 'git' ? 'git pull' : 'download from GitHub'}.` + (updateInfo.canUpdate ? '' : ' Open <code>http://localhost:8080</code> on the computer to install.');
          $('updApply').hidden = !updateInfo.canUpdate; $('btnVersion').classList.add('avail');
        } else { $('updStatus').textContent = `Up to date (GitHub: ${updateInfo.repo}, ${updateInfo.branch}).`; $('btnVersion').classList.remove('avail'); }
      } else {
        // static hosting (GitHub Pages): compare the served version.json with what's running
        const fresh = await (await fetch('version.json?t=' + Date.now(), { cache: 'no-store' })).json();
        if (fresh.version !== localVersion.version) { $('updStatus').innerHTML = `<b>Version ${esc(fresh.version)} is available</b> — ${esc(fresh.notes || '')}`; $('updReload').hidden = false; $('btnVersion').classList.add('avail'); }
        else $('updStatus').textContent = 'Up to date. (This copy is served from a web host; it updates whenever the site is redeployed.)';
      }
    } catch (e) { $('updStatus').textContent = 'Could not check: ' + e.message; }
  }
  async function applyUpdate() {
    $('updApply').disabled = true; $('updStatus').textContent = 'Installing… (the server restarts when done)'; $('updLog').hidden = false; $('updLog').textContent = '';
    try {
      const r = await (await fetch('/api/update/apply', { method: 'POST' })).json();
      $('updLog').textContent = (r.log || []).join('\n');
      if (r.error) { $('updStatus').textContent = 'Update failed: ' + r.error; $('updApply').disabled = false; return; }
      $('updStatus').textContent = `Installed ${r.after.version}. Waiting for the server to come back…`;
      const t0 = Date.now();
      const poll = async () => {
        try { const v = await (await fetch('/api/version', { cache: 'no-store' })).json(); if (v.local.version === r.after.version) { showBanner(v.local.version); $('updStatus').textContent = 'Server is back. Reload to use the new version.'; $('updReload').hidden = false; return; } } catch {}
        if (Date.now() - t0 < 30000) setTimeout(poll, 700); else $('updStatus').textContent = 'Server did not come back — start it again with start.command / start.bat.';
      };
      setTimeout(poll, 1500);
    } catch (e) { $('updStatus').textContent = 'Update failed: ' + e.message; $('updApply').disabled = false; }
  }
  function showBanner(v) { $('updBannerText').textContent = `Version ${v} is installed.`; $('updBanner').hidden = false; }
  const hardReload = async () => { try { const regs = await navigator.serviceWorker?.getRegistrations(); for (const r of regs || []) await r.update(); } catch {} location.reload(); };
  $('btnVersion').onclick = () => { $('dlgUpdate').showModal(); checkUpdates(); };
  $('updCheck').onclick = () => checkUpdates();
  $('updApply').onclick = applyUpdate;
  $('updReload').onclick = hardReload; $('updBannerReload').onclick = hardReload; $('updBannerClose').onclick = () => { $('updBanner').hidden = true; };
  loadVersion();

  // ---------- mixer ----------
  const mixer = SD.setupMixerUI(ctx, kit);

  // ---------- boot ----------
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
  loadSongs();
  if (navigator.requestMIDIAccess) initMidi();
  window.stagedrums = { transport, kit, mixer, get song() { return song; }, get tl() { return tl; } };
})();
