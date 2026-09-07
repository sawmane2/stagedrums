/* StageDrums — MIDI: .mid export/import (SMF) and live Web MIDI output with clock. */
(function (global) {
  'use strict';
  const SD = global.StageDrums;

  // General MIDI drum map (channel 10)
  const GM = { K: 36, S: 38, R: 37, H: 42, Ho: 46, D: 51, C: 49, T: 50, M: 47, F: 43, B: 56, CLICK: 76 };
  const NOTE_TO_INST = { 35: 'K', 36: 'K', 37: 'R', 38: 'S', 40: 'S', 39: 'S', 42: 'H', 44: 'H', 46: 'Ho', 51: 'D', 59: 'D', 53: 'D',
    49: 'C', 57: 'C', 55: 'C', 52: 'C', 50: 'T', 48: 'T', 47: 'M', 45: 'M', 43: 'F', 41: 'F', 56: 'B' };
  const VEL = { X: 120, x: 96, g: 40, o: 100 };

  function noteFor(inst, ch) { return inst === 'H' && ch === 'o' ? GM.Ho : inst === 'Hp' ? 44 : inst === 'Db' ? 53 : GM[inst]; }
  function velFor(ch) { return VEL[ch] || 96; }

  // ---------- helpers ----------
  function vlq(n) { const b = [n & 0x7f]; while ((n >>= 7) > 0) b.unshift((n & 0x7f) | 0x80); return b; }
  function u32(n) { return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]; }
  function u16(n) { return [(n >> 8) & 255, n & 255]; }
  function str(s) { return Array.from(new TextEncoder().encode(s)); }
  function track(events) { // events: [{t, data:[...]}] absolute ticks
    events.sort((a, b) => a.t - b.t || a.pri - b.pri);
    const out = []; let last = 0;
    for (const e of events) { out.push(...vlq(e.t - last), ...e.data); last = e.t; }
    out.push(0, 0xff, 0x2f, 0); // end of track
    return [...str('MTrk'), ...u32(out.length), ...out];
  }
  function meta(t, type, bytes, pri = 0) { return { t, pri, data: [0xff, type, ...vlq(bytes.length), ...bytes] }; }

  // Chord name → MIDI notes (block chord, octave around C3-C4) for a reference chord track
  const ROOTS = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11, Cb: 11 };
  function chordNotes(name) {
    const m = String(name).match(/^([A-G][#b]?)(.*?)(?:\/([A-G][#b]?))?$/); if (!m) return [];
    const root = ROOTS[m[1]]; if (root == null) return [];
    const q = m[2];
    let iv = [0, 4, 7];
    if (/^(m|min|-)(?!aj)/.test(q)) iv = [0, 3, 7];
    if (/dim|°/.test(q)) iv = [0, 3, 6];
    if (/aug|\+/.test(q)) iv = [0, 4, 8];
    if (/sus2/.test(q)) iv = [0, 2, 7]; else if (/sus/.test(q)) iv = [0, 5, 7];
    if (/5$/.test(q) && !/7|9|6/.test(q)) iv = [0, 7];
    if (/maj7|M7|Δ/.test(q)) iv.push(11); else if (/7/.test(q)) iv.push(10);
    if (/6/.test(q) && !/7/.test(q)) iv.push(9);
    if (/9/.test(q)) { if (!iv.includes(10) && !iv.includes(11)) iv.push(10); iv.push(14); }
    if (/add9|2$/.test(q)) iv.push(14);
    const base = 48 + root; // C3 = 48
    const notes = iv.map(i => base + i);
    if (m[3] && ROOTS[m[3]] != null) notes.unshift(36 + ROOTS[m[3]]); // bass note
    return notes;
  }

  // ---------- Export ----------
  function exportMidi(song, opts = {}) {
    const tl = SD.buildTimeline(song);
    const sig = tl.sig, PPQ = 480;
    const den0 = +sig.sig.split('/')[1];
    const stepTicks = (PPQ * 4 / den0) / sig.stepsPerBeat; // ticks per grid step
    const barTicks = stepTicks * sig.steps;
    const usPerQuarter = Math.round(60e6 / (song.bpm || 120));
    const [num, den] = sig.sig.split('/').map(Number);
    const denPow = Math.log2(den);

    const meta0 = [
      meta(0, 0x03, str(`${song.title || 'Song'} - ${song.artist || ''}`)),
      meta(0, 0x51, [(usPerQuarter >> 16) & 255, (usPerQuarter >> 8) & 255, usPerQuarter & 255]),
      meta(0, 0x58, [num, denPow, 24, 8]),
    ];
    const drums = [meta(0, 0x03, str('Drums (StageDrums)'))];
    const chords = [meta(0, 0x03, str('Chords (reference)'))];
    const CH_DRUM = 9, CH_CHORD = 0;

    tl.sections.forEach(sec => meta0.push(meta(sec.start * barTicks, 0x06, str(sec.name)))); // markers
    tl.bars.forEach((bar, bi) => {
      const t0 = bi * barTicks;
      // chord text events + block chords
      bar.chords.forEach(c => {
        const t = t0 + Math.round(c.at * sig.stepsPerBeat * stepTicks);
        const len = Math.round(c.beats * sig.stepsPerBeat * stepTicks) - 5;
        if (c.name && c.name !== '—') {
          meta0.push(meta(t, 0x01, str(c.name)));
          chordNotes(c.name).forEach(n => {
            chords.push({ t, pri: 1, data: [0x90 | CH_CHORD, n, 70] });
            chords.push({ t: t + len, pri: 0, data: [0x80 | CH_CHORD, n, 0] });
          });
        }
      });
      // drums
      const hits = SD.barHits(bar, bi, tl);
      for (const h of hits) {
        const t = t0 + h.step * stepTicks;
        drums.push({ t, pri: 1, data: [0x90 | CH_DRUM, h.note, h.vel] });
        drums.push({ t: t + Math.round(stepTicks / 2), pri: 0, data: [0x80 | CH_DRUM, h.note, 0] });
      }
    });
    const tracks = [track(meta0), track(drums), track(chords)];
    const bytes = new Uint8Array([...str('MThd'), ...u32(6), ...u16(1), ...u16(tracks.length), ...u16(PPQ), ...tracks.flat()]);
    return bytes;
  }

  /** All drum hits for one timeline bar as [{step, inst, ch, note, vel}], honouring custom MIDI bars, fills, crash. */
  SD.barHits = function (bar, bi, tl) {
    const sig = tl.sig; const hits = [];
    if (bar.crash) hits.push({ step: 0, inst: 'C', ch: 'x', note: GM.C, vel: 110 });
    let pat = bar.custom || (bar.varIdx && bar.groove.vars ? bar.groove.vars[bar.varIdx - 1] : bar.groove);
    if (!bar.custom && bar.fill) { const f = bar.groove.fills || SD.FILLS[sig.sig]; pat = f[(bi * 5 + (bar.section || 0) * 3) % f.length]; }
    let mini = null;
    if (!bar.custom && bar.mini) { const mf = bar.groove.minis || SD.MINIFILLS[sig.sig]; if (mf) mini = mf[(bi * 3) % mf.length]; }
    for (const inst of ['K', 'S', 'R', 'H', 'Hp', 'D', 'Db', 'C', 'T', 'M', 'F', 'B']) {
      let row = pat[inst];
      if (mini) { // overlay the last-beat mini fill: drums the mini defines take over the last beat
        const base = (row || '.'.repeat(sig.steps)).split(''); const mrow = mini[inst];
        if (mrow) { for (let s = sig.steps - 4; s < sig.steps; s++) base[s] = mrow[s] || '.'; row = base.join(''); }
        else if ('STMF'.includes(inst) && row) { for (let s = sig.steps - 4; s < sig.steps; s++) if (s % 4 !== 0) base[s] = '.'; row = base.join(''); }
      }
      if (!row) continue;
      for (let s = 0; s < sig.steps; s++) {
        const ch = row[s]; if (!ch || ch === '.') continue;
        hits.push({ step: s, inst, ch, note: noteFor(inst, ch), vel: velFor(ch) });
      }
    }
    return hits;
  };

  // ---------- Import (.mid drum track → per-bar custom patterns) ----------
  function readVlq(d, p) { let n = 0, b; do { b = d[p.i++]; n = (n << 7) | (b & 0x7f); } while (b & 0x80); return n; }
  function parseMidi(buf) {
    const d = new Uint8Array(buf);
    const rd32 = i => (d[i] << 24 | d[i + 1] << 16 | d[i + 2] << 8 | d[i + 3]) >>> 0;
    const rd16 = i => d[i] << 8 | d[i + 1];
    if (String.fromCharCode(...d.slice(0, 4)) !== 'MThd') throw new Error('Not a MIDI file');
    const ntracks = rd16(10), div = rd16(12);
    if (div & 0x8000) throw new Error('SMPTE time division not supported');
    const ppq = div;
    let pos = 8 + rd32(4);
    const notes = []; let tempo = null; let sig = null;
    for (let t = 0; t < ntracks; t++) {
      if (String.fromCharCode(...d.slice(pos, pos + 4)) !== 'MTrk') break;
      const len = rd32(pos + 4); const end = pos + 8 + len; const p = { i: pos + 8 };
      let tick = 0, status = 0;
      while (p.i < end) {
        tick += readVlq(d, p);
        let b = d[p.i];
        if (b & 0x80) { status = b; p.i++; } // else running status
        if (status === 0xff) {
          const type = d[p.i++]; const l = readVlq(d, p);
          if (type === 0x51 && tempo == null) tempo = 60e6 / ((d[p.i] << 16) | (d[p.i + 1] << 8) | d[p.i + 2]);
          if (type === 0x58 && !sig) sig = `${d[p.i]}/${1 << d[p.i + 1]}`;
          p.i += l;
        } else if (status === 0xf0 || status === 0xf7) { const l = readVlq(d, p); p.i += l; }
        else {
          const hi = status & 0xf0, ch = status & 0x0f;
          const n1 = d[p.i++]; const n2 = (hi === 0xc0 || hi === 0xd0) ? 0 : d[p.i++];
          if (hi === 0x90 && n2 > 0) notes.push({ tick, ch, note: n1, vel: n2 });
        }
      }
      pos = end;
    }
    return { ppq, notes, tempo, sig };
  }

  /** Convert parsed MIDI into per-bar custom patterns. Uses channel 10 notes if present, else all notes. */
  function midiToBars(parsed, timeSig) {
    const sig = SD.parseSig(timeSig || parsed.sig || '4/4');
    const ticksPerStep = (parsed.ppq * 4 / +sig.sig.split('/')[1]) / sig.stepsPerBeat;
    const ticksPerBar = ticksPerStep * sig.steps;
    let notes = parsed.notes.filter(n => n.ch === 9); if (!notes.length) notes = parsed.notes;
    const bars = [];
    for (const n of notes) {
      const inst = NOTE_TO_INST[n.note]; if (!inst) continue;
      const bar = Math.floor(n.tick / ticksPerBar);
      const step = Math.round((n.tick - bar * ticksPerBar) / ticksPerStep) % sig.steps;
      const b = bars[bar] || (bars[bar] = {});
      const key = inst === 'Ho' ? 'H' : inst;
      if (!b[key]) b[key] = '.'.repeat(sig.steps).split('');
      b[key][step] = inst === 'Ho' ? 'o' : n.vel > 110 ? 'X' : n.vel < 55 ? 'g' : 'x';
    }
    return { sig: sig.sig, bpm: parsed.tempo ? Math.round(parsed.tempo) : null,
      bars: Array.from(bars, b => b ? Object.fromEntries(Object.entries(b).map(([k, v]) => [k, v.join('')])) : null) };
  }

  // ---------- Live Web MIDI output ----------
  class MidiOut {
    constructor() { this.access = null; this.port = null; this.sendNotes = true; this.sendClock = true; this.ctx = null; }
    async init(ctx) {
      this.ctx = ctx;
      if (!navigator.requestMIDIAccess) throw new Error('Web MIDI is not supported in this browser (use Chrome/Edge on the computer).');
      this.access = await navigator.requestMIDIAccess({ sysex: false });
      return this.outputs();
    }
    outputs() { return this.access ? [...this.access.outputs.values()] : []; }
    select(id) { this.port = this.outputs().find(o => o.id === id) || null; }
    _ts(ctxTime) { return performance.now() + (ctxTime - this.ctx.currentTime) * 1000; }
    note(inst, ch, ctxTime) {
      if (!this.port || !this.sendNotes) return;
      const n = noteFor(inst, ch), v = velFor(ch), ts = this._ts(ctxTime);
      this.port.send([0x99, n, v], ts); this.port.send([0x89, n, 0], ts + 60);
    }
    clock(ctxTime) { if (this.port && this.sendClock) this.port.send([0xf8], this._ts(ctxTime)); }
    start(ctxTime) { if (this.port && this.sendClock) this.port.send([0xfa], this._ts(ctxTime)); }
    stop() { if (this.port && this.sendClock) this.port.send([0xfc]); }
  }

  SD.GM = GM; SD.exportMidi = exportMidi; SD.parseMidi = parseMidi; SD.midiToBars = midiToBars; SD.MidiOut = MidiOut; SD.chordNotes = chordNotes;
})(window);
