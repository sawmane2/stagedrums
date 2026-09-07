/* StageDrums — chord-following band: bass, keys (pad/organ) and rhythm guitar, all synthesized.
   Driven by the transport per step; reads the chord under each step from the timeline. */
(function (global) {
  'use strict';
  const SD = global.StageDrums;
  const ROOTS = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11, Cb: 11 };
  const mtof = m => 440 * Math.pow(2, (m - 69) / 12);

  /** Parse "Am7/G" → { root: 9, bass: 7, intervals: [...] } (null for N.C. / holds). */
  function parseChord(name) {
    const m = /^([A-G][#b]?)(.*?)(?:\/([A-G][#b]?))?$/.exec(String(name || '').trim()); if (!m || ROOTS[m[1]] == null) return null;
    const q = m[2]; let iv = [0, 4, 7];
    if (/^(m|min|-)(?!aj)/.test(q)) iv = [0, 3, 7];
    if (/dim|°/.test(q)) iv = [0, 3, 6]; if (/aug|\+/.test(q)) iv = [0, 4, 8];
    if (/sus2/.test(q)) iv = [0, 2, 7]; else if (/sus/.test(q)) iv = [0, 5, 7];
    if (/^5$/.test(q)) iv = [0, 7];
    if (/maj7|M7|Δ/.test(q)) iv.push(11); else if (/7/.test(q)) iv.push(10);
    if (/9/.test(q)) iv.push(14);
    return { root: ROOTS[m[1]], bass: m[3] && ROOTS[m[3]] != null ? ROOTS[m[3]] : ROOTS[m[1]], intervals: iv, minor: iv[1] === 3 };
  }

  // ---- patterns (16 steps per 4/4 bar; 'r' root, '5' fifth, 'o' octave, '3' third, 'x' chord strum down, 'u' strum up, '.' rest, '-' hold) ----
  const BASS = {
    off: null,
    whole: 'r---------------',
    halves: 'r-------r-------',
    roots: 'r-------r---5---',          // root on 1 & 3, fifth pickup
    eighths: 'r-r-r-r-r-r-r-r-',
    pump: 'r-r-r-r-5-r-o-5-',           // rock 8ths with fifth/octave
    boogie: 'r-3-5-6-o-6-5-3-',         // walking boogie (6 = sixth)
    shuffle: 'r--r5--5r--ro--5',
    ballad: 'r-------5---o---',
  };
  const GTR = {
    off: null,
    strum8: 'x.u.x.u.x.u.x.u.',
    strum16: 'x.uux.uux.uux.uu',
    folk: 'x...u.x.u...u.x.',
    stabs: 'x.......x.......',
    arp: 'a.b.c.d.a.b.c.d.',           // arpeggio: a=root b=3rd c=5th d=octave
    whole: 'x---------------',
  };
  const KEYS = { off: null, pad: 'pad', organ: 'organ', epiano: 'epiano' };

  class Band {
    constructor(ctx, dest) {
      this.ctx = ctx;
      this.bus = { bass: ctx.createGain(), keys: ctx.createGain(), gtr: ctx.createGain() };
      for (const g of Object.values(this.bus)) g.connect(dest);
      this.bus.bass.gain.value = 0.9; this.bus.keys.gain.value = 0.5; this.bus.gtr.gain.value = 0.6;
      this.trim = { bass: 0.22, keys: 0.09, gtr: 0.18 }; // internal scaling so the sliders sit around 0.5-1.0
      this.keysVoices = null; this.keysChord = null; this.enabled = true;
      this._noise = null;
    }
    setLevel(k, v) { if (this.bus[k]) this.bus[k].gain.value = v; }
    stopAll(t = this.ctx.currentTime) { this._releaseKeys(t); }

    /** Settings for a bar: song-level `band` merged with section overrides. */
    static settingsFor(song, secDef) {
      const d = Object.assign({ bass: 'off', keys: 'off', gtr: 'off' }, song.band || {}, secDef.band || {});
      return d;
    }
    chordAt(bar, step, sig) {
      let c = bar.chords[0];
      for (const x of bar.chords) if (step >= Math.round(x.at * sig.stepsPerBeat) - 1e-6) c = x;
      return parseChord(c && c.name);
    }
    /** Called by the transport for every step. */
    step(bar, step, t, sig, song, secDef, bpm) {
      if (!this.enabled) return; this.bpm = bpm || 120;
      const s = Band.settingsFor(song, secDef);
      const ch = this.chordAt(bar, step, sig);
      if (!ch) { if (step === 0) this._releaseKeys(t); return; }
      const scale = sig.steps === 16 ? 1 : 16 / sig.steps; // patterns are 16-step; stretch for 12-step bars
      const pi = Math.floor(step * scale) % 16;
      // bass
      const bp = BASS[s.bass]; if (bp) { const ch1 = bp[pi]; if (ch1 && ch1 !== '.' && ch1 !== '-') this.bassNote(ch, ch1, t, this._holdLen(bp, pi) * (60 / this.bpm / sig.stepsPerBeat)); }
      // guitar
      const gp = GTR[s.gtr]; if (gp) { const c = gp[pi]; if (c && c !== '.' && c !== '-') this.gtrHit(ch, c, t); }
      // keys: retrigger on chord change or bar start
      if (KEYS[s.keys]) { const key = `${ch.root}-${ch.intervals.join(',')}-${s.keys}`; if (key !== this.keysChord || step === 0 && !this.keysVoices) { this._releaseKeys(t); this.keysChord = key; this.keysOn(ch, s.keys, t); } }
      else if (this.keysVoices) this._releaseKeys(t);
    }
    _holdLen(pat, i) { let n = 1; for (let k = i + 1; k < 16 && pat[k] === '-'; k++) n++; return n; }

    // ---- bass: saw + sub, filtered, with a little drive ----
    bassNote(ch, sym, t, holdSec) {
      const ctx = this.ctx; const base = 28 + ch.bass; // E1 = 28 → keep bass in E1..E2 range
      let midi = base + (sym === '5' ? 7 : sym === 'o' ? 12 : sym === '3' ? (ch.minor ? 3 : 4) : sym === '6' ? (ch.minor ? 10 : 9) : 0);
      if (midi > 43) midi -= 12;
      const f = mtof(midi), dur = Math.min(Math.max(holdSec * 0.9, 0.12), 1.6);
      const o1 = ctx.createOscillator(); o1.type = 'sawtooth'; o1.frequency.value = f;
      const o2 = ctx.createOscillator(); o2.type = 'sine'; o2.frequency.value = f;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 1.2;
      lp.frequency.setValueAtTime(900, t); lp.frequency.exponentialRampToValueAtTime(220, t + Math.min(0.5, dur));
      const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(this.trim.bass, t + 0.008);
      g.gain.setValueAtTime(this.trim.bass, t + dur * 0.6); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      const sub = ctx.createGain(); sub.gain.value = 0.6;
      o1.connect(lp); o2.connect(sub); sub.connect(g); lp.connect(g); g.connect(this.bus.bass);
      o1.start(t); o2.start(t); o1.stop(t + dur + 0.05); o2.stop(t + dur + 0.05);
    }

    // ---- keys: sustained chord voices ----
    keysOn(ch, kind, t) {
      const ctx = this.ctx; const voices = [];
      const notes = ch.intervals.map(i => 60 + ((ch.root + i) % 12) + (i >= 12 ? 12 : 0)); // around C4
      // keep voicing compact: drop the top if above G4 span → invert down
      const midis = notes.map(n => n > 67 ? n - 12 : n).sort((a, b) => a - b);
      const master = ctx.createGain(); master.gain.setValueAtTime(0.0001, t);
      const att = kind === 'pad' ? 0.35 : 0.01;
      master.gain.exponentialRampToValueAtTime(this.trim.keys * (kind === 'pad' ? 1 : 0.9), t + att);
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = kind === 'pad' ? 1800 : 4000;
      master.connect(lp); lp.connect(this.bus.keys);
      for (const m of midis) {
        const f = mtof(m);
        if (kind === 'organ') {
          for (const [h, a] of [[1, 1], [2, 0.6], [3, 0.35], [4, 0.25], [0.5, 0.5]]) { const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f * h; const g = ctx.createGain(); g.gain.value = 0.22 * a / midis.length; o.connect(g); g.connect(master); o.start(t); voices.push(o); }
        } else if (kind === 'epiano') {
          const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f; const o2 = ctx.createOscillator(); o2.type = 'triangle'; o2.frequency.value = f * 2;
          const g = ctx.createGain(); g.gain.setValueAtTime(0.5 / midis.length, t); g.gain.exponentialRampToValueAtTime(0.12 / midis.length, t + 1.5);
          const g2 = ctx.createGain(); g2.gain.setValueAtTime(0.25 / midis.length, t); g2.gain.exponentialRampToValueAtTime(0.01 / midis.length, t + 0.6);
          o.connect(g); o2.connect(g2); g.connect(master); g2.connect(master); o.start(t); o2.start(t); voices.push(o, o2);
        } else { // pad: two detuned saws
          for (const det of [-6, 6]) { const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f; o.detune.value = det; const g = ctx.createGain(); g.gain.value = 0.16 / midis.length; o.connect(g); g.connect(master); o.start(t); voices.push(o); }
        }
      }
      this.keysVoices = { voices, master };
    }
    _releaseKeys(t) {
      const v = this.keysVoices; if (!v) return; this.keysVoices = null; this.keysChord = null;
      const rel = 0.12; v.master.gain.cancelScheduledValues(t); v.master.gain.setValueAtTime(Math.max(v.master.gain.value, 0.001), t); v.master.gain.exponentialRampToValueAtTime(0.0001, t + rel);
      for (const o of v.voices) { try { o.stop(t + rel + 0.02); } catch {} }
    }

    // ---- guitar: Karplus-Strong plucks ----
    _pluckBuffer(f, secs, bright) {
      const sr = this.ctx.sampleRate, N = Math.max(2, Math.round(sr / f)), len = Math.floor(sr * secs);
      const buf = this.ctx.createBuffer(1, len, sr), d = buf.getChannelData(0);
      const ring = new Float32Array(N); for (let i = 0; i < N; i++) ring[i] = Math.random() * 2 - 1;
      let idx = 0, prev = 0; const damp = bright ? 0.996 : 0.992;
      for (let i = 0; i < len; i++) { const cur = ring[idx]; const nx = ring[(idx + 1) % N]; const v = damp * 0.5 * (cur + nx); d[i] = cur; ring[idx] = v; idx = (idx + 1) % N; }
      return buf;
    }
    gtrHit(ch, sym, t) {
      const ctx = this.ctx;
      // voicing: root position triad + octave, guitar range (E3..)
      const midis = ch.intervals.slice(0, 3).map(i => 52 + ((ch.root + i + 12 - 4) % 12) + 4).sort((a, b) => a - b);
      midis.push(midis[0] + 12);
      let notes = midis;
      if (sym === 'a' || sym === 'b' || sym === 'c' || sym === 'd') notes = [midis[{ a: 0, b: 1, c: 2, d: 3 }[sym]]];
      const up = sym === 'u'; const order = up ? notes.slice().reverse() : notes;
      order.forEach((m, i) => {
        const src = ctx.createBufferSource(); src.buffer = this._pluckBuffer(mtof(m), 1.4, !up);
        const g = ctx.createGain(); g.gain.value = this.trim.gtr * (up ? 0.7 : 1) * (notes.length === 1 ? 1.4 : 1);
        const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 120;
        src.connect(hp); hp.connect(g); g.connect(this.bus.gtr); src.start(t + i * 0.012);
      });
    }
  }

  SD.Band = Band; SD.parseChord = parseChord; SD.BASS_PATTERNS = BASS; SD.GTR_PATTERNS = GTR; SD.KEYS_KINDS = KEYS;
})(window);
