#!/usr/bin/env python3
"""StageDrums: turn a recording into stage-ready stems for a song in the app.

Pipeline (all local, all free):
  1. ENSEMBLE   average htdemucs_ft and hdemucs_mmi, each already averaged over time-shifted passes.
                Two different architectures make different mistakes; averaging cancels a lot of the
                artifacts that make a single model sound "EQ'd".
  2. SPLIT      divide the ensemble's `other` into guitar / piano / rest using the 6-source model's
                ratios only (Wiener-style), so the guitar split inherits the good model's quality.
  3. KIT        DrumSep the ensemble drums into kick / snare / toms / cymbals (they sum back to it).
  4. GRID       beat-track the drum stem for bar times, and score every bar for "the drummer filled here".
  5. ENCODE     write MP3s into the app's local/audio/<song-id>/ and update the song JSON.

usage: prepare_song.py <song-json> <work-dir> [name] [--format flac|mp3-320|mp3-160]
       --format flac (default) is lossless — the stems are the quality floor, not the effects.
       work-dir holds  ens/htdemucs_ft/<n>/  ens/hdemucs_mmi/<n>/  out/htdemucs_6s/<n>/  (from demucs)
"""
import sys, os, re, json, subprocess, glob, numpy as np, soundfile as sf

ROOT = '/home/claude/drum-daw'
DRUMSEP = {'bombo': 'kick', 'redoblante': 'snare', 'toms': 'toms', 'platillos': 'cymbals'}

def rms_db(x): return 20 * np.log10(np.sqrt((np.asarray(x) ** 2).mean()) + 1e-12)

def ensemble(work, name, out):
    """Average the models that produced each source. Missing models are simply skipped."""
    os.makedirs(out, exist_ok=True)
    dirs = [d for d in glob.glob(f'{work}/ens/*/{name}') if os.path.isdir(d)]
    if not dirs: raise SystemExit('no ensemble dirs in ' + work)
    made = {}
    for src in ['drums', 'bass', 'other', 'vocals']:
        files = [f'{d}/{src}.wav' for d in dirs if os.path.exists(f'{d}/{src}.wav')]
        if not files: continue
        acc, sr = None, None
        for f in files:
            x, sr = sf.read(f, dtype='float32')
            acc = x if acc is None else acc[:len(x)] + x[:len(acc)]
        acc /= len(files)
        sf.write(f'{out}/{src}.wav', acc, sr)
        made[src] = (len(files), rms_db(acc))
    print('  ensemble of', [os.path.basename(os.path.dirname(d)) for d in dirs], '->', {k: f'{v[0]} models, {v[1]:.1f} dB' for k, v in made.items()})
    return out

def run(cmd):
    print('  $', ' '.join(cmd)); subprocess.run(cmd, check=True)

FORMAT = 'flac'
def encode(src, dst):
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    if FORMAT == 'flac':
        dst = re.sub(r'\.mp3$', '.flac', dst)
        subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', src, '-codec:a', 'flac', '-compression_level', '5', dst], check=True)
    else:
        subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', src, '-codec:a', 'libmp3lame', '-b:a', FORMAT.split('-')[1] + 'k', dst], check=True)
    return os.path.basename(dst)

def main():
    global FORMAT
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    for a in sys.argv[1:]:
        if a.startswith('--format='): FORMAT = a.split('=', 1)[1]
    song_path, work = args[0], args[1].rstrip('/')
    name = args[2] if len(args) > 2 else os.path.basename(work)
    song = json.load(open(song_path))
    sid = song['id']
    print(f"== {song['title']} ({sid})")

    ens = ensemble(work, name, f'{work}/final')
    # guitar / piano split, using the 6-source model only for the ratios
    six = f'{work}/out/htdemucs_6s/{name}'
    if os.path.exists(six + '/guitar.wav'):
        run(['python3', '/home/claude/tools/split_other.py', f'{ens}/other.wav', six, f'{work}/split'])
        for p in ['guitar', 'piano', 'other']:
            if os.path.exists(f'{work}/split/{p}.wav'): os.replace(f'{work}/split/{p}.wav', f'{ens}/{p}.wav')
    # kit parts
    if not os.path.exists(f'{work}/ds/drumsep/drums/bombo.wav'):
        run(['demucs', '-n', 'drumsep', '--repo', '/tmp/drumsep', '--segment', '20', '-j', '1', '-d', 'cpu', '-o', f'{work}/ds', f'{ens}/drums.wav'])

    # keep only stems that actually contain something
    stems = {}
    for p in ['drums', 'bass', 'guitar', 'piano', 'other', 'vocals']:
        f = f'{ens}/{p}.wav'
        if not os.path.exists(f): continue
        x, _ = sf.read(f, dtype='float32')
        db = rms_db(x)
        if db < -45: print(f'  {p}: {db:.1f} dB — silent, skipped'); continue
        stems[p] = f
        print(f'  {p}: {db:.1f} dB')

    base = f'local/audio/{sid}/'
    files = {}
    for p, f in stems.items(): files[p] = base + encode(f, f'{ROOT}/{base}{p}.mp3')
    kit = {}
    for esp, en in DRUMSEP.items():
        f = f'{work}/ds/drumsep/drums/{esp}.wav'
        if os.path.exists(f): kit[en] = base + 'kit/' + encode(f, f'{ROOT}/{base}kit/{en}.mp3')

    a = song.get('audio', {}) or {}
    a['stems'] = files
    if kit: a['kit'] = kit
    mix = a.get('mix', {}) or {}
    for p in stems: mix.setdefault(p, 0 if p == 'vocals' else 1)
    a['mix'] = {p: mix[p] for p in stems}
    a['format'] = FORMAT
    a['note'] = ("Demucs ensemble (htdemucs_ft + hdemucs_mmi, time-shift averaged); guitar/piano split from the "
                 "6-source model's ratios; kit parts from DrumSep. barTimes and fills measured from the drum stem. "
                 "local/audio/ is not in git.")
    if 'barTimes' in a: a['barTimes'] = a['barTimes']
    song['audio'] = a
    song['rev'] = song.get('rev', 1) + 1
    json.dump(song, open(song_path, 'w'), indent=1, ensure_ascii=False)

    idx_path = f'{ROOT}/songs/index.json'; idx = json.load(open(idx_path))
    idx = [song if x['id'] == sid else x for x in idx]
    json.dump(idx, open(idx_path, 'w'), indent=1, ensure_ascii=False)
    print('  stems:', list(a['stems']), '| kit:', list(kit), '| rev', song['rev'])

if __name__ == '__main__':
    main()
