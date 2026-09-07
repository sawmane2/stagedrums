/* StageDrums — parse pasted chord sheets (Ultimate Guitar "Chords" text) into a song. */
(function (global) {
  'use strict';

  const CHORD_RE = /^(N\.?C\.?|[A-G](?:#|b|♯|♭)?(?:maj|min|m|M|dim|aug|sus|add|dom|°|ø|\+|-)?[0-9]*(?:\([^)]*\))?(?:(?:maj|min|m|M|sus|add|dim|aug|b|#|♭|♯|\+|-)?[0-9]+)*(?:\/[A-G](?:#|b|♯|♭)?)?)$/;
  const HOLD_TOKENS = new Set(['|', '/', '.', '-', '%', '_', 'x2', 'x3', 'x4', '(x2)', '(x3)', '(x4)']);

  function isChordToken(tok) {
    if (!tok) return false;
    if (HOLD_TOKENS.has(tok)) return true;
    return CHORD_RE.test(tok.replace(/[()]/g, ''));
  }

  /** A line is a chord line if every non-empty token looks like a chord/hold. */
  function isChordLine(line) {
    const toks = line.trim().split(/\s+/).filter(Boolean);
    if (!toks.length) return false;
    const chords = toks.filter(t => isChordToken(t));
    // Be tolerant of stray annotations like "(x2)" or "|"
    return chords.length === toks.length || (chords.length >= 2 && chords.length >= toks.length - 1 && toks.some(t => CHORD_RE.test(t)));
  }

  function guessGroove(sectionName, fallback) {
    const n = sectionName.toLowerCase();
    if (/intro/.test(n)) return 'hats-only';
    if (/bridge/.test(n)) return 'half-time';
    if (/outro|ending/.test(n)) return fallback;
    if (/solo/.test(n)) return fallback;
    return fallback;
  }

  /**
   * Parse UG-style text into sections. Section headers: [Verse 1], [Chorus], Verse:, CHORUS etc.
   * Chord lines become bars: with the "one chord per bar" default, "G D Em C" → 4 bars.
   * A '|' separated line like "| G  D | Em C |" is honoured as explicit bars.
   * A repeat marker "x2" at the end of a line duplicates that line.
   */
  function parseChordSheet(text, opts = {}) {
    const lines = text.replace(/\r/g, '').split('\n');
    const sections = [];
    let cur = null;
    const HEADER_RE = /^\s*\[?\s*((?:pre-?)?(?:intro|verse|chorus|bridge|solo|lead|outro|interlude|instrumental|break|tag|ending|coda|refrain|hook|turnaround|main riff|riff)\s*\d*[^\]\n]*?)\s*\]?\s*:?\s*$/i;

    const push = (name) => { cur = { name: name.trim(), bars: [], lyrics: [], sheet: [] }; sections.push(cur); };

    for (let raw of lines) {
      const line = raw.replace(/\t/g, '    ');
      const trimmed = line.trim();
      if (!trimmed) continue;
      const h = trimmed.match(HEADER_RE) || trimmed.match(/^\[([^\]]{1,40})\]$/);
      if (h) {
        // ignore metadata like [tab] or [ch] tags leaked from HTML
        if (/^(tab|ch)$/i.test(h[1])) continue;
        push(h[1]); continue;
      }
      if (/^(capo|tuning|key|tempo|bpm|difficulty|author|strumming)/i.test(trimmed)) {
        const t = trimmed.match(/(?:tempo|bpm)\D*(\d{2,3})/i); if (t) opts.bpm = +t[1];
        continue;
      }
      if (isChordLine(trimmed)) {
        if (!cur) push('Verse 1');
        cur.sheet.push(line.replace(/\s+$/, ''));
        if (opts.barsPerLine > 0) { // fixed bars per chord line: chords placed by column, holds fill the rest
          const n = opts.barsPerLine, toks = [];
          const re = /\S+/g; let mm; while ((mm = re.exec(line))) if (!/^\(?x\d\)?$/i.test(mm[0])) toks.push({ col: mm.index, name: mm[0] });
          // chords in a line split its bars evenly (blues lines change on the half-line); first chord gets any remainder
          const bars = new Array(n).fill(toks[0] ? toks[0].name : '—');
          if (toks.length > 1) { const per = Math.floor(n / toks.length), rem = n - per * toks.length;
            let b = 0; toks.forEach((t, i) => { const len = per + (i === 0 ? rem : 0); for (let k = 0; k < len && b < n; k++, b++) bars[b] = t.name; }); }
          cur.bars.push(...bars); continue;
        }
        let l = trimmed;
        let rep = 1; const m = l.match(/\(?x(\d)\)?\s*$/i); if (m) { rep = +m[1]; l = l.slice(0, m.index).trim(); }
        let bars;
        if (l.includes('|')) {
          bars = l.split('|').map(s => s.trim()).filter(Boolean).map(s => s.split(/\s+/).filter(t => !HOLD_TOKENS.has(t) || /^[./-]$/.test(t)).join(' '));
        } else {
          const toks = l.split(/\s+/).filter(t => !/^\(?x\d\)?$/i.test(t));
          if (opts.chordsPerBar && opts.chordsPerBar > 1) {
            bars = [];
            for (let i = 0; i < toks.length; i += opts.chordsPerBar) bars.push(toks.slice(i, i + opts.chordsPerBar).join(' '));
          } else {
            // Merge hold tokens into the previous chord's bar ("G . . D" style)
            bars = [];
            for (const t of toks) {
              if (/^[./-]$/.test(t) && bars.length) bars[bars.length - 1] += ' ' + t;
              else bars.push(t);
            }
          }
        }
        for (let r = 0; r < rep; r++) cur.bars.push(...bars);
      } else {
        if (cur) { cur.lyrics.push(trimmed); cur.sheet.push(line.replace(/\s+$/, '')); }
      }
    }

    // Collapse repeated chord-line + lyric-line pairs: nothing to do, bars already accumulated.
    const groove = opts.groove || 'rock';
    const song = {
      id: 'song-' + Date.now().toString(36),
      title: opts.title || 'Untitled', artist: opts.artist || '',
      bpm: opts.bpm || 120, time: opts.time || '4/4', groove,
      sections: sections.filter(s => s.bars.length).map(s => ({
        name: s.name, groove: guessGroove(s.name, groove),
        fill: !/intro/i.test(s.name), bars: s.bars,
        lyrics: s.lyrics.join('\n'), sheet: s.sheet.join('\n'),
      })),
    };
    if (!song.sections.length) throw new Error('No chord lines found. Paste the chords text (not the URL) — chords like G, Am, D7 on their own lines.');
    return song;
  }

  /** Prompt you can give to an AI (Claude/ChatGPT) with the chord sheet to get a StageDrums song JSON back. */
  function aiPrompt(text, meta) {
    const grooves = Object.entries(global.StageDrums.GROOVES).map(([k, v]) => `${k} (${v.sig}: ${v.desc})`).join(', ');
    return `You are helping build a backing-drum + chord-chart file for live performance.
Convert the chord sheet below into JSON with EXACTLY this shape:

{
  "title": "...", "artist": "...", "bpm": 120, "time": "4/4", "groove": "rock",
  "sections": [
    { "name": "Intro", "groove": "hats-only", "repeat": 1, "fill": false, "crash": false, "bars": ["G", "D", "Em", "C"] },
    { "name": "Verse 1", "groove": "rock", "fill": true, "bars": ["G", "D", "Em", "C", "G", "D", "Em", "C"] }
  ]
}

Rules:
- Each item in "bars" is ONE bar. Put two chords in one bar as "G D" (half bar each), or use dots to hold: "Am . . G" = Am for 3 beats, G for 1.
- Work out the real bar count from the song's rhythm/lyrics (listen to the song if you know it); UG sheets often show one chord per change, not per bar.
- Pick the closest groove per section from this list: ${grooves}.
- Use "repeat" instead of duplicating identical bars. Use "fill": true when a section leads into a bigger one; "crash": true on big section entrances.
- Use the song's real tempo for "bpm" and correct time signature.
- Copy each section's lyric lines from the sheet into "lyrics" (one line per line, \n separated) so they show on the chart.
- Return ONLY the JSON.

Title: ${meta.title || ''}   Artist: ${meta.artist || ''}

CHORD SHEET:
${text}`;
  }

  /** Attach a pasted sheet's lyrics/chord lines to an existing song's sections (keeps bars & grooves). */
  function attachSheet(song, text) {
    const parsed = parseChordSheet(text, { barsPerLine: 4 });
    const norm = s => String(s).toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-z0-9]/g, '');
    const used = new Set(); let attached = 0;
    const secs = song.sections;
    for (const ps of parsed.sections) {
      let target = secs.find((s, i) => !used.has(i) && norm(s.name) === norm(ps.name));
      if (!target) target = secs.find((s, i) => !used.has(i) && !/intro|outro|solo|instrumental|count/i.test(s.name) && !s.sheet);
      if (!target) continue;
      used.add(secs.indexOf(target)); target.sheet = ps.sheet; target.lyrics = ps.lyrics; attached++;
    }
    return attached;
  }
  global.StageDrums.attachSheet = attachSheet;
  global.StageDrums.parseChordSheet = parseChordSheet;
  global.StageDrums.aiPrompt = aiPrompt;
  global.StageDrums.isChordLine = isChordLine;
})(window);
