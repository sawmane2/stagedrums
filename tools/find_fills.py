#!/usr/bin/env python3
"""Find the bars where the drummer actually played a fill.

Reads an isolated drum stem plus the song's bar times, and scores every bar on the things that make a
fill a fill: more hits than usual, most of them in the second half of the bar, tom/snare energy rather
than hi-hat, and a landing on the next downbeat. Prints the best bars as JSON for a song's audio.fills.
"""
import sys, json, numpy as np, librosa, scipy.signal as sg

def fill_scores(drums_wav, bar_times, sr=22050):
    y, _ = librosa.load(drums_wav, sr=sr, mono=True)
    hop = 128
    env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop)
    t = librosa.times_like(env, sr=sr, hop_length=hop)
    peaks = librosa.util.peak_pick(env, pre_max=4, post_max=4, pre_avg=8, post_avg=8, delta=env.mean() * 0.6, wait=3)
    ptimes, pstr = t[peaks], env[peaks]
    # tom / snare band (skins) vs hats-and-cymbals band, so a tom run scores and a busy hat pattern doesn't
    b1, a1 = sg.butter(4, [110 / (sr / 2), 900 / (sr / 2)], 'band'); skins = sg.filtfilt(b1, a1, y)
    b2, a2 = sg.butter(4, 6000 / (sr / 2), 'high'); metal = sg.filtfilt(b2, a2, y)
    def band_rms(x, a, b):
        i0, i1 = int(a * sr), int(b * sr)
        seg = x[max(0, i0):max(0, i1)]
        return float(np.sqrt((seg ** 2).mean()) + 1e-9) if len(seg) else 1e-9

    n = len(bar_times) - 1
    hits, late, skin_ratio = np.zeros(n), np.zeros(n), np.zeros(n)
    for i in range(n):
        a, b = bar_times[i], bar_times[i + 1]
        m = (ptimes >= a) & (ptimes < b)
        hits[i] = m.sum()
        if hits[i]:
            rel = (ptimes[m] - a) / max(1e-6, b - a)
            late[i] = float((pstr[m] * rel).sum() / (pstr[m].sum() + 1e-9))  # 0 = all on beat 1, 1 = all at the end
        half = a + (b - a) / 2
        skin_ratio[i] = band_rms(skins, half, b) / (band_rms(metal, half, b) + 1e-9)

    med = np.median(hits[hits > 0]) if (hits > 0).any() else 1
    busy = hits / max(med, 1)
    z = lambda v: (v - v.mean()) / (v.std() + 1e-9)
    score = 1.0 * z(busy) + 0.8 * z(late) + 0.6 * z(np.log1p(skin_ratio))
    return score, hits, busy, late, skin_ratio

def main():
    drums, bars_json, out_json = sys.argv[1], sys.argv[2], sys.argv[3]
    top = int(sys.argv[4]) if len(sys.argv) > 4 else 8
    bar_times = json.load(open(bars_json))
    if isinstance(bar_times, dict): bar_times = bar_times['barTimes']
    score, hits, busy, late, skin = fill_scores(drums, bar_times)
    n = len(score)
    # a fill leads somewhere: prefer bars whose neighbours are ordinary, and never the very first/last bar
    order = np.argsort(-score)
    picked = []
    for i in order:
        if i < 2 or i >= n - 1: continue
        if any(abs(i - j) < 2 for j in picked): continue
        if score[i] < 0.8: break
        picked.append(int(i))
        if len(picked) >= top: break
    picked.sort()
    json.dump(picked, open(out_json, 'w'))
    print('bars scored:', n)
    for i in picked:
        print(f'  bar {i:3d} at {bar_times[i]:7.2f}s  score {score[i]:5.2f}  hits {hits[i]:3.0f} ({busy[i]:.2f}x)  late {late[i]:.2f}  skins/metal {skin[i]:5.2f}')
    print('fills ->', picked)

if __name__ == '__main__':
    main()
