"""Recorta a la persona de una foto (rembg, modelo isnet-general-use) y quita los márgenes transparentes.
Uso: cutout.py <entrada> <salida.png>
"""
import sys

from PIL import Image
from rembg import new_session, remove

img = Image.open(sys.argv[1]).convert("RGB")
out = remove(img, session=new_session("isnet-general-use"))
# solo lo opaco de verdad cuenta para el encuadre (evita bordes casi invisibles)
box = out.getchannel("A").point(lambda a: 255 if a > 40 else 0).getbbox()
if box:
    out = out.crop(box)
out.save(sys.argv[2])
print(f"{out.width}x{out.height}")
