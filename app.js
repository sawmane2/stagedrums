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
    if (local && local.length) songs = local;
    else {
      try { songs = await (await fetch('songs/index.json')).json(); } catch { songs = []; }
      persistSongs();
    }
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
    renderSongList(); renderChart(); renderBeats(); renderPads();
    updateNow(0, true);
  }

  // ---------- chart ----------
  function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  function renderChart() {
    const chart = $('chart'); chart.innerHTML = '';
    tl.sections.forEach(sec => {
      const secDef = song.sections[sec.index];
      const div = document.createElement('div'); div.className = 'section'; div.dataset.section = sec.index;
      const rep = secDef.repeat > 1 ? ` ×${secDef.repeat}` : '';
      div.innerHTML = `<div class="section-head"><span class="name">${esc(sec.name)}</span>
        <span class="meta">${sec.count} bars${rep} · ${esc(secDef.groove || song.groove || 'rock')}</span>
        <span class="jump">tap to jump</span></div>`;
      div.querySelector('.section-head').onclick = () => transport.playing ? queueSection(sec.index, false) : jumpTo(sec.start);
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
      if (sec.lyrics) { const ly = document.createElement('div'); ly.className = 'lyric'; ly.textContent = sec.lyrics; div.appendChild(ly); }
      chart.appendChild(div);
    });
  }
  function renderBeats() {
    const b = $('beats'); b.innerHTML = '';
    for (let i = 0; i < tl.sig.beats; i++) { const d = document.createElement('div'); d.className = 'beat' + (i === 0 ? ' one' : ''); b.appendChild(d); }
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
      if (se) { se.classList.add('current'); const ch = $('chart'); ch.scrollTo({ top: se.offsetTop - ch.offsetTop - 8, behavior: 'smooth' }); }
      renderLive();
    }
    const barsLeft = sec.end - barIdx;
    $('nextIn').textContent = `in ${barsLeft} bar${barsLeft === 1 ? '' : 's'}`;
    $('barCounter').textContent = `Bar ${barIdx + 1} / ${tl.total}  ·  ${sec.name} ${bar.barInSection + 1}/${sec.count}`;
    // bar highlighting
    const el = document.querySelector(`.bar[data-bar="${barIdx}"]`);
    if (el !== currentBarEl || force) {
      if (currentBarEl) currentBarEl.classList.remove('now');
      document.querySelectorAll('.bar.done').forEach(e => e.classList.remove('done'));
      for (let i = 0; i < barIdx; i++) { const d = document.querySelector(`.bar[data-bar="${i}"]`); if (d && tl.bars[i].section === bar.section) d.classList.add('done'); }
      if (currentBarEl) currentBarEl.querySelectorAll('.chord.on').forEach(c => c.classList.remove('on'));
      currentBarEl = el; if (el) el.classList.add('now');
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
      let s;
      if (text.startsWith('{')) { s = JSON.parse(text); s.id = s.id || 'song-' + Date.now().toString(36); }
      else s = SD.parseChordSheet(text, { title: $('impTitle').value, artist: $('impArtist').value, bpm: +$('impBpm').value, time: $('impTime').value, groove: $('impGroove').value });
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
      anchorBar: st.anchorBar, anchorServerMs: sync ? SD.ctxToServer(ctx, sync, st.anchorCtxTime) : 0, countIn: st.countIn };
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
      }
      return;
    }
    if (role !== 'follower') return;
    if (m.type === 'song') {
      const s = m.song; const i = songs.findIndex(x => x.id === s.id);
      if (i >= 0) songs[i] = s; else songs.push(s); persistSongs();
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
    transport.stop(true); setPlayUI();
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
