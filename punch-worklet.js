/* StageDrums — transient shaper for the kit stems. Two envelope followers (fast / slow) per channel; when the fast
   one leads, that's an attack → boost by `attack`; when it lags, that's the body → cut by `sustain`. ~20 ops/sample. */
class PunchProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [ { name: 'attack', defaultValue: 0.5, minValue: 0, maxValue: 1 }, { name: 'sustain', defaultValue: 0.3, minValue: 0, maxValue: 1 }, { name: 'bypass', defaultValue: 0, minValue: 0, maxValue: 1 } ];
  }
  constructor() { super(); this.fast = [0, 0]; this.slow = [0, 0]; this.g = [1, 1]; }
  process(inputs, outputs, p) {
    const inp = inputs[0], out = outputs[0]; if (!inp || !inp.length) return true;
    const sr = sampleRate, aF = 1 - Math.exp(-1 / (0.0006 * sr)), rF = 1 - Math.exp(-1 / (0.03 * sr)), aS = 1 - Math.exp(-1 / (0.02 * sr)), rS = 1 - Math.exp(-1 / (0.12 * sr)), gs = 1 - Math.exp(-1 / (0.002 * sr));
    const A = p.attack[0] * 1.6, S = p.sustain[0] * 0.8, bypass = p.bypass[0] > 0.5;
    for (let c = 0; c < out.length; c++) {
      const x = inp[Math.min(c, inp.length - 1)], y = out[c];
      let f = this.fast[c] || 0, s = this.slow[c] || 0, g = this.g[c] || 1;
      for (let i = 0; i < x.length; i++) {
        const a = Math.abs(x[i]);
        f += (a - f) * (a > f ? aF : rF); s += (a - s) * (a > s ? aS : rS);
        const r = f / (s + 1e-6);
        const target = bypass ? 1 : (r > 1 ? 1 + A * Math.min(3, r - 1) : 1 - S * Math.min(1, 1 - r));
        g += (target - g) * gs;
        y[i] = x[i] * g;
      }
      this.fast[c] = f; this.slow[c] = s; this.g[c] = g;
    }
    return true;
  }
}
registerProcessor('stagedrums-punch', PunchProcessor);
