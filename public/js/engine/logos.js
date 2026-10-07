// Logos de empresas y modelos de IA (SVG originales de @lobehub/icons-static-svg, MIT) en public/logos/<id>.svg.
// Se dibujan tal cual, sobre una placa blanca tipo app, para que sean fieles en cualquier estilo.
// Uso editorial: identificar de qué empresa o modelo se habla, nunca insinuar patrocinio.

export const LOGOS = {
  openai: 'OpenAI', codex: 'Codex', sora: 'Sora',
  anthropic: 'Anthropic', claude: 'Claude',
  google: 'Google', gemini: 'Gemini', gemma: 'Gemma', notebooklm: 'NotebookLM',
  meta: 'Meta', microsoft: 'Microsoft', copilot: 'Copilot', githubcopilot: 'GitHub Copilot', github: 'GitHub',
  xai: 'xAI', grok: 'Grok',
  deepseek: 'DeepSeek', qwen: 'Qwen', alibaba: 'Alibaba', kimi: 'Kimi', moonshot: 'Moonshot AI',
  zhipu: 'Zhipu (GLM)', minimax: 'MiniMax', bytedance: 'ByteDance', doubao: 'Doubao',
  mistral: 'Mistral', perplexity: 'Perplexity', huggingface: 'Hugging Face', nvidia: 'NVIDIA', apple: 'Apple', aws: 'AWS',
  ollama: 'Ollama', lmstudio: 'LM Studio', groq: 'Groq', cerebras: 'Cerebras', openrouter: 'OpenRouter',
  cursor: 'Cursor', windsurf: 'Windsurf', v0: 'v0', replit: 'Replit', lovable: 'Lovable', n8n: 'n8n', langchain: 'LangChain',
  midjourney: 'Midjourney', stability: 'Stability AI', runway: 'Runway', suno: 'Suno', elevenlabs: 'ElevenLabs', fishaudio: 'Fish Audio',
};
export const LOGO_IDS = Object.keys(LOGOS);
export const isLogo = (name) => Object.prototype.hasOwnProperty.call(LOGOS, name);

const IMG = {};
export const logoImage = (id) => IMG[id] || null;
/** Para entornos sin <img> (pruebas en Node): registrar la imagen ya cargada. */
export function setLogoImage(id, img) { IMG[id] = img; }

/** Carga todos los logos (una vez). El render es síncrono: hay que esperar a esto antes de dibujar/exportar. */
let loading = null;
export function preloadLogos(base = '/logos/') {
  if (loading) return loading;
  loading = Promise.all(LOGO_IDS.map((id) => new Promise((resolve) => {
    const im = new Image();
    im.onload = () => { IMG[id] = im; resolve(); };
    im.onerror = () => resolve();
    im.src = `${base}${id}.svg`;
  })));
  return loading;
}
