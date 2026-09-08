/* StageDrums — offline pitch-shift / time-stretch worker (SoundTouchJS, LGPL-2.1, vendored in vendor/ with one
   small modification: guided WSOLA offsets). One job = one song: {id, stems:{name:[Float32Array,…]}, sampleRate,
   semitones, tempo} → {id, stems:{name:[…]}}. A reference pass over the *sum of all stems* records the time-domain
   decisions; every stem is then processed replaying those same decisions, so the stems stay sample-aligned with
   each other (a naive per-stem run drifts by up to ~10 ms between kick and bass). Pitch shift keeps duration;
   tempo != 1 changes it and the caller rescales bar times. */
import { SoundTouch, SimpleFilter } from './vendor/soundtouch.js';

function run(L, R, semitones, tempo, guide, record) {
  const n = L.length;
  const source = { extract(target, numFrames, position) {
    const avail = Math.max(0, Math.min(numFrames, n - position));
    for (let i = 0; i < avail; i++) { target[i * 2] = L[position + i]; target[i * 2 + 1] = R[position + i]; }
    return avail; } };
  const st = new SoundTouch(); st.pitchSemitones = semitones; st.tempo = tempo;
  st.stretch.guide = guide || null; st.stretch.guideIndex = 0; st.stretch.record = record || null;
  const filter = new SimpleFilter(source, st);
  const want = Math.round(n / tempo), cap = want + 44100;
  const outL = new Float32Array(cap), outR = new Float32Array(cap);
  const chunk = 8192, buf = new Float32Array(chunk * 2);
  let got = 0, frames;
  while ((frames = filter.extract(buf, chunk)) > 0) {
    if (got + frames > cap) break;
    for (let i = 0; i < frames; i++) { outL[got + i] = buf[i * 2]; outR[got + i] = buf[i * 2 + 1]; }
    got += frames;
  }
  const fin = [outL, outR].map(a => { const o = new Float32Array(want); o.set(a.subarray(0, Math.min(got, want))); return o; });
  return fin;
}

self.onmessage = ({ data }) => {
  const { id, stems, sampleRate, semitones = 0, tempo = 1 } = data;
  const names = Object.keys(stems);
  const n = Math.max(...names.map(k => stems[k][0].length));
  // reference = the band as a whole
  const mixL = new Float32Array(n), mixR = new Float32Array(n);
  for (const k of names) { const [l, r] = [stems[k][0], stems[k][1] || stems[k][0]]; for (let i = 0; i < l.length; i++) { mixL[i] += l[i]; mixR[i] += r[i]; } }
  const record = [];
  run(mixL, mixR, semitones, tempo, null, record);
  self.postMessage({ id, progress: 1 / (names.length + 1) });
  const out = {}, transfer = [];
  names.forEach((k, i) => {
    const l = stems[k][0], r = stems[k][1] || stems[k][0];
    // stems shorter than the longest are padded so every stem sees the same frame grid
    const L = l.length === n ? l : Object.assign(new Float32Array(n), l), R = r.length === n ? r : Object.assign(new Float32Array(n), r);
    const fin = run(L, R, semitones, tempo, record, null);
    out[k] = fin; transfer.push(fin[0].buffer, fin[1].buffer);
    self.postMessage({ id, progress: (i + 2) / (names.length + 1) });
  });
  self.postMessage({ id, stems: out, sampleRate }, transfer);
};
