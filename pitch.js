/* StageDrums — key change and tempo change by rendering every stem offline (keyshift-worker.js) and swapping
   the buffers, so nothing runs in real time on the audio thread. Sync stays exact: pitch shift keeps every
   sample position; a tempo change rescales barTimes by the same ratio. */
(function (global) {
  'use strict';
  const SD = global.StageDrums;

  class Shifter {
    constructor() { this.worker = null; this.job = null; this.seq = 0; }
    _w() {
      if (this.worker) return this.worker;
      const w = new Worker('keyshift-worker.js', { type: 'module' });
      w.onmessage = ({ data }) => { const j = this.job; if (!j || j.id !== data.id) return; if (data.progress != null) { j.onProgress && j.onProgress(data.progress); return; } this.job = null; j.resolve(data); };
      w.onerror = e => { const j = this.job; this.job = null; if (j) j.reject(e); this.worker = null; try { w.terminate(); } catch (x) {} };
      this.worker = w; return w;
    }
    /** Run one whole song through the worker: {name: [Float32Array,…]} → same shape. */
    _run(stems, opts, onProgress) {
      const id = ++this.seq, w = this._w(), transfer = [];
      for (const k of Object.keys(stems)) for (const ch of stems[k]) transfer.push(ch.buffer);
      return new Promise((resolve, reject) => {
        this.job = { id, resolve, reject, onProgress };
        w.postMessage({ id, stems, sampleRate: opts.sampleRate, semitones: opts.semitones || 0, tempo: opts.tempo || 1 }, transfer);
      });
    }
    /** Measure the algorithm's constant lag with a click train, so rendered stems stay aligned to barTimes. */
    async calibrate(sampleRate, opts) {
      const sr = sampleRate, n = sr * 4, x = new Float32Array(n), tempo = opts.tempo || 1;
      for (let k = sr; k < n - sr; k += Math.floor(sr / 2)) for (let i = 0; i < 40; i++) x[k + i] = (i % 2 ? -1 : 1) * (1 - i / 40);
      const r = await this._run({ c: [x.slice(), x.slice()] }, Object.assign({}, opts, { sampleRate }));
      const y = r.stems.c[0];
      let best = 0, bestV = -1;
      for (let lag = -6000; lag <= 6000; lag += 2) { let s = 0; for (let k = sr; k < n - sr; k += 3) { const j = Math.round(k / tempo) + lag; if (j >= 0 && j < y.length) s += x[k] * y[j]; } if (s > bestV) { bestV = s; best = lag; } }
      return best;
    }
    /**
     * Render {name: AudioBuffer} → {name: AudioBuffer} at `semitones` and/or `tempo`. onProgress(done, total).
     * All stems go through one guided pass so they keep their relative timing; the output is shifted by the measured
     * constant lag so sample 0 still means bar-time 0.
     */
    async render(ctx, stems, opts, onProgress) {
      const sr = ctx.sampleRate, tempo = opts.tempo || 1, names = Object.keys(stems);
      const lag = await this.calibrate(sr, opts);
      const raw = {}; for (const k of names) { const b = stems[k]; raw[k] = []; for (let c = 0; c < b.numberOfChannels; c++) raw[k].push(b.getChannelData(c).slice()); }
      const r = await this._run(raw, Object.assign({}, opts, { sampleRate: sr }), p => onProgress && onProgress(p * names.length, names.length));
      const out = {};
      for (const k of names) {
        const src = stems[k], want = Math.round(src.length / tempo), b = ctx.createBuffer(src.numberOfChannels, want, sr);
        for (let c = 0; c < b.numberOfChannels; c++) {
          const y = r.stems[k][Math.min(c, r.stems[k].length - 1)], d = b.getChannelData(c);
          if (lag >= 0) d.set(y.subarray(lag, lag + Math.min(want, y.length - lag)));
          else d.set(y.subarray(0, Math.min(want + lag, y.length)), -lag);
        }
        out[k] = b;
      }
      onProgress && onProgress(names.length, names.length);
      return out;
    }
    dispose() { if (this.worker) this.worker.terminate(); this.worker = null; this.job = null; }
  }

  // ---------- chord transposition for the chart ----------
  const SHARPS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const FLATS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
  const IDX = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, Fb: 4, F: 5, 'E#': 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11, Cb: 11 };
  function transposeNote(note, semis, flats) {
    const i = IDX[note]; if (i == null) return note;
    const pc = (((i + semis) % 12) + 12) % 12;
    let useFlats = flats;
    if (useFlats == null) { // spell the way a player would read it: Bb/Eb/Ab as flats, F#/C# as sharps, Db when coming down
      if (/b$/.test(note)) useFlats = true; else if (/#$/.test(note)) useFlats = false;
      else useFlats = pc === 3 || pc === 8 || pc === 10 || (pc === 1 && semis < 0);
    }
    return (useFlats ? FLATS : SHARPS)[pc];
  }
  /** "Am7/G" + 2 → "Bm7/A". Holds ('.', '|', 'N.C.') pass through. `flats` forces a spelling; by default the note's own spelling and the target decide. */
  function transpose(name, semis, flats) {
    if (!semis || !name) return name;
    const m = String(name).match(/^([A-G](?:#|b)?)(.*?)(?:\/([A-G](?:#|b)?))?$/);
    if (!m) return name;
    return transposeNote(m[1], semis, flats) + (m[2] || '') + (m[3] ? '/' + transposeNote(m[3], semis, flats) : '');
  }
  /** Transpose every chord token in a bar string ("G D", "Am . . G") or a sheet line, leaving everything else alone. */
  function transposeLine(line, semis, flats) {
    if (!semis || !line) return line;
    return String(line).replace(/[A-G](?:#|b)?(?:maj|min|m|M|dim|aug|sus|add|°|ø|\+|-)?[0-9]*(?:\([^))]*\))?(?:(?:maj|min|m|M|sus|add|dim|aug|b|#|\+|-)?[0-9]+)*(?:\/[A-G](?:#|b)?)?(?![a-z])/g, tok => transpose(tok, semis, flats));
  }

  SD.Shifter = Shifter; SD.transpose = transpose; SD.transposeLine = transposeLine;
})(window);
