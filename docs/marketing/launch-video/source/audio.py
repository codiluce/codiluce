"""The launch film's soundtrack, every sound rendered from earshot's bank (no recordings, no music library).

A 120 BPM groove (808 kick on the bar's root, claps, hats, kalimba arpeggios over Am - F - G - Em) and the effects,
placed on the picture's cues from video/timeline.js. Writes a 48 kHz stereo WAV mastered to about -14 LUFS, -1 dBTP.
Usage: python -I audio.py <timeline.json> <out.wav>
"""
import json
import sys
from functools import lru_cache

import numpy as np
import pyloudnorm
from scipy.signal import butter, resample_poly, sosfilt

from earshot.forge import bank

SR = 48000
TL = json.load(open(sys.argv[1]))
OUT = sys.argv[2]
DUR = TL['duration']
END = TL.get('soundEnd', DUR)  # the sound fades out here; silence after it, to the end of the film
CU = TL['cues']
SC = TL['scenes']
M0, M1, C0 = SC['montage'][0], SC['montage'][1], SC['cta'][0]
BEAT = 60 / TL['bpm']
mix = np.zeros((int(SR * (DUR + 3)), 2), np.float32)


@lru_cache(maxsize=None)
def take(sound, seed=None, dur=None, apex=None, pitch=None):
    y, meta = bank.render(sound, seed=seed, dur=dur, apex=apex, pitch=pitch)
    if y.ndim == 1:
        y = np.stack([y, y], axis=1)
    if not meta['checks']['ok']:
        print('audit:', sound, seed, meta['checks']['summary'])
    return y.astype(np.float32), meta


def db(x):
    return 10 ** (x / 20)


def place(at, sound, level=0.0, align='onset', pan=0.0, seed=None, dur=None, apex=None, pitch=None, hp=None, cut=None, wide=False):
    """Adds a take so that its onset / peak / end lands on `at` (film seconds)."""
    y, meta = take(sound, seed, dur, apex, pitch)
    if hp:
        y = sosfilt(butter(2, hp, 'highpass', fs=SR, output='sos'), y, axis=0).astype(np.float32)
    ref = {'onset': meta['onset_s'], 'peak': meta['peak_s'], 'end': meta['dur_s'], 'start': 0.0}[align]
    start = int(round((at - float(ref)) * SR))
    if cut is not None:  # stop the take at film time `cut`, with a 15 ms fade
        n = int(round(cut * SR)) - start
        if n <= 0:
            return
        y = y[:n].copy()
        f = min(len(y), int(0.015 * SR))
        y[-f:] *= np.linspace(1, 0, f)[:, None]
    g = db(level)
    left, right = g * min(1, 1 - pan), g * min(1, 1 + pan)
    s0, s1 = max(0, start), min(len(mix), start + len(y))
    if s1 <= s0:
        return
    seg = y[s0 - start:s1 - start]
    mix[s0:s1, 0] += seg[:, 0] * left
    mix[s0:s1, 1] += seg[:, 1] * right
    if wide:  # early reflections on one side each: width without a comb in mono
        for ch, ms, gain in ((0, 19, -9), (1, 27, -9), (0, 41, -14), (1, 53, -14)):
            d = int(ms * SR / 1000)
            a0, a1 = s0 + d, min(len(mix), s1 + d)
            if a1 > a0:
                mix[a0:a1, ch] += seg[: a1 - a0, ch] * g * db(gain)


def beats(a, b, step=BEAT, offset=0.0):
    t = a + offset
    while t < b - 1e-9:
        yield round(t, 6)
        t += step


# ---- harmony: one chord per 2 s bar, Am F G Em ----
ROOTS = ['A1', 'F1', 'G1', 'E1']
CHORDS = [['A5', 'C6', 'E6', 'A5'], ['F5', 'A5', 'C6', 'F5'], ['G5', 'B5', 'D6', 'G5'], ['E5', 'G5', 'B5', 'E6']]
bar = lambda t: int(t // (4 * BEAT)) % 4
STOPS = [(5.75, 6.0), (M1 - 0.15, C0)]  # stop-downs: the groove is silent here
SILENT = lambda t: any(a <= t < b for a, b in STOPS)


def kick(t, level=-2.5):
    if SILENT(t):
        return
    cut = next((a for a, b in STOPS if t < a < t + 0.45), None)
    place(t, 'sub_drop/punch', level, pitch=ROOTS[bar(t)], dur=0.42, cut=cut)


def clap(t, level=-3.5):
    if SILENT(t):
        return
    place(t, 'fit/snap/switch_flip', level, seed=int(t * 4) % 3 + 1, hp=300, wide=True)
    place(t, 'swish/blade', level - 5, align='peak', dur=0.16, apex=0.012, hp=1500, seed=int(t * 4) % 3 + 1)


def hat(t, level, pan):
    if SILENT(t):
        return
    place(t, 'pro_hover_tick/soft', level, pan=pan * 1.8, seed=int(t * 8) % 4 + 1, hp=4000)


def arp(a, b, level=-15.0, step=BEAT / 4, lift=3.0):
    pattern = [0, 1, 2, 3, 2, 1, 2, 3]
    for i, t in enumerate(beats(a, b, step)):
        if SILENT(t):
            continue
        note = CHORDS[bar(t)][pattern[i % 8]]
        accent = 2.0 if i % 4 == 0 else 0.0
        stop = any(abs(b - a0) < 1e-6 for a0, _ in STOPS)
        place(t, 'pluck/kalimba_soft', level + lift + accent, pitch=note, pan=0.5 if i % 2 else -0.5, cut=b if stop else b + 0.6, wide=True)


def groove(a, b, kicks=True, claps=True, hats16=True, hat_level=-12.0):
    for i, t in enumerate(beats(a, b)):
        if kicks:
            kick(t)
        if claps and int(round(t / BEAT)) % 2 == 1:
            clap(t)
    for i, t in enumerate(beats(a, b, BEAT / 4 if hats16 else BEAT / 2)):
        off = abs((t / (BEAT / 2)) % 1 - 0.5) < 0.25 if not hats16 else (int(round(t / (BEAT / 4))) % 2 == 1)
        hat(t, hat_level + (3 if off else 0), 0.3 if int(round(t / (BEAT / 4))) % 2 else -0.3)


# ---- music ----
# Hook: half-time kick, eighth hats, the first arpeggio enters with the second line.
for t in beats(0, 3):
    kick(t, -3.0)
for t in beats(0, 3, BEAT / 4):
    hat(t, -16 + (3 if int(round(t / (BEAT / 4))) % 2 else 0), 0.3 if int(round(t / (BEAT / 4))) % 2 else -0.3)
arp(0.0, 3.0, -17)
place(0.0, 'pro_impact/short', -4)
place(0.0, 'pro_sub_drop/quick', -6, pitch='A1')
# Problem: four on the floor, claps, sixteenth hats, then the stop-down before the reveal.
groove(3.0, 5.75)
arp(3.0, 5.75, -17)
# Reveal: no drums, a slow arpeggio under the logo, the build into the map.
arp(6.5, 8.5, -16, BEAT / 2)
# Features: the full groove; one lighter bar for the pull request's tour, where it morphs into a diagram.
beat2 = CU['beatCuts'][0]
groove(8.5, beat2)
arp(8.5, beat2, -16)
groove(beat2, beat2 + 1.0, kicks=False, claps=False, hats16=False, hat_level=-16)
arp(beat2, beat2 + 1.0, -15, BEAT / 2)
groove(beat2 + 1.0, M0)
arp(beat2 + 1.0, M0, -16)
# Montage: busier, claps on eighths in the last bar, a roll into the end card.
groove(M0, M1 - 0.15, hat_level=-12.5)
for t in beats(M1 - 1.0, M1 - 0.15, BEAT / 2):
    clap(t, -6)
arp(M0, M1 - 0.15, -15)
# End card: the groove carries on lighter, and a final button.
groove(C0 + 0.5, CU['button'], claps=True, hat_level=-16)
arp(C0, CU['button'], -17, BEAT / 2)

# ---- effects on the picture ----
# Hook.
for t in CU['hookPanes']:
    place(t, 'pro_pop_in/round', -9, pan=(-0.5, 0.0, 0.5)[CU['hookPanes'].index(t)])
place(0.05, 'pro_typing_run/standard', -16, align='start', pan=-0.2)
place(0.75, 'pro_typing_run/soft', -17, align='start', pan=0.25)
place(CU['hookSwap'], 'whoosh_fast/tight', -9, align='peak', dur=0.55, apex=0.4)
for i, t in enumerate(CU['hookGrid']):
    place(t, 'pro_pop_in/deep', -8 + i, seed=i + 1)
for i, t in enumerate(beats(1.75, 2.9, 0.07)):
    place(t, 'hover_tick/high', -24, pan=0.35, seed=i % 4 + 1, hp=3000)
place(2.98, 'whoosh_fast/reverse', -9, align='peak', dur=0.6, apex=0.45)
# Problem.
place(CU['prStamp'], 'pro_impact/short', -2)
for i, t in enumerate(beats(3.0, 3.42, 0.035)):
    place(t, 'pro_click/tink', -22, seed=i % 4 + 1, pan=-0.3)
for i, t in enumerate(CU['questions']):
    place(t, 'pro_pop_in/deep', -5, seed=i + 2)
    place(t, 'fit/hit/bamboo_tok', -12, seed=i + 1)
place(CU['riserEnd'], 'riser/rush', -8, align='end', dur=1.5)
place(CU['riserEnd'], 'pro_riser/roll', -11, align='end', dur=1.1)
place(5.72, 'whoosh_fast/reverse', -8, align='peak', dur=0.5, apex=0.4, cut=5.77)
# Reveal.
place(CU['reveal'], 'impact/punch', -1)
place(CU['reveal'], 'pro_sub_drop/ref', -2, pitch='A1')
place(CU['reveal'] + 0.02, 'shimmer/m5', -12, pitch='A5', wide=True)
place(CU['wordmark'] + 0.05, 'whoosh_fast/tight', -11, align='peak', dur=0.5, apex=0.3)
for i, n in enumerate(['A4', 'C5', 'E5']):
    place(CU['wordmark'] + i * 0.06, 'pluck/kalimba', -9, pitch=n)
for i, n in enumerate(['E5', 'A5']):
    place(CU['tagline'] + i * 0.25, 'pluck/kalimba_ring', -11, pitch=n)
place(8.5, 'riser/air', -11, align='end', dur=1.2)
place(CU['openWhoosh'] + 0.1, 'whoosh_big/swell', -6, align='peak', dur=1.0, apex=0.6)
place(8.5, 'pro_impact/short', -5)
# Features: a whoosh on each cut, a soft landing for each title, the UI's own clicks.
for t in CU['featureCuts']:
    place(t, 'whoosh_fast/tight', -9, align='peak', dur=0.5, apex=0.32)
for t in [8.45] + CU['featureCuts'][:-1]:
    place(t + 0.12, 'fit/land.light/fingertip_book', -10)
for i, t in enumerate(CU['clicks']):
    place(t, 'fit/click/floss_lid', -7, seed=i + 1, pan=0.15)
for t in CU['beatCuts']:
    place(t, 'whoosh_fast/tight', -12, align='peak', dur=0.45, apex=0.3)
place(CU['clicks'][2] + 0.3, 'pro_notify/ding_2045', -16)
for i, t in enumerate(CU['agentHops']):
    place(t, 'pro_pop/tink', -15, seed=i + 1, pan=(-0.3, 0.2, 0.35)[i % 3])
place(CU['morph'] + 0.45, 'swish/soft', -10, align='peak', dur=0.9, apex=0.5)
for i, n in enumerate(['E5', 'G5', 'A5', 'C6', 'E6']):
    place(CU['morph'] + 0.15 + i * 0.09, 'pluck/kalimba', -13, pitch=n, pan=-0.3 + i * 0.15)
# Montage.
for i, t in enumerate(CU['montageCuts'][1:]):
    place(t, 'swipe/flick', -10, align='peak', dur=0.4, apex=0.2, seed=i + 1)
place(CU['planSnap'], 'toggle/rocker', -8)
place(CU['planSnap'], 'pro_pop_in/knock', -9)
place(CU['peopleClick'], 'pro_pop_in/round', -12)
place(CU['depsTap'], 'fit/click/floss_lid', -9, seed=3)
place(CU['historyStep'], 'fit/click/floss_lid', -11, seed=2, pan=0.2)
place(M1 - 0.15, 'pro_riser/nblips', -12, align='end', dur=0.85)
# End card.
place(CU['sting'], 'pro_impact/short', -2)
place(CU['sting'], 'pro_sub_drop/ref', -3, pitch='A1')
place(CU['sting'], 'notify/m1', -10)
for i, n in enumerate(['A4', 'C5', 'E5', 'B5']):
    place(CU['sting'] + 0.03 + i * 0.05, 'pluck/kalimba', -10, pitch=n)
n = len(TL['command'])
rng = np.random.default_rng(7)
for i in range(n):
    t = CU['typeStart'] + (CU['typeEnd'] - CU['typeStart']) * i / n + rng.uniform(-0.008, 0.008)
    key = 'fit/key.space/thock_space' if TL['command'][i] == ' ' else ('fit/key/medium' if i % 2 else 'fit/key/thock')
    place(t, key, -13, seed=i % 5 + 1, pan=0.05)
place(CU['enter'], 'typing_key/deep', -9)
place(CU['enter'] + 0.12, 'pro_notify/ding_1930', -14)
place(CU['url'], 'fit/land.light/finger_phone', -13)
place(CU['button'], 'sub_drop/punch', 0, pitch='A1', dur=0.5)
place(CU['button'], 'pro_impact/short', -4)
for i, n in enumerate(['A4', 'E5', 'A5', 'C6']):
    place(CU['button'] + i * 0.03, 'pluck/kalimba_ring', -9, pitch=n)

# ---- master: high-pass the rumble, a true-peak limiter, loudness to about -14 LUFS ----
y = mix[: int(SR * END)].astype(np.float64)
y = sosfilt(butter(2, 28, 'highpass', fs=SR, output='sos'), y, axis=0)
fade = int(0.2 * SR)
y[-fade:] *= np.linspace(1, 0, fade)[:, None] ** 1.5
meter = pyloudnorm.Meter(SR)


def true_peak(x):
    return 20 * np.log10(np.max(np.abs(resample_poly(x, 4, 1, axis=0))) + 1e-12)


def limit(x, ceiling_db):
    """Look-ahead peak limiter (2 ms look-ahead, 80 ms release) on the louder channel."""
    ceiling = db(ceiling_db)
    peak = np.max(np.abs(x), axis=1)
    want = np.minimum(1.0, ceiling / np.maximum(peak, 1e-9))
    look = int(0.002 * SR)
    # the gain reaches its minimum `look` samples before the peak
    from scipy.ndimage import minimum_filter1d
    want = minimum_filter1d(want, size=2 * look + 1, origin=0)
    g = np.empty_like(want)
    rel = np.exp(-1 / (0.08 * SR))
    atk = np.exp(-1 / (0.0007 * SR))
    cur = 1.0
    for i, w in enumerate(want):
        cur = atk * cur + (1 - atk) * w if w < cur else rel * cur + (1 - rel) * w
        g[i] = min(cur, w) if w < cur else cur
    return x * g[:, None]


target = -14.0
y *= db(target - meter.integrated_loudness(y))
for _ in range(6):
    z = limit(y, -1.3)
    lufs, tp = meter.integrated_loudness(z), true_peak(z)
    if tp <= -1.0 and abs(lufs - target) < 0.3:
        break
    y *= db(target - lufs)
y = z
if true_peak(y) > -1.0:
    y *= db(-1.0 - true_peak(y) - 0.05)
print(f'integrated {meter.integrated_loudness(y):.1f} LUFS, true peak {true_peak(y):.2f} dBTP')
import soundfile
y = np.concatenate([y, np.zeros((int(SR * DUR) - len(y), 2))])
soundfile.write(OUT, y.astype(np.float32), SR, subtype='PCM_24')
