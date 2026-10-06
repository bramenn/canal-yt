"""Alineación palabra a palabra con faster-whisper (local, CPU).
Entrada (stdin, JSON): {"model": "small", "items": [{"file": "...mp3", "prompt": "texto esperado"}]}
Salida (stdout, JSON): [{"file": ..., "words": [{"w": "palabra", "s": 0.12, "e": 0.40, "p": 0.98}], "duration": 25.1}]
"""
import json
import subprocess
import sys

import numpy as np
from faster_whisper import WhisperModel


def load_audio(path, rate=16000):
    # decodificamos con ffmpeg (evita depender de la versión de PyAV)
    raw = subprocess.run(
        ["ffmpeg", "-nostdin", "-v", "error", "-i", path, "-f", "f32le", "-ac", "1", "-ar", str(rate), "-"],
        check=True, capture_output=True,
    ).stdout
    return np.frombuffer(raw, dtype=np.float32)


req = json.load(sys.stdin)
model = WhisperModel(req.get("model", "small"), device="cpu", compute_type="int8")
out = []
for item in req["items"]:
    segments, info = model.transcribe(
        load_audio(item["file"]),
        language="es",
        word_timestamps=True,
        initial_prompt=(item.get("prompt") or "")[:900] or None,  # el texto esperado guía el reconocimiento
        beam_size=5,
        vad_filter=False,
        condition_on_previous_text=False,
    )
    words = [
        {"w": w.word.strip(), "s": round(w.start, 3), "e": round(w.end, 3), "p": round(w.probability, 3)}
        for seg in segments
        for w in (seg.words or [])
    ]
    out.append({"file": item["file"], "words": words, "duration": round(info.duration, 3)})
    print(f"alineado {item['file']}", file=sys.stderr, flush=True)
json.dump(out, sys.stdout, ensure_ascii=False)
