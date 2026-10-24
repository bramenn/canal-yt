"""Diálogo de un episodio con tiempos, traducido al inglés por faster-whisper (para episodios con subtítulos en imagen).
Uso: translate.py audio.wav [modelo]  →  stdout JSON: [{"s": 12.3, "e": 15.0, "text": "..."}]
"""
import json
import subprocess
import sys

import numpy as np
from faster_whisper import WhisperModel

# decodificamos con ffmpeg, como align.py (la versión de PyAV instalada no encaja con faster-whisper)
raw = subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-i", sys.argv[1], "-f", "f32le", "-ac", "1", "-ar", "16000", "-"], check=True, capture_output=True).stdout

model = WhisperModel(sys.argv[2] if len(sys.argv) > 2 else "small", device="cpu", compute_type="int8")
segments, _ = model.transcribe(np.frombuffer(raw, dtype=np.float32), language="ja", task="translate", vad_filter=True, beam_size=1, condition_on_previous_text=False)
print(json.dumps([{"s": round(s.start, 2), "e": round(s.end, 2), "text": s.text.strip()} for s in segments if s.text.strip()]))
