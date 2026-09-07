/* StageDrums — noise gate AudioWorklet. Peak-follower gate with attack / hold / release and a floor ("range"). */
class GateProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'threshold', defaultValue: -45, minValue: -90, maxValue: 0 },   // dB
      { name: 'attack',    defaultValue: 0.005, minValue: 0.0005, maxValue: 0.2 }, // s
      { name: 'hold',      defaultValue: 0.06, minValue: 0, maxValue: 1 },     // s
      { name: 'release',   defaultValue: 0.12, minValue: 0.005, maxValue: 2 },  // s
      { name: 'range',     defaultValue: -80, minValue: -100, maxValue: 0 },   // dB floor when closed
      { name: 'bypass',    defaultValue: 0, minValue: 0, maxValue: 1 },
    ];
  }
  constructor() {
    super();
    this.env = 0; this.gain = 0; this.holdLeft = 0; this.open = false; this.frames = 0;
  }
  process(inputs, outputs, p) {
    const inp = inputs[0], out = outputs[0];
    if (!inp || !inp.length) return true;
    const n = inp[0].length, sr = sampleRate;
    if (p.bypass[0] > 0.5) { for (let c = 0; c < out.length; c++) out[c].set(inp[c] || inp[0]); return true; }
    const thr = Math.pow(10, p.threshold[0] / 20);
    const floor = Math.pow(10, p.range[0] / 20);
    const hyst = thr * 0.7; // close a bit below the open threshold
    const aCoef = Math.exp(-1 / (sr * Math.max(0.0005, p.attack[0])));
    const rCoef = Math.exp(-1 / (sr * Math.max(0.005, p.release[0])));
    const envRel = Math.exp(-1 / (sr * 0.02));
    const holdSamples = Math.floor(p.hold[0] * sr);
    let peak = 0;
    for (let i = 0; i < n; i++) {
      // envelope: peak follower with fast attack, 20ms release, summed across channels
      let s = 0; for (let c = 0; c < inp.length; c++) s = Math.max(s, Math.abs(inp[c][i]));
      this.env = s > this.env ? s : this.env * envRel + s * (1 - envRel);
      if (this.env > peak) peak = this.env;
      // state
      if (this.env > thr) { this.open = true; this.holdLeft = holdSamples; }
      else if (this.open && this.env < hyst) { if (this.holdLeft > 0) this.holdLeft--; else this.open = false; }
      const target = this.open ? 1 : floor;
      this.gain = target > this.gain ? target + (this.gain - target) * aCoef : target + (this.gain - target) * rCoef;
      for (let c = 0; c < out.length; c++) out[c][i] = (inp[c] || inp[0])[i] * this.gain;
    }
    this.frames += n;
    if (this.frames >= sr / 20) { this.frames = 0; this.port.postMessage({ open: this.open, gain: this.gain, peak }); }
    return true;
  }
}
registerProcessor('stagedrums-gate', GateProcessor);
