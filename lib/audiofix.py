"""Aplica correcciones a un audio de voz y escribe uno NUEVO (el original no se toca).
Entrada (stdin, JSON): {"file": "in.mp3", "out": "out.mp3", "edits": [...]}
edits (tiempos en segundos del audio ORIGINAL):
  {"type": "gain", "t0", "t1", "gain", "ramp"}      atenuar/silenciar/nivelar un tramo con rampas suaves
  {"type": "cut", "t0", "t1"}                        quitar un tramo (acortar pausas)
  {"type": "replace", "t0", "t1", "file", "padStart", "padEnd"}   sustituir un tramo por otro audio (trozo regenerado)
Salida (stdout, JSON): {"duration": nueva duración}
"""
import json
import subprocess
import sys

import numpy as np

RATE = 44100


def load(path):
    raw = subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-i", path, "-f", "f32le", "-ac", "1", "-ar", str(RATE), "-"],
                         check=True, capture_output=True).stdout
    return np.frombuffer(raw, dtype=np.float32).copy()


def idx(t):
    return int(round(max(0.0, t) * RATE))


def fade(a, ms=8):
    n = min(len(a) // 2, int(RATE * ms / 1000))
    if n > 0:
        a[:n] *= np.linspace(0, 1, n)
        a[-n:] *= np.linspace(1, 0, n)
    return a


def trim_silence(a, thr_db=-45):
    """Quita el silencio de los bordes de un trozo regenerado (para controlar la pausa del empalme)."""
    if not len(a):
        return a
    thr = 10 ** (thr_db / 20)
    loud = np.where(np.abs(a) > thr)[0]
    if not len(loud):
        return a[:0]
    return a[max(0, loud[0] - int(RATE * 0.02)): loud[-1] + int(RATE * 0.04)]


req = json.load(sys.stdin)
x = load(req["file"])
edits = req["edits"]

# 1) ganancias con rampas (sobre el original, antes de cortar/empalmar)
env = np.ones(len(x), dtype=np.float32)
for e in edits:
    if e["type"] != "gain":
        continue
    a, b = idx(e["t0"]), idx(e["t1"])
    r = max(1, idx(e.get("ramp", 0.02)))
    g = float(e["gain"])
    seg = np.full(max(0, b - a), g, dtype=np.float32)
    env[a:b] = np.minimum(env[a:b], seg) if g < 1 else seg
    # rampas de entrada y salida
    ra = np.linspace(1, g, r, dtype=np.float32)
    lo = max(0, a - r)
    if a > lo:
        env[lo:a] = np.minimum(env[lo:a], ra[-(a - lo):]) if g < 1 else ra[-(a - lo):]
    hi = min(len(env), b + r)
    rb = np.linspace(g, 1, r, dtype=np.float32)
    env[b:hi] = np.minimum(env[b:hi], rb[: hi - b]) if g < 1 else rb[: hi - b]
x = x * env

# 2) cortes y sustituciones: se reconstruye el audio por tramos en orden
ops = sorted([e for e in edits if e["type"] in ("cut", "replace")], key=lambda e: e["t0"])
pieces, pos = [], 0
for e in ops:
    a, b = idx(e["t0"]), idx(e["t1"])
    if a < pos:  # solapa con una operación anterior: se recorta
        a = pos
    if b <= a:
        continue
    pieces.append(fade(x[pos:a].copy(), 4) if pos else x[pos:a].copy())
    if e["type"] == "replace":
        new = trim_silence(load(e["file"]))
        pad0 = np.zeros(idx(e.get("padStart", 0.12)), dtype=np.float32)
        pad1 = np.zeros(idx(e.get("padEnd", 0.12)), dtype=np.float32)
        pieces.append(np.concatenate([pad0, fade(new.copy()), pad1]))
    pos = b
pieces.append(x[pos:].copy())
y = np.concatenate([p for p in pieces if len(p)]) if pieces else x
# sin saturar
peak = float(np.abs(y).max()) if len(y) else 0
if peak > 0.98:
    y = y * (0.98 / peak)

subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-f", "f32le", "-ac", "1", "-ar", str(RATE), "-i", "-",
                "-b:a", "192k", req["out"]], input=y.astype(np.float32).tobytes(), check=True)
json.dump({"duration": round(len(y) / RATE, 3)}, sys.stdout)
