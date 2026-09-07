#!/usr/bin/env python3
"""Print a per-bar map of a recording: which instruments are playing, where the singing starts and stops.
Used to fit a chart's sections to the actual take."""
import sys, json, numpy as np, librosa

def main():
    d = sys.argv[1]; grid = json.load(open(sys.argv[2])); bt = grid['barTimes']
    sr = 22050
    stems = {}
    for name in sys.argv[3:]:
        k, path = name.split('=', 1)
        stems[k], _ = librosa.load(path, sr=sr, mono=True)
    n = len(bt) - 1
    cols = list(stems)
    print('bar   time    ' + '  '.join(f'{c[:6]:>6s}' for c in cols) + '   (dB per bar)')
    prev = {}
    for i in range(n):
        a, b = int(bt[i] * sr), int(bt[i + 1] * sr)
        vals = []
        for c in cols:
            x = stems[c][a:b]
            vals.append(20 * np.log10(np.sqrt((x ** 2).mean()) + 1e-9) if len(x) else -99)
        mark = ''
        if 'vocals' in cols:
            v = vals[cols.index('vocals')]
            was = prev.get('v', -99)
            if v > -32 and was <= -32: mark = ' <- vocal in'
            if v <= -32 and was > -32: mark = ' <- vocal out'
            prev['v'] = v
        print(f'{i:3d} {bt[i]:7.2f}  ' + '  '.join(f'{v:6.1f}' for v in vals) + mark)

if __name__ == '__main__':
    main()
