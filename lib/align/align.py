"""Alineación palabra a palabra con faster-whisper (local, CPU).
Entrada (stdin, JSON): {"model": "small", "items": [{"file": "...mp3", "prompt": "texto esperado"}]}
Salida (stdout, JSON): [{"file": ..., "words": [{"w": "palabra", "s": 0.12, "e": 0.40, "p": 0.98}], "duration": 25.1}]
"""
import json
import re
import subprocess
import sys
import unicodedata

import numpy as np
from faster_whisper import WhisperModel


def load_audio(path, rate=16000):
    # decodificamos con ffmpeg (evita depender de la versión de PyAV)
    raw = subprocess.run(
        ["ffmpeg", "-nostdin", "-v", "error", "-i", path, "-f", "f32le", "-ac", "1", "-ar", str(rate), "-"],
        check=True, capture_output=True,
    ).stdout
    return np.frombuffer(raw, dtype=np.float32)


def norm(w):
    w = unicodedata.normalize("NFD", w.lower())
    return re.sub(r"[^a-z0-9ñ]", "", "".join(c for c in w if unicodedata.category(c) != "Mn"))


def transcribe(audio, prompt):
    segments, info = model.transcribe(
        audio,
        language="es",
        word_timestamps=True,
        initial_prompt=prompt or None,
        beam_size=5,
        vad_filter=False,
        condition_on_previous_text=False,
    )
    words = [
        {"w": w.word.strip(), "s": round(w.start, 3), "e": round(w.end, 3), "p": round(w.probability, 3)}
        for seg in segments
        for w in (seg.words or [])
    ]
    return words, info.duration


def quality(words, expected, duration):
    """0..1: cuánto de lo esperado se oye y si los tiempos son creíbles.
    Con el texto como pista, Whisper a veces "alucina" un galimatías y amontona palabras en un instante."""
    exp = [norm(w) for w in expected.split()]
    exp = [w for w in exp if w]
    heard = {norm(w["w"]) for w in words}
    found = sum(1 for w in exp if w in heard) / max(1, len(exp))
    # más de 7 palabras en un segundo es imposible al hablar: tiempos amontonados
    starts = sorted(w["s"] for w in words)
    crammed = sum(1 for i in range(len(starts)) if i + 7 < len(starts) and starts[i + 7] - starts[i] < 1.0)
    # mucho rato sin palabras al principio (con voz sonando) también es mala señal
    late = 1 if words and words[0]["s"] > 3.0 else 0
    return found - min(0.5, crammed / max(1, len(words)) * 4) - 0.2 * late


req = json.load(sys.stdin)
model = WhisperModel(req.get("model", "small"), device="cpu", compute_type="int8")
out = []
for item in req["items"]:
    audio = load_audio(item["file"])
    expected = item.get("prompt") or ""
    words, duration = transcribe(audio, expected[:900])  # el texto esperado guía el reconocimiento
    q = quality(words, expected, duration)
    if expected and q < 0.8:
        # la pista confundió a Whisper: se vuelve a escuchar sin ella y se queda la mejor versión
        alt, _ = transcribe(audio, None)
        qa = quality(alt, expected, duration)
        print(f"realineado sin pista {item['file']} ({q:.2f} → {qa:.2f})", file=sys.stderr, flush=True)
        if qa > q:
            words, q = alt, qa
    out.append({"file": item["file"], "words": words, "duration": round(duration, 3), "quality": round(q, 3)})
    print(f"alineado {item['file']}", file=sys.stderr, flush=True)
json.dump(out, sys.stdout, ensure_ascii=False)
