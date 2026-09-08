# StageDrums — implementation plan: effects, key change, tap tempo, pedal, cue feed

Written for a coding agent picking this up cold. It reconciles a voice-brainstorm wish list against the
code that actually exists in this repo as of **v0.20.0**. Read §0 before anything else — several items in
the brainstorm are already built, and two of them are built differently than the notes assume.

---

## 0. What already exists (read this first)

**Runtime shape.** Plain HTML/JS, no build step, no framework, no bundler. Every file is loaded by a
`<script>` tag in `index.html` and hangs things off the `window.StageDrums` (`SD`) namespace. There is a
zero-dependency Node server (`server.js`) that serves the files, relays WebSocket sync between computer
and iPad, and exposes a small update/audio API. Keep all of that. Do not introduce a build step, a
framework, or npm runtime dependencies.

**The audio graph, as it is today** (`drums.js`, class `Transport`, audio-backing mode):

```
per stem:  AudioBufferSourceNode ──▶ audio.gains[stem] (GainNode) ──┐
                                                                    ├──▶ _aGain ──▶ ctx.destination
                                                                    │    (master backing level)
synth kit: DrumKit buses ──▶ master ──▶ sat ──▶ tone ──▶ comp ──────┘
```

- `Transport.setAudio({stems, mix, barTimes, fills, gain, …})` builds `audio.stems` (name → AudioBuffer),
  `audio.gains` (name → GainNode) and `_aGain`.
- `Transport._aStart(when, offset, keys)` creates fresh `AudioBufferSourceNode`s for `keys` (default: all
  stems), each wrapped in a short-crossfade GainNode, and connects them to `audio.gains[stem]`. It is
  called on start, on every seek (section jump, hold wrap, queued section) and for fill splices.
- `Transport._scheduleAudio()` is the clock in audio mode: the *recording* is the time source. Bar lines
  come from `audio.barTimes` (one entry per bar plus the end, measured from the drum stem). Every bar it
  fires `onBar`/`onBeat`, publishes a sync anchor, and resolves hold/+1/queue at the bar line.
- Per-section stem mixes already exist: `transport.stemMixFor(bar)` → `applyStemMix(bar, when)` ramps
  `audio.gains[*]` exactly at the bar line where a section starts.

**Song JSON, audio block, as it is today:**

```json
"audio": {
  "stems": { "drums": "local/audio/<id>/drums.mp3", "bass": "…", "guitar": "…", "vocals": "…" },
  "kit":   { "kick": "local/audio/<id>/kit/kick.mp3", "snare": "…", "toms": "…", "cymbals": "…" },
  "mix":   { "drums": 1, "bass": 1, "guitar": 1, "vocals": 0 },
  "mute":  { "vocals": true },
  "splitDrums": false,
  "barTimes": [0.255, 2.601, …],
  "fills": [15, 28, 36, …]
}
```
Sections can carry `"stems": {"guitar": 0}` to override the mix from that section's first bar.

**Already built — do not rebuild:** section loop/hold, +1 pass, queue/Go now, section pads, per-stem
faders and mutes, per-section stem mixes, kit split (kick/snare/toms/cymbals), real drum fills spliced
into loop turnarounds, voice cues, click, count-in, host/follower sync, live input mixer for the
Focusrite (`mixer.js`, gate worklet, comp, EQ, reverb, limiter, `setSinkId` output picking), MIDI in/out,
self-update from GitHub, song library + import + sheet view.

**Two brainstorm assumptions to correct:**
1. *"Tap tempo … could throw off stem sync"* — the risk is real but different from the note's framing.
   Nothing in this app plays at a "tempo"; the recording is the clock and `barTimes` are measured
   timestamps. Changing speed means resampling/stretching the audio itself and scaling `barTimes` by the
   same ratio. See §4 — done offline, it's much safer than the notes assume.
2. *"Both independently mixable"* for the cue feed — the click is Web Audio and mixable; the voice cues
   are `SpeechSynthesisUtterance`, which does **not** pass through the Web Audio graph and cannot be
   routed or metered. It has only its own `volume` property, and it plays to the system output. See §7
   for the two honest options.

**Testing.** `tests/` has a Playwright harness that drives the real app against a real server
(`node server.js 8099`). `tests/test-all.js` plays every song and asserts the chart lands on the right
section and chord with no console errors. **Every feature below must land with a test in that harness.**

**Release.** `node release.js <x.y.z> "notes"` bumps `version.json`, commits and tags. Bump `CACHE` in
`sw.js` on every release or browsers serve stale files. `local/` (the audio) is git-ignored on purpose.

---

## 1. Foundations to lay before any feature (do this first)

### 1a. Pin the sample rate to 44.1 kHz
`app.js` line ~9 currently:
```js
const ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
```
Change to `{ sampleRate: 44100, latencyHint: 'interactive' }`. Keep `interactive` — the same context runs
the live mic mixer, and `playback` would add tens of milliseconds to the monitor path.

Why it matters: `decodeAudioData` resamples every decoded file to the context rate. The stems are 44.1 kHz;
a 48 kHz context resamples all of them, every song, for no reason. After the change, log
`ctx.sampleRate` on boot and show a one-line warning in the sidebar if it isn't 44100 (Safari may refuse
the request).

Also worth telling the user once, in the README: **set the Focusrite to 44.1 kHz** in Audio MIDI Setup, or
CoreAudio converts at the device boundary anyway.

### 1b. The honest quality ceiling is the stems, not the DSP
The stems currently ship as **160 kbps MP3** (`tools/prepare_song.py`, `encode()`). No amount of care in
the effect chain recovers what that throws away, and the distortion stage in §2 will emphasise codec
artifacts. Before claiming "CD quality":
- Add a `--format {mp3-160,mp3-320,flac}` flag to `tools/prepare_song.py`; default **flac** for new songs.
- FLAC decodes fine in Safari 14+/Chrome via `decodeAudioData`; it is lossless and about 4× the file size
  (~25 MB per stem for a 4-minute song). Disk is not the constraint; **memory is** — see §9.
- Re-encode at least the songs that get effects (The Prowl, anything with a distorted vocal).

### 1c. Give every stem an FX insertion point
Today `_aStart` connects each source straight to `audio.gains[stem]`. Insert one node per stem so effects
live in a stable place that survives seeks and fill splices (sources are recreated constantly; the FX
chain must not be):

```
source ─▶ fxIn[stem] ─▶ [effect chain] ─▶ gains[stem] ─▶ _aGain ─▶ destination
```

Pre-fader on purpose: the stem fader must not change how hard the distortion is driven.

In `Transport.setAudio()` create `audio.fxIn[k] = ctx.createGain()` alongside each `audio.gains[k]`, and
have the (initially empty) chain connect `fxIn[k] → gains[k]`. In `_aStart`, connect sources to
`this.audio.fxIn[k]` instead of `this.audio.gains[k]`. Nothing else changes; per-section mixes, mutes and
fill splicing all keep working untouched.

### 1d. Song schema additions (all optional, all backwards compatible)
```json
"audio": {
  "fx":   { "vocals": { "enabled": true, "intensity": 0.8,
                        "chain": [ {"type":"drive","drive":0.45},
                                   {"type":"radio","low":200,"high":4000} ] } },
  "key":  { "semitones": 0 },
  "fade": { "out": 6 }
}
```
`app.js` `loadSongs()` merges newer shipped `rev`s into the user's localStorage copy while preserving what
the user attached (sheets, lyrics, `audio`). Extend that merge to preserve user-edited `fx`, `key` and
`fade` the same way, and bump `rev` on any shipped song you change.

---

## 2. Per-stem effect chains with saved presets

**Goal.** Any stem of any song can carry a saved chain of effects with one master intensity knob, loaded
automatically with the song, adjustable live, mixable from the iPad.

**New file `effects.js`** (script tag after `drums.js`, before `app.js`), exporting `SD.FX`:

```js
SD.FX.build(ctx, chainSpec)   // → { input, output, nodes, setIntensity(x), dispose() }
SD.FX.TYPES                   // registry: name → { label, defaults, make(ctx, params) }
```

Each effect type is a small factory returning `{ input, output, set(params, intensity) }`. Ship these:

| type | nodes | intensity 0 → 1 maps to |
|---|---|---|
| `drive` | `WaveShaperNode` (`oversample: '4x'`) + make-up gain | curve amount `k` 2 → 60, make-up compensating |
| `radio` | `BiquadFilterNode` highpass + lowpass | band narrows toward `[low, high]`, wide open at 0 |
| `eq` | 3 × peaking/shelf biquads | gain scaling |
| `comp` | `DynamicsCompressorNode` | threshold/ratio |
| `verb` | `ConvolverNode` + wet gain (reuse `mixer.js`'s generated IRs) | wet level |

**Intensity semantics.** One knob, two jobs: it scales each effect's own parameters *and* crossfades
wet against dry across the whole chain (`input → dryGain → output` in parallel with the chain). At 0 the
chain is bypassed — actually `disconnect()` the effect nodes, don't just zero a gain, so an unused chain
costs no CPU.

**Distortion curve.** Classic normalised arctan/tanh shaper, 4× oversampled:
```js
function curve(k, n = 2048) {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) { const x = (i * 2) / (n - 1) - 1; c[i] = ((1 + k) * x) / (1 + k * Math.abs(x)); }
  return c;
}
```
Rebuild the curve only when drive changes (it's an array assignment, not an AudioParam — do not do it per
animation frame). Everything else is an AudioParam: automate with `setTargetAtTime(v, ctx.currentTime, 0.02)`
so knob moves don't zipper.

**UI.** In the Backing panel, each stem row gets an "fx" button opening a small panel: enable toggle,
intensity slider, the chain listed with per-effect parameter sliders, and a preset dropdown
(`SD.FX.PRESETS`). Levels and intensity save to the song (`persistSongs()` + `broadcastSong()`), exactly
like the stem mix does today. Follower sends `{cmd:'fx', stem, patch}`; the host applies and re-broadcasts.
Reuse the existing pattern in `onSyncMessage` — note the follower already avoids a full chart rebuild when
only `audio` changed; extend that comparison to cover `fx`.

**The Prowl preset (first concrete case).** Dan Auerbach, *Keep It Hid* (2009). We do not have this
recording yet — ask the user for the file, then run `tools/prepare_song.py` like the other songs. Ship the
preset on the vocal stem:
```json
"fx": { "vocals": { "enabled": true, "intensity": 0.75,
        "chain": [ {"type":"radio","low":220,"high":3800,"q":0.7},
                   {"type":"drive","drive":0.5,"tone":0.4},
                   {"type":"eq","bands":[{"f":1200,"g":3,"q":1.2}]} ] } }
```
Order matters: filter *before* the shaper keeps the low end from turning to mud, then a narrow presence
bump after it puts the rasp back in the intelligible band. Expect to tune by ear with the intensity knob;
that is the whole point of the knob.

**Test.** `tests/test-fx.js`: load the song, assert the chain builds, assert `intensity 0` leaves the stem
bit-identical to bypass (render both through an `OfflineAudioContext` and compare), assert intensity
changes are audible (RMS/spectral centroid moves), assert no console errors on repeated song switches
(the chain must be disposed — watch for node leaks across 20 song loads).

---

## 3. Live key change

**Goal.** Drop the whole song a half step on a rough night; every stem shifts together and still sounds
like a record.

**Decision: pre-render offline, do not pitch-shift in real time.** Reasons, in order of weight:
1. **CPU.** SoundTouchJS's `PitchShifter` runs on a `ScriptProcessorNode` (deprecated, main-thread, glitches
   under GC). Six stems × real time on a fanless M2 Air, next to the mic mixer, is exactly the sustained
   load the hardware constraint warns about.
2. **Quality.** Offline, the algorithm can use larger windows and we can listen to the result before the
   downbeat. Real time forces small windows and audible warble.
3. **Sync.** Pitch shifting doesn't move bar lines, but a real-time shifter adds latency and buffering that
   the bar-accurate splice logic (`_aStart` at exact ctx times) would have to compensate for everywhere.

**How.**
- Vendor `soundtouch.js` into `vendor/` **unmodified, with its license header** (SoundTouchJS is LGPL-2.1;
  keeping it as a separate unmodified file loaded by its own script tag is the clean way to use it here).
  Note it in the README's credits next to the drum kit samples.
- New `keyshift-worker.js`: receives `{channels: [Float32Array…], sampleRate, semitones}` (transferables),
  runs SoundTouch with `pitchSemitones = n`, `tempo = 1`, posts the shifted channels back.
- New `SD.KeyShifter` in `effects.js` (or its own `pitch.js`): given `transport.audio.stems` and a
  semitone count, renders every stem through a small worker pool (2 workers; more will fight the audio
  thread), shows progress in the Backing panel, then hands the new buffers to
  `transport.setAudio({...same, stems: shifted})` while stopped, or at the next bar line if playing.
- **Cache exactly one alternate key in memory** (`{semitones, stems}`) and free it when the user picks a
  different one or loads another song. See §9 — buffers are big.
- Expect roughly a few seconds per stem for a 4-minute song; it is a between-songs action, not a mid-song
  one. Make that explicit in the UI ("Rendering −1 semitone… 3 of 6").

**Formant preservation — be straight with the user.** SoundTouch pitch-shifts by time-stretching and
resampling, which moves formants with the pitch. At ±1–2 semitones this is inaudible on a mix and is what
every band's backing track rig does. It is *not* true formant preservation; that needs a phase vocoder
with spectral-envelope warping, which is a much bigger build. Ship ±2 semitones now, offer the bigger
version later only if the user actually hears a problem. Clamp the UI to ±6 and warn past ±3.

**Do not forget the chart.** If the audio moves, the chords on the iPad must move with it, or the whole
thing is a trap on stage. Add `SD.transpose(name, semitones, preferFlats)` handling root + accidental +
quality + extensions + slash bass (`"D/F#"` → `"C#/F"`), pick sharps or flats from the resulting key, and
apply it in the chart renderers (`renderChart`, sheet view, `nowChord`, voice cues) as a display transform
driven by `song.audio.key.semitones`. Never rewrite the stored `bars`. `instruments.js` already has
`parseChord()` — reuse its parsing, add the inverse.

**Test.** `tests/test-key.js`: shift +2, assert every stem buffer's length is unchanged (pitch shift must
not change duration), assert `barTimes` untouched, assert the displayed chord for bar 0 moved by 2
semitones, assert playback still lands on the right bar after the swap.

---

## 4. Tap tempo (experimental, isolated, off by default)

**Goal.** Tap four times, play the song a little faster or slower tonight.

**Same engine as §3, different knob:** SoundTouch `tempo = ratio`, `pitchSemitones = 0`, rendered offline
per stem. Then:
- `barTimes' = t0 + (t - t0) / ratio` for every bar (`t0` = the first bar time), so the chart tracks the
  stretched audio exactly.
- `fills` are bar *indices* — unchanged.
- Displayed BPM = measured BPM × ratio.

**Rules that keep it from becoming a liability:**
- Live behind a `prefs.experimental.tapTempo` flag, in its own file (`tempo.js`), off by default.
- Only applies while **stopped**. No mid-song re-render — that is where the sync risk actually lives.
- Clamp to ±12 %; refuse (with a message) beyond that, where WSOLA starts to smear drums.
- Tap detection: collect intervals, drop any more than 30 % from the running median, need 3 good
  intervals, show the resulting ratio and BPM before applying. A "Reset to original" button that restores
  the untouched buffers and `barTimes` — keep the originals, never overwrite them.
- The moment it makes a song feel wrong, it should be deletable by removing one script tag and one panel.

**Test.** `tests/test-tempo.js`: ratio 1.06 → assert stem duration shrank by ~6 %, `barTimes` span shrank by
the same factor, bar N still starts on the same musical event (correlate the drum stem's onset envelope
around a few bar lines before and after), reset restores exactly.

---

## 5. Per-song auto-fade ending

Small, self-contained, do it early — it's a quick win.

- Schema: `"audio": { "fade": { "out": 6 } }` (seconds; absent or 0 = hard stop as now).
- In `Transport._scheduleAudio()`, when scheduling the bar at which `bt[total] - barStart <= fade`,
  ramp `_aGain.gain`: `cancelScheduledValues(t)`, `setValueAtTime(current, t)`,
  `linearRampToValueAtTime(0.0001, endTime)`. Restore the gain to its set level in `stop()` and on any
  seek — hold, +1, queue and Go now must all **cancel** a scheduled fade, or a held last section fades to
  silence and the band is left playing to nothing. That cancellation is the only tricky part; test it.
- UI: a "Fade out over N s at the end" number field in the Backing panel, saved per song.
- Which songs need it: Weight of Love, Harvest Moon and Sittin' on a Rainbow all end on a studio fade —
  set them once measured.

---

## 6. Foot pedal (Donner 2-button, Bluetooth HID keyboard)

The pedal just sends key presses, so this is input plumbing, not device integration.

- New `pedal.js` (or a section of `app.js` — it's ~40 lines): a `keydown` listener on `window`, added
  **before** the existing shortcut handler in `app.js:356`, that consumes the event when it matches a
  mapped key.
- Mapping in prefs, with a **learn mode**: "Press the left pedal now" → capture `e.code` → save. Never
  hardcode arrow keys; different Donner modes send different keys, and the app already uses arrows for
  section stepping.
- Actions, exactly as decided — single tap only, no hold/double-tap:
  - **Left:** toggle loop on the current section → `setHold(!transport.hold)`.
  - **Right:** advance to the next song → stop, select the next entry in the song list, load it (in audio
    mode, start decoding its stems immediately so it's ready), broadcast to the iPad.
- Guards that matter live: ignore `e.repeat` (a held pedal must not machine-gun), ignore when the event
  target is an input/textarea/select or a dialog is open, and debounce ~250 ms per button.
- Show the mapping in the sidebar so it's checkable at soundcheck, and flash the mapped button in the UI
  on each press so the user can confirm the pedal is paired before the set.

**Test.** `tests/test-pedal.js`: dispatch the mapped `keydown` twice quickly → hold toggles once, not
twice; dispatch right → song advances; dispatch while a dialog is open → nothing happens.

---

## 7. Private cue feed on the iPad

**The architecture already gives you the separation:** the computer feeds the PA, the iPad is a follower
and its own output is the in-ear feed. What's missing is the mix control and one honest limitation.

Build on the follower:
- A **Cue** panel: click level, voice-cue level, "cues only" master, all saved in prefs (per device, not
  per song).
- Click already exists (`kit.click`, `bus.click`). Give it its own gain that is independent of the drum
  master so a follower with `followerAudio` off still gets a click.
- **The voice-cue limitation:** `SpeechSynthesisUtterance` output does not pass through Web Audio. It has
  a `volume` property and goes to the system output. So either
  (a) accept it — expose `utterance.volume` as the "voice level" slider, which is what most apps do, or
  (b) ship recorded cue words (`cues/chorus.mp3`, `verse.mp3`, `again.mp3`, `one-more.mp3`, `ending.mp3`,
  plus numbers) so they play through the Web Audio graph and are genuinely mixable, duckable against the
  click, and consistent across devices.
  **Recommendation: (a) now, (b) as a follow-up** — (b) is maybe an hour of work plus recording, and it is
  the only way to truly mix voice against click.
- `setSinkId` is Chrome-only and **not available in iOS Safari**: on the iPad the cue feed follows the
  system route, i.e. whatever is plugged into (or paired with) the iPad. Say so in the UI rather than
  offering a device picker that does nothing.
- **iPad → computer mixer remote:** extend the existing follower→host `cmd` protocol (`sendCmd` in
  `app.js`, handled in `onSyncMessage`). Add `{cmd:'master', value}`, `{cmd:'fx', stem, patch}`,
  `{cmd:'key', semitones}`, `{cmd:'fade', seconds}`. The host applies, persists and re-broadcasts the song
  so both screens agree. Keep every new command idempotent — messages can arrive twice.

**Test.** `tests/test-cue.js`: follower with `followerAudio` off still schedules clicks; cue levels persist
across reload; a follower `master` command changes the host's gain.

---

## 8. Cross-cutting: audio quality checklist

Apply to every feature above, and to anything added later:

- 44.1 kHz context (§1a); no per-file resampling; ask the user to run the interface at 44.1 kHz.
- `WaveShaperNode.oversample = '4x'` on every non-linearity. Verify with a sine sweep through an
  `OfflineAudioContext` and an FFT: aliased partials should sit below −60 dBFS.
- No `ScriptProcessorNode` anywhere. If real-time DSP ever becomes necessary, it is an `AudioWorklet`.
- Parameter changes via `setTargetAtTime`/ramps, never bare assignment during playback (clicks).
- Pre-render pitch/tempo offline (§3, §4) — the highest-risk DSP never runs under real-time pressure.
- Effects that are off are **disconnected**, not zeroed.
- Keep the master path clean: stems → `_aGain` → destination, with a single limiter only if peaks
  demand it (there is one in `mixer.js` for mic inputs; the backing path deliberately has none).
- Re-encode stems to FLAC for songs that get effects (§1b) — the codec, not the DSP, is the current floor.

---

## 9. Cross-cutting: staying inside a fanless M2 Air

**Memory is the harder limit, and nobody has flagged it yet.** A decoded stereo stem costs
`duration × 44100 × 2 ch × 4 bytes` ≈ **21 MB per minute**. Harvest Moon (5:03, 6 stems) is already
~640 MB decoded; with the kit split it's 9 buffers, ~950 MB; hold one pitch-shifted copy and it doubles.
On an 8 GB Air that is where the tab dies, long before the CPU does. So:
- Free the previous song's buffers on song change (drop references, let the `audioCache` be an LRU with a
  budget of ~1.2 GB rather than an unbounded map — it is currently unbounded).
- Cache exactly one alternate key/tempo render at a time.
- Consider decoding the vocal stem only when it is actually unmuted.

**CPU.** Rough per-instance costs at 44.1 kHz, stereo, on this class of chip: a biquad ~0.05 %, a
`WaveShaper` at 4× ~0.3 %, a compressor ~0.2 %, a convolver with a 1-second IR ~2–4 %, a buffer source +
gain ~0.05 %. A 9-stem song with a two-effect chain on one stem lands near 2–3 % — fine. The things that
actually threaten the audio thread are: convolution reverbs (the mic mixer's, one per channel), any
real-time pitch shifter, and garbage collection from allocating in a hot path.
- Budget rule: **total measured audio-thread load under 25 %** with everything on, so thermal throttling
  (which can halve sustained clocks on a fanless Air) still leaves headroom.
- Measure, don't guess: add a hidden diagnostics panel that reports (a) an `AudioWorklet` that times its
  own `process()` calls and reports a rolling mean/max, (b) dropped-frame detection by comparing
  `ctx.currentTime` progression against `performance.now()`, (c) `ctx.baseLatency`/`outputLatency`.
  Log a warning when the mean exceeds 15 %.
- Test the realistic worst case, not each feature alone: 9 stems + vocal FX chain + mic mixer with gate,
  comp and reverb on four channels + iPad syncing + a key change rendering in a worker. That combination
  is the actual gig.

---

## 10. Suggested build order

> **Status (v0.23.0):** §1a, §1c, §1d, §2, §3, §4, §5, §6 and §7 are built and covered by `tests/`. One
> design change from the text below: instead of shifting stems independently, the worker does a *guided*
> pass — the WSOLA offsets are recorded on the sum of all stems and replayed for each one (a ~6-line
> modification to the vendored SoundTouch), which keeps the stems sample-aligned; measured, an
> unguided per-stem shift drifted kick against bass by up to ~7 ms. 
> **v0.24.0:** §1b (FLAC default in the pipeline), §9 (cache budget + health line), and all of §12 except
> recorded cue words are built: live pitch correction (`pitch-worklet.js`, YIN + TD-PSOLA, in the mixer
> strip), drum punch (`punch-worklet.js`), reverb IR kinds + `local/ir/`, song search, drag ordering.
> Still open: recorded cue words (§7 option b).

Each step is releasable on its own and testable before the next.

1. **§1a + §1b + §1c** — sample rate, encoder flag, FX insertion point. No user-visible change; everything
   after depends on it. Release 0.21.0.
2. **§5 auto-fade** — small, immediately useful, exercises the new schema-merge path. 0.22.0.
3. **§6 foot pedal** — self-contained, no audio risk, big stage win. 0.22.0.
4. **§2 effect chains + The Prowl** — the largest UI piece. Needs the recording from the user. 0.23.0.
5. **§7 cue feed + iPad remote mixer** — builds on the command protocol the FX panel just extended. 0.24.0.
6. **§3 key change** — vendor SoundTouch, worker, chord transposition. 0.25.0.
7. **§4 tap tempo** — same engine, behind the experimental flag, evaluated on stage before it's trusted. 0.26.0.

## 11. Decisions the user still needs to make

- **The Prowl recording** — needed before its preset can be tuned (and Mississippi Queen is still without
  one).
- **Recorded cue words vs `speechSynthesis.volume`** (§7) — affects whether voice cues are truly mixable.
- **FLAC re-encode** (§1b) — bigger files and more memory in exchange for the quality claim actually
  holding; probably yes for songs with effects, not for everything.
- **How far the key change has to go** (§3) — ±2 semitones is safe with the simple approach; beyond ±3
  wants the much larger formant-preserving build.

---

## 12. Pending items from the broader brainstorm (scoped, not yet scheduled)

These were listed as "still pending" in the notes. Scoping them here so the picture is complete; none of
them block §1–§7.

**Switchable convolution reverb impulse responses.** The `verb` effect in §2 should take an `ir` name.
Ship a small set of *generated* IRs (`room`, `plate`, `hall`, `spring`) built the way `mixer.js` already
synthesises its room IR (shaped noise with a decay curve) so nothing has to be downloaded, plus support
for user-supplied `.wav` IRs dropped into `local/ir/`. Cost: a convolver is the most expensive node in the
graph (~2–4 % per second of IR); share **one** convolver per IR across stems via a send bus rather than
one per stem, exactly like a mixing console does.

**Drum "punch" enhancer with a master intensity slider.** Transient shaping on the kit stems (or the
kick/snare parts when split): a `DynamicsCompressorNode` with fast attack and a parallel dry path gives
sustain control; for attack emphasis use the classic two-envelope-follower difference in an
`AudioWorklet` (~30 lines), plus a tilt EQ. One knob scales attack gain, sustain reduction and EQ
together. Fits the §2 registry as type `punch`; when the kit is split, apply to `kick` and `snare` only.

**Live pitch correction with adjustable retune speed.** This is the one item that is genuinely
real-time DSP, and it belongs on the **live mic through `mixer.js`**, not on a stem (the recorded singers
are already in tune). Pitch detection (YIN/McLeod) + PSOLA or phase-vocoder shift in an `AudioWorklet`,
snapping to the song's key (which §3 already tracks) with a `retune` time constant. Budget ~5–8 % of the
audio thread on an M2 at 44.1 kHz and ~20 ms of added latency, which is at the edge of what a singer
tolerates in in-ears. Build last, behind a flag, and evaluate on stage like tap tempo. If it proves too
heavy or too laggy, a hardware unit on the mic path is the honest fallback.

**Song browser search.** Already discussed in an earlier session; the sidebar list has no filter box
today. A title/artist/tag text filter is ~20 lines in `renderSongList()` — do it whenever the list gets
long enough to want it.
