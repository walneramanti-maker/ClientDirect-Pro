"""Musique de fond originale, dynamique, 118 BPM, calée sur le minutage des scènes."""
import json, numpy as np
from scipy.signal import butter, sosfilt
import wave

SR = 44100
TL = json.load(open('/tmp/ad/timeline.json'))
BPM = TL['bpm']; BEAT = 60 / BPM; BAR = 4 * BEAT
TOTAL = TL['total']
N = int((TOTAL + 0.05) * SR)
rng = np.random.default_rng(7)
L = np.zeros(N); R = np.zeros(N)

def nf(m): return 440 * 2 ** ((m - 69) / 12)
def env_exp(n, tau): return np.exp(-np.arange(n) / (tau * SR))
def place(buf, sig, t, gain=1.0):
    i = int(t * SR)
    if i >= N: return
    j = min(N, i + len(sig)); buf[i:j] += gain * sig[: j - i]
def lp(x, fc, order=2): return sosfilt(butter(order, fc, 'low', fs=SR, output='sos'), x)
def hp(x, fc, order=2): return sosfilt(butter(order, fc, 'high', fs=SR, output='sos'), x)
def bp(x, lo, hi): return sosfilt(butter(2, [lo, hi], 'band', fs=SR, output='sos'), x)
def saw(f, n, ph=0.0):
    t = np.arange(n) / SR; x = np.zeros(n)
    for k in range(1, int(min(40, 16000 / f)) + 1):
        x += np.sin(2 * np.pi * f * k * t + ph * k) / k
    return x * 0.6

# Accords : Do – Sol – La m – Fa (I V vi IV), une mesure chacun
CH = [[60, 64, 67, 72], [55, 62, 67, 71], [57, 60, 64, 69], [53, 60, 65, 69]]
ROOT = [36, 43, 45, 41]

DROP = 3 * BAR                      # la batterie entre avec « Avec ClientDirect Pro »
BREAK = TL['scenes'][7]['start']    # « votre partenaire digital » : respiration
FIN = TL['scenes'][8]['start']      # carte finale
END_HIT = FIN + 8 * BEAT        # accord final
nbars = int(np.ceil(TOTAL / BAR))

# --- Kick
kn = int(0.4 * SR); kt = np.arange(kn) / SR
kick = np.sin(2 * np.pi * np.cumsum(45 + 110 * np.exp(-kt / 0.03)) / SR) * env_exp(kn, 0.16)
kick += 0.3 * rng.standard_normal(kn) * env_exp(kn, 0.003)
# --- Clap
cn = int(0.25 * SR)
clap = bp(rng.standard_normal(cn), 900, 4000) * env_exp(cn, 0.06)
for d in (0.010, 0.020):
    clap[int(d * SR):] += 0.6 * bp(rng.standard_normal(cn - int(d * SR)), 900, 4000) * env_exp(cn - int(d * SR), 0.02)
# --- Charleston
hn = int(0.06 * SR); hat = hp(rng.standard_normal(hn), 7000) * env_exp(hn, 0.012)
on = int(0.3 * SR); ohat = hp(rng.standard_normal(on), 6000) * env_exp(on, 0.09)

kick_times = []
for b in range(nbars):
    t0 = b * BAR
    for q in range(4):
        t = t0 + q * BEAT
        if t >= TOTAL - 0.1: continue
        in_groove = (DROP <= t < BREAK) or (FIN <= t < END_HIT)
        intro = t < DROP
        if in_groove:
            place(L, kick, t, 0.9); place(R, kick, t, 0.9); kick_times.append(t)
            if q in (1, 3): place(L, clap, t, 0.32); place(R, clap, t + 0.004, 0.32)
        for e in range(2):
            th = t + e * BEAT / 2
            if th >= TOTAL - 0.1 or th >= END_HIT: continue
            g = 0.10 if (in_groove or intro) else 0.05
            if e == 1 and q == 3 and in_groove: place(L, ohat, th, 0.07); place(R, ohat, th, 0.09)
            else: place(L, hat, th, g * 0.8); place(R, hat, th, g)
        # Charleston en double croches pendant le groove
        if in_groove:
            for s in (1, 3):
                place(R, hat, t + s * BEAT / 4, 0.045); place(L, hat, t + s * BEAT / 4, 0.03)

# Roulement de caisse claire avant l'entrée de la batterie et avant la carte finale
for start, beats in ((DROP - 2 * BEAT, 2), (FIN - 2 * BEAT, 2)):
    n = 16
    for i in range(n):
        tt = start + i * beats * BEAT / n
        place(L, clap, tt, 0.05 + 0.25 * i / n); place(R, clap, tt, 0.05 + 0.25 * i / n)

# Courbe de ducking (effet « pompe » sur le synthé quand la grosse caisse frappe)
duck = np.ones(N)
dn = int(0.35 * SR); dcurve = 1 - 0.55 * env_exp(dn, 0.09)
for t in kick_times:
    i = int(t * SR); j = min(N, i + dn); duck[i:j] = np.minimum(duck[i:j], dcurve[: j - i])

# --- Nappe (accords), basse et arpège
pad_l = np.zeros(N); pad_r = np.zeros(N); bass = np.zeros(N); arp_l = np.zeros(N); arp_r = np.zeros(N)
for b in range(nbars):
    t0 = b * BAR
    if t0 >= END_HIT: break
    c = CH[b % 4]; n = int(BAR * SR) + int(0.3 * SR)
    a = np.minimum(1, np.arange(n) / (0.08 * SR)) * np.minimum(1, (n - np.arange(n)) / (0.3 * SR))
    for k, m in enumerate(c):
        place(pad_l, saw(nf(m) * 0.997, n) * a, t0, 0.06)
        place(pad_r, saw(nf(m) * 1.003, n, 0.7) * a, t0, 0.06)
    # basse en croches, octave sur les contre-temps
    if t0 >= DROP - 0.01 and t0 < BREAK or FIN - BAR / 2 <= t0 < END_HIT:
        for e in range(8):
            tb = t0 + e * BEAT / 2
            if tb >= END_HIT: break
            bn = int(BEAT / 2 * SR * 0.9)
            f = nf(ROOT[b % 4] + (12 if e % 2 else 0))
            place(bass, saw(f, bn) * env_exp(bn, 0.12) * np.minimum(1, np.arange(bn) / 80), tb, 0.30)
    # arpège en doubles croches dès la 2e mesure
    if b >= 1:
        pat = [0, 1, 2, 3, 2, 1, 2, 3]
        for s in range(16):
            ts = t0 + s * BEAT / 4
            if ts >= END_HIT or (BREAK <= ts < FIN and s % 2): continue
            m = c[pat[s % 8]] + 12
            an = int(0.22 * SR)
            tone = (saw(nf(m), an) * 0.5 + np.sin(2 * np.pi * nf(m) * np.arange(an) / SR)) * env_exp(an, 0.07)
            place(arp_l if s % 2 else arp_r, tone, ts, 0.055)
            place(arp_r if s % 2 else arp_l, tone, ts + 0.012, 0.02)

# Accord final tenu
fn = N - int(END_HIT * SR)
if fn > 0:
    a = np.minimum(1, np.arange(fn) / (0.01 * SR)) * env_exp(fn, 1.4)
    for m in CH[0] + [48, 36]:
        place(pad_l, saw(nf(m) * 0.997, fn) * a, END_HIT, 0.07)
        place(pad_r, saw(nf(m) * 1.003, fn, 0.7) * a, END_HIT, 0.07)
    place(L, kick, END_HIT, 0.9); place(R, kick, END_HIT, 0.9)
    place(L, clap, END_HIT, 0.3); place(R, clap, END_HIT, 0.3)

# Filtre de la nappe : fermé pendant l'intro, s'ouvre vers l'entrée de la batterie
t = np.arange(N) / SR
pad_l = lp(pad_l, 2200) * duck; pad_r = lp(pad_r, 2200) * duck
intro_mask = t < DROP
pad_l[intro_mask] = lp(pad_l, 700)[intro_mask]; pad_r[intro_mask] = lp(pad_r, 700)[intro_mask]
bass = lp(bass, 900) * (0.6 + 0.4 * duck)
arp_l = lp(arp_l, 5000); arp_r = lp(arp_r, 5000)

# Montée de bruit avant l'entrée et avant la fin
for start, dur in ((DROP - BAR, BAR), (FIN - 2 * BAR + BAR / 2, 1.5 * BAR)):
    rn = int(dur * SR)
    sweep = hp(rng.standard_normal(rn), 2000) * np.linspace(0, 1, rn) ** 2
    place(L, sweep, start, 0.08); place(R, sweep, start, 0.08)

L += pad_l + bass + arp_l; R += pad_r + bass + arp_r
# léger écho stéréo sur l'arpège
d = int(BEAT * 0.75 * SR)
L[d:] += 0.18 * arp_r[:-d]; R[d:] += 0.18 * arp_l[:-d]
# fondu final
fo = int(1.2 * SR); L[-fo:] *= np.linspace(1, 0, fo); R[-fo:] *= np.linspace(1, 0, fo)
mix = np.stack([L, R], 1)
mix = np.tanh(mix / np.max(np.abs(mix)) * 1.4) * 0.9
pcm = (mix * 32767).astype('<i2')
with wave.open('/tmp/ad/music_raw.wav', 'wb') as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes(pcm.tobytes())
print('ok', round(N / SR, 2), 's')
