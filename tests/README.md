# Browser tests

Headless Chromium drives the real app against a real server, so transport, sync and audio
paths are exercised the way they run on stage.

```bash
node server.js 8099 &                 # serve the app (needs local/audio/ for the audio tests)
cd tests && npm i playwright          # once
node test-all.js                      # play every song, print bar/section/chord + console errors
```

| file | what it proves |
|---|---|
| `test-all.js` | every song loads, plays from the middle, chart lands on the right section/chord, no console errors |
| `test-audio.js` | audio backing mode: seek, hold, queue-now, stop, switch back to synth |
| `test-sync.js` | host + follower: bar events line up, follower's Go now moves the host, stop propagates |
| `test-stems.js` | stems load, faders and mutes apply, follower can move the host's stem mix |
| `test-sections.js` | per-section stem mixes switch at the bar line; "the section playing now" scope follows |
| `test-fills.js` | a held section splices a real fill into the kit stems on the turnaround |
| `test-fx.js` | 44.1 kHz context; effect presets build/apply/bypass; offline render sanity; chains survive song switches |
| `test-fade-pedal.js` | fade-out ramps near the end and is cancelled by Hold; pedal keys toggle hold / next song, repeat-guarded, ignored in dialogs |
| `test-key.js` | chord transposition; key change renders all stems, keeps duration and bar times, chart shows the new chords, back to original restores |
| `test-tempo.js` | tap tempo: ratio applied, stem length and bar times scale by the same ratio, drum hits still sit on bar lines, reset restores |
| `test-guided-shift.js` | two stems shifted together keep a constant relative lag (the guided WSOLA modification works) |
| `test-cue.js` | follower click independent of drums; follower moves the host's backing level, effects and song |

Each script hardcodes `http://localhost:8099` and the Chromium path
(`/opt/pw-browsers/chromium-1194/chrome-linux/chrome`) — change both for your machine.
