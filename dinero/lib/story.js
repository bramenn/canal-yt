// Historias de dinero y negocios para shorts (fórmula de Emprende Aprendiendo / MagnatesMedia / Logically Answered):
// 1) findStories: la IA busca historias reales con gancho (fracasos, caídas, decisiones absurdas, cómo alguien se hizo
//    rico, empresas en peligro hoy) y las verifica.
// 2) writeScript: gancho con el dato de dinero más sorprendente, quién y el problema, el momento clave con cifras, el
//    giro, el resultado de hoy y un final que enlaza con el principio; y qué se ve en cada frase (foto, cifra gigante,
//    titular de prensa o gráfica).
import { claudeStep } from '../../lib/claude.js';

const STORIES_SCHEMA = {
  type: 'object',
  properties: {
    stories: {
      type: 'array',
      items: {
        type: 'object',
        properties: { subject: { type: 'string' }, angle: { type: 'string' }, facts: { type: 'string' }, sources: { type: 'array', items: { type: 'string' } } },
        required: ['subject', 'angle', 'facts', 'sources'],
      },
    },
  },
  required: ['stories'],
};

export async function findStories({ count = 3, avoid = [], learn = '' }, emit, track) {
  const today = new Date().toISOString().slice(0, 10);
  const ev = await claudeStep({
    prompt: `Hoy es ${today}. Busca en la web y elige las ${count} historias REALES de dinero y negocios con MÁS gancho para un short de YouTube/TikTok en español (audiencia de España, Latinoamérica e hispanos de EE. UU.).

Lo que funciona en este nicho (canales con millones de vistas):
- Fracasos y caídas: «la empresa que rechazó comprar Google», «cómo GoPro perdió el 97 %», «Blockbuster y la oferta de Netflix».
- Cómo alguien se hizo rico de forma inesperada: «se hizo millonaria sin cobrar un centavo», «reinventó el sujetador deportivo con una pistola de pegamento».
- Decisiones o tácticas de negocio sorprendentes: precios, marketing, estafas famosas, apuestas locas («así nació Virgin Atlantic»).
- Actualidad con historia detrás: una empresa en peligro o en boca de todos esta semana, contada desde su origen.
Mezcla marcas mundiales con hispanas (Zara, Bimbo, Mercado Libre, Rappi, Mercadona…). Nada de consejos de inversión.
${avoid.length ? `Ya hechas (no repitas la misma historia): ${avoid.slice(0, 50).join(' · ')}` : ''}
${learn}

Para cada una: "subject" (la empresa o persona), "angle" (el giro sorprendente en una frase), "facts" (datos concretos y verificados: cifras con su moneda, fechas, nombres, qué pasó exactamente; incluye 2-4 cifras llamativas y, si hay, un titular real de prensa con su medio) y "sources" (URLs).`,
    schema: STORIES_SCHEMA, system: 'Eres guionista de un canal de shorts de historias de negocios en español. Verificas los datos antes de contarlos.',
    model: 'sonnet', effort: 'medium', tools: ['WebSearch', 'WebFetch'],
  }, emit, track);
  return { stories: (ev.data.stories ?? []).slice(0, count), cost: ev.cost ?? 0 };
}

const SCRIPT_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    thumb_text: { type: 'string' },
    thumb_word: { type: 'string' },
    yellow: { type: 'array', items: { type: 'string' } },
    red: { type: 'array', items: { type: 'string' } },
    lines: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          show: { type: 'string', enum: ['foto', 'cifra', 'titular', 'grafica'] },
          query: { type: 'string' },
          number: { type: 'string' },
          label: { type: 'string' },
          outlet: { type: 'string' },
          headline: { type: 'string' },
          bars: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, value: { type: 'number' } }, required: ['label', 'value'] } },
          unit: { type: 'string' },
        },
        required: ['text', 'show', 'query'],
      },
    },
  },
  required: ['title', 'thumb_text', 'thumb_word', 'yellow', 'red', 'lines'],
};

// duración por plataforma: Shorts premia el % visto (corto); TikTok solo paga (Creator Rewards) vídeos de más de 1 min
const LENGTH = {
  youtube: '35-45 segundos: 100-120 palabras, ni una más; cada frase aporta un dato nuevo, nada de relleno',
  tiktok: '65-75 segundos: 175-200 palabras, NUNCA menos de 170 (TikTok solo paga los vídeos de más de 1 minuto). Usa el tiempo extra para más contexto, una segunda cifra impactante y un remate mejor; sin relleno y con el mismo ritmo',
};

export async function writeScript(story, emit, track, { platform = 'youtube', more = '', learn = '' } = {}) {
  const ev = await claudeStep({
    prompt: `Escribe el guion de un short vertical de historias de dinero y negocios (voz en off en español neutro, ${LENGTH[platform]}).${more ? `\n${more}` : ''}

Historia: ${story.subject} — ${story.angle}
Datos (no inventes nada más; las cifras, exactamente como están): ${story.facts}

Fórmula (la de los canales que más funcionan):
1. GANCHO en la primera frase: el dato de dinero más sorprendente, sin decir todavía quién es («Ella gana más de un millón al año sin cobrar un solo centavo a sus clientes.», «Esta empresa rechazó comprar Netflix por 50 millones.»). También vale la segunda persona: «Así que eres Richard Branson en 1984 y te cancelan el vuelo…».
2. Quién es y el problema o la situación.
3. El momento clave con cifras concretas (cuánto invirtió, cuánto perdió, cuánto vale).
4. El GIRO: «Pero el negocio real no era…» / «El problema es que…».
5. Resultado de hoy y un final que deja con ganas o enlaza con el principio (bucle). Sin despedidas ni «suscríbete».
Frases cortas para leer en voz alta; las cifras en palabras («cuatrocientos mil dólares»).

Devuelve:
- "title": título del short, palabras clave en MAYÚSCULAS, ≤ 70 caracteres, curiosidad + dinero (ej.: «Se Hizo MILLONARIA Sin Cobrar Un CENTAVO»).
- "thumb_text": texto de la miniatura, 2-4 palabras en MAYÚSCULAS que no repitan el título (ej.: «-97 %», «RECHAZÓ A NETFLIX», «0 € A SUS CLIENTES»). "thumb_word": la palabra o cifra que va en amarillo.
- "lines": el guion frase a frase (cada "text" de 4 a 18 palabras; juntas forman el guion completo). Para cada frase, QUÉ SE VE ("show"):
  · "foto": una foto real; "query" = búsqueda de imágenes concreta (la persona, el producto, el logo, la tienda, el lugar). Es lo más habitual.
  · "cifra": la cifra a pantalla completa cuando la frase dice un número impactante; "number" = la cifra corta como se leería en pantalla («$400.000», «-97 %», «1.000 M €», «x10»), "label" = 1-4 palabras que explican («de sus ahorros», «en bolsa»). "query" = foto de fondo relacionada.
  · "titular": un titular REAL de prensa sobre la historia (de los datos); "outlet" = el medio («Bloomberg», «El País»), "headline" = el titular (≤ 12 palabras, en español). Como mucho uno por guion. "query" = foto de fondo.
  · "grafica": una comparación o evolución con números reales; "bars" = 2-5 barras {label, value} en orden, "unit" = unidad («M$», «%», «tiendas»). Como mucho una por guion. "query" = foto de fondo.
  Entre 2 y 4 frases con cifra/titular/gráfica en total, el resto fotos; nunca dos tarjetas seguidas iguales.
- "yellow": 6-12 palabras sueltas del guion que se resaltan en amarillo (nombres, cifras). "red": 2-5 palabras en rojo (pérdidas, fracaso, lo impactante). Palabras exactas del guion.${learn}`,
    schema: SCRIPT_SCHEMA, system: 'Eres guionista de shorts virales de historias de negocios en español.', model: 'sonnet', effort: 'medium', tools: [],
  }, emit, track);
  return { script: ev.data, cost: ev.cost ?? 0 };
}
