/* StageDrums — synthesized drum kit, groove library and transport/scheduler.
   Everything is Web Audio; no samples required. */
(function (global) {
  'use strict';

  // ---------- Drum kit (synthesized) ----------
  class DrumKit {
    constructor(ctx) {
      this.ctx = ctx;
      this.master = ctx.createGain(); this.master.gain.value = 0.8;
      this.comp = ctx.createDynamicsCompressor();
      this.comp.threshold.value = -12; this.comp.ratio.value = 4; this.comp.attack.value = 0.003; this.comp.release.value = 0.15;
      this.master.connect(this.comp); this.comp.connect(ctx.destination);
      this.bus = {};
      for (const name of ['kick', 'snare', 'hat', 'cym', 'tom', 'perc', 'click']) {
        const g = ctx.createGain(); g.connect(this.master); this.bus[name] = g;
      }
      this.bus.click.gain.value = 0;
      this.noise = this._makeNoise();
    }
    _makeNoise() {
      const len = this.ctx.sampleRate * 2;
      const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      return buf;
    }
    setLevel(bus, v) { if (this.bus[bus]) this.bus[bus].gain.value = v; }
    setMaster(v) { this.master.gain.value = v; }

    _noiseSrc(t, dur) {
      const s = this.ctx.createBufferSource(); s.buffer = this.noise; s.loop = true;
      s.start(t); s.stop(t + dur + 0.05); return s;
    }
    _env(t, peak, dur, curve) {
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0001), t + 0.002);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      return g;
    }

    kick(t, v = 1) {
      const ctx = this.ctx;
      const osc = ctx.createOscillator(); osc.type = 'sine';
      osc.frequency.setValueAtTime(160, t);
      osc.frequency.exponentialRampToValueAtTime(48, t + 0.09);
      const g = this._env(t, 1.2 * v, 0.45);
      osc.connect(g); g.connect(this.bus.kick);
      osc.start(t); osc.stop(t + 0.5);
      // click transient
      const n = this._noiseSrc(t, 0.02);
      const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 1500;
      const ng = this._env(t, 0.35 * v, 0.02);
      n.connect(f); f.connect(ng); ng.connect(this.bus.kick);
    }
    snare(t, v = 1) {
      const ctx = this.ctx;
      const n = this._noiseSrc(t, 0.25);
      const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1800; f.Q.value = 0.7;
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 600;
      const ng = this._env(t, 0.9 * v, 0.22);
      n.connect(f); f.connect(hp); hp.connect(ng); ng.connect(this.bus.snare);
      for (const fr of [185, 330]) {
        const o = ctx.createOscillator(); o.type = 'triangle'; o.frequency.setValueAtTime(fr, t);
        o.frequency.exponentialRampToValueAtTime(fr * 0.8, t + 0.08);
        const og = this._env(t, 0.5 * v, 0.12);
        o.connect(og); og.connect(this.bus.snare); o.start(t); o.stop(t + 0.15);
      }
    }
    ghost(t) { this.snare(t, 0.3); }
    rim(t, v = 1) { // side-stick / cross-stick
      const ctx = this.ctx;
      const o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = 820;
      const g = this._env(t, 0.5 * v, 0.06);
      const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 2400; f.Q.value = 3;
      o.connect(f); f.connect(g); g.connect(this.bus.snare); o.start(t); o.stop(t + 0.08);
    }
    hat(t, v = 1, open = false) {
      const ctx = this.ctx;
      const dur = open ? 0.35 : 0.06;
      const n = this._noiseSrc(t, dur);
      const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 7000;
      const bp = ctx.createBiquadFilter(); bp.type = 'peaking'; bp.frequency.value = 10000; bp.gain.value = 6;
      const g = this._env(t, 0.5 * v, dur);
      n.connect(f); f.connect(bp); bp.connect(g); g.connect(this.bus.hat);
    }
    ride(t, v = 1) {
      const ctx = this.ctx;
      const n = this._noiseSrc(t, 0.5);
      const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 5200; f.Q.value = 1.2;
      const g = this._env(t, 0.35 * v, 0.5);
      n.connect(f); f.connect(g); g.connect(this.bus.cym);
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = 3150;
      const og = this._env(t, 0.12 * v, 0.6);
      o.connect(og); og.connect(this.bus.cym); o.start(t); o.stop(t + 0.7);
    }
    crash(t, v = 1) {
      const ctx = this.ctx;
      const n = this._noiseSrc(t, 1.8);
      const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 3000;
      const g = this._env(t, 0.8 * v, 1.8);
      n.connect(f); f.connect(g); g.connect(this.bus.cym);
      for (const fr of [2170, 3400, 4600]) {
        const o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = fr;
        const og = this._env(t, 0.05 * v, 1.2);
        o.connect(og); og.connect(this.bus.cym); o.start(t); o.stop(t + 1.3);
      }
    }
    tom(t, v = 1, pitch = 'hi') {
      const ctx = this.ctx;
      const base = { hi: 240, mid: 170, lo: 110 }[pitch] || 170;
      const o = ctx.createOscillator(); o.type = 'sine';
      o.frequency.setValueAtTime(base * 1.3, t); o.frequency.exponentialRampToValueAtTime(base, t + 0.06);
      o.frequency.exponentialRampToValueAtTime(base * 0.85, t + 0.35);
      const g = this._env(t, 0.9 * v, 0.4);
      o.connect(g); g.connect(this.bus.tom); o.start(t); o.stop(t + 0.45);
    }
    cowbell(t, v = 1) {
      const ctx = this.ctx;
      const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 800; f.Q.value = 1.5;
      const g = this._env(t, 0.55 * v, 0.18);
      f.connect(g); g.connect(this.bus.perc);
      for (const fr of [587, 845]) {
        const o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = fr;
        o.connect(f); o.start(t); o.stop(t + 0.2);
      }
    }
    click(t, accent = false) {
      const ctx = this.ctx;
      const o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = accent ? 1600 : 1000;
      const g = this._env(t, accent ? 0.7 : 0.45, 0.04);
      o.connect(g); g.connect(this.bus.click); o.start(t); o.stop(t + 0.05);
    }

    /** Play one step token for an instrument letter */
    hit(inst, ch, t) {
      const v = ch === 'X' ? 1.15 : ch === 'x' ? 0.85 : ch === 'g' ? 0.35 : ch === 'o' ? 0.9 : 0.85;
      switch (inst) {
        case 'K': return this.kick(t, v);
        case 'S': return ch === 'g' ? this.ghost(t) : this.snare(t, v);
        case 'R': return this.rim(t, v);
        case 'H': return this.hat(t, v, ch === 'o');
        case 'D': return this.ride(t, v);
        case 'C': return this.crash(t, v);
        case 'T': return this.tom(t, v, 'hi');
        case 'M': return this.tom(t, v, 'mid');
        case 'F': return this.tom(t, v, 'lo');
        case 'B': return this.cowbell(t, v);
      }
    }
  }

  // ---------- Groove library ----------
  // 16 steps per 4/4 bar (16ths). Letters: K kick, S snare (g = ghost), R rim/cross-stick,
  // H hats (o = open), D ride, C crash, T/M/F hi/mid/floor tom, B cowbell. 'x' hit, 'X' accent, '.' rest.
  const GROOVES = {
    'rock':        { sig: '4/4', desc: 'Straight 8ths rock', K: 'x.......x.......', S: '....x.......x...', H: 'x.x.x.x.x.x.x.x.' },
    'rock-16':     { sig: '4/4', desc: 'Driving 16th hats',   K: 'x.......x.x.....', S: '....x.......x...', H: 'xxxxxxxxxxxxxxxx' },
    'rock-heavy':  { sig: '4/4', desc: 'Heavy, open hats',    K: 'x.....x.x.....x.', S: '....x.......x...', H: 'o.o.o.o.o.o.o.o.' },
    'pop':         { sig: '4/4', desc: 'Pop with syncopated kick', K: 'x......xx.....x.', S: '....x.......x...', H: 'x.x.x.x.x.x.x.x.' },
    'four-floor':  { sig: '4/4', desc: 'Kick every beat (dance/pop)', K: 'x...x...x...x...', S: '....x.......x...', H: '..x...x...x...x.' },
    'half-time':   { sig: '4/4', desc: 'Half-time feel',      K: 'x...............', S: '........x.......', H: 'x.x.x.x.x.x.x.x.' },
    'ballad':      { sig: '4/4', desc: 'Slow ballad, cross-stick', K: 'x.........x.....', R: '....x.......x...', H: 'x.x.x.x.x.x.x.x.' },
    'ballad-ride': { sig: '4/4', desc: 'Ballad on the ride',  K: 'x.......x.......', S: '....x.......x...', D: 'x.x.x.x.x.x.x.x.' },
    'country':     { sig: '4/4', desc: 'Train / country 2-step', K: 'x...x...x...x...', S: '..x...x...x...x.', H: 'x.x.x.x.x.x.x.x.' },
    'shuffle':     { sig: '4/4', desc: 'Blues shuffle',       K: 'x.......x.......', S: '....x.......x...', H: 'x..xx..xx..xx..x' },
    'funk':        { sig: '4/4', desc: 'Funk 16ths w/ ghosts', K: 'x..x..x...x..x..', S: '....x..g..g.x..g', H: 'x.x.x.x.x.x.x.xo' },
    'reggae':      { sig: '4/4', desc: 'One drop',            K: '........x.......', R: '........x.......', H: 'x.x.x.x.x.x.x.x.' },
    'bossa':       { sig: '4/4', desc: 'Bossa nova',          K: 'x..x..x.x..x..x.', R: '..x..x...x..x...', H: 'x.x.x.x.x.x.x.x.' },
    'punk':        { sig: '4/4', desc: 'Fast punk',           K: 'x...x...x...x...', S: '..x...x...x...x.', H: 'x.x.x.x.x.x.x.x.' },
    'motown':      { sig: '4/4', desc: 'Snare on every beat', K: 'x.......x.......', S: 'x...x...x...x...', H: 'x.x.x.x.x.x.x.x.' },
    'train':       { sig: '4/4', desc: 'Brushy train beat',   K: 'x.......x.......', S: 'xgxgXgxgxgxgXgxg', H: '................' },
    'baker-blues': { sig: '4/4', desc: 'Ginger Baker-style driving blues rock (Cream)', K: 'x..x..x.x..x.x..', S: '....x..g....x..g', H: 'x.x.x.x.x.x.x.xo' },
    'baker-ride':  { sig: '4/4', desc: 'Same groove on the ride (solo section)', K: 'x..x..x.x..x.x..', S: '....x..g....x..g', D: 'x.x.x.x.x.x.x.x.', H: '....x.......x...' },
    'baker-toms':  { sig: '4/4', desc: 'Tom-driven turnaround feel', K: 'x.......x.......', S: '....x.......x...', T: 'x.x.....x.x.....', F: '....x.x.....x.x.' },
    'cowbell-count': { sig: '4/4', desc: 'Cowbell 8ths only (Mississippi Queen count-off)', B: 'X.x.x.x.X.x.x.x.' },
    'laing-cowbell': { sig: '4/4', desc: 'Heavy rock 8ths with cowbell on top (Mountain)', K: 'x......xx.......', S: '....x.......x...', B: 'X.x.x.x.X.x.x.x.', H: '....x.......x...' },
    'laing-heavy':   { sig: '4/4', desc: 'Heavy rock, open hats, pushing kick', K: 'x......xx.....x.', S: '....x.......x...', H: 'o.o.o.o.o.o.o.o.' },
    'laing-ride':    { sig: '4/4', desc: 'Heavy rock on the ride w/ cowbell accents', K: 'x......xx.....x.', S: '....x.......x...', D: 'x.x.x.x.x.x.x.x.', B: 'X.......X.......' },
    'hats-only':   { sig: '4/4', desc: 'Just hats (intro/breakdown)', H: 'x.x.x.x.x.x.x.x.' },
    'kick-only':   { sig: '4/4', desc: 'Kick + hats build',   K: 'x...x...x...x...', H: 'x.x.x.x.x.x.x.x.' },
    'silence':     { sig: '4/4', desc: 'Drums out' },
    'waltz':       { sig: '3/4', desc: '3/4 waltz',           K: 'x...........', S: '....x...x...', H: 'x.x.x.x.x.x.' },
    'waltz-ride':  { sig: '3/4', desc: '3/4 on ride',         K: 'x...........', R: '....x...x...', D: 'x.x.x.x.x.x.' },
    'six-eight':   { sig: '6/8', desc: '6/8 ballad',          K: 'x.....x.....', S: '......x.....', H: 'x.x.x.x.x.x.' },
    'six-eight-drive': { sig: '6/8', desc: '6/8 driving',    K: 'x.....x..x..', S: '......x.....', H: 'xxxxxxxxxxxx', C: '............' },
  };

  // Fills (replace the last bar of a section when section.fill is true)
  const FILLS = {
    '4/4': [
      { K: 'x.......x.......', S: '....x...xxxx....', T: '............xx..', F: '..............xx', H: 'x.x.x.x.........' },
      { K: 'x.......x...x...', S: '....x.x.x.x.x.x.', T: '.............x..', M: '..............x.', F: '...............x', H: 'x.x.x.x.........' },
      { K: 'x...x...x...x...', S: 'x.x.x.x.xxxxxxxx', H: '................' },
      { K: 'x.......x.......', S: '....xx..........', T: '......xx........', M: '........xx......', F: '..........xxxxxx' },
    ],
    '3/4': [{ K: 'x...........', S: '....x...xxxx', T: '........x...', F: '..........x.' }],
    '6/8': [{ K: 'x.....x.....', S: '......x.xxxx', T: '........x...', F: '..........xx' }],
  };

  function parseSig(sig) {
    const [n, d] = (sig || '4/4').split('/').map(Number);
    // steps per beat: 4 for quarter-note beats; 2 for 6/8 (eighth-note beats)
    const stepsPerBeat = d === 8 ? 2 : 4;
    return { beats: n, stepsPerBeat, steps: n * stepsPerBeat, sig: `${n}/${d}` };
  }

  function grooveFor(name, sig) {
    let g = GROOVES[name];
    if (!g || g.sig !== sig) {
      // fallback: first groove matching signature
      g = Object.values(GROOVES).find(x => x.sig === sig && x !== GROOVES.silence) || GROOVES.rock;
    }
    return g;
  }

  // ---------- Song → bar timeline ----------
  const HOLD = new Set(['.', '/', '-', '%', '_', '|']);
  function parseBar(str, beats, prevBar) {
    const s = String(str || '').trim();
    if (s === '%' && prevBar) return prevBar.chords.map(c => ({ ...c }));
    const toks = s.split(/\s+/).filter(Boolean);
    if (!toks.length) return [{ name: '—', beats, at: 0 }];
    // Each token = equal slice; holds extend previous chord
    const slice = beats / toks.length;
    const out = [];
    toks.forEach((t, i) => {
      if (HOLD.has(t) && out.length) { out[out.length - 1].beats += slice; }
      else out.push({ name: HOLD.has(t) ? '—' : t, beats: slice, at: i * slice });
    });
    return out;
  }

  function buildTimeline(song) {
    const sig = parseSig(song.time);
    const bars = [];
    const sections = [];
    (song.sections || []).forEach((sec, si) => {
      const repeat = Math.max(1, sec.repeat | 0 || 1);
      const groove = grooveFor(sec.groove || song.groove || 'rock', sig.sig);
      const start = bars.length;
      let prev = null;
      for (let r = 0; r < repeat; r++) {
        (sec.bars || []).forEach((b, bi) => {
          const bar = {
            index: bars.length, section: si, barInSection: bi, repeat: r,
            chords: parseBar(b, sig.beats, prev),
            groove, grooveName: sec.groove || song.groove || 'rock',
            fill: !!sec.fill && bi === sec.bars.length - 1,
            custom: (sec.midi && sec.midi[bi]) || (song.midiBars && song.midiBars[bars.length]) || null,
            crash: (sec.crash !== false) && bi === 0 && r === 0 && si > 0,
            lastOfSection: bi === sec.bars.length - 1 && r === repeat - 1,
          };
          bars.push(bar); prev = bar;
        });
      }
      sections.push({ index: si, name: sec.name || `Section ${si + 1}`, start, end: bars.length, count: bars.length - start, lyrics: sec.lyrics || '' });
    });
    return { sig, bars, sections, total: bars.length };
  }

  // ---------- Transport / scheduler ----------
  class Transport {
    constructor(kit) {
      this.kit = kit; this.ctx = kit.ctx;
      this.bpm = 120; this.song = null; this.tl = null;
      this.playing = false;
      // Live arrangement (Prime-style): hold = keep repeating the current section; extra = extra passes of the
      // current section before moving on; queued = {section, now} section to go to (at section end, or next bar if now)
      this.hold = false; this.extra = 0; this.queued = null;
      this.onLive = null;  // callback when hold/extra/queued change
      this.countIn = true; this.audible = true;
      this.lookahead = 0.12; this.tick = 25;
      this.onBar = null; this.onBeat = null; this.onStop = null; this.onAnchor = null;
      this._timer = null;
      this._anchor = null; // {bar, ctxTime, bpm}
    }
    setSong(song) { this.song = song; this.tl = buildTimeline(song); this.bpm = song.bpm || 120; }
    setBpm(bpm) {
      bpm = Math.min(240, Math.max(40, bpm));
      if (this.playing) {
        // re-anchor at current position so position stays continuous
        const pos = this.position();
        this.bpm = bpm;
        this._anchor = { bar: pos, ctxTime: this.ctx.currentTime, bpm };
        this._nextStepTime = this.ctx.currentTime; this._bar = Math.floor(pos); this._step = Math.round((pos - this._bar) * this.tl.sig.steps) % this.tl.sig.steps;
        this._emitAnchor();
      } else this.bpm = bpm;
    }
    secPerStep() { return 60 / this.bpm / this.tl.sig.stepsPerBeat; }
    secPerBar() { return this.secPerStep() * this.tl.sig.steps; }

    /** Fractional bar position (may be negative during count-in). */
    position(ctxTime) {
      if (!this.playing || !this._anchor) return this._pausedPos || 0;
      const t = ctxTime ?? this.ctx.currentTime;
      const a = this._anchor;
      if (a.countIn && t < a.ctxTime) return (t - a.ctxTime) / this.secPerBar(); // negative: count-in progress (-1..0)
      let pos = a.bar + (t - a.ctxTime) / this.secPerBar();
      if (this.tl && pos >= this.tl.total) pos = this.tl.total;
      return pos;
    }
    /** Integer bar the transport is in (or about to enter during count-in / when stopped). */
    currentBar() {
      if (!this.playing) return this._pausedPos || 0;
      const p = this.position();
      return p < 0 ? this._anchor.bar : Math.min(this.tl.total - 1, Math.floor(p));
    }
    sectionOf(bar) { const b = this.tl.bars[Math.max(0, Math.min(this.tl.total - 1, bar))]; return b ? b.section : 0; }
    /** Which section will play after the given one, given hold/extra/queued. */
    predictNext(sectionIdx) {
      if (this.hold || this.extra > 0) return sectionIdx;
      if (this.queued) return this.queued.section;
      return sectionIdx + 1 < this.tl.sections.length ? sectionIdx + 1 : -1;
    }
    setHold(on) { this.hold = !!on; this._liveChanged(); }
    addExtra(n = 1) { this.extra = Math.max(0, this.extra + n); this._liveChanged(); }
    /** Queue a section: plays when the current section ends (or at the next bar if now=true). */
    queueSection(section, now = false) {
      if (section < 0 || section >= this.tl.sections.length) return;
      if (!this.playing) { this._pausedPos = this.tl.sections[section].start; if (this.onBar) this.onBar(this._pausedPos); return; }
      this.queued = { section, now: !!now }; if (now) { this.hold = false; this.extra = 0; }
      this._liveChanged();
    }
    clearQueue() { this.queued = null; this._liveChanged(); }
    /** "Go": if something is queued make it happen at the next bar; otherwise go to the natural next section at the next bar. */
    goNow() {
      if (!this.playing) return;
      const cur = this.sectionOf(this.currentBar());
      const target = this.queued ? this.queued.section : Math.min(this.tl.sections.length - 1, cur + 1);
      this.hold = false; this.extra = 0; this.queued = { section: target, now: true };
      this._liveChanged();
    }
    _liveChanged() { if (this.onLive) this.onLive(this); this._emitAnchor(); }
    /** Called when the scheduler leaves bar `prev` and has tentatively advanced to this._bar. Returns true if it moved non-linearly. */
    _resolveBoundary(prev) {
      const tl = this.tl; const sec = tl.sections[tl.bars[prev].section];
      if (this.queued && this.queued.now) {
        this._bar = tl.sections[this.queued.section].start; this.queued = null; this._fire(() => this._liveChanged(), null, this._nextStepTime); return true;
      }
      if (this._bar >= sec.end) {
        if (this.hold) { this._bar = sec.start; return true; }
        if (this.extra > 0) { this.extra--; this._bar = sec.start; this._fire(() => this._liveChanged(), null, this._nextStepTime); return true; }
        if (this.queued) { this._bar = tl.sections[this.queued.section].start; this.queued = null; this._fire(() => this._liveChanged(), null, this._nextStepTime); return true; }
      }
      return false;
    }

    start(fromBar = 0) {
      if (!this.tl || !this.tl.total) return;
      if (this.ctx.state === 'suspended') this.ctx.resume();
      this.stop(true);
      this.playing = true;
      const now = this.ctx.currentTime + 0.05;
      this._bar = this.countIn ? -1 : fromBar; this._step = 0;
      this._nextStepTime = now;
      this._countFrom = fromBar; this._barHits = null; this.queued = null;
      this._anchor = { bar: fromBar, ctxTime: this.countIn ? now + this.secPerBar() : now, bpm: this.bpm, countIn: this.countIn };
      this._emitAnchor();
      if (this.midi) this.midi.start(this.countIn ? now + this.secPerBar() : now);
      this._timer = setInterval(() => this._schedule(), this.tick);
      this._schedule();
    }
    stop(silent) {
      if (this.midi && this.playing) this.midi.stop();
      this._pausedPos = this.playing ? Math.max(0, Math.floor(this.position())) : (this._pausedPos || 0);
      this.playing = false;
      if (this._timer) clearInterval(this._timer); this._timer = null;
      if (!silent && this.onStop) this.onStop();
      if (!silent) this._emitAnchor();
    }
    toggle() { this.playing ? this.stop() : this.start(this._pausedPos || 0); }
    jumpTo(bar) { if (this.playing) this.start(bar); else { this._pausedPos = bar; if (this.onBar) this.onBar(bar); } }

    /** Follower mode: align this transport to a host anchor expressed in local ctx time. */
    syncTo(state, anchorCtxTime) {
      if (!this.tl) return;
      this.hold = !!state.hold; this.extra = state.extra || 0; this.queued = state.queued || null;
      if (this.onLive) this.onLive(this);
      this.bpm = state.bpm || this.bpm;
      if (!state.playing) {
        if (this.playing) { this.playing = false; clearInterval(this._timer); this._timer = null; }
        this._pausedPos = state.pausedPos || 0;
        if (this.onBar) this.onBar(this._pausedPos);
        return;
      }
      const sig = this.tl.sig;
      const now = this.ctx.currentTime;
      const stepSec = this.secPerStep();
      const countIn = !!state.countIn && anchorCtxTime > now;
      this._anchor = { bar: state.anchorBar, ctxTime: anchorCtxTime, bpm: this.bpm, countIn: !!state.countIn };
      this._countFrom = state.anchorBar;
      let bar, step;
      if (countIn) {
        const startCtx = anchorCtxTime - this.secPerBar();
        let stepsAhead = Math.max(0, Math.ceil((now - startCtx) / stepSec));
        this._nextStepTime = startCtx + stepsAhead * stepSec;
        bar = -1; step = stepsAhead % sig.steps;
        if (stepsAhead >= sig.steps) { bar = state.anchorBar; step = stepsAhead - sig.steps; }
      } else {
        let stepsAhead = Math.max(0, Math.ceil((now - anchorCtxTime) / stepSec));
        this._nextStepTime = anchorCtxTime + stepsAhead * stepSec;
        bar = state.anchorBar + Math.floor(stepsAhead / sig.steps); step = stepsAhead % sig.steps;
      }
      if (bar >= 0) bar = Math.min(this.tl.total, bar);
      this._bar = bar; this._step = step; this._barHits = null;
      if (!this.playing) {
        this.playing = true;
        this._timer = setInterval(() => this._schedule(), this.tick);
      }
    }

    _emitAnchor() {
      if (this.onAnchor) this.onAnchor({
        playing: this.playing, bpm: this.bpm, hold: this.hold, extra: this.extra, queued: this.queued,
        anchorBar: this._anchor ? this._anchor.bar : (this._pausedPos || 0),
        anchorCtxTime: this._anchor ? this._anchor.ctxTime : this.ctx.currentTime,
        countIn: !!(this._anchor && this._anchor.countIn),
        pausedPos: this._pausedPos || 0,
      });
    }

    _schedule() {
      const tl = this.tl, sig = tl.sig;
      while (this._nextStepTime < this.ctx.currentTime + this.lookahead) {
        const t = this._nextStepTime;
        if (this._bar < 0) {
          // count-in bar: clicks on beats, always audible through master (not click bus)
          if (this._step % sig.stepsPerBeat === 0 && this.audible) this.kit.hat(t, this._step === 0 ? 1.1 : 0.7);
          if (this._step % sig.stepsPerBeat === 0) this.kit.click(t, this._step === 0);
          if (this._step === 0) this._fire(this.onBar, this._bar, t);
          if (this._step % sig.stepsPerBeat === 0) this._fire(this.onBeat, this._step / sig.stepsPerBeat, t, this._bar);
        } else {
          if (this._bar >= tl.total) { this._fire(() => this.stop(), null, t); return; }
          const bar = tl.bars[this._bar];
          if (this._step === 0) {
            this._fire(this.onBar, this._bar, t);
          }
          if (this._step % sig.stepsPerBeat === 0) {
            this._fire(this.onBeat, this._step / sig.stepsPerBeat, t, this._bar);
            this.kit.click(t, this._step === 0);
          }
          if (this._step === 0 || !this._barHits) this._barHits = global.StageDrums.barHits(bar, this._bar, tl);
          if (this.audible || this.midi) {
            for (const h of (this._barHits || [])) {
              if (h.step !== this._step) continue;
              if (this.audible) this.kit.hit(h.inst, h.ch, t);
              if (this.midi) this.midi.note(h.inst, h.ch, t);
            }
          }
        }
        if (this.midi) { // MIDI clock: 24 pulses per quarter note
          const pulses = (24 * 4 / +sig.sig.split('/')[1]) / sig.stepsPerBeat;
          for (let c = 0; c < pulses; c++) this.midi.clock(t + c * this.secPerStep() / pulses);
        }
        // advance
        this._step++;
        this._nextStepTime += this.secPerStep();
        if (this._step >= sig.steps) {
          this._step = 0;
          if (this._bar < 0) {
            this._bar = this._countFrom;
          } else {
            const prev = this._bar; this._bar++;
            if (this._resolveBoundary(prev)) {
              this._anchor = { bar: this._bar, ctxTime: this._nextStepTime, bpm: this.bpm };
              this._emitAnchor();
            } else if (this._bar % 4 === 0) {
              // periodic re-anchor keeps followers tight
              this._anchor = { bar: this._bar, ctxTime: this._nextStepTime, bpm: this.bpm };
              this._emitAnchor();
            }
          }
        }
      }
    }
    _fire(cb, a, t, b) {
      if (!cb) return;
      const delay = Math.max(0, (t - this.ctx.currentTime) * 1000);
      setTimeout(() => cb(a, b), delay);
    }
  }

  global.StageDrums = { DrumKit, GROOVES, FILLS, Transport, buildTimeline, parseSig, parseBar };
})(window);
