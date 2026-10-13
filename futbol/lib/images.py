"""Búsqueda de imágenes con ddgs (DuckDuckGo / Bing sin clave).
Uso: images.py <backend> <consulta> [n]   → stdout: JSON [{image, thumbnail, width, height, source, url, title}]
"""
import json
import sys

from ddgs import DDGS

backend, q = sys.argv[1], sys.argv[2]
n = int(sys.argv[3]) if len(sys.argv) > 3 else 24
res = DDGS().images(q, max_results=n, backend=backend, safesearch="moderate")
print(json.dumps([
    {k: r.get(k) for k in ("image", "thumbnail", "width", "height", "source", "url", "title")}
    for r in res
]))
