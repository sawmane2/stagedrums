/* StageDrums — real-time vocal pitch correction (AudioWorklet).
   Detection: YIN on a 2:1-decimated copy of the input, every 512 samples (11.6 ms).
   Correction: the detected pitch is pulled toward the nearest note of the chosen scale with a "retune" time
   constant — slow keeps vibrato and slides, fast is the hard-tune sound.
   Resynthesis: TD-PSOLA. Grains one period long (Hann, 2 periods wide) are taken at the input's own pitch
   period and laid down at the corrected period, so the spectral envelope (the formants) never moves — the
   voice keeps its timbre. Unvoiced sound and silence pass straight through (delayed the same amount, so
   nothing shifts in time). Fixed latency: 1024 samples (23 ms at 44.1 kHz). Reports pitch and its own CPU
   use over the port for the UI. */
class PitchFixProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'amount', defaultValue: 1, minValue: 0, maxValue: 1 },        // how far toward the target note (1 = fully)
      { name: 'retune', defaultValue: 0.12, minValue: 0.005, maxValue: 0.6 }, // seconds; time constant of the pull
      { name: 'root', defaultValue: 0, minValue: 0, maxValue: 11 },         // key root, 0 = C
      { name: 'scale', defaultValue: 0, minValue: 0, maxValue: 2 },         // 0 chromatic, 1 major, 2 minor (natural + harmonic 7th)
      { name: 'bypass', defaultValue: 0, minValue: 0, maxValue: 1 },
    ];
  }
  constructor() {
    super();
    const N = 16384;
    this.N = N; this.buf = new Float32Array(N); this.wp = 0;          // input ring buffer (absolute index = written samples)
    this.out = new Float32Array(N); this.op = 0;                        // output accumulation ring (absolute index = output samples)
    this.D = 1152;                                                      // fixed latency in samples (26 ms): room for a 2-period grain plus peak alignment
    this.dec = new Float32Array(2048); this.decLen = 0;                 // decimated analysis window (2:1)
    this.yinBuf = new Float32Array(700);
    this.period = 0; this.voiced = 0; this.conf = 0;                    // detection state (period in full-rate samples)
    this.periodS = 0;                                                   // smoothed input period
    this.ratio = 1; this.ratioT = 1;                                    // current / target correction ratio
    this.nextSynth = this.D;                                            // absolute output index of the next synthesis mark
    this.lastAnal = 0;                                                  // absolute input index of the last analysis mark used
    this.since = 0; this.frames = 0; this.cpu = 0; this.lastPitch = 0; this.targetPitch = 0;
    this.grain = new Float32Array(4096);
    this.port.onmessage = () => {};
  }
  // --- YIN on the decimated buffer: returns period in decimated samples (or 0) and the aperiodicity
  yin() {
    const x = this.dec, W = 1024, maxTau = 640, minTau = 20; // 22.05 kHz: 34 Hz .. 1100 Hz
    const d = this.yinBuf; d[0] = 1;
    let run = 0;
    for (let tau = 1; tau < maxTau; tau++) {
      let s = 0;
      for (let i = 0; i < W; i += 1) { const v = x[i] - x[i + tau]; s += v * v; }
      run += s; d[tau] = run > 0 ? s * tau / run : 1;
    }
    const thr = 0.15; let tau = -1;
    for (let t = minTau; t < maxTau; t++) { if (d[t] < thr) { while (t + 1 < maxTau && d[t + 1] < d[t]) t++; tau = t; break; } }
    if (tau < 0) { let best = minTau; for (let t = minTau; t < maxTau; t++) if (d[t] < d[best]) best = t; if (d[best] < 0.4) tau = best; else return { period: 0, ap: 1 }; }
    // parabolic refinement
    const a = d[tau - 1], b = d[tau], c = d[tau + 1] || b; const den = a - 2 * b + c; const off = den ? 0.5 * (a - c) / den : 0;
    return { period: tau + off, ap: d[tau] };
  }
  detect() {
    // fill the decimated window from the newest 2048 input samples (averaging pairs = cheap anti-alias)
    const N = this.N, start = this.wp - 4096;
    for (let i = 0; i < 2048; i++) { const j = (start + 2 * i) & (N - 1); this.dec[i] = 0.5 * (this.buf[j] + this.buf[(j + 1) & (N - 1)]); }
    let e = 0; for (let i = 0; i < 2048; i += 4) e += this.dec[i] * this.dec[i];
    if (e < 2048 / 4 * 1e-6) { this.voiced = 0; this.period = 0; return; } // silence
    const r = this.yin();
    if (r.period > 0) { this.period = r.period * 2; this.conf = 1 - r.ap; this.voiced = Math.min(1, this.voiced + 0.5); }
    else { this.voiced = Math.max(0, this.voiced - 0.34); }
  }
  inScale(pc, scale, root) {
    if (scale === 0) return true;
    const rel = ((pc - root) % 12 + 12) % 12;
    return scale === 1 ? [0, 2, 4, 5, 7, 9, 11].includes(rel) : [0, 2, 3, 5, 7, 8, 10, 11].includes(rel);
  }
  target(freq, scale, root) {
    const midi = 69 + 12 * Math.log2(freq / 440);
    let best = Math.round(midi), bd = 99;
    for (let m = Math.floor(midi) - 2; m <= Math.ceil(midi) + 2; m++) { if (!this.inScale(((m % 12) + 12) % 12, scale, root)) continue; const dd = Math.abs(m - midi); if (dd < bd) { bd = dd; best = m; } }
    return 440 * Math.pow(2, (best - 69) / 12);
  }
  process(inputs, outputs, p) {
    const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
    const inp = inputs[0] && inputs[0][0], out = outputs[0][0];
    if (!out) return true;
    const n = out.length, N = this.N, mask = N - 1;
    const bypass = p.bypass[0] > 0.5, amount = p.amount[0], retune = p.retune[0], root = p.root[0] | 0, scale = p.scale[0] | 0;
    // 1. push input
    for (let i = 0; i < n; i++) this.buf[(this.wp + i) & mask] = inp ? inp[i] : 0;
    this.wp += n; this.since += n;
    // 2. detect every 256 samples
    if (this.since >= 512) {
      this.since = 0; this.detect();
      if (this.period > 0 && this.voiced > 0) {
        const f = sampleRate / this.period;
        this.periodS = this.periodS ? this.periodS + (this.period - this.periodS) * 0.5 : this.period;
        const tf = this.target(f, scale, root); this.lastPitch = f; this.targetPitch = tf;
        this.ratioT = Math.pow(tf / f, amount);
      } else { this.ratioT = 1; this.lastPitch = 0; }
    }
    // retune: one-pole toward the target ratio, time constant `retune` seconds
    const k = 1 - Math.exp(-n / (retune * sampleRate));
    this.ratio += (this.ratioT - this.ratio) * k;
    // 3. synthesis: lay grains at the corrected period into the output ring, up to the end of this block (+ lookahead)
    const blockEnd = this.op + n; // absolute output index
    const P = this.periodS > 0 ? this.periodS : 0;
    const v = this.voiced;
    if (!bypass && v > 0 && P > 0) {
      const Pg = Math.min(P, 512);                            // grain half-width; very low notes get a shorter window
      const L = Math.floor(2 * Pg), half = Math.floor(L / 2);
      // every grain whose window reaches into this block must be placed now; the input it needs (up to
      // center + P/8 + half) is already in the ring because D covers it
      while (this.nextSynth < blockEnd + half + 1) {
        const Ps = P / this.ratio;                            // output period
        const center = this.nextSynth - this.D;               // matching input position (absolute input index)
        // analysis mark: on the P grid from the last one (grains repeat or skip as the ratio demands), then peak-aligned
        let anal = this.lastAnal ? this.lastAnal + Math.round((center - this.lastAnal) / P) * P : center;
        if (Math.abs(anal - center) > P) anal = center;
        anal = Math.round(anal);
        let best = anal, bv = -1; const w = Math.max(2, Math.floor(P / 8));
        for (let j = anal - w; j <= anal + w; j++) { const a = Math.abs(this.buf[j & mask]); if (a > bv) { bv = a; best = j; } }
        anal = best; this.lastAnal = anal;
        const ns = Math.round(this.nextSynth);
        for (let j = 0; j < L; j++) {
          const wv = 0.5 - 0.5 * Math.cos(2 * Math.PI * (j + 0.5) / L);
          this.out[(ns - half + j) & mask] += this.buf[(anal - half + j) & mask] * wv;
        }
        this.grains = (this.grains || 0) + 1;
        this.nextSynth += Math.max(8, Ps);
      }
    } else {
      // not voiced / bypass: keep the synthesis clock rolling so the next voiced note starts in phase
      if (this.nextSynth < blockEnd) this.nextSynth = blockEnd; this.lastAnal = 0;
    }
    // 4. emit: mix PSOLA output with the dry signal delayed by D, weighted by voicing (crossfaded)
    for (let i = 0; i < n; i++) {
      const oi = (this.op + i) & mask, di = (this.op + i - this.D) & mask;
      const wet = this.out[oi], dry = this.buf[di];
      const g = bypass ? 0 : v;
      out[i] = dry * (1 - g) + wet * g;
      this.out[oi] = 0;
    }
    for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(out);
    this.op += n;
    // 5. stats
    if (t0) { const dt = (performance.now() - t0) / (1000 * n / sampleRate); this.cpu += (dt - this.cpu) * 0.05; }
    if ((++this.frames & 15) === 0) this.port.postMessage({ pitch: this.lastPitch, target: this.targetPitch, cents: this.lastPitch ? 1200 * Math.log2(this.targetPitch / this.lastPitch) : 0, voiced: v, cpu: this.cpu, latency: this.D / sampleRate, ratio: this.ratio, grains: this.grains || 0, period: P });
    return true;
  }
}
registerProcessor('stagedrums-pitchfix', PitchFixProcessor);
