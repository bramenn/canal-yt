# Sonido: qué dice la evidencia y qué reglas aplica el motor

## Lo que dice la evidencia
- **La calidad del audio cambia la credibilidad.** Con el mismo contenido, el audio malo hace que se perciba al ponente como menos inteligente y su trabajo como menos importante (Newman & Schwarz, *Science Communication*, 2018). La prioridad es una voz limpia y a buen volumen.
- **En vídeos explicativos, lo que sobra estorba.** Moreno & Mayer (2000, *Journal of Educational Psychology*) añadieron música de fondo y efectos —incluso efectos relacionados con lo que se explicaba— a explicaciones narradas. La música empeoró la retención y la comprensión en los dos experimentos, los efectos en uno, y la combinación fue lo peor. Es el **principio de coherencia** de Mayer (d ≈ 0,70): se aprende mejor sin sonidos ni músicas que no ayudan a entender.
- **Sonido e imagen a la vez se perciben como un solo evento** («síncresis», Michel Chion). Un efecto exactamente en el corte o en la entrada de un dato le da peso; un efecto suelto, sin evento visual, solo añade ruido.
- **La repetición cansa.** El mismo sonido una y otra vez produce fatiga. Funciona usar pocos sonidos, variantes alternas y pequeñas variaciones de tono.
- **YouTube normaliza a unos -14 LUFS**: baja lo que está más alto, pero no sube lo que está más bajo. Máster recomendado: unos -14/-15 LUFS integrados, con picos por debajo de -1 dBTP.
- **Música bajo la voz**: la guía habitual de mezcla es dejarla 15-20 dB por debajo mientras se habla y subirla solo en los huecos (ducking con ataque ~20-50 ms y liberación ~400-600 ms).

## Lo que hace el canal de referencia (medido en 2 vídeos)
- Máster a **-15 LUFS**, con muy poco rango dinámico (LRA ≈ 3 LU).
- En el vídeo de estilo infografía hay un **fondo continuo unos 20 dB por debajo de la voz** (en las pausas nunca baja de -41 dBFS). En el de estilo pizarra prácticamente no hay fondo (en las pausas cae a -62 dBFS).

## Reglas del motor (`public/js/engine/audio.js`)
| Evento visual | Sonido | Notas |
|---|---|---|
| Cambio de escena | Transición (whoosh) | 0,12 s antes del corte, para que el barrido lo cruce |
| Elemento que entra al nombrarse | Elemento (pop) | Solo si tiene `cue`; nunca en ráfaga |
| Rótulo de palabra clave | Rótulo (tick) | Es el más bajo de todos (-8 dB) |
| Giro «ESPERA…» / veredicto | Golpe | El veredicto, 5 dB más suave |
| Resultado de una cuenta o cifra grande | Resultado (ding) | Cuando el número se fija |
| Escena de terminal | Teclado | Es el fondo de su escena y dura lo que el tecleo |

- **Separación mínima** entre efectos: Sutil 1,6 s · Normal 0,9 s · Marcado 0,55 s. Si dos chocan, gana el de más prioridad (golpe > transición > resultado > elemento > rótulo).
- **Tope por minuto**: Sutil 8 · Normal 14 · Marcado 22.
- Los efectos que caen **mientras se habla suenan 4 dB más bajos**.
- **Variedad**: hasta 3 variantes por hueco, que se alternan, con ±4 % de tono y ±1,5 dB de volumen.
- **Niveles**: cada sonido se normaliza por RMS (efectos a -18 dBFS y música a -20 dBFS antes de los deslizadores). La voz IA se normaliza a ≈ -17 dBFS RMS, lo que da una mezcla de ≈ -15 LUFS. Lleva un limitador final a -3 dBFS.
- **Música**: -22 dB bajo la voz por defecto, +7 dB en pausas de más de 0,8 s, entrada de 1,5 s y salida de 3 s.

## Licencias (Freesound)
- **CC0**: se puede usar en un canal monetizado sin atribución. Es la opción por defecto.
- **CC BY**: se puede usar en un canal monetizado, **con atribución**. La app genera el texto para la descripción.
- **CC BY-NC y Sampling+**: **excluidas**, porque no permiten uso comercial (y un canal monetizado lo es).
- Las condiciones de la API de Freesound dicen que el uso comercial *de la API* se negocia caso por caso con la UPF, y que solo se guarden las copias necesarias. Para ir con total tranquilidad en un canal monetizado, puedes usar la app para buscar y escuchar, y descargar el archivo original desde freesound.org con tu cuenta (o importarlo con «Subir archivo»).
- Para música de fondo, la **Biblioteca de audio de YouTube** está pensada para usarse en YouTube, incluidos vídeos monetizados. Impórtala con «Subir archivo».
