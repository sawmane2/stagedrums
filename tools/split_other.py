#!/usr/bin/env python3
"""Split a high-quality "other" stem into guitar / piano / rest.

The 6-source Demucs model is the only one that separates guitar and piano, but it is not fine-tuned and
its stems carry more artifacts than htdemucs_ft's. So take the *good* model's `other` stem and divide it
using only the *ratios* the 6-source model implies, bin by bin (a Wiener-style split). The three outputs
sum back to the good stem exactly, so nothing is invented and nothing is lost.

usage: split_other.py <good_other.wav> <6s_dir> <out_dir>
"""
import sys, os, numpy as np, soundfile as sf

def stft(x, n=4096, hop=1024):
    w = np.hanning(n).astype('float32')
    L = 1 + (len(x) - n) // hop
    out = np.empty((n // 2 + 1, L), dtype='complex64')
    for i in range(L): out[:, i] = np.fft.rfft(x[i * hop:i * hop + n] * w)
    return out

def mag(path, ch, n=4096, hop=1024):
    x, sr = sf.read(path, dtype='float32')
    if x.ndim == 1: x = np.stack([x, x], 1)
    return np.abs(stft(np.ascontiguousarray(x[:, ch]), n, hop)), sr

def main():
    good, dir6, out = sys.argv[1], sys.argv[2], sys.argv[3]
    os.makedirs(out, exist_ok=True)
    parts = [p for p in ('guitar', 'piano', 'other') if os.path.exists(f'{dir6}/{p}.wav')]
    x, sr = sf.read(good, dtype='float32')
    if x.ndim == 1: x = np.stack([x, x], 1)
    n, hop = 4096, 1024
    res = {p: np.zeros_like(x) for p in parts}
    for ch in range(2):
        X = stft(np.ascontiguousarray(x[:, ch]), n, hop)
        M = {p: mag(f'{dir6}/{p}.wav', ch)[0] for p in parts}
        T = min([X.shape[1]] + [M[p].shape[1] for p in parts])
        X = X[:, :T]
        tot = sum(M[p][:, :T] for p in parts) + 1e-8
        for p in parts:
            r = (M[p][:, :T] / tot).astype('float32')
            Y = X * r
            # inverse STFT (overlap-add with the same window; hop = n/4 so the windows sum flat)
            y = np.zeros(len(x), dtype='float32'); w = np.hanning(n).astype('float32'); norm = np.zeros(len(x), dtype='float32')
            for i in range(T):
                seg = np.fft.irfft(Y[:, i]).astype('float32')
                y[i * hop:i * hop + n] += seg * w; norm[i * hop:i * hop + n] += w * w
            res[p][:, ch] = y / np.maximum(norm, 1e-6)
    for p in parts:
        sf.write(f'{out}/{p}.wav', res[p], sr)
    s = sum(res[p] for p in parts)
    err = 20 * np.log10(np.sqrt(((s - x[:len(s)]) ** 2).mean()) / (np.sqrt((x ** 2).mean()) + 1e-12) + 1e-12)
    print('wrote', parts, 'to', out, '| reconstruction error %.1f dB below the source' % -err)

if __name__ == '__main__':
    main()
