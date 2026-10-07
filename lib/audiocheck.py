"""Busca aberraciones en la SEÑAL de un audio de voz (lo que el texto no puede ver).
Entrada (stdin, JSON): {"file": "...mp3", "words": [{"w","s","e","p"}...]}
Salida (stdout, JSON): {"duration", "speech_db", "issues": [{"kind","t0","t1","db","detail"}]}

kind:
  noise  - suena algo con tono ENTRE palabras (gemido, zumbido, sílaba inventada o palabra que no está en el guion)
  breath - respiración demasiado fuerte entre palabras
  click  - chasquido / clic muy corto
  clip   - saturación (la onda toca el techo)
  level  - una frase suena mucho más fuerte o más floja que el resto
  pause  - pausa demasiado larga dentro del segmento
"""
import json
import subprocess
import sys

import numpy as np

RATE = 22050


def load(path):
    raw = subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-i", path, "-f", "f32le", "-ac", "1", "-ar", str(RATE), "-"],
                         check=True, capture_output=True).stdout
    return np.frombuffer(raw, dtype=np.float32)


def db(x):
    return 10 * np.log10(np.maximum(x, 1e-12))


req = json.load(sys.stdin)
x = load(req["file"])
dur = len(x) / RATE
words = sorted(req.get("words") or [], key=lambda w: w["s"])

def tonality(seg):
    """(planitud espectral, periodicidad): ruido/respiración → planitud alta y poca periodicidad; voz/gemido → al revés."""
    if len(seg) < 1100:
        return 0.0, 1.0
    fl, pv = [], []
    for i in range(0, len(seg) - 1024, 512):
        f = seg[i:i + 1024] * np.hanning(1024)
        S = np.abs(np.fft.rfft(f)) ** 2 + 1e-12
        fl.append(np.exp(np.mean(np.log(S))) / np.mean(S))
        a = np.correlate(f, f, "full")[1023:]
        a = a / (a[0] + 1e-12)
        pv.append(a[RATE // 400:RATE // 70].max())
    return float(np.median(fl)), float(np.median(pv))


# energía en ventanas de 20 ms
W = int(RATE * 0.02)
n = len(x) // W
frames = x[: n * W].reshape(n, W)
e_db = db((frames ** 2).mean(axis=1))
ft = (np.arange(n) + 0.5) * W / RATE

# nivel de la voz: mediana de las ventanas dentro de palabras
inside = np.zeros(n, bool)
for w in words:
    inside[(ft >= w["s"]) & (ft <= w["e"])] = True
speech = e_db[inside & (e_db > -60)]
speech_db = float(np.median(speech)) if speech.size else float(np.median(e_db[e_db > -60])) if (e_db > -60).any() else -30.0
issues = []


def add(kind, t0, t1, level, detail):
    issues.append({"kind": kind, "t0": round(float(t0), 3), "t1": round(float(t1), 3), "db": round(float(level), 1), "detail": detail})


# --- sonido fuerte entre palabras (huecos de Whisper con energía de voz) ---
gaps = []
prev_end = 0.0
for w in words:
    gaps.append((prev_end, w["s"]))
    prev_end = max(prev_end, w["e"])
gaps.append((prev_end, dur))
for a, b in gaps:
    a2, b2 = a + 0.12, b - 0.08  # márgenes: colas y ataques de las palabras no cuentan
    if b2 - a2 < 0.25:
        continue
    m = (ft >= a2) & (ft <= b2)
    if not m.any():
        continue
    loud = e_db[m] > speech_db - 12  # casi tan fuerte como la voz: no es respiración
    # tramo continuo más largo de ventanas fuertes
    best = run = 0
    for v in loud:
        run = run + 1 if v else 0
        best = max(best, run)
    if best * 0.02 >= 0.18:
        idx = np.where(m)[0][loud]
        t0, t1 = ft[idx[0]] - 0.01, ft[idx[-1]] + 0.01
        flat, tone = tonality(x[int(t0 * RATE):int(t1 * RATE)])
        if flat > 0.03 and tone < 0.5:
            add("breath", t0, t1, float(e_db[m].max()), f"respiración fuerte ({t1 - t0:.1f} s)")
        else:
            add("noise", t0, t1, float(e_db[m].max()), f"sonido con tono entre palabras ({t1 - t0:.1f} s): gemido o palabra que no está en el guion")

# --- clics: saltos bruscos de la onda muy por encima de lo normal alrededor ---
d = np.abs(np.diff(x))
C = int(RATE * 0.01)
nc = len(d) // C
if nc > 4:
    blocks = d[: nc * C].reshape(nc, C)
    peak = blocks.max(axis=1)
    local = np.convolve(np.median(blocks, axis=1), np.ones(15) / 15, mode="same")
    ratio = peak / np.maximum(local, 1e-5)
    hits = np.where((ratio > 40) & (peak > 0.08))[0]
    last = -1
    for h in hits:
        t = (h + 0.5) * C / RATE
        if t - last < 0.3:
            continue
        if any(w["s"] - 0.03 <= t <= w["e"] + 0.03 for w in words):
            continue  # dentro de una palabra: es una consonante (p, t, k), no un clic
        last = t
        add("click", t - 0.008, t + 0.008, float(20 * np.log10(peak[h] + 1e-9)), "chasquido entre palabras")

# --- saturación ---
clip = np.abs(x) >= 0.985
if clip.sum() >= 3:
    idx = np.where(clip)[0]
    groups = np.split(idx, np.where(np.diff(idx) > RATE * 0.1)[0] + 1)
    for g in groups:
        if len(g) >= 3:
            add("clip", g[0] / RATE, g[-1] / RATE, 0.0, f"{len(g)} muestras saturadas")

# --- frases con volumen anormal (por grupos de ~6 palabras) ---
for k in range(0, len(words), 6):
    grp = words[k:k + 6]
    if len(grp) < 3:
        continue
    # solo ventanas con voz de verdad (las pausas que Whisper mete dentro de una palabra no cuentan)
    m = (ft >= grp[0]["s"]) & (ft <= grp[-1]["e"]) & inside & (e_db > speech_db - 18)
    if m.sum() < 10:
        continue
    lv = float(np.median(e_db[m]))
    if abs(lv - speech_db) >= 8:
        add("level", grp[0]["s"], grp[-1]["e"], lv - speech_db,
            f"{'más fuerte' if lv > speech_db else 'más flojo'} que el resto ({lv - speech_db:+.0f} dB)")

# --- pausas demasiado largas entre palabras ---
for a, b in zip(words, words[1:]):
    gap = b["s"] - a["e"]
    if gap > 1.3:
        add("pause", a["e"], b["s"], 0.0, f"pausa de {gap:.1f} s")
if words:
    if words[0]["s"] > 0.8:
        add("pause", 0.0, words[0]["s"], 0.0, f"empieza con {words[0]['s']:.1f} s de silencio")
    if dur - words[-1]["e"] > 1.2:
        add("pause", words[-1]["e"], dur, 0.0, f"termina con {dur - words[-1]['e']:.1f} s de silencio")

json.dump({"duration": round(dur, 3), "speech_db": round(speech_db, 1), "issues": sorted(issues, key=lambda i: i["t0"])}, sys.stdout)
