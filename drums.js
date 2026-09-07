/* StageDrums — synthesized drum kit, groove library and transport/scheduler.
   Everything is Web Audio; no samples required. */
(function (global) {
  'use strict';

  // ---------- Drum kit (synthesized) ----------
  class DrumKit {
    constructor(ctx) {
      this.ctx = ctx;
      this.master = ctx.createGain(); this.master.gain.value = 0.8;
      // drum bus: saturation → tone → glue compressor (+ short room in parallel)
      this.sat = ctx.createWaveShaper(); this.sat.oversample = '2x';
      this.tone = { low: ctx.createBiquadFilter(), mid: ctx.createBiquadFilter(), lp: ctx.createBiquadFilter() };
      this.tone.low.type = 'lowshelf'; this.tone.low.frequency.value = 100;
      this.tone.mid.type = 'peaking'; this.tone.mid.frequency.value = 2500; this.tone.mid.Q.value = 0.8;
      this.tone.lp.type = 'lowpass'; this.tone.lp.frequency.value = 20000; this.tone.lp.Q.value = 0.5;
      this.room = ctx.createConvolver(); this.roomGain = ctx.createGain(); this.roomGain.gain.value = 0;
      this.comp = ctx.createDynamicsCompressor();
      this.comp.threshold.value = -12; this.comp.ratio.value = 4; this.comp.attack.value = 0.003; this.comp.release.value = 0.15;
      this.master.connect(this.sat); this.sat.connect(this.tone.low); this.tone.low.connect(this.tone.mid); this.tone.mid.connect(this.tone.lp); this.tone.lp.connect(this.comp);
      this.master.connect(this.room); this.room.connect(this.roomGain); this.roomGain.connect(this.comp);
      this.comp.connect(ctx.destination);
      this.setBus('vintage');
      this.bus = {};
      for (const name of ['kick', 'snare', 'hat', 'cym', 'tom', 'perc', 'click']) {
        const g = ctx.createGain(); g.connect(this.master); this.bus[name] = g;
      }
      this.bus.click.gain.value = 0;
      this.noise = this._makeNoise();
      this.samples = null; this.mode = 'synth'; this.kitName = 'Synth';
      this._openHat = null;
    }
    /** Load a sampled kit (kits/<name>/kit.json). Falls back to synth if anything fails. */
    async loadSamples(url) {
      const base = url.replace(/[^/]*$/, '');
      const manifest = await (await fetch(url, { cache: 'force-cache' })).json();
      const insts = {};
      await Promise.all(Object.entries(manifest.instruments).map(async ([inst, e]) => {
        const layers = await Promise.all(e.layers.map(async l => ({ v: l.v, buffers: await Promise.all(l.files.map(async f => {
          const ab = await (await fetch(base + f, { cache: 'force-cache' })).arrayBuffer();
          const buffer = await this.ctx.decodeAudioData(ab);
          // find the true onset so every hit lands exactly on the grid regardless of encoder padding
          const ch = buffer.getChannelData(0); let pk = 0; for (let i = 0; i < ch.length; i++) { const a = Math.abs(ch[i]); if (a > pk) pk = a; }
          let on = 0; const thr = pk * 0.03; while (on < ch.length && Math.abs(ch[on]) < thr) on++;
          return { buffer, offset: Math.max(0, on - 8) / buffer.sampleRate };
        })) })));
        insts[inst] = { gain: e.gain ?? 1, layers };
      }));
      this.samples = insts; this.kitName = manifest.name || 'Sampled'; this.mode = 'acoustic';
      return manifest;
    }
    setMode(m) { this.mode = (m === 'acoustic' && this.samples) ? 'acoustic' : 'synth'; }
    _sample(key, vel, t, bus) {
      const s = this.samples && this.samples[key]; if (!s) return null;
      const layer = s.layers.find(l => vel <= l.v + 1e-6) || s.layers[s.layers.length - 1];
      const pick = layer.buffers[Math.floor(Math.random() * layer.buffers.length)];
      const src = this.ctx.createBufferSource(); src.buffer = pick.buffer;
      src.playbackRate.value = 1 + (Math.random() - 0.5) * 0.015; // tiny natural variation
      const g = this.ctx.createGain(); g.gain.value = s.gain * (0.8 + 0.2 * Math.min(1, vel)) * (1 + (Math.random() - 0.5) * 0.12);
      src.connect(g); g.connect(this.bus[bus]); src.start(t, pick.offset);
      return { src, g };
    }
    _choke(node, t) { if (!node) return; try { node.g.gain.setTargetAtTime(0, t, 0.01); node.src.stop(t + 0.08); } catch {} }
    _makeNoise() {
      const len = this.ctx.sampleRate * 2;
      const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      return buf;
    }
    setLevel(bus, v) { if (this.bus[bus]) this.bus[bus].gain.value = v; }
    /** 'clean' = transparent; 'vintage' = tape-style saturation, darker top, a little room, glue. */
    setBus(mode) {
      this.busMode = mode;
      const drive = mode === 'vintage' ? 1.6 : 1.0;
      const n = 2048, curve = new Float32Array(n);
      for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; curve[i] = Math.tanh(x * drive) / Math.tanh(drive); }
      this.sat.curve = curve;
      this.tone.low.gain.value = mode === 'vintage' ? 2 : 0;
      this.tone.mid.gain.value = mode === 'vintage' ? 1.5 : 0;
      this.tone.lp.frequency.value = mode === 'vintage' ? 11000 : 20000;
      if (!this.room.buffer) this.room.buffer = this._roomIR(0.35);
      this.roomGain.gain.value = mode === 'vintage' ? 0.16 : 0;
      this.comp.threshold.value = mode === 'vintage' ? -16 : -12; this.comp.ratio.value = mode === 'vintage' ? 3 : 4;
    }
    _roomIR(sec) {
      const sr = this.ctx.sampleRate, len = Math.floor(sr * sec), buf = this.ctx.createBuffer(2, len, sr);
      for (let c = 0; c < 2; c++) { const d = buf.getChannelData(c); let lp = 0;
        for (let i = 0; i < len; i++) { const t = i / len; const n = Math.random() * 2 - 1; lp += (n - lp) * 0.5; d[i] = lp * Math.pow(1 - t, 3) * (i < sr * 0.004 ? 0 : 1); } }
      return buf;
    }
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
    cowbell(t, v = 1) { // modal model of a steel cowbell: inharmonic partials, fast-damped top, stick click
      const ctx = this.ctx;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 4200; lp.Q.value = 0.7;
      lp.connect(this.bus.perc);
      const partials = [[560, 1, 0.22], [845, 0.55, 0.16], [1180, 0.3, 0.1], [1650, 0.22, 0.08], [2460, 0.12, 0.06], [3300, 0.07, 0.04]];
      for (const [fr, amp, dec] of partials) {
        const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = fr * (1 + (Math.random() - 0.5) * 0.01);
        const g = this._env(t, 0.5 * v * amp, dec);
        o.connect(g); g.connect(lp); o.start(t); o.stop(t + dec + 0.05);
      }
      const n = this._noiseSrc(t, 0.012); const nf = ctx.createBiquadFilter(); nf.type = 'bandpass'; nf.frequency.value = 2500; nf.Q.value = 1;
      const ng = this._env(t, 0.25 * v, 0.012); n.connect(nf); nf.connect(ng); ng.connect(lp);
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
      if (this.mode === 'acoustic' && this.samples && (inst !== 'B' || this.samples.B)) {
        const vel = Math.min(1, v);
        switch (inst) {
          case 'K': return this._sample('K', vel, t, 'kick');
          case 'S': return this._sample(ch === 'X' && this.samples.Sx ? 'Sx' : 'S', vel, t, 'snare'); // accents = rimshot
          case 'R': return this._sample('R', vel, t, 'snare');
          case 'H': {
            if (ch === 'o') { this._choke(this._openHat, t); this._openHat = this._sample('Ho', vel, t, 'hat'); return this._openHat; }
            this._choke(this._openHat, t); this._openHat = null; return this._sample('H', vel, t, 'hat');
          }
          case 'D': return this._sample(ch === 'X' && this.samples.Db ? 'Db' : 'D', vel, t, 'cym');
          case 'Db': return this._sample(this.samples.Db ? 'Db' : 'D', vel, t, 'cym');
          case 'Hp': { this._choke(this._openHat, t); this._openHat = null; return this._sample(this.samples.Hp ? 'Hp' : 'H', vel * 0.8, t, 'hat'); }
          case 'C': return this._sample('C', vel, t, 'cym');
          case 'T': return this._sample('T', vel, t, 'tom');
          case 'M': return this._sample('M', vel, t, 'tom');
          case 'F': return this._sample('F', vel, t, 'tom');
          case 'B': return this._sample('B', vel, t, 'perc');
        }
      }
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
        case 'Hp': return this.hat(t, v * 0.6, false);
        case 'Db': return this.ride(t, v * 1.2);
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
    // Ginger Baker (Cream, 1967): loose, jazz-schooled, ride-heavy, kick doubled under the riff, hi-hat foot on 2 & 4,
    // ghosted snare, tom accents. A touch of swing and laid-back snare.
    'baker-blues': { sig: '4/4', desc: 'Ginger Baker-style blues rock (Cream) — ride, doubled kick, ghosts', swing: 0.18, feel: 'loose',
      K: 'x.....x.x.....x.', S: '....X.g.....X..g', D: 'x.x.x.x.x.x.x.x.', Hp: '....x.......x...',
      vars: [
        { K: 'x.....x.x..x..x.', S: '....X.g...g.X..g', D: 'x.x.x.x.x.x.x.x.', Hp: '....x.......x...' },
        { K: 'x.....x.x.....x.', S: '....X.......X.gg', D: 'X.x.x.x.X.x.x.x.', Hp: '....x.......x...', F: '..............x.' },
        { K: 'x.....x.x.....x.', S: '....X.g.....X...', D: 'x.x.x.x.x.x.x.x.', Hp: '....x.......x...', T: '..............xx' },
      ] },
    'baker-busy':  { sig: '4/4', desc: 'Baker, second verse — busier kick, ghosts, tom answers', swing: 0.2, feel: 'loose',
      K: 'x..x..x.x..x..x.', S: '....X.g.g...X.g.', D: 'x.x.x.x.x.x.x.x.', Hp: '....x.......x...',
      vars: [
        { K: 'x..x..x.x.xx..x.', S: '....X.g.....X.gg', D: 'x.x.x.x.x.x.x.x.', Hp: '....x.......x...', T: '..............x.' },
        { K: 'x..x..x.x..x..xx', S: '....X...g.g.X...', D: 'X.x.x.x.X.x.x.x.', Hp: '....x.......x...', F: '..........x.....' },
        { K: 'x..x..x.x..x..x.', S: '....X.g.....X...', D: 'x.x.x.x.x.x.x...', Hp: '....x.......x...', T: '............x.x.', F: '..............x.' },
        { K: 'x..x..x.x..x..x.', S: '....X.gg....X.g.', D: 'x.x.x.x.x.x.x.x.', Hp: '....x.......x...', M: '.......x........' },
      ] },
    'baker-jazz':  { sig: '4/4', desc: 'Baker jazz ride (ding-ding-da-ding), hat on 2 & 4, snare comping', swing: 0.3, feel: 'loose',
      K: 'x.......x.......', S: '....X..g..g.X...', D: 'x...x.x.x...x.x.', Hp: '....x.......x...',
      vars: [
        { K: 'x.....x.x.......', S: '....X...g...X.g.', D: 'x...x.x.x...x.x.', Hp: '....x.......x...', T: '......x.........' },
        { K: 'x.......x..x....', S: '..g.X.....g.X...', D: 'X...x.x.X...x.x.', Hp: '....x.......x...', F: '..............x.' },
        { K: 'x.......x.......', S: '....X.g...g.X.g.', D: 'x...x.x.x...x.x.', Hp: '....x.......x...', Db: '........x.......' },
      ] },
    'baker-heavy': { sig: '4/4', desc: 'Baker, last verse — double kick, crashing ride, toms', swing: 0.15, feel: 'loose',
      K: 'x.xx..x.x.xx..x.', S: '....X.......X..g', D: 'X.x.X.x.X.x.X.x.', Hp: '....x.......x...',
      vars: [
        { K: 'x.xx..x.x.xx..xx', S: '....X.......X...', D: 'X.x.X.x.X.x.X.x.', Hp: '....x.......x...', F: '..............x.' },
        { K: 'x.xx..x.x.xxx.x.', S: '....X.g.....X.g.', C: 'x...............', D: '..x.X.x.X.x.X.x.', Hp: '....x.......x...', T: '............x...', F: '.............x..' },
        { K: 'x.xx..x.x.xx..x.', S: '....X.......X...', D: 'X.x.X.x.X.x.X...', Hp: '....x.......x...', T: '..............xx' },
      ] },
    'baker-ride':  { sig: '4/4', desc: 'Baker on the ride bell, opened up (solo)', swing: 0.18, feel: 'loose',
      K: 'x.....x.x.....x.', S: '....X.g.....X..g', D: 'X.x.X.x.X.x.X.x.', Hp: '....x.......x...',
      vars: [{ K: 'x.....x.x..x..x.', S: '....X.g.g...X.gg', D: 'X.x.X.x.X.x.X.x.', Hp: '....x.......x...', F: '............x...' }] },
    'baker-toms':  { sig: '4/4', desc: 'Baker riff feel — kick and floor tom under the riff', swing: 0.18, feel: 'loose',
      K: 'x.....x.x.....x.', S: '....X.......X...', F: 'x.x...x.x.x...x.', T: '......x.......x.', Hp: '....x.......x...',
      vars: [{ K: 'x.....x.x.....x.', S: '....X.......X.g.', F: 'x.x...x.x.x.....', T: '......x.....x.xx', Hp: '....x.......x...' }] },
    // Corky Laing (Mountain, 1970): big, heavy, slightly ahead of the beat, cowbell 8ths, rimshot backbeats, open hats.
    'cowbell-count': { sig: '4/4', desc: 'Cowbell 8ths only (Mississippi Queen count-off)', feel: 'tight', B: 'X.x.x.x.X.x.x.x.' },
    'laing-cowbell': { sig: '4/4', desc: 'Heavy rock 8ths with cowbell on top (Mountain)', feel: 'push',
      K: 'x......xx.......', S: '....X.......X...', B: 'X.x.x.x.X.x.x.x.', Hp: '....x.......x...',
      vars: [{ K: 'x......xx.....x.', S: '....X.......X.g.', B: 'X.x.x.x.X.x.x.x.', Hp: '....x.......x...' },
             { K: 'x......xx.......', S: '....X.......X...', B: 'X.x.x.x.X.x.xxx.', Hp: '....x.......x...' }] },
    'laing-heavy':   { sig: '4/4', desc: 'Heavy rock, open hats, pushing kick (Mountain verse)', feel: 'push',
      K: 'x......xx.....x.', S: '....X.......X...', H: 'o.o.o.o.o.o.o.o.',
      vars: [{ K: 'x......xx.x...x.', S: '....X.......X...', H: 'o.o.o.o.o.o.o.o.' },
             { K: 'x......xx.....x.', S: '....X.....g.X..g', H: 'o.o.o.o.o.o.o.oo' }] },
    'laing-ride':    { sig: '4/4', desc: 'Heavy rock on the ride, cowbell on 1 & 3 (solo)', feel: 'push',
      K: 'x......xx.....x.', S: '....X.......X...', D: 'x.x.x.x.x.x.x.x.', B: 'X.......X.......',
      vars: [{ K: 'x......xx.....x.', S: '....X.......X.g.', D: 'X.x.x.x.X.x.x.x.', B: 'X.......X.......', Db: '..............x.' }] },
    'laing-boogie':  { sig: '4/4', desc: 'Mid-tempo heavy boogie, half-swung (Sittin\' on a Rainbow)', swing: 0.28, feel: 'push',
      K: 'x.....x.x.....x.', S: '....X.......X...', H: 'x.x.x.x.x.x.x.o.',
      vars: [{ K: 'x.....x.x..x..x.', S: '....X.......X.g.', H: 'x.x.x.x.x.x.x.o.' },
             { K: 'x.....x.x.....x.', S: '....X.....g.X...', H: 'x.x.x.x.x.x.x.x.', B: '..............x.' }] },
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
      { K: 'x...x...x...x...', S: '....X...x.x.X.xx', T: '..........x.....', F: '............x...', D: 'x.x.x.x.........' },
      { K: 'x.......x.......', S: '....X.....xx....', T: '........xx..x...', M: '..............x.', F: '............x..x' },
      { K: 'x.......x.....x.', S: '....X.......xxxx', H: 'x.x.x.x.x.x.....' },
    ],
    '3/4': [{ K: 'x...........', S: '....x...xxxx', T: '........x...', F: '..........x.' }],
    '6/8': [{ K: 'x.....x.....', S: '......x.xxxx', T: '........x...', F: '..........xx' }],
  };

  // Ginger Baker-style fills: tom rolls, triplet-ish tumbles, double-kick under the toms, snare-tom answers
  const BAKER_FILLS = [
    { K: 'x.......x.....xx', S: '....X...xx......', T: '..........xx....', M: '............x...', F: '.............x..' },
    { K: 'x.xx....x.xx....', S: '....X.x.x.......', T: '........x.x.....', M: '..........x.x...', F: '............x.xx' },
    { K: 'x.......x.......', S: '....X.......xxx.', T: '........xxx.....', F: '...............x' },
    { K: 'x...x...x...x.xx', S: '....X.g.X.g.X.g.', T: '.........x...x..', F: '...........x...x' },
    { K: 'x.......x.xx..x.', S: '....X..x..x.....', T: '..........x.x...', M: '............x...', F: '..............xx' },
    { K: 'x.......x.......', S: '....X...x.x.x.x.', F: '.........x.x.x.x' },
  ];
  const BAKER_MINIS = [{ S: '............x.x.', F: '.............x.x' }, { T: '............xx..', F: '..............xx' }, { S: '............X...', K: '..............xx' }, { S: '............x.xx' }];
  for (const g of ['baker-blues', 'baker-busy', 'baker-jazz', 'baker-heavy', 'baker-ride', 'baker-toms']) { GROOVES[g].fills = BAKER_FILLS; GROOVES[g].minis = BAKER_MINIS; }
  // short fills on the last beat of a 4-bar phrase (drummers "turn the corner" every 4 bars)
  const MINIFILLS = {
    '4/4': [{ S: '............x.xx' }, { S: '............xx..', T: '..............x.', F: '...............x' }, { T: '............xx..', F: '..............xx' }, { S: '............X.x.', F: '...............x' }],
    '3/4': [{ S: '........x.xx' }], '6/8': [{ S: '.........xxx' }],
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
            mini: !(sec.fill && bi === sec.bars.length - 1) && sec.bars.length >= 4 && (bi % 4 === 3),
            varIdx: (groove.vars && bi > 0 && (bi % 2 === 1)) ? ((bi * 7 + r * 3) % (groove.vars.length + 1)) : 0, // 0 = main pattern
            swing: sec.swing ?? song.swing ?? groove.swing ?? 0,
            feel: sec.feel || song.feel || groove.feel || 'normal',
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
      this.countIn = true; this.audible = true; this.humanize = true;
      this.lookahead = 0.12; this.tick = 25;
      this.onBar = null; this.onBeat = null; this.onStop = null; this.onAnchor = null;
      this._timer = null;
      this._anchor = null; // {bar, ctxTime, bpm}
    }
    setSong(song) { this.song = song; this.tl = buildTimeline(song); this.bpm = song.bpm || 120; if (this.audio) this.setAudio(null); }
    /**
     * Audio backing mode: play a real recording (an AudioBuffer, e.g. the song with the vocals removed) instead of
     * synthesized drums + band. `barTimes` = seconds into the recording where each bar starts (total+1 entries,
     * the last one is the end). The chart, cues, hold/+1/queue and follower sync all keep working; jumps seek.
     */
    setAudio(a) {
      if (this.playing) this.stop();
      if (this._aGain) { try { this._aGain.disconnect(); } catch (e) {} }
      this.audio = null; this._aGain = null;
      // one buffer (`buffer`) or several stems (`stems: {drums: AudioBuffer, bass: …}`) played in lock-step, each with its own level
      const stems = a && (a.stems || (a.buffer ? { mix: a.buffer } : null));
      if (!stems || !Object.keys(stems).length) return;
      const total = this.tl ? this.tl.total : 0;
      let bt = (a.barTimes || []).map(Number);
      if (bt.length < total + 1) { // fill from bpm grid after the last known bar time
        const spb = this.secPerBar(); let last = bt.length ? bt[bt.length - 1] : (a.offset || 0);
        if (!bt.length) bt.push(last);
        while (bt.length < total + 1) { last += spb; bt.push(last); }
      }
      this._aGain = this.ctx.createGain(); this._aGain.gain.value = a.gain ?? 1; this._aGain.connect(this.ctx.destination);
      const gains = {}; const mix = a.mix || {};
      for (const k of Object.keys(stems)) { const g = this.ctx.createGain(); g.gain.value = mix[k] ?? 1; g.connect(this._aGain); gains[k] = g; }
      const duration = Math.max(...Object.values(stems).map(b => b.duration));
      this.audio = { stems, gains, barTimes: bt, name: a.name || '', duration, buffer: stems[Object.keys(stems)[0]] };
    }
    setAudioGain(g) { if (this._aGain) this._aGain.gain.value = g; }
    /** Level of one stem (0 = off). Takes effect immediately, mid-song. */
    setStemGain(name, v, when) { const g = this.audio && this.audio.gains[name]; if (g) g.gain.setTargetAtTime(Math.max(0, v), Math.max(when || 0, this.ctx.currentTime), 0.02); }
    /** Apply the stem levels for a bar (per-section mixes come from `stemMixFor`), ramping at time `when`. */
    applyStemMix(bar, when) {
      if (!this.audio || !this.stemMixFor) return;
      const mix = this.stemMixFor(bar) || {};
      for (const k of Object.keys(this.audio.gains)) if (mix[k] != null) this.setStemGain(k, mix[k], when);
    }
    /** Shift every bar time by `sec` (nudge the chart against the recording). */
    nudgeAudio(sec) { if (this.audio) this.audio.barTimes = this.audio.barTimes.map(t => t + sec); }
    /** Duration of bar `b` in seconds (audio mode uses the recording's real bar lengths). */
    barSec(b) {
      if (this.audio) { const bt = this.audio.barTimes; b = Math.max(0, Math.min(bt.length - 2, b)); return Math.max(0.2, bt[b + 1] - bt[b]); }
      return this.secPerBar();
    }
    setBpm(bpm) {
      bpm = Math.min(240, Math.max(40, bpm));
      if (this.audio) { this.bpm = bpm; return; } // tempo is the recording's in audio mode
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
      const barSec = a.barSec || this.secPerBar();
      if (a.countIn && t < a.ctxTime) return (t - a.ctxTime) / barSec; // negative: count-in progress (-1..0)
      if (this.audio && this._aSegs && this._aSegs.length) {
        // map ctx time → recording time (via the playing segment) → fractional bar (via barTimes)
        let seg = this._aSegs[0]; for (const s of this._aSegs) if (s.ctx <= t) seg = s;
        if (t < seg.ctx) return Math.max(-1, (t - seg.ctx) / barSec); // still counting in
        return Math.min(this.tl.total, this._barAt(seg.offset + (t - seg.ctx)));
      }
      let pos = a.bar + (t - a.ctxTime) / barSec;
      if (this.tl && pos >= this.tl.total) pos = this.tl.total;
      return pos;
    }
    /** Fractional bar at a time in the recording (audio mode). */
    _barAt(sec) {
      const bt = this.audio.barTimes; let lo = 0, hi = bt.length - 2;
      while (lo < hi) { const m = (lo + hi + 1) >> 1; if (bt[m] <= sec) lo = m; else hi = m - 1; }
      return lo + (sec - bt[lo]) / Math.max(0.2, bt[lo + 1] - bt[lo]);
    }
    /** Start (or re-start at a seek) the recording at ctx time `when`, from `offset` seconds into it. */
    _aStart(when, offset) {
      if (this._aSrc) for (const s of this._aSrc) { try { s.stop(when); } catch (e) {} }
      this._aSrc = [];
      for (const [k, buffer] of Object.entries(this.audio.stems)) {
        if (offset >= buffer.duration - 0.01) continue;
        const src = this.ctx.createBufferSource(); src.buffer = buffer; src.connect(this.audio.gains[k]);
        src.start(when, Math.max(0, offset)); this._aSrc.push(src);
      }
      this._aSegs.push({ ctx: when, offset });
      if (this._aSegs.length > 4) this._aSegs.shift();
    }
    _aStop() {
      if (this._aSrc) for (const s of this._aSrc) { try { s.stop(); } catch (e) {} }
      this._aSrc = null; this._aSegs = [];
    }
    /** Integer bar the transport is in (or about to enter during count-in / when stopped). */
    currentBar() {
      if (!this.playing) return this._pausedPos || 0;
      const p = this.position();
      return p < 0 ? (this._countFrom ?? this._anchor.bar) : Math.min(this.tl.total - 1, Math.floor(p));
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
      const firstBar = this.barSec(fromBar);
      this._anchor = { bar: fromBar, ctxTime: this.countIn ? now + firstBar : now, bpm: this.bpm, countIn: this.countIn, barSec: firstBar };
      if (this.audio) {
        this._aSegs = []; this._aSrc = null; this._aNextBarCtx = now; this._aPrev = null; this._aSec = null;
        if (!this.countIn) this._aStart(now, this.audio.barTimes[fromBar]);
        this._emitAnchor();
        this._timer = setInterval(() => this._scheduleAudio(), this.tick);
        this._scheduleAudio();
        return;
      }
      this._emitAnchor();
      if (this.midi) this.midi.start(this.countIn ? now + this.secPerBar() : now);
      this._timer = setInterval(() => this._schedule(), this.tick);
      this._schedule();
    }
    stop(silent) {
      if (this.midi && this.playing) this.midi.stop();
      if (this.band) this.band.stopAll();
      this._pausedPos = this.playing ? Math.max(0, Math.floor(this.position())) : (this._pausedPos || 0);
      if (this.audio) this._aStop();
      this.playing = false; this._follow = false;
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
        this._follow = false;
        this._pausedPos = state.pausedPos || 0;
        if (this.onBar) this.onBar(this._pausedPos);
        return;
      }
      const sig = this.tl.sig;
      const now = this.ctx.currentTime;
      const stepSec = this.secPerStep();
      const countIn = !!state.countIn && anchorCtxTime > now;
      const prevAnchor = this._anchor;
      this._anchor = { bar: state.anchorBar, ctxTime: anchorCtxTime, bpm: this.bpm, countIn: !!state.countIn, barSec: state.barSec };
      this._countFrom = state.anchorBar;
      if (state.audio) { // host plays a recording: follow its per-bar anchors (variable bar lengths, jumps at bar lines)
        const barSec = state.barSec || this.secPerBar(), beatSec = barSec / sig.beats;
        this._fAnch = (this._fAnch || []).filter(a => a.ctx > now && !(a.bar === state.anchorBar && Math.abs(a.ctx - anchorCtxTime) < 0.02));
        if (this._follow && this.playing && this._timer && anchorCtxTime > now - beatSec / 2) {
          // already running: the host announces each bar (and every jump) ahead of time — queue it, the loop re-seats on it
          this._fAnch.push({ bar: state.anchorBar, ctx: anchorCtxTime, barSec }); this._fAnch.sort((a, b) => a.ctx - b.ctx);
          if (anchorCtxTime > now) this._anchor = prevAnchor; // position() keeps reading from the bar we are actually in
          return;
        }
        const start = countIn ? anchorCtxTime - barSec : anchorCtxTime;
        let beatsAhead = Math.max(0, Math.ceil((now - start) / beatSec));
        this._fNext = start + beatsAhead * beatSec; this._fBarSec = barSec;
        if (countIn) { if (beatsAhead < sig.beats) { this._fBar = -1; this._fBeat = beatsAhead; } else { this._fBar = state.anchorBar; this._fBeat = beatsAhead - sig.beats; } }
        else { this._fBar = state.anchorBar + Math.floor(beatsAhead / sig.beats); this._fBeat = beatsAhead % sig.beats; }
        if (!this._follow || !this._timer) { if (this._timer) clearInterval(this._timer); this._timer = setInterval(() => this._scheduleFollow(), this.tick); }
        this._follow = true; this.playing = true;
        return;
      }
      if (this._follow) { this._follow = false; if (this._timer) { clearInterval(this._timer); this._timer = null; } }
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
        barSec: this._anchor && this._anchor.barSec ? this._anchor.barSec : undefined,
        audio: !!this.audio || undefined,
        pausedPos: this._pausedPos || 0,
      });
    }

    /** Audio-mode scheduler: the recording is the clock; we fire bar/beat events, count-in clicks and seeks ahead of time. */
    _scheduleAudio() {
      const tl = this.tl, sig = tl.sig, bt = this.audio.barTimes;
      // schedule a little further ahead than followers do, so our per-bar anchors reach them before they place that bar
      while (this._aNextBarCtx < this.ctx.currentTime + this.lookahead + 0.1) {
        const t = this._aNextBarCtx;
        if (this._bar < 0) { // count-in: one bar of clicks at the tempo of the first bar
          const dur = this.barSec(this._countFrom), beat = dur / sig.beats;
          for (let b = 0; b < sig.beats; b++) {
            if (this.audible) this.kit.hit('H', b === 0 ? 'X' : 'x', t + b * beat);
            this.kit.click(t + b * beat, b === 0);
            this._fire(this.onBeat, b, t + b * beat, -1);
          }
          this._fire(this.onBar, -1, t);
          this._bar = this._countFrom; this._aNextBarCtx = t + dur;
          this._aStart(t + dur, bt[this._countFrom]);
          continue;
        }
        // a bar line is about to pass (within lookahead): decide NOW what starts there, so Hold / +1 / Go / queue
        // pressed anywhere in the previous bar still land on this bar line
        if (this._aPrev != null) {
          this._nextStepTime = t;
          const jumped = this._resolveBoundary(this._aPrev);
          if (this._bar < tl.total && (jumped || this._bar !== this._aPrev + 1)) this._aStart(Math.max(t, this.ctx.currentTime), bt[this._bar]);
          this._aPrev = null;
        }
        if (this._bar >= tl.total) { if (this._aSrc) for (const s of this._aSrc) { try { s.stop(t + 0.02); } catch (e) {} } this._fire(() => this.stop(), null, t); return; }
        const dur = this.barSec(this._bar), beat = dur / sig.beats;
        // per-section stem mix: ramp at the bar line whenever the section changes (and on the first bar / after a jump)
        const secNow = tl.bars[this._bar].section;
        if (secNow !== this._aSec) { this.applyStemMix(this._bar, t); this._aSec = secNow; }
        this._fire(this.onBar, this._bar, t);
        for (let b = 0; b < sig.beats; b++) { this.kit.click(t + b * beat, b === 0); this._fire(this.onBeat, b, t + b * beat, this._bar); }
        this._anchor = { bar: this._bar, ctxTime: t, bpm: this.bpm, barSec: dur };
        this._emitAnchor(); // every bar: real recordings drift in tempo, so followers re-anchor often
        this._aPrev = this._bar; this._bar++;
        this._aNextBarCtx = t + dur;
      }
    }
    /** Follower in audio mode: no drums here (the host plays the recording); just track bars/beats from the anchor. */
    _scheduleFollow() {
      const now = this.ctx.currentTime, sig = this.tl.sig;
      while (this._fNext < now + 0.05) { // short lookahead: give the host's anchors time to arrive first
        let t = this._fNext, bar = this._fBar, beat = this._fBeat;
        const beatSec = (this._fBarSec || this.secPerBar()) / sig.beats;
        // a host anchor due around this beat re-seats us (exact bar line, new bar length, or a jump to another section)
        const pa = this._fAnch && this._fAnch[0];
        if (pa && pa.ctx <= t + beatSec / 2) {
          this._fAnch.shift();
          if (pa.ctx < t - beatSec / 2) continue; // stale duplicate
          bar = pa.bar; beat = 0; t = Math.max(pa.ctx, now); this._fBarSec = pa.barSec;
          this._anchor = { bar, ctxTime: pa.ctx, bpm: this.bpm, barSec: pa.barSec };
        }
        if (bar >= this.tl.total) { this._fire(() => this.stop(), null, t); return; }
        if (beat === 0) this._fire(this.onBar, bar, t);
        this.kit.click(t, beat === 0); this._fire(this.onBeat, beat, t, bar);
        beat++; if (beat >= sig.beats) { beat = 0; bar = bar < 0 ? this._countFrom : bar + 1; }
        this._fBar = bar; this._fBeat = beat;
        this._fNext = t + (this._fBarSec || this.secPerBar()) / sig.beats;
      }
    }

    _schedule() {
      const tl = this.tl, sig = tl.sig;
      while (this._nextStepTime < this.ctx.currentTime + this.lookahead) {
        const t = this._nextStepTime;
        if (this._bar < 0) {
          // count-in bar: clicks on beats, always audible through master (not click bus)
          if (this._step % sig.stepsPerBeat === 0 && this.audible) this.kit.hit('H', this._step === 0 ? 'X' : 'x', t);
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
            const stepSec = this.secPerStep();
            for (const h of (this._barHits || [])) {
              if (h.step !== this._step) continue;
              const th = this.humanize ? t + global.StageDrums.humanOffset(h, this._step, sig, bar, stepSec) : t;
              const ch = this.humanize ? global.StageDrums.humanVel(h, this._step, sig, bar) : h.ch;
              if (this.audible) this.kit.hit(h.inst, ch, th);
              if (this.midi) this.midi.note(h.inst, ch, th);
            }
          }
          if (this.band && this.audible) this.band.step(bar, this._step, t, sig, this.song, this.song.sections[bar.section] || {}, this.bpm);
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

  // ---------- Feel: how a real drummer places and weights hits ----------
  const FEEL = {
    normal: { jitter: 0.004, lay: { S: 0.004, K: 0, H: -0.002, D: 0, T: 0.003, M: 0.003, F: 0.004, C: 0.002, B: -0.001 } },
    loose:  { jitter: 0.007, lay: { S: 0.009, K: 0.002, H: -0.002, D: 0.001, T: 0.005, M: 0.005, F: 0.006, C: 0.004, B: 0 } },
    push:   { jitter: 0.004, lay: { S: -0.003, K: -0.004, H: -0.004, D: -0.003, T: 0, M: 0, F: 0.001, C: -0.002, B: -0.005 } },
    tight:  { jitter: 0.0015, lay: {} },
  };
  function gauss() { let s = 0; for (let i = 0; i < 4; i++) s += Math.random(); return (s - 2) / 1.15; }
  /** Timing offset (seconds) for one hit: swing + per-instrument lay-back/push + small random jitter. */
  function humanOffset(h, step, sig, bar, stepSec) {
    const f = FEEL[bar.feel] || FEEL.normal;
    let off = (f.lay[h.inst] || 0) + gauss() * f.jitter;
    const sw = bar.swing || 0;
    if (sw > 0 && sig.stepsPerBeat === 4) {
      const inBeat = step % 4;
      if (inBeat === 2) off += sw * 0.667 * stepSec;        // off-beat 8th → toward the triplet
      else if (inBeat === 1 || inBeat === 3) off += sw * 0.33 * stepSec; // 16ths lean the same way
    }
    if (h.step === 0 && h.inst === 'K') off -= 0.001; // downbeat kick leads slightly
    return off;
  }
  /** Velocity shaping: hi-hat/ride accent on the beat, random ±, crescendo through fills. */
  function humanVel(h, step, sig, bar) {
    let v = h.ch === 'X' ? 1.0 : h.ch === 'g' ? 0.35 : h.ch === 'o' ? 0.9 : 0.82;
    if ((h.inst === 'H' || h.inst === 'D' || h.inst === 'B') && h.ch !== 'X') {
      const inBeat = step % sig.stepsPerBeat;
      v *= inBeat === 0 ? 1.0 : inBeat === 2 ? 0.78 : 0.62;
      if (step === 0) v *= 1.08;
    }
    if (bar.fill) v *= 0.75 + 0.35 * (step / sig.steps);
    v *= 1 + gauss() * 0.06;
    v = Math.max(0.15, Math.min(1.15, v));
    return v >= 1.0 ? 'X' : v < 0.45 ? 'g' : v >= 0.88 && h.ch === 'o' ? 'o' : h.ch === 'o' ? 'o' : 'x';
  }
  global.StageDrums = { DrumKit, GROOVES, FILLS, MINIFILLS, FEEL, Transport, buildTimeline, parseSig, parseBar, humanOffset, humanVel };
})(window);
