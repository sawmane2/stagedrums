#!/usr/bin/env python3
"""Rough chord per bar from the harmonic stems (guitar + bass + other + piano): chroma templates for major, minor,
dominant 7, minor 7 and power chords, bass note as the root hint. Good enough to draft a chart to then fix by ear."""
import sys, json, numpy as np, librosa
def main():
    grid = json.load(open(sys.argv[1])); bt = grid['barTimes']; sr = 22050
    y = None
    for path in sys.argv[2:]:
        x, _ = librosa.load(path, sr=sr, mono=True); y = x if y is None else y[:len(x)] + x[:len(y)]
    C = librosa.feature.chroma_cqt(y=y, sr=sr, hop_length=512); ct = librosa.times_like(C, sr=sr, hop_length=512)
    names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
    T = {}
    for r in range(12):
        maj = np.zeros(12); maj[[r, (r + 4) % 12, (r + 7) % 12]] = 1
        mi = np.zeros(12); mi[[r, (r + 3) % 12, (r + 7) % 12]] = 1
        d7 = maj.copy(); d7[(r + 10) % 12] = 0.8
        m7 = mi.copy(); m7[(r + 10) % 12] = 0.8
        p5 = np.zeros(12); p5[[r, (r + 7) % 12]] = 1
        T[names[r]] = maj; T[names[r] + 'm'] = mi; T[names[r] + '7'] = d7; T[names[r] + 'm7'] = m7; T[names[r] + '5'] = p5
    out = []
    for b in range(len(bt) - 1):
        i, j = np.searchsorted(ct, bt[b]), np.searchsorted(ct, bt[b + 1]); v = C[:, i:max(i + 1, j)].mean(1)
        v = v / (np.linalg.norm(v) + 1e-9)
        best = max(T, key=lambda k: v @ (T[k] / np.linalg.norm(T[k])))
        out.append(best)
    json.dump(out, open(sys.argv[1].replace('grid', 'chords'), 'w'))
    for b in range(0, len(out), 8): print(f'{b:3d}: ' + ' '.join(f'{c:4s}' for c in out[b:b + 8]))
if __name__ == '__main__': main()
