"""Transcribe un audio largo (un episodio de podcast) con faster-whisper, con el tiempo de cada palabra.
Uso: transcribe.py <audio> <salida.json> [modelo]
Salida: [{"s": inicio, "e": fin, "t": texto, "w": [[palabra, inicio, fin], ...]}, ...]
Por stderr va el avance: "avance <segundos transcritos> <duración total>".
"""
import json
import subprocess
import sys

import numpy as np
from faster_whisper import WhisperModel

src, dst = sys.argv[1], sys.argv[2]
model_name = sys.argv[3] if len(sys.argv) > 3 else "small"

# decodificamos con ffmpeg (no depende de la versión de PyAV)
raw = subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-i", src, "-f", "f32le", "-ac", "1", "-ar", "16000", "-"],
                     check=True, capture_output=True).stdout
audio = np.frombuffer(raw, dtype=np.float32)
total = len(audio) / 16000

model = WhisperModel(model_name, compute_type="int8")
segments, _ = model.transcribe(audio, language="es", word_timestamps=True, vad_filter=True, beam_size=1)
out = []
for s in segments:
    out.append({"s": round(s.start, 2), "e": round(s.end, 2), "t": s.text.strip(),
                "w": [[w.word.strip(), round(w.start, 2), round(w.end, 2)] for w in (s.words or [])]})
    print(f"avance {s.end:.0f} {total:.0f}", file=sys.stderr, flush=True)
with open(dst, "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False)
print(f"listo {len(out)} frases", file=sys.stderr, flush=True)
