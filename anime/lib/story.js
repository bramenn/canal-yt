// Historias y guiones de los shorts de anime, al estilo de AniDosis (curiosidades contadas con gancho y humor).
// 1) findStories: la IA busca en la web noticias y curiosidades de anime recientes y elige las de más gancho.
// 2) writeScript: guion de ~50 s (gancho, «el problema es que…», explicación, remate), palabras a resaltar
//    y qué se ve en cada frase (escenas del anime o una imagen).
import { claudeStep } from '../../lib/claude.js';

/** Normaliza el nombre del anime a su franquicia principal para controlar la rotación y variedad. */
export function franchiseOf(name = '') {
  const n = String(name).toLowerCase().trim();
  if (n.includes('dragon ball') || n.includes('goku') || n.includes('vegeta') || n.includes('beerus')) return 'Dragon Ball';
  if (n.includes('naruto') || n.includes('boruto') || n.includes('shippuden')) return 'Naruto';
  if (n.includes('one piece') || n.includes('luffy') || n.includes('zoro')) return 'One Piece';
  if (n.includes('jujutsu') || n.includes('gojo') || n.includes('sukuna')) return 'Jujutsu Kaisen';
  if (n.includes('demon slayer') || n.includes('kimetsu') || n.includes('tanjiro')) return 'Demon Slayer';
  if (n.includes('bleach') || n.includes('ichigo')) return 'Bleach';
  if (n.includes('chainsaw') || n.includes('denji') || n.includes('makima')) return 'Chainsaw Man';
  if (n.includes('one punch') || n.includes('saitama')) return 'One Punch Man';
  if (n.includes('attack on titan') || n.includes('shingeki') || n.includes('eren') || n.includes('levi')) return 'Attack on Titan';
  if (n.includes('hunter x hunter') || n.includes('hxh') || n.includes('gon') || n.includes('killua')) return 'Hunter x Hunter';
  if (n.includes('my hero academia') || n.includes('boku no hero') || n.includes('deku')) return 'My Hero Academia';
  if (n.includes('death note') || n.includes('light yagami')) return 'Death Note';
  if (n.includes('solo leveling') || n.includes('jinwoo')) return 'Solo Leveling';
  if (n.includes('dan da dan') || n.includes('dandadan')) return 'Dan Da Dan';
  if (n.includes('frieren')) return 'Frieren';
  if (n.includes('spy x family') || n.includes('anya')) return 'Spy x Family';
  if (n.includes('blue lock')) return 'Blue Lock';
  if (n.includes('kaiju no. 8') || n.includes('kaiju 8')) return 'Kaiju No. 8';
  return name.trim();
}

const STORIES_SCHEMA = {
  type: 'object',
  properties: {
    stories: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          anime: { type: 'string' }, angle: { type: 'string' }, facts: { type: 'string' }, sources: { type: 'array', items: { type: 'string' } },
          type: { type: 'string', enum: ['noticia', 'atemporal'] },
          nyaa: { type: 'string' }, episode: { type: 'number' }, moment: { type: 'string' },
          related: { type: 'array', items: { type: 'object', properties: { episode: { type: 'number' }, moment: { type: 'string' } }, required: ['episode', 'moment'] } },
        },
        required: ['anime', 'angle', 'facts', 'sources', 'type', 'nyaa', 'episode', 'moment', 'related'],
      },
    },
  },
  required: ['stories'],
};

export async function findStories({ count = 3, avoid = [], recentFranchises = [], learn = '' }, emit, track) {
  const today = new Date().toISOString().slice(0, 10);
  // medido en YouTube: la noticia del día da un pico de un mes (MAPPA/JJK: 16.656 vistas, todas en mayo); un tema atemporal
  // con título buscable gotea ~1.000 vistas al mes durante un año (Gachiakuta: solo el 11 % el primer mes)
  // medido 14-23 oct: las curiosidades de franquicias gigantes (clones de Naruto: 19.695 vistas, 77 % se queda) son los
  // virales y traen suscriptores; las noticias de nicho se quedan en ~1.000 (35-55 % se queda). Una sola noticia por tanda.
  const timeless = count >= 2 ? count - 1 : 0;
  const ev = await claudeStep({
    prompt: `Hoy es ${today}. Busca en la web (noticias de anime de los últimos 7-10 días: Anime News Network, Crunchyroll News, X/Twitter de estudios, Reddit r/anime, ComicBook, CBR, medios japoneses) y elige las ${count} historias de anime con MÁS gancho (${timeless ? `${count - timeless} noticias y ${timeless} atemporal${timeless > 1 ? 'es' : ''}` : 'noticias'}) para un short de TikTok/YouTube en español al estilo del canal AniDosis.

Lo que funciona en ese estilo (de sus shorts con más de 500.000 vistas): una curiosidad o polémica con un giro gracioso o sorprendente, no una noticia seca.
- «Este anime inventó un ataque tan largo que ningún villano lo soporta»
- «Este nuevo anime te advierte de algo antes de empezar»
- «Esta actriz de voz recibió un personaje MUY extraño»
- «One Piece ocultó una pista clave durante 20 años en un cartel de fondo»
- «Los animadores de MAPPA tuvieron que rehacer este episodio en 48 horas»

REGLAS DE VARIEDAD Y ROTACIÓN ESTRICTAS (OBLIGATORIAS):
1. CERO REPETICIÓN EN LA TANDA: Cada una de las ${count} historias DEBE pertenecer a una franquicia o serie COMPLETAMENTE DIFERENTE. Prohibido incluir dos historias de la misma saga en esta selección.
2. ROTACIÓN Y ENFRIAMIENTO TEMPORAL: Para mantener la frescura del canal y evitar cansar a la audiencia, NO elijas historias de estas franquicias recientemente tratadas: ${recentFranchises.length ? recentFranchises.join(', ') : 'ninguna'}. Explora y rota hacia OTRAS franquicias gigantes (One Piece, Hunter x Hunter, Bleach, Attack on Titan, Solo Leveling, Chainsaw Man, Dan Da Dan, Spy x Family, Frieren, Demon Slayer, Jujutsu Kaisen, Death Note, Vinland Saga, Blue Lock, Kaiju No. 8, etc.) o sorpresas del anime de esta temporada.
3. EQUILIBRIO DE ANALYTICS: Si una franquicia tuvo buen rendimiento en el pasado, tómalo como lección sobre el gancho y el tono narrativo, NUNCA como excusa para saturar el canal con el mismo anime una y otra vez.

Lo que más vistas da (medido en 2026-10 en este canal y en Kudasai, Animelos, Rincón Otaku y Doctor Random), por orden:
1. Franquicias gigantes con noticia oficial (Jujutsu Kaisen, One Piece, Naruto, Demon Slayer, Chainsaw Man, One Punch Man, Bleach…): nuestros únicos shorts de 7.000-16.000 vistas.
2. Regresos y despedidas con nostalgia o polémica: «rompe su silencio tras 9 años», «regresa», «ADIÓS a…», «los animes que NO volverán» (nuestro récord: 31.000 en TikTok).
3. Escándalos y curiosidades con gente real: censura, prohibiciones, fans que colapsan una web, una VTuber de 42 años, un cosplayer, un músico o una marca famosa que se cruza con un anime.
Valen también: récords raros, polémicas de fans, decisiones absurdas de estudios.
REGLA DEL ÁNGULO (medido en 37 shorts, oct-2026): elige historias que se puedan contar como CONTRASTE o PARADOJA («X hace A, pero B»: las espadas dibujan dragones de agua pero no llenan un vaso) o como VERSUS entre personajes famosos. Esos shorts retienen al 68 % y triplican vistas frente a la noticia contada tal cual (57 %). En "angle" escribe ya ese contraste.
Evita: anuncios secos (tráiler, fecha o reparto) de animes poco conocidos (los que menos rinden y los que más se quedan en 0), rumores sin fuente, spoilers enormes sin aviso${avoid.length ? `, y estas historias ya hechas: ${avoid.slice(0, 40).join(' · ')}` : ''}.

${timeless ? `NOTICIA (1, "type": "noticia"): SOLO de una franquicia gigante (nada de animes de nicho, idols, cantantes o series poco conocidas).
ATEMPORALES (${timeless}, "type": "atemporal"): SOLO de franquicias gigantes (One Piece, Naruto, Demon Slayer, Hunter x Hunter, Jujutsu Kaisen, Bleach, Chainsaw Man, Attack on Titan…), un tema que siga interesando dentro de un año a quien lo vea por primera vez: cómo funciona un poder o técnica icónica, el secreto de una pelea memorable, qué revela un episodio clave. OBLIGATORIO: que sea un momento que se VE en un episodio concreto del anime de TV (con su "episode" y "nyaa"), porque el short se monta con las escenas de ese episodio; nada de detalles del autor o del manga que no salgan en pantalla. REGLA: el gancho y el ángulo deben girar en torno a un personaje, técnica o pelea MUY conocidos (Luffy, Naruto, Tanjiro, Gojo, Killua, Levi, Ichigo, Denji…), NUNCA centrados en el nombre propio de un personaje secundario oscuro que nadie busca (si interviene un secundario poco conocido, enfócalo desde lo que hizo el protagonista famoso, p. ej. «Luffy reveló una debilidad que nadie notó en Marineford» en vez de centrarlo en un secundario menor). Datos de fuentes fiables (wiki oficial, el propio anime o manga, entrevistas), sin spoilers del final. Ej. reales que funcionaron: «Naruto Shippuden: cómo los clones aceleraban el entrenamiento de Naruto» (9.200+ vistas en 24 h), «Demon Slayer: por qué Tanjiro no produce agua real con su espada» (6.800+ vistas), «Gachiakuta: el episodio que revela el oscuro pasado de Amo».\n` : ''}
${learn}

Para cada una: "anime" (nombre del anime tal como se busca su tráiler en YouTube, en romaji o inglés), "angle" (el giro gracioso o sorprendente en una frase), "facts" (los datos concretos y verificados: nombres, cifras, fechas, qué pasó exactamente), "sources" (URLs) y "type" ("noticia" | "atemporal").
Si es "atemporal": gira en torno a un momento que se VE en un episodio del anime de TV: "episode" = número de ese episodio comprobado en una wiki (One Piece y Naruto con numeración absoluta; series por temporadas, dentro de la temporada), "nyaa" = título en rōmaji como lo nombran los fansubs en nyaa.si, con la temporada si hace falta («Kimetsu no Yaiba», «Naruto Shippuuden», «Shingeki no Kyojin S3»), "moment" = qué pasa en pantalla, en inglés con los nombres de los subtítulos en inglés, y "related" = [].
Si es "noticia": "episode" = 0 y "moment" vacío, pero si la franquicia tiene anime de TV, "nyaa" = su título en rōmaji como arriba y "related" = 2 episodios FAMOSOS de esa serie (comprobados en una wiki) con un momento icónico cada uno que encaje con la noticia: los personajes, el arco o la obra de los que habla (p. ej. si la noticia es sobre el final de Bleach, la última batalla de Ichigo o su primer episodio). Cada uno: { "episode", "moment" (qué pasa en pantalla, en inglés) }. Sus escenas acompañan a las imágenes de la noticia, que siguen mostrando lo que se cuenta. Sin anime de TV: "nyaa" vacío y "related" = [].`,
    schema: STORIES_SCHEMA, system: 'Eres guionista de un canal de shorts de anime en español. Verificas los datos antes de contarlos.',
    effort: 'medium', tools: ['WebSearch', 'WebFetch'],
  }, emit, track);

  // Filtro de seguridad programático: garantiza que no se repita franquicia en el lote y respeta el enfriamiento
  const rawList = ev.data.stories ?? [];
  const selected = [];
  const blocked = new Set(recentFranchises.map((f) => f.toLowerCase()));
  const batchFranchises = new Set();

  for (const s of rawList) {
    const f = franchiseOf(s.anime).toLowerCase();
    if (!blocked.has(f) && !batchFranchises.has(f)) {
      batchFranchises.add(f);
      selected.push(s);
      if (selected.length === count) break;
    }
  }

  // Si tras excluir las franquicias en enfriamiento no alcanzamos el conteo solicitado, permitimos historias siempre que sean únicas entre sí
  if (selected.length < count) {
    for (const s of rawList) {
      const f = franchiseOf(s.anime).toLowerCase();
      if (!batchFranchises.has(f)) {
        batchFranchises.add(f);
        selected.push(s);
        if (selected.length === count) break;
      }
    }
  }

  return { stories: selected.slice(0, count), cost: ev.cost ?? 0 };
}

const SCRIPT_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    description: { type: 'string' },
    hashtags: { type: 'array', items: { type: 'string' } },
    thumb_text: { type: 'string' },
    thumb_word: { type: 'string' },
    scene_query: { type: 'string' },
    franchise: { type: 'string' },
    yellow: { type: 'array', items: { type: 'string' } },
    red: { type: 'array', items: { type: 'string' } },
    lines: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          show: { type: 'string', enum: ['anime', 'imagen', 'video'] },
          query: { type: 'string' },
          visual: { type: 'string' },
        },
        required: ['text', 'show', 'query', 'visual'],
      },
    },
  },
  required: ['title', 'description', 'hashtags', 'thumb_text', 'thumb_word', 'scene_query', 'franchise', 'yellow', 'red', 'lines'],
};

// duración por plataforma: Shorts premia el % visto (corto); TikTok solo paga (Creator Rewards) vídeos de más de 1 min
const LENGTH = {
  youtube: '38-42 segundos: 105-112 palabras, ni una más (medido: 40-44 s se ven al 61 %, 44 s o más al 49 %; los únicos que la gente repite duran 38-39 s); cada frase tiene que aportar algo nuevo, nada de relleno',
  tiktok: '61-66 segundos: 180-195 palabras, NUNCA menos de 178 (TikTok solo paga los vídeos de más de 1 minuto; se narra a ~2,9 palabras/s sin pausas largas). Usa el tiempo extra para una segunda prueba, consecuencia o dato curioso del mismo caso y un remate mejor; NUNCA metas una sinopsis general del anime para alargar y mantén el mismo ritmo',
};

export async function writeScript(story, emit, track, { platform = 'youtube', more = '', learn = '' } = {}) {
  const ev = await claudeStep({
    prompt: `Escribe el guion de un short vertical de anime (voz en off en español latino, ${LENGTH[platform]}) al estilo de AniDosis.${more ? `\n${more}` : ''}${learn}

Historia: ${story.anime} — ${story.angle}
Datos (no inventes nada más): ${story.facts}${story.type === 'atemporal' ? '\nTema ATEMPORAL: se verá durante meses, así que nada de «hoy», «acaba de», «esta semana» ni fechas relativas; cuéntalo para quien lo descubre ahora.' : ''}

Fórmula de AniDosis:
1. Gancho en la primera frase, que se entiende sin contexto y es un CONTRASTE o PARADOJA que abre una pregunta que solo se responde al final («Demon Slayer tiene espadas que dibujan dragones de agua, pero no te llenan un vaso»; «Dragon Ball puso a Beerus en el título y su actor ni tuvo que volver al micrófono»). NUNCA la noticia contada tal cual («X llegó al cine», «X va a tener…», «X anunció…»): si es una noticia, cuéntala por su contradicción («Yuri!!! on ICE canceló su película… y aun así llegó al cine»). Medido: gancho de contraste = 68 % se queda y 4.100 vistas de mediana; noticia tal cual = 57 % y 1.580. Sus 2-3 PRIMERAS palabras son el nombre más famoso de la historia (Nirvana, Naruto, Toyota, Jujutsu Kaisen…), nunca algo genérico como «Esta cantante» o «Un director» (medido en YouTube: con el nombre famoso delante se queda a verlo el 59 %; con «Esta cantante…», el 42 %).
2. Giro: «El problema es que…» / «Pero hay un detalle…».
3. Explicación con los datos concretos, con un tono cercano y con humor (habla al espectador: «Mira», «Verás», «Y es que…»). PROHIBIDO meter una sinopsis general del anime en las frases centrales (nada de detener la historia para contar «La historia sigue a un joven que…» o «En este anime una chica se enamora de…»: medido en nuestras curvas de retención de YouTube Analytics, entre el 35 % y el 50 % del vídeo se va la mitad de la audiencia cuando el guion se desvía a resumir de qué trata la serie). Cada frase del centro debe avanzar directamente el conflicto, el cómo pasó o el dato curioso del titular.
4. Remate gracioso o sorprendente.
5. Penúltima frase: responde por fin la pregunta que abrió el gancho (la recompensa por quedarse).
6. Última frase: una OPINIÓN FUERTE del narrador, que los fans quieran discutir o defender («Gojo es mejor profesor que Koro-sensei, y no está ni cerca»; «Ese Kamehameha con los pies es lo más inteligente que hizo Goku»), y que enlace con la primera frase para que el vídeo se vea en bucle. Sin inventar datos, sin insultar a nadie, sin despedidas ni «suscríbete». Medido: las preguntas suaves («¿Prefieres X o Y?») dieron 0 comentarios en 156.000 vistas.
Frases cortas y naturales para leer en voz alta; los números escritos en palabras; nombres japoneses tal cual.

Devuelve:
- "title": título al estilo AniDosis, una AFIRMACIÓN (no una pregunta: los títulos con pregunta rinden menos), palabras clave en MAYÚSCULAS, ≤ 70 caracteres, sin el nombre del canal (p. ej. «Este ANIME Se DESPIDIÓ De La MEJOR Manera POSIBLE!»).
- "thumb_text": el texto de la miniatura (primer fotograma): 2-4 palabras en MAYÚSCULAS que despierten curiosidad o emoción sin contarlo todo y que NO repitan el título (juegan juntos: el título da contexto, la miniatura el gancho). Ej.: «NADIE LO SOPORTA», «¿CANCELADO?», «12 MINUTOS GRITANDO». "thumb_word": la palabra de "thumb_text" que va en amarillo.
- "description": 1-2 frases para la descripción del short. "hashtags": 5-8 sin '#'.
- "franchise": el nombre corto de la franquicia para buscar sus tráileres en YouTube («One Piece», «Attack on Titan», «Dragon Ball»), aunque la historia sea de un juego, una colaboración o un spin-off.
- "scene_query": si la historia habla de una escena, pelea, técnica o momento concreto del anime (p. ej. el final de Cyberpunk Edgerunners, el ataque de fantasmas de Gotenks, el entrenamiento de clones de Naruto), pon la búsqueda en inglés para encontrar ese clip exacto en YouTube (p. ej. «Cyberpunk Edgerunners David ending scene», «Dragon Ball Z Gotenks Super Ghost Kamikaze Attack scene»); si es una noticia general donde basta el tráiler del anime, pon "".
- "lines": el guion frase a frase (cada "text" de 4 a 18 palabras, en orden; juntas forman el guion completo). Para cada frase indica:
  * "show": "anime" (escenas del anime; "query" = nombre del anime para buscar su tráiler/PV en YouTube, normalmente "${story.anime}"), "imagen" (una foto específica de algo que se menciona: el director/autor, actor de voz, entrevista, producto, cartel, post o escena puntual; "query" = búsqueda concreta en inglés o español para encontrar exactamente esa imagen) o "video" (un vídeo concreto que no es el tráiler general: un videoclip, anuncio, clip viral, comparativa o escena muy específica; "query" = búsqueda exacta en YouTube de ESE vídeo, sin fechas ni horas, solo nombres: «Rayearth Mokona one minute recap»). Al menos 3 frases deben ser "anime" para que siempre haya escenas del anime.
  * "visual": descripción breve y concreta (4-12 palabras) de QUÉ debe verse exactamente en pantalla y bien encuadrado mientras suena esta frase (p. ej. «primer plano de David sonriendo antes del disparo final», «foto real del director Hiroyuki Imaishi en entrevista», «Gotenks rodeado de sus fantasmas kamikaze», «Lucy sola en la Luna recordando a David»).
  REGLA: cada frase que habla de alguien o algo concreto (una persona real, el creador, un actor, un vídeo, una foto, un producto o una escena exacta) debe pedirlo en "show" ("imagen" o "video") y detallarlo en "visual" para que el editor lo muestre justo en ese momento y bien encuadrado.
- "yellow": 6-12 palabras sueltas del guion que se resaltan en amarillo (nombres, cifras, lo importante). "red": 2-5 palabras que se resaltan en rojo (lo impactante o negativo). Palabras exactas tal como aparecen en el guion.`,
    schema: SCRIPT_SCHEMA, system: 'Eres guionista de shorts virales de anime en español latino.', effort: 'medium', tools: [],
  }, emit, track);
  return { script: ev.data, cost: ev.cost ?? 0 };
}

/** Texto de miniatura para un guion que no lo tiene (shorts hechos antes de las miniaturas). */
export async function thumbText(script, emit, track) {
  const ev = await claudeStep({
    prompt: `Short de anime: «${script.title}». Guion: ${script.lines.map((l) => l.text).join(' ')}

Escribe el texto de su miniatura (primer fotograma): "thumb_text" = 2-4 palabras en MAYÚSCULAS que despierten curiosidad o emoción sin contarlo todo y que NO repitan el título (el título da contexto, la miniatura el gancho). "thumb_word" = la palabra de "thumb_text" que va en amarillo.`,
    schema: { type: 'object', properties: { thumb_text: { type: 'string' }, thumb_word: { type: 'string' } }, required: ['thumb_text', 'thumb_word'] },
    system: 'Eres experto en miniaturas de YouTube.', effort: 'low', tools: [],
  }, emit, track);
  return ev.data;
}
