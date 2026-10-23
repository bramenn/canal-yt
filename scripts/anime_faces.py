#!/usr/bin/env python3
"""Detecta caras de anime en un tramo de vídeo (o en una imagen) para encuadrar el recorte vertical 9:16.

Uso: anime_faces.py <archivo> <inicio_s> <duracion_s> [paso_s]
Salida (JSON por stdout): {"w": ancho, "h": alto, "samples": [{"t": seg_relativo, "faces": [[cx, cy, size], ...]}]}
Las coordenadas van normalizadas 0-1 sobre el fotograma original; size = lado de la cara / alto del fotograma.
"""
import json
import os
import sys

import cv2

HERE = os.path.dirname(os.path.abspath(__file__))
CASCADE = os.environ.get('ANIMEFACE_CASCADE') or os.path.join(HERE, '..', '.tools', 'animeface', 'lbpcascade_animeface.xml')


def detect(det, frame):
    h, w = frame.shape[:2]
    scale = 640.0 / w if w > 640 else 1.0
    small = cv2.resize(frame, (int(w * scale), int(h * scale))) if scale != 1.0 else frame
    gray = cv2.equalizeHist(cv2.cvtColor(small, cv2.COLOR_BGR2GRAY))
    sh = small.shape[0]
    found = det.detectMultiScale(gray, scaleFactor=1.05, minNeighbors=3, minSize=(max(16, sh // 28), max(16, sh // 28)))
    out = []
    for (x, y, fw, fh) in found:
        out.append([round((x + fw / 2) / small.shape[1], 4), round((y + fh / 2) / sh, 4), round(fh / sh, 4)])
    # las más grandes primero (el protagonista del plano)
    out.sort(key=lambda f: -f[2])
    return out[:4]


def main():
    path = sys.argv[1]
    start = float(sys.argv[2]) if len(sys.argv) > 2 else 0.0
    dur = float(sys.argv[3]) if len(sys.argv) > 3 else 0.0
    step = float(sys.argv[4]) if len(sys.argv) > 4 else 0.2
    det = cv2.CascadeClassifier(CASCADE)
    if det.empty():
        raise SystemExit('No se pudo cargar la cascada de caras de anime')
    if os.path.splitext(path)[1].lower() in ('.jpg', '.jpeg', '.png', '.webp', '.img', '.bmp'):
        img = cv2.imread(path)
        if img is None:
            raise SystemExit('Imagen ilegible')
        print(json.dumps({'w': img.shape[1], 'h': img.shape[0], 'samples': [{'t': 0, 'faces': detect(det, img)}]}))
        return
    cap = cv2.VideoCapture(path)
    w, h = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    samples = []
    t = 0.0
    while t <= dur + 1e-6:
        cap.set(cv2.CAP_PROP_POS_MSEC, (start + t) * 1000.0)
        ok, frame = cap.read()
        if not ok:
            break
        samples.append({'t': round(t, 3), 'faces': detect(det, frame)})
        t += step
    cap.release()
    print(json.dumps({'w': w, 'h': h, 'samples': samples}))


if __name__ == '__main__':
    main()
