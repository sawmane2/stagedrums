/* StageDrums — per-stem effect chains (drive, radio band, EQ, compressor, reverb) with one intensity knob.
   A chain sits between a stem's fxIn node and its fader (pre-fader). Intensity 0 = bypassed (nodes disconnected),
   so an idle chain costs nothing. Parameter moves go through setTargetAtTime so knobs don't zipper. */
(function (global) {
  'use strict';
  const SD = global.StageDrums;
  const lerp = (a, b, t) => a + (b - a) * t;
  const now = ctx => ctx.currentTime;
  const ramp = (param, v, ctx, tc = 0.02) => { try { param.setTargetAtTime(v, now(ctx), tc); } catch (e) { param.value = v; } };

  /** Normalised soft-clip curve: ((1+k)x)/(1+k|x|). 4× oversampled in the shaper to keep aliasing down. */
  function driveCurve(k, n = 4096) {
    const c = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = (i * 2) / (n - 1) - 1; c[i] = ((1 + k) * x) / (1 + k * Math.abs(x)); }
    return c;
  }
  /** Make-up gain so a typical vocal (≈ −12 dBFS sine) keeps its loudness whatever the drive. */
  function driveMakeup(k) {
    let inR = 0, outR = 0; const N = 512, A = 0.25;
    for (let i = 0; i < N; i++) { const x = A * Math.sin((i / N) * 2 * Math.PI); const y = ((1 + k) * x) / (1 + k * Math.abs(x)); inR += x * x; outR += y * y; }
    return Math.sqrt(inR / Math.max(outR, 1e-9));
  }
  function irBuffer(ctx, decay, tone = 0.5) {
    const sr = ctx.sampleRate, len = Math.max(1, Math.floor(sr * Math.min(6, Math.max(0.1, decay)))), buf = ctx.createBuffer(2, len, sr);
    for (let c = 0; c < 2; c++) { const d = buf.getChannelData(c); let lp = 0; const a = 0.15 + 0.8 * tone;
      for (let i = 0; i < len; i++) { const t = i / len; const n = Math.random() * 2 - 1; lp += (n - lp) * a; d[i] = lp * Math.pow(1 - t, 2.2) * (i < sr * 0.003 ? 0 : 1); } }
    return buf;
  }

  const TYPES = {
    drive: {
      label: 'Drive / fuzz', defaults: { drive: 0.5, tone: 0.5 },
      params: { drive: [0, 1, 'Drive'], tone: [0, 1, 'Tone'] },
      make(ctx) {
        const shaper = ctx.createWaveShaper(); shaper.oversample = '4x';
        const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 0.7;
        const makeup = ctx.createGain();
        shaper.connect(lp); lp.connect(makeup);
        let lastK = -1;
        return { input: shaper, output: makeup, set(p, I) {
          const k = lerp(0, 60, Math.pow(Math.max(0, Math.min(1, p.drive * I)), 1.6));
          if (Math.abs(k - lastK) > 0.05) { shaper.curve = driveCurve(k); lastK = k; ramp(makeup.gain, driveMakeup(k), ctx); }
          ramp(lp.frequency, lerp(20000, lerp(1800, 12000, p.tone), I), ctx);
        } };
      },
    },
    radio: {
      label: 'Radio band', defaults: { low: 200, high: 4000, q: 0.8 },
      params: { low: [40, 1000, 'Low cut Hz'], high: [1200, 12000, 'High cut Hz'], q: [0.5, 4, 'Resonance'] },
      make(ctx) {
        const hp = ctx.createBiquadFilter(); hp.type = 'highpass';
        const lp = ctx.createBiquadFilter(); lp.type = 'lowpass';
        hp.connect(lp);
        return { input: hp, output: lp, set(p, I) {
          ramp(hp.frequency, Math.exp(lerp(Math.log(20), Math.log(p.low), I)), ctx); ramp(hp.Q, lerp(0.7, p.q, I), ctx);
          ramp(lp.frequency, Math.exp(lerp(Math.log(20000), Math.log(p.high), I)), ctx); ramp(lp.Q, lerp(0.7, p.q, I), ctx);
        } };
      },
    },
    eq: {
      label: 'EQ (low / mid / high)', defaults: { low: 0, mid: 0, midF: 1200, high: 0 },
      params: { low: [-12, 12, 'Low dB'], mid: [-12, 12, 'Mid dB'], midF: [200, 6000, 'Mid Hz'], high: [-12, 12, 'High dB'] },
      make(ctx) {
        const l = ctx.createBiquadFilter(); l.type = 'lowshelf'; l.frequency.value = 200;
        const m = ctx.createBiquadFilter(); m.type = 'peaking'; m.Q.value = 1.1;
        const h = ctx.createBiquadFilter(); h.type = 'highshelf'; h.frequency.value = 4000;
        l.connect(m); m.connect(h);
        return { input: l, output: h, set(p, I) { ramp(l.gain, p.low * I, ctx); ramp(m.gain, p.mid * I, ctx); ramp(m.frequency, p.midF, ctx); ramp(h.gain, p.high * I, ctx); } };
      },
    },
    comp: {
      label: 'Compressor', defaults: { threshold: -18, ratio: 3, attack: 0.006, release: 0.18, makeup: 3 },
      params: { threshold: [-40, 0, 'Threshold dB'], ratio: [1, 12, 'Ratio'], attack: [0.001, 0.05, 'Attack s'], release: [0.05, 0.6, 'Release s'], makeup: [0, 12, 'Make-up dB'] },
      make(ctx) {
        const c = ctx.createDynamicsCompressor(); c.knee.value = 6; const g = ctx.createGain(); c.connect(g);
        return { input: c, output: g, set(p, I) {
          ramp(c.threshold, lerp(0, p.threshold, I), ctx); ramp(c.ratio, lerp(1, p.ratio, I), ctx); ramp(c.attack, p.attack, ctx); ramp(c.release, p.release, ctx);
          ramp(g.gain, Math.pow(10, (p.makeup * I) / 20), ctx);
        } };
      },
    },
    verb: {
      label: 'Reverb', defaults: { wet: 0.25, decay: 1.4, tone: 0.5 },
      params: { wet: [0, 1, 'Wet'], decay: [0.2, 5, 'Decay s'], tone: [0, 1, 'Brightness'] },
      make(ctx) {
        const inp = ctx.createGain(), out = ctx.createGain(), dry = ctx.createGain(), wet = ctx.createGain(), conv = ctx.createConvolver();
        inp.connect(dry); dry.connect(out); inp.connect(conv); conv.connect(wet); wet.connect(out);
        let last = null;
        return { input: inp, output: out, set(p, I) {
          const key = p.decay.toFixed(2) + '/' + p.tone.toFixed(2);
          if (key !== last) { conv.buffer = irBuffer(ctx, p.decay, p.tone); last = key; }
          ramp(wet.gain, p.wet * I, ctx); ramp(dry.gain, 1 - 0.25 * p.wet * I, ctx);
        } };
      },
    },
  };

  const PRESETS = {
    'radio-fuzz-vocal': { label: 'Radio fuzz vocal (The Prowl)', intensity: 0.75, chain: [
      { type: 'radio', low: 200, high: 4000, q: 0.9 }, { type: 'drive', drive: 0.5, tone: 0.45 }, { type: 'eq', low: 0, mid: 3, midF: 1400, high: 0 } ] },
    'warm-vocal': { label: 'Warm vocal (comp + air)', intensity: 0.7, chain: [ { type: 'comp', threshold: -20, ratio: 3, attack: 0.008, release: 0.2, makeup: 3 }, { type: 'eq', low: -1, mid: 0, midF: 1000, high: 2 } ] },
    'telephone': { label: 'Telephone', intensity: 1, chain: [ { type: 'radio', low: 400, high: 3000, q: 1.5 } ] },
    'crunch-guitar': { label: 'Crunch guitar', intensity: 0.6, chain: [ { type: 'drive', drive: 0.35, tone: 0.6 }, { type: 'eq', low: -2, mid: 2, midF: 800, high: -1 } ] },
    'room': { label: 'Room reverb', intensity: 0.6, chain: [ { type: 'verb', wet: 0.3, decay: 1.2, tone: 0.5 } ] },
    'glue': { label: 'Glue compressor', intensity: 0.7, chain: [ { type: 'comp', threshold: -16, ratio: 2.5, attack: 0.01, release: 0.25, makeup: 2 } ] },
  };

  /**
   * Build a chain from a spec {enabled, intensity, chain:[{type, ...params}]}.
   * Returns {input, output, update(spec), dispose(), shape} — `shape` identifies the node structure so callers
   * can decide whether an update needs a rebuild (types/order changed) or just new parameter values.
   */
  function build(ctx, spec) {
    const input = ctx.createGain(), output = ctx.createGain();
    const fx = [];
    let prev = input;
    for (const e of (spec.chain || [])) {
      const T = TYPES[e.type]; if (!T) continue;
      const node = T.make(ctx); prev.connect(node.input); prev = node.output; fx.push({ type: e.type, node });
    }
    prev.connect(output);
    const chain = {
      input, output, shape: shapeOf(spec),
      update(s) {
        const I = Math.max(0, Math.min(1, s.intensity ?? 1));
        (s.chain || []).forEach((e, i) => { const f = fx[i]; if (!f || f.type !== e.type) return; f.node.set(Object.assign({}, TYPES[e.type].defaults, e), I); });
      },
      dispose() { try { input.disconnect(); output.disconnect(); for (const f of fx) { f.node.input.disconnect(); f.node.output.disconnect(); } } catch (e) {} },
    };
    chain.update(spec);
    return chain;
  }
  function shapeOf(spec) { return (spec && spec.chain || []).map(e => e.type).join('>'); }
  /** Is this spec audible at all? (enabled, intensity > 0, at least one known effect) */
  function active(spec) { return !!(spec && spec.enabled !== false && (spec.intensity ?? 1) > 0.001 && (spec.chain || []).some(e => TYPES[e.type])); }

  SD.FX = { TYPES, PRESETS, build, shapeOf, active };
})(window);
