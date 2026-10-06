// Prompts + JSON Schemas que se pasan a Claude Code (`claude -p --json-schema`).
// La biblia de estilo vive en style/estilo.md (estudiada de las transcripciones de style/referencias/).
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ICONS = ['gpu', 'mac', 'chip', 'server', 'ram', 'model', 'cloud', 'laptop', 'money', 'doc', 'bolt', 'clock'];
export const COLORS = ['white', 'red', 'yellow', 'blue'];
export const SCENE_TYPES = [
  'title', 'stat', 'price', 'compare', 'versus', 'list', 'showcase',
  'stairs', 'quote', 'wait', 'terminal', 'calc', 'grid', 'analogy', 'verdict', 'cta',
];

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const STYLE_FILE = path.join(ROOT, 'style', 'estilo.md');
export const loadStyle = () => (existsSync(STYLE_FILE) ? readFileSync(STYLE_FILE, 'utf8') : '');

const SCENE_GUIDE = `
## ESCENAS ANIMADAS (motor propio, lienzo 16:9)
El vídeo alterna composiciones sobrias tipo infografía (titular pequeño arriba con UNA palabra clave en amarillo, píldoras monoespaciadas, tags con cifras, iconos).
LA IMAGEN SIGUE A LA VOZ. Nada puede quedarse quieto más de ~6 segundos:
- Cambia de escena cada 4-8 segundos de narración (~12-24 palabras). Un segmento de 40 s lleva 5-8 escenas.
- "cue" = las primeras 3-6 palabras EXACTAS (copiadas literal, sin asteriscos) de la frase donde aparece la escena. La primera escena de cada segmento puede tener cue vacío.
- En escenas con items (compare, list, calc, showcase, stairs, analogy, versus), CADA item lleva su propio "cue": las 2-5 palabras EXACTAS de la narración en las que se nombra ese elemento, en orden. Así cada barra, paso o punto aparece justo cuando se dice. Escribe la narración para que nombre cada elemento por separado.
- Las palabras con *énfasis* de la narración salen como rótulo animado al decirse: marca 2-4 por párrafo (cifras, conceptos clave, nombres), cortas (1-4 palabras).
Tipos y campos:
- title: lines[] (1-3 líneas MUY cortas en MAYÚSCULAS, color por línea), sticker opcional, icon opcional. Afirmaciones rotundas, apertura de bloque.
- stat: lines[0] = etiqueta corta, value = cifra grande ("6X", "380 GB", "31 MIN"), caption = aclaración.
- price: icon + sticker{label,value} con el precio; lines[0] opcional; caption opcional.
- compare: lines[0] = título; items[] (2-6) con label, value (número para la barra), display (texto), highlight.
- versus: lines[0] opcional; items[0] e items[1] con label, icon, display. Flecha entre ambos.
- list: lines[0] = título; items[] (2-5) con label y note. Ideal para "punto de control" y quiz final.
- showcase: items[] (1-3) con icon, label, display; highlight resalta uno. Presentar hardware/modelos.
- stairs: items[] (3-6) en escalera (generaciones/versiones); highlight = el que rompe la tendencia.
- quote: quote{text, source, votes?} — lo que dijo la comunidad/paper/README. *palabras* clave en amarillo. Parafrasea si no es literal.
- wait: lines[] de 2 líneas tipo "ESPERA..." / "¿QUÉ?" para giros y "la cifra engaña".
- terminal: code = comando(s) y salida (máx. 8 líneas), caption opcional.
- calc: lines[0] = título; items[] = pasos: label = la operación ("1.299 $ ÷ 200 $/mes"), display = resultado ("≈ 6,5 MESES"). El último es el resultado.
- grid: SOLO para proporciones. lines[0] = título ("SOLO CABE 1 DE CADA 4"), value = proporción ("1/4" o "72%"), caption.
- analogy: lines[0] = título de la analogía ("LA COCINA DE UN RESTAURANTE"); items[] (2-4): label = elemento de la analogía ("ENCIMERA"), display = lo real ("VRAM"), note = rasgo ("pequeña · rapidísima").
- verdict: lines[] (veredicto rotundo), mood = positive|negative|neutral, icon, sticker opcional.
- cta: lines[] (la pregunta para comentarios, corta), caption.
Colores de línea: white, red, yellow, blue. Amarillo = la palabra clave; rojo = alerta/coste; azul = dato neutro.
Textos de escena: ultra cortos (se leen en 1 segundo). display y value: máximo ~12 caracteres ("≈ 260 DÍAS", "35 TOK/S"); los matices van en caption o note. Usa "analogy" cuando el guion use una analogía, "calc" cuando haga cuentas, "list" para el punto de control y el quiz, "quote" para lo que dice la comunidad.
`;

const DIDACTIC = `
## DIDÁCTICA (prioridad máxima: que se entienda a la primera, sin perder el estilo)
Basado en los principios de aprendizaje multimedia de Mayer (coherencia, señalización, segmentación, pre-entrenamiento, personalización).
- MENOS datos, MEJOR explicados. Como máximo 1-2 cifras nuevas por párrafo. Si tienes 5 cifras, elige las 2 que cambian la decisión; el resto puede ir solo en pantalla o fuera.
- Cada cifra se traduce a algo que se siente: tiempo de espera, meses de suscripción, "como X veces tu PC". Nunca una cifra sola.
- Pre-entrenamiento: antes de usar un concepto (VRAM, cuantizar, tokens por segundo, prefill...), defínelo en una frase sencilla. Solo los conceptos que el vídeo necesita.
- Orden concreto → abstracto: primero el ejemplo cotidiano o la escena, después la regla.
- Señaliza la estructura: anuncia los pasos ("te lo cuento en tres pasos"), marca las transiciones ("primero…", "ahora viene lo importante…", "y esto nos lleva a…").
- Segmenta: bloques de 30-60 s con UNA idea cada uno, y una frase-resumen al cerrar el bloque ("O sea: …").
- Repite la idea clave con otras palabras al menos una vez (dicha de forma distinta, no copiada).
- Respira: frases de 8-18 palabras, una idea por frase, pausas "..." después de cada cifra importante y antes de un giro. Nada de encadenar subordinadas ni listas largas habladas.
- Habla a una persona ("tú", "tu tarjeta"), con preguntas que anticipen la duda del espectador ("¿y esto qué significa para tu PC?").
- La pantalla complementa a la voz: muestra la cifra o el esquema, no el mismo texto que se dice.
- Prueba final: si alguien que no sabe nada de IA no podría repetir la idea de un bloque con sus palabras, ese bloque tiene demasiada información.
`;

const ORIGINALITY = `
## ORIGINALIDAD (obligatorio)
- Imita el OFICIO (estructura, ritmo, recursos), nunca las frases. Prohibido reutilizar cualquier secuencia de 5 o más palabras seguidas de las transcripciones de referencia o de los ejemplos de esta biblia.
- Frases-firma del canal de referencia que NO puedes usar ni parafrasear de cerca: "una codicia muy concreta", "la vocecita", "la pregunta del impulso", "la de tu dinero", "Esto es para vosotros", "la cuenta cabe en una servilleta", "la cifra es correcta y a la vez engaña", "Espero que esto te haya ahorrado una compra", "un plan de amortización para tus tataranietos", "es un ejemplo tonto, pero lo de verdad funciona así".
- Inventa en cada vídeo tus propias imágenes, analogías y remates, con la voz de este canal. Si una frase te sale "de memoria", reescríbela.
`;

const VERACITY = `
## VERACIDAD
- Investiga con WebSearch/WebFetch antes de afirmar cifras recientes (precios, specs, benchmarks, fechas). Fecha exacta de cada dato.
- Si una cifra es estimación o cuenta tuya, dilo ("la cuenta es mía", "aproximadamente", "es impresión mía, no un dato").
- Nunca inventes citas literales, mediciones ni benchmarks; parafrasea lo que dijo la comunidad y pon las fuentes en "sources".
`;

export function systemPrompt({ variant = 'es-ES' } = {}) {
  const lang = variant === 'es-LATAM'
    ? '\n## VARIANTE DE IDIOMA\nEscribe en español latinoamericano neutro: "ustedes" en vez de "vosotros", "cuéntenme", "computadora/PC", sin modismos de España. Conserva todo lo demás del estilo.\n'
    : '\n## VARIANTE DE IDIOMA\nEspañol de España, como el canal de referencia (vosotros/os/contádmelo + tú al espectador individual).\n';
  return `Eres el guionista jefe y director de arte de un canal de YouTube en español sobre IA (IA local, hardware para IA, modelos abiertos y cerrados, costes reales).
Imitas el estilo del canal de referencia, que se ha estudiado a partir de sus transcripciones y fotogramas. Esta es la biblia de estilo:

${loadStyle()}
${lang}${DIDACTIC}${SCENE_GUIDE}${ORIGINALITY}${VERACITY}`;
}

const line = {
  type: 'object',
  properties: { text: { type: 'string' }, color: { type: 'string', enum: COLORS } },
  required: ['text', 'color'],
};
const sticker = {
  type: 'object',
  properties: { label: { type: 'string' }, value: { type: 'string' } },
  required: ['label', 'value'],
};
const source = {
  type: 'object',
  properties: { title: { type: 'string' }, url: { type: 'string' } },
  required: ['title', 'url'],
};

export const THUMB_SCHEMA = {
  type: 'object',
  properties: {
    lines: { type: 'array', items: line, minItems: 1, maxItems: 3 },
    sticker,
    icon: { type: 'string', enum: ICONS },
    icon2: { type: 'string', enum: [...ICONS, 'none'] },
    layout: { type: 'string', enum: ['left', 'top', 'arrow'] },
  },
  required: ['lines', 'sticker', 'icon', 'layout'],
};

export const SCENE_SCHEMA = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: SCENE_TYPES },
    cue: { type: 'string' },
    lines: { type: 'array', items: line },
    sticker,
    icon: { type: 'string', enum: ICONS },
    value: { type: 'string' },
    caption: { type: 'string' },
    mood: { type: 'string', enum: ['positive', 'negative', 'neutral'] },
    code: { type: 'string' },
    quote: {
      type: 'object',
      properties: { text: { type: 'string' }, source: { type: 'string' }, votes: { type: 'string' } },
      required: ['text', 'source'],
    },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          cue: { type: 'string' },
          value: { type: 'number' },
          display: { type: 'string' },
          note: { type: 'string' },
          icon: { type: 'string', enum: ICONS },
          highlight: { type: 'boolean' },
        },
        required: ['label'],
      },
    },
  },
  required: ['type', 'cue'],
};

export const SEGMENT_SCHEMA = {
  type: 'object',
  properties: {
    section: { type: 'string', enum: ['HOOK', 'CONTEXTO', 'DATOS', 'GIRO', 'VEREDICTO', 'CIERRE'] },
    narration: { type: 'string' },
    scenes: { type: 'array', items: SCENE_SCHEMA, minItems: 1, maxItems: 10 },
  },
  required: ['section', 'narration', 'scenes'],
};

export const TOPICS_SCHEMA = {
  type: 'object',
  properties: {
    topics: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          formula: { type: 'string' },
          hook: { type: 'string' },
          why_now: { type: 'string' },
          key_facts: { type: 'array', items: { type: 'string' } },
          audience_question: { type: 'string' },
          score: {
            type: 'object',
            properties: {
              total: { type: 'number' }, demand: { type: 'number' },
              novelty: { type: 'number' }, fit: { type: 'number' },
            },
            required: ['total', 'demand', 'novelty', 'fit'],
          },
          thumbnail: THUMB_SCHEMA,
          sources: { type: 'array', items: source },
        },
        required: ['title', 'formula', 'hook', 'why_now', 'key_facts', 'score', 'thumbnail', 'sources'],
      },
    },
  },
  required: ['topics'],
};

export const VIDEO_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    alt_titles: { type: 'array', items: { type: 'string' } },
    description: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    thumbnail: THUMB_SCHEMA,
    alt_thumbnails: { type: 'array', items: THUMB_SCHEMA },
    segments: { type: 'array', items: SEGMENT_SCHEMA, minItems: 5 },
    sources: { type: 'array', items: source },
  },
  required: ['title', 'alt_titles', 'description', 'tags', 'thumbnail', 'segments', 'sources'],
};

const today = () => new Date().toISOString().slice(0, 10);

export function topicsPrompt({ niche, count = 8, avoid = [], extra = '' }) {
  return `Fecha de hoy: ${today()}.
Tarea: encuentra ${count} temas de vídeo NUEVOS para el canal sobre: ${niche || 'IA local, hardware para IA, modelos abiertos, costes de la IA, Claude/OpenAI/DeepSeek/Qwen'}.

Proceso:
1. Usa WebSearch varias veces (al menos 5 búsquedas distintas) para ver qué ha pasado en los últimos 7-14 días: lanzamientos de modelos, benchmarks, precios de GPU/RAM/Mac, cambios de planes y precios de APIs, polémicas, herramientas nuevas (ollama, llama.cpp, MLX, vLLM, LM Studio), hilos virales en Hacker News o r/LocalLLaMA, modelos en tendencia en Hugging Face.
2. Prioriza temas donde se puedan hacer CÁLCULOS concretos y que respondan una pregunta de dinero o decisión que el espectador ya se hace (¿me lo compro?, ¿cuánto cuesta?, ¿sustituye a mi plan?, ¿el titular es verdad?). Ideal: un número viral que se puede matizar o desmontar.
3. Para cada tema, escribe el título con las fórmulas del canal y diseña la miniatura (2-4 palabras, pegatina con cifra, objeto). En hook escribe la primera frase del vídeo tal como se diría (escena concreta o idea viral).
4. Puntúa de 0 a 100: demand (interés/búsqueda), novelty (frescura), fit (encaje con el canal); total = media ponderada (demand 40%, novelty 35%, fit 25%).
5. key_facts: 3-6 datos verificados con cifra, útiles para el guion. sources: las URLs reales que consultaste.
${avoid.length ? `\nEvita repetir estos temas ya hechos:\n- ${avoid.join('\n- ')}\n` : ''}${extra ? `\nIndicaciones extra del creador: ${extra}\n` : ''}
Ordena de mayor a menor score.total.`;
}

export const WPM = 180; // ritmo medido en los vídeos de referencia (≈180 palabras/min)

export function scriptPrompt({ topic, minutes = 14, notes = '', channel = '' }) {
  const words = Math.round(minutes * WPM);
  return `Fecha de hoy: ${today()}.
Escribe el vídeo completo (guion para teleprompter + escenas animadas + miniaturas + metadatos) para este tema:

${JSON.stringify(topic, null, 2)}

Duración objetivo: ${minutes} minutos ≈ ${words} palabras de narración en total (±10%). Reparte en 8-16 segmentos.
${channel ? `Nombre del canal: ${channel}.\n` : ''}${notes ? `Notas del creador (prioridad alta): ${notes}\n` : ''}
Proceso:
1. Calibra el estilo: lee con Read al menos 2 transcripciones de la carpeta referencias/ (elige las más parecidas al tema). Fíjate en el arranque, las analogías, el punto de control, cómo hace las cuentas y el cierre. NO copies frases (lee la sección ORIGINALIDAD): imita el oficio con palabras tuyas.
2. Investiga con WebSearch/WebFetch: confirma cada cifra (specs, precios actuales, benchmarks, fechas). Mínimo 5 búsquedas. Busca también qué dice la comunidad (Reddit, Hacker News, X).
3. Diseña el arco con las secciones HOOK → CONTEXTO → DATOS → GIRO → VEREDICTO → CIERRE (puedes repetir DATOS/GIRO). Debe incluir: una escena inicial concreta con fecha u hora; "lo que no sabemos"; un momento "primero quiero ser justo"; una analogía larga con un ejemplo inventado de números pequeños; un punto de control; las cuentas en voz alta traducidas a tiempo o dinero; el contraargumento honesto; una recomendación por perfil; una regla corta para recordar; y la vuelta a la escena inicial al final.
4. Narración para leer en voz alta siguiendo la sección DIDÁCTICA: una idea por bloque, máximo 1-2 cifras nuevas por párrafo, cada cifra traducida a algo tangible, frases de 8-18 palabras, mini-resumen al cerrar cada bloque. *énfasis* con asteriscos (2-4 por párrafo), "..." para pausas, párrafos separados con \\n. Es mejor explicar bien 3 ideas que mencionar 10.
5. Escenas variadas sincronizadas con "cue" (no repitas tipo dos veces seguidas), una cada 4-8 s, con "cue" también en cada item.
6. thumbnail = la mejor miniatura; alt_thumbnails = 2 alternativas con otro ángulo. title con las fórmulas del canal; alt_titles = 4 alternativas.
7. description: 3-5 líneas + capítulos (00:00 …) calculados a ${WPM} palabras/min. tags: 10-15.`;
}

export const DENSIFY_SCHEMA = {
  type: 'object',
  properties: {
    segments: {
      type: 'array',
      items: {
        type: 'object',
        properties: { index: { type: 'number' }, scenes: { type: 'array', items: SCENE_SCHEMA, minItems: 1, maxItems: 10 } },
        required: ['index', 'scenes'],
      },
    },
  },
  required: ['segments'],
};

/** Redistribuye/añade escenas a un guion ya escrito SIN tocar la narración. */
export function densifyPrompt(video, indices = null) {
  const pick = Array.isArray(indices) && indices.length ? new Set(indices) : null;
  const segs = video.segments
    .map((s, i) => ({ index: i, section: s.section, narration: s.narration, escenas_actuales: s.scenes }))
    .filter((s) => !pick || pick.has(s.index));
  const context = pick ? `\nContexto (segmentos vecinos, NO los devuelvas): ${video.segments.map((s, i) => (pick.has(i - 1) || pick.has(i + 1)) && !pick.has(i) ? `[${i}] ${s.section}: ${String(s.narration).slice(0, 160)}…` : '').filter(Boolean).join(' | ')}\n` : '';
  return `Este vídeo ya tiene la narración cerrada, pero las escenas animadas se quedan quietas demasiado tiempo mientras la voz sigue hablando.
Reescribe SOLO las escenas de cada segmento para que la imagen siga a la voz (lee la sección "LA IMAGEN SIGUE A LA VOZ"):
- Una escena cada 4-8 segundos (~12-24 palabras de narración). Conserva las escenas actuales que funcionen y añade las que falten entre medias.
- "cue" de cada escena y de cada item copiado LITERAL de la narración (sin asteriscos), en el orden en que se dice.
- Aprovecha cada cifra, comparación, lista, analogía o cita de la narración para una escena que la muestre al decirse.
- No cambies la narración ni el número de segmentos.

Título: ${video.title}
${context}
${JSON.stringify(segs, null, 1)}

Devuelve "segments" con el mismo "index" y las escenas nuevas en "scenes".`;
}

export const PUBLISH_SCHEMA = {
  type: 'object',
  properties: {
    titles: {
      type: 'array', minItems: 4, maxItems: 6,
      items: { type: 'object', properties: { title: { type: 'string' }, angle: { type: 'string' }, why: { type: 'string' } }, required: ['title', 'angle', 'why'] },
    },
    description_hook: { type: 'string' },
    description_body: { type: 'string' },
    chapters: {
      type: 'array',
      items: { type: 'object', properties: { segment: { type: 'number' }, title: { type: 'string' } }, required: ['segment', 'title'] },
    },
    tags: { type: 'array', items: { type: 'string' } },
    hashtags: { type: 'array', items: { type: 'string' } },
    pinned_comment: { type: 'string' },
    thumbnail_advice: { type: 'string' },
  },
  required: ['titles', 'description_hook', 'description_body', 'chapters', 'tags', 'hashtags', 'pinned_comment', 'thumbnail_advice'],
};

/** Paquete de publicación: título(s) que hablan con la miniatura, descripción, capítulos, etiquetas. */
export function publishPrompt({ video, thumbnail, segments, channel = '', variant = 'es-ES' }) {
  const thumbText = [...(thumbnail?.lines ?? []).map((l) => l.text), thumbnail?.sticker ? `${thumbnail.sticker.label} ${thumbnail.sticker.value}` : ''].filter(Boolean).join(' / ');
  return `El vídeo ya está terminado. Prepara su publicación en YouTube.
Canal: ${channel || 'canal de IA en español'} · Español: ${variant === 'es-LATAM' ? 'latinoamericano neutro' : 'de España'}
Título de trabajo: ${video.title}
Texto de la MINIATURA (lo que el espectador ya verá en la imagen): "${thumbText}" · objeto: ${thumbnail?.icon ?? '-'}

Segmentos (índice, sección, duración real, de qué va):
${segments.map((s) => `[${s.index}] ${s.section} · ${s.secs} s · ${s.summary}`).join('\n')}

Fuentes usadas: ${(video.sources ?? []).map((s) => s.title).join('; ') || 'ninguna'}

BUENAS PRÁCTICAS (síguelas todas):
TÍTULOS (5):
- Título + miniatura son un paquete: el título NO repite las palabras de la miniatura; la complementa (la miniatura da la emoción o la cifra; el título da el tema y la pregunta). Cuenta como fallo repetir 2 o más palabras de la miniatura.
- La palabra clave que la gente buscaría (modelo, producto, "IA local", etc.) en las primeras palabras. Lo esencial dentro de los primeros ~50 caracteres (es lo que se ve en móvil); total idealmente 45-65, nunca más de 100.
- Curiosidad honesta: promete exactamente lo que el vídeo cumple (nada de clickbait falso). Cifra concreta si la hay.
- Usa las fórmulas del canal (coste, advertencia, sustitución, resolución, multiplicador, ranking, benchmark, explicado). Title Case moderado, sin todo en mayúsculas, sin emojis.
- Cinco ángulos distintos (p. ej. pregunta, advertencia, cifra, comparación, resultado). Ordénalos del más fuerte al menos. En "why" explica en una frase cómo encaja con la miniatura.
DESCRIPCIÓN:
- description_hook: 1-2 frases (≤150 caracteres) que se ven antes de "más": la promesa del vídeo con la palabra clave. Sin repetir el título literal.
- description_body: 2-4 párrafos cortos: qué vas a entender, para quién es, qué cifras se calculan. Natural, sin relleno SEO. Sin capítulos, sin fuentes, sin hashtags (los añade la app).
CAPÍTULOS: agrupa segmentos en 4-8 capítulos con títulos cortos (2-6 palabras) y descriptivos. "segment" = índice del segmento donde empieza. El primero empieza en el segmento 0. Cada capítulo debe durar al menos 15 s.
ETIQUETAS: 10-15, que sumen menos de 450 caracteres. YouTube les da un papel menor: usa la palabra clave principal, variantes, nombres de producto y faltas de ortografía comunes. Sin "#".
HASHTAGS: 3, cortos, relevantes, sin "#".
COMENTARIO FIJADO: una pregunta concreta que invite a responder (como el CTA del vídeo), 1-2 frases.
thumbnail_advice: si la miniatura y el mejor título se pisan o la miniatura no encaja con el ángulo, di qué cambiar (1-2 frases); si encajan, dilo.`;
}

export const SHORTS_SCHEMA = {
  type: 'object',
  properties: {
    clips: {
      type: 'array', minItems: 3, maxItems: 5,
      items: {
        type: 'object',
        properties: {
          start: { type: 'number' }, end: { type: 'number' },
          hook_text: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' },
          hashtags: { type: 'array', items: { type: 'string' } }, why: { type: 'string' }, score: { type: 'number' },
        },
        required: ['start', 'end', 'hook_text', 'title', 'description', 'hashtags', 'why', 'score'],
      },
    },
  },
  required: ['clips'],
};

/** Elige los mejores momentos del vídeo largo para Shorts (rangos de frases con tiempos reales). */
export function shortsPrompt({ title, sentences, channel = '', variant = 'es-ES' }) {
  return `Del vídeo "${title}" (canal ${channel || 'de IA en español'}, español ${variant === 'es-LATAM' ? 'latinoamericano' : 'de España'}) hay que sacar Shorts verticales que lleven gente al vídeo completo.
Estas son sus frases numeradas con su tiempo real (inicio–fin en segundos):
${sentences.map((s) => `[${s.i}] ${s.t0.toFixed(1)}–${s.t1.toFixed(1)} · ${s.text}`).join('\n')}

Elige los 3-5 MEJORES momentos. Cada clip es un rango CONTINUO de frases (start = índice de la primera, end = índice de la última, incluida):
- Duración entre 20 y 55 s (ideal 25-45 s). Calcula con los tiempos.
- Se entiende SOLO, sin haber visto el vídeo: no empieza con conectores que necesiten contexto ("Y", "Pero", "Entonces", "O sea", "Esto", "Eso") ni con referencias a algo anterior.
- La PRIMERA frase es un gancho: una cifra sorprendente, una pregunta, una afirmación que choca o un problema concreto. Los 3 primeros segundos deciden si se queda.
- Termina en un remate (la respuesta, la cifra final, el giro), no a mitad de idea. Si el final enlaza bien con el principio para verse en bucle, mejor.
- Momentos distintos entre sí (no solapados), priorizando cuentas sorprendentes, giros ("pero ojo…"), comparaciones de precio y veredictos.
Para cada clip:
- hook_text: texto grande en pantalla durante todo el short, 3-7 palabras en mayúsculas, con la *palabra clave* entre asteriscos. Complementa a lo que se dice, no lo repite.
- title: título del Short, ≤ 60 caracteres, curiosidad honesta con la palabra clave al principio. Sin emojis.
- description: 1-2 frases + "Vídeo completo en el canal." (el enlace se pone como "vídeo relacionado" en YouTube Studio).
- hashtags: 3 (sin #), el primero "shorts".
- why: por qué puede funcionar (1 frase). score: 0-100.
Ordena de mayor a menor score.`;
}

export function refinePrompt({ segment, instruction, context }) {
  return `Estás editando UN segmento de un vídeo ya escrito.
Contexto del vídeo: ${context}

Segmento actual:
${JSON.stringify(segment, null, 2)}

Instrucción del creador: ${instruction || 'Mejóralo: más ritmo, más concreto, mejores escenas.'}

Devuelve el segmento reescrito completo (misma "section" salvo que la instrucción diga otra cosa). Si necesitas verificar una cifra, usa WebSearch.`;
}
