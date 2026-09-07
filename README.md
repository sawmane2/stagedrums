# StageDrums

Live backing drums for a band with no drummer, plus chord charts that follow the drums in real time on an iPad. Everything is plain HTML/JS (a PWA) with a zero‑dependency Node relay server for computer ↔ iPad sync. No build step.

```
drum-daw/
├── index.html      app shell
├── app.js          UI, song library, chart tracking, voice cues, host/follower roles
├── drums.js        synthesized drum kit, groove library, transport/scheduler
├── parser.js       Ultimate Guitar chord-sheet → song JSON, AI prompt generator
├── sync.js         WebSocket sync client + clock offset estimation
├── midi.js         .mid export/import (SMF) + live Web MIDI out with MIDI clock
├── mixer.js        live mixer DSP: per-channel gate/comp/EQ/reverb, master limiter, device routing
├── mixer-ui.js     mixer panel (strips, meters, presets)
├── gate-worklet.js noise gate AudioWorklet
├── server.js       serves the app + relays sync messages + update API (node server.js)
├── updater.js      self-update from GitHub (git pull or tarball), used by server.js and update.command/.bat
├── release.js      bump version.json + commit + tag
├── version.json    current version + notes (drives the update check)
├── update.config.json  your GitHub repo/branch for updates (never overwritten)
├── start.command / start.bat / update.command / update.bat   double-click helpers
├── sw.js           service worker (offline / installable)
├── manifest.json   PWA manifest
├── songs/index.json  demo songs (loaded on first run)
└── styles.css
```

## Quick start

**Solo (one device):** open `index.html` in Chrome/Safari (or `npx serve .`). Pick a demo song, hit Play (or Space).

**Computer + iPad, synced:**

1. On the computer (plugged into the PA/speaker): `node server.js` — it prints the address, e.g. `http://192.168.1.20:8080`.
2. Open that address on the computer, set the role dropdown to **Host**.
3. Open the same address on the iPad (same Wi‑Fi, or the computer's hotspot), set role to **Follower**. Tap Connect. Add to Home Screen for a full‑screen app.
4. Play/stop, jump between sections, tempo and loop can be controlled from either device. The chart on the iPad tracks the host's drums to within a few ms (the pill in the corner shows the estimated clock error).

Sync design: the server is the shared clock. The host publishes a *transport anchor* ("bar 8 starts at server time T, at 104 BPM, looping bars 8–16") every few bars and whenever something changes. The follower converts that into its own AudioContext time, so it stays locked even if a message is late; no continuous streaming is needed.

## Performing

- **Big chord display** shows the chord you're on, section name, what's coming next and in how many bars, beat dots and a bar counter.
- **Section pads** (the row under the display, one per section) work like Loop Community Prime: the section you're in keeps its place in the song, and changes land on the bar.
  - **Tap a pad** to queue that section — it starts when the current section finishes (pad pulses green). Tap again to un‑queue.
  - **Long‑press a pad** (or right‑click) to go there at the **next bar** instead of waiting for the section to end.
  - **Hold** keeps repeating the current section until you release it — stretch a solo, vamp under talking, jam.
  - **+1 pass** plays the current section one more time, then carries on (tap again for +2, +3…).
  - **Go now** moves to the queued section — or the natural next one — at the next bar. Use it to cut a section short.
  - Fills still play on the last bar of every pass, so a held chorus sounds like a drummer repeating it, not a loop point.
- **Voice cues** (in‑ears or the iPad speaker) announce what's actually coming one bar early (two bars for long sections): "Chorus", "Again", "One more", "Ending" — they follow your Hold/queue choices.
- **Click (in‑ears)** slider in the Drum mix adds a metronome click; keep it at 0 on the PA.
- **Count‑in**: one bar of hi‑hat clicks before the song starts.
- All of this works from either device: the iPad (Follower) sends the command, the computer (Host) executes it, both charts move together.
- Keys: `Space` play/stop, `1`–`9` queue a section (`Shift` = at next bar), `H`/`L` hold, `+` extra pass, `Enter` go now, `←/→` previous/next section at next bar, `F` performance view (hide sidebar). Double‑tap the header area on the iPad for performance view.

## Getting songs in

**Paste from Ultimate Guitar.** Open the *Chords* version of a song, select the chord/lyric text and copy it, then **+ Import** and paste. `[Verse]`/`[Chorus]` headers become sections; every chord on a chord line becomes one bar; `| G D | Em C |` is honoured as explicit bars; `x2` repeats a line. **Sheet view.** Songs imported from a chords page (or with a sheet attached — tick *Attach lyrics/chords to the selected song* in the Import dialog to add them to a song that already has its bars and grooves) show as a **chords‑over‑lyrics sheet**, monospace like the site, with the chord you're on lit up and the current line highlighted and kept in view; tap any chord to jump/queue there. *View: Sheet / Grid* in the sidebar switches to the bar grid. *Bars per chord line* in the Import dialog (default 4) sets how many bars each lyric line gets — right for blues and most rock verses; chords in a line split its bars evenly. Lyric lines under each section are also kept and shown on stage: the current line appears large under the chord display with the next line dimmed beneath it, spread across the section's bars (or placed exactly with a per-bar `lyricBars` array in the song JSON). Set the BPM and default groove in the dialog.

UG sheets show chord *changes*, not bars, so bar counts are often off. Two ways to fix that:

1. **Edit song JSON** and adjust `bars` by hand (each entry is one bar; `"G D"` = two chords in a bar, `"Am . . G"` = Am for 3 beats then G).
2. **Copy AI drum prompt** in the import dialog, paste the prompt + chord sheet into Claude/ChatGPT, and paste the JSON it returns into the import box. The prompt asks the AI for real bar counts, a groove per section, tempo and time signature.

### Song JSON

```json
{
  "title": "Jam in G", "artist": "Demo", "bpm": 104, "time": "4/4", "groove": "rock",
  "sections": [
    { "name": "Intro",  "groove": "hats-only", "crash": false, "bars": ["G", "D", "Em", "C"] },
    { "name": "Verse 1","groove": "rock", "fill": true, "repeat": 2, "bars": ["G", "D", "Em", "C"] },
    { "name": "Chorus", "groove": "rock-16", "crash": true, "fill": true, "bars": ["C", "G", "D . . D/F#", "G"] }
  ]
}
```

`groove` names are in `drums.js` (`GROOVES`): rock, rock-16, rock-heavy, pop, four-floor, half-time, ballad, ballad-ride, country, shuffle, funk, reggae, bossa, punk, motown, train, hats-only, kick-only, silence, waltz, waltz-ride (3/4), six-eight, six-eight-drive (6/8), plus song-specific baker-blues / baker-busy / baker-jazz / baker-heavy / baker-ride / baker-toms (Ginger Baker) and laing-cowbell / laing-heavy / laing-ride / laing-boogie / cowbell-count (Corky Laing). Grooves are 16‑step strings per instrument (`K` kick, `S` snare, `H` hats, `D` ride, `C` crash, `T/M/F` toms, `R` cross‑stick, `B` cowbell) so adding your own is one line. `fill: true` plays a fill on a section's last bar; `crash: true` crashes on its first bar.

Songs live in the browser's localStorage. Use **Export** to save a `.json` and drop it in `songs/` (and add it to `songs/index.json`) to ship it with the app.

## Backing track from the real recording

Synthesized drums never sound like the record, so the **Backing track** panel plays the real recording instead — split into **stems** you can mix — while the chart, section cues, in-ear click, Hold / +1 pass / Go now and the iPad followers all keep working. The recording is the clock: bar lines follow its real timing, jumps happen at bar lines by seeking, and the synth kit and band are muted automatically.

**Stem mixer.** One fader and a mute per stem — kill the vocals, drop the guitar you're playing yourself, push the drums up. Levels change live mid-song, are saved with the song, and the iPad can move them too (it asks the host, which is what actually plays the audio).

**Per-section mixes.** The *Mixing* selector says what the faders are editing: the whole song, a named section, or "the section playing now" (the faders follow the chart as it moves). A section that has its own levels shows a • next to its name, and its mix is applied automatically at the bar line where the section starts — drums-only intro, full band chorus, guitar out for the solo. *Use the song mix for…* clears a section's overrides. In song JSON this is `"stems": {"guitar": 0, "vocals": 0.4}` on a section, over `audio.mix` for the song.

**Split drums** turns the drums fader into **kick / snare / toms / cymbals** (a second pass with DrumSep), for when the kit itself needs balancing. The four parts add back up to the drum stem, so nothing is lost by switching.

**Getting stems.** [Demucs](https://github.com/facebookresearch/demucs) is the free one and the one used here (`htdemucs_ft` for drums/bass/vocals, `htdemucs_6s` for guitar/piano) — it works on the waveform and re-synthesizes each instrument, unlike older maskers (Spleeter and most free web tools) that just decide which frequencies to keep and leave the swirly, EQ'd sound behind. Paid services (Moises, AudioShake, SpectraLayers, RipX) go further and can split lead from rhythm guitar, which no open model does yet; whatever they hand you, drop the files in with **Load stems…** and each becomes its own fader (names are read from the filenames: `drums`, `bass`, `vocals`, `guitar`, `lead`, `rhythm`, `piano`, `kick`, `snare`…). Files are saved to `local/audio/<song-id>/`, which is outside git so updates never touch them. **Load audio file…** takes a single ready-made mix instead.

**Timing.** With no measured bar times the chart is laid on the song's BPM grid from the first sound; **◂ 50ms / 50ms ▸** nudges it. Songs can ship exact bar times: `"audio": {"stems": {…}, "kit": {…}, "mix": {…}, "barTimes": [0.26, 2.60, …]}` — one entry per bar plus the end, measured from the drum stem. Weight of Love and Outside Woman Blues ship with theirs; add the audio files and they line up.

**Source** switches back to **Synth drums + band** for jamming or when the recording isn't on this computer. Followers (iPad) never need the files.

## Drum sounds

Pick the kit in the sidebar (**Drum kit**):

- **Rock kit (real samples)** — the default. A close‑mic'd rock kit: Premier kick, **Ludwig Supraphonic snare** (the classic '60s/'70s rock snare — accented hits play the rimshot), 12"/14"/18" toms, hi‑hat closed/open/pedal with choke, Istanbul Agop ride and bell, and a 20" Zildjian Avedis crashed at the edge. 4 velocity layers × 2–4 round‑robins per drum (124 samples, ~1.7 MB, cached offline). Samples recorded by Vincent "Tchackpoum" Sermone (Tchimera Drum Kit); this derivative kit is CC BY‑SA 4.0 and music made with it is free to use.
- **Vintage bus** (checkbox) — tape‑style saturation, a darker top end, a touch of room and glue compression on the whole kit, to sit closer to late‑'60s records. Untick for a clean modern sound.
- **Orchestral kit (VCSL)** — the earlier concert bass drum / orchestral snare / suspended cymbal set (CC0). Kept for variety.
- **Synth kit** — synthesized drums, no download, always available.

Every sample's true onset is detected at load time so hits land exactly on the grid — and then a **feel** engine moves them off it the way a drummer does: each groove has a `feel` (`loose` = Baker‑style laid‑back snare and a little jitter; `push` = Laing‑style ahead of the beat; `tight`) and a `swing` amount, hi‑hats/ride are accented on the beat and softer between, velocities vary a few percent, fills crescendo, and grooves carry alternate bars (`vars`) that rotate every other bar plus short "mini fills" on the last beat of every 4th bar. A song or section can set `"swing"` / `"feel"` to override the groove. Turn it off with `stagedrums.transport.humanize = false` in the console if you ever want a machine. To add your own kit, create `kits/<name>/kit.json` like the existing ones and list it in `kits/index.json`.

## Band: bass, keys, rhythm guitar

For songs where you need more than drums, the **Band** panel in the sidebar adds a chord‑following bass, keys and rhythm guitar (all synthesized, no downloads). Pick a pattern per instrument — bass: `whole`, `halves`, `roots`, `eighths`, `pump`, `boogie`, `shuffle`, `ballad`; guitar: `strum8`, `strum16`, `folk`, `stabs`, `arp`, `whole`; keys: `pad`, `organ`, `epiano` — and set levels. The choice is saved with the song, and any section can override it in Edit song JSON with `"band": {"bass": "pump", "keys": "organ", "gtr": "off"}` (e.g. drums‑only verses, full band choruses, `"off"` everywhere for songs where your live players cover those parts). The band reads the chord under every beat, including split bars like `"Em . . D"`, and joins the drums on the same master bus and limiter.

## MIDI

- **Export .mid** (sidebar → MIDI) writes a Type‑1 Standard MIDI File: tempo + time signature, a marker per section, a text event per chord, a **Drums** track on channel 10 (General MIDI drum map: 36 kick, 38 snare, 42/46 hats, 51 ride, 49 crash, 50/47/43 toms, 37 cross‑stick) and a **Chords (reference)** track of block chords. Drop it into Logic/Ableton/Reaper/GarageBand and swap in any drum kit.
- **Import .mid drums** loads a drum track (channel 10, or all notes if there's no channel 10) and quantises it to the 16th grid, bar by bar. Bars marked ♪ then play the imported transcription; bars without MIDI fall back to the section's groove. The song JSON gets a `midiBars` array so it stays with the song. A section can also carry its own `"midi": [ {K:"x...", S:"..."}, ... ]` array (one pattern per bar) if you want to hand‑write a part.
- **Live MIDI out** (Chrome/Edge on the computer): pick a MIDI output and the host sends every drum hit as a note on channel 10 plus MIDI clock, Start and Stop, so a hardware drum machine, a DAW with a real kit, or a lighting rig can follow StageDrums in tempo. Turn the app's own drum sound down with Master if the DAW is making the noise.

## Live mixer (Focusrite / any audio interface)

Click **🎚 Mixer** in the top bar on the **computer**, open at `http://localhost:8080` in **Chrome or Edge**. Pick the interface as input, press **Start interface**, and pick the interface (or PA) as the output device. Each channel strip is one interface input:

`Trim → High‑pass → 3‑band EQ (low shelf 200 Hz, sweepable mid, high shelf 6 kHz) → Noise gate → Compressor → Makeup → Reverb send → Pan → Fader → Master → Limiter (−1 dB) → output`

- **Presets** per strip: Vocal, Backing vocal, Acoustic guitar, Electric guitar, Keys, Bass, Harmonica/horn mic, Flat. They're starting points — every parameter stays adjustable.
- **Gate** is a proper peak‑follower gate (AudioWorklet) with threshold, hold and release; the green LED on the meter shows it open. Compressor shows gain reduction as the blue bar on the meter. The browser's compressor adds automatic makeup gain, so "Makeup" is extra on top.
- **Reverb** is one shared convolution reverb (decay, tone, return) with a per‑channel send — sends are post‑fader.
- **Drums** are routed through the same master and limiter, so one fader/limiter protects the PA.
- Settings persist; **Auto‑start** re‑opens the interface on launch after the first tap.

Things to know: browsers add latency (typically 10–25 ms in Chrome on macOS/Windows with an interface's ASIO/Core Audio driver, more on Windows without ASIO) — fine for guitars and keys, noticeable for a singer's own monitoring. Turn the interface's **Direct Monitor** off to hear the processed sound, or leave it on and use the mixer only for the PA feed. Chrome exposes all interface inputs on macOS; on Windows it may only expose the first stereo pair — the status line shows how many it got. Safari and any non‑`localhost` address give a stereo pair only, so the mixer belongs on the host computer.

## Roadmap

- [x] Live arrangement: section pads, hold, extra passes, queue, go‑now (Prime‑style)
- [x] Live mixer: gate / comp / EQ / reverb per interface input, master limiter
- [ ] Set lists (ordered songs, auto‑advance)
- [ ] Internet sync fallback (Supabase Realtime / WebRTC) for when a LAN isn't possible
- [ ] Sampled kits (WAV) alongside the synth kit; per‑song kit choice
- [ ] Per‑bar groove overrides and custom groove editor
- [x] MIDI export / import / live MIDI out with clock
- [ ] Transpose / capo display on the chart
- [ ] Direct URL import if a UG proxy is acceptable (currently paste‑only, which avoids scraping/CORS issues)

## Updating

The app updates itself from GitHub.

- **In the app:** the version pill in the top bar (e.g. `v0.8.0`) turns green with a dot when a newer version is on GitHub. Click it → **Install update**. The computer pulls the new files, restarts the server, and every connected device (iPad included) shows a "Version x.y.z is installed — Reload" banner. Songs and mixer settings live in the browser, so they survive updates. Installing is only allowed from the computer running the server (`http://localhost:8080`).
- **Double‑click:** `update.command` (Mac) or `update.bat` (Windows) does the same from the desktop; `start.command` / `start.bat` start the server and open the app.
- **Terminal:** `node server.js --update` (add `--force` to reinstall the current version).

How it works: `updater.js` reads `update.config.json` (`repo` = your GitHub `owner/name`, `branch`; or falls back to `repository` in `package.json`) and compares `version.json` with the copy on GitHub. If the folder is a git checkout it runs `git pull --ff-only`; otherwise it downloads the branch tarball and extracts it over the folder — zero dependencies. `update.config.json` and the `local/` folder are never overwritten, and a backup of the previous files goes to `local/backup-<version>/`. A copy served from GitHub Pages simply picks up the new files on reload; its version pill offers "Reload now" when the site has changed.

Releasing (for whoever edits the code): `node release.js 0.9.0 "what changed"` bumps `version.json`, commits and tags; then `git push && git push --tags`. Anyone running the app sees the update within a click.

## Deploying

GitHub Pages works for the solo PWA (`Settings → Pages → main / root`). Note browsers block `ws://` from an `https://` page, so for synced shows run `node server.js` on the computer and open *that* address on both devices — it also works with no internet at all.
