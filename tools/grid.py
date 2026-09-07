#!/usr/bin/env python3
"""Measure a recording's bar grid: where every bar starts, and where the arrangement changes.

Beat-tracks the isolated drum stem (much steadier than the full mix), picks the downbeat phase that best
explains the kick/onset pattern and the chord changes, snaps each bar line to the nearest real onset, and
reports section-boundary candidates from a self-similarity novelty curve — so a chart can be matched to
the take instead of to a metronome.

usage: grid.py <drums.wav> <mix-or-harmony.wav> <out.json> [--bars N] [--offset SEC]
"""
import sys, json, numpy as np, librosa, scipy.signal as sg

def measure(drums, harm, sr=22050):
    yd, _ = librosa.load(drums, sr=sr, mono=True)
    ym, _ = librosa.load(harm, sr=sr, mono=True)
    dur = len(yd) / sr
    tempo, beats = librosa.beat.beat_track(y=ym + yd, sr=sr, units='time', trim=False)
    beats = np.asarray(beats)
    hop = 128
    oe = librosa.onset.onset_strength(y=yd, sr=sr, hop_length=hop); ot = librosa.times_like(oe, sr=sr, hop_length=hop)
    b, a = sg.butter(4, 110 / (sr / 2), 'low'); ok = librosa.onset.onset_strength(y=sg.filtfilt(b, a, yd), sr=sr, hop_length=hop)
    val = lambda env, t: env[max(0, np.searchsorted(ot, t) - 2):np.searchsorted(ot, t) + 3].max() if len(env) else 0
    # chroma change: bars usually start where the harmony moves
    C = librosa.feature.chroma_cqt(y=ym, sr=sr, hop_length=512); ct = librosa.times_like(C, sr=sr, hop_length=512)
    def chroma_change(t):
        i = np.searchsorted(ct, t)
        a1 = C[:, max(0, i - 8):i].mean(1); a2 = C[:, i:i + 8].mean(1)
        if a1.sum() == 0 or a2.sum() == 0: return 0
        return 1 - float(a1 @ a2 / (np.linalg.norm(a1) * np.linalg.norm(a2) + 1e-9))
    best, scores = None, []
    for ph in range(4):
        idx = np.arange(ph, len(beats), 4)
        bars = beats[idx]
        s = (np.mean([val(ok, t) for t in bars]) / (np.mean(ok) + 1e-9)
             + np.mean([val(oe, t) for t in bars]) / (np.mean(oe) + 1e-9)
             + 3 * np.mean([chroma_change(t) for t in bars]))
        scores.append(round(float(s), 3))
        if best is None or s > scores[best]: best = ph
    bars = list(beats[best::4])
    while len(bars) > 1 and bars[-1] + (bars[-1] - bars[-2]) < dur: bars.append(bars[-1] + (bars[-1] - bars[-2]))
    bars = np.array(bars)
    snapped = bars.copy()
    for i in range(len(bars)):
        i0, i1 = np.searchsorted(ot, bars[i] - 0.06), np.searchsorted(ot, bars[i] + 0.06)
        if i1 > i0:
            j = i0 + int(np.argmax(oe[i0:i1]))
            if oe[j] > np.percentile(oe, 60): snapped[i] = ot[j]
    snapped = np.maximum.accumulate(snapped)
    # novelty: where the arrangement changes (section boundaries)
    F = np.vstack([librosa.feature.mfcc(y=ym + yd, sr=sr, n_mfcc=13, hop_length=512),
                   librosa.feature.chroma_cqt(y=ym, sr=sr, hop_length=512) * 4])
    F = librosa.util.sync(F, librosa.time_to_frames(snapped, sr=sr, hop_length=512), aggregate=np.mean)
    F = F / (np.linalg.norm(F, axis=0, keepdims=True) + 1e-9)
    nb = F.shape[1]
    nov = np.zeros(nb)
    w = 4
    for i in range(nb):
        a1 = F[:, max(0, i - w):i]; a2 = F[:, i:i + w]
        if a1.shape[1] and a2.shape[1]: nov[i] = 1 - float((a1.mean(1) @ a2.mean(1)))
    cands = [int(i) for i in np.argsort(-nov)[:24] if i > 1]
    return dict(tempo=float(np.atleast_1d(tempo)[0]), phase=best, phase_scores=scores, duration=dur,
                barTimes=[round(float(x), 3) for x in snapped],
                bars=len(snapped) - 1,
                boundaries=sorted(cands), novelty=[round(float(x), 3) for x in nov])

def main():
    drums, harm, out = sys.argv[1], sys.argv[2], sys.argv[3]
    r = measure(drums, harm)
    json.dump(r, open(out, 'w'))
    print(f"tempo {r['tempo']:.1f}  phase {r['phase']} {r['phase_scores']}  bars {r['bars']}  duration {r['duration']:.1f}s")
    print('bar 0 at %.2fs, mean bar %.3fs' % (r['barTimes'][0], np.mean(np.diff(r['barTimes']))))
    print('section-change candidates (bar #):', r['boundaries'][:20])

if __name__ == '__main__':
    main()
