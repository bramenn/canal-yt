// Credenciales que se ponen desde ⚙ Ajustes. Se guardan solo en este ordenador (.secrets/, permisos 600) y nunca se devuelven:
// la interfaz solo ve si están puestas. Las de Claude y Codex se pasan a sus CLI por variables de entorno.
import { readKey, keySource, saveKey } from '../../lib/tts/keys.js';

// id → variables de entorno que alimenta (la primera es la que se consulta para saber si está puesta)
const ENV = {
  claude: ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'],
  openai: ['CODEX_API_KEY', 'OPENAI_API_KEY'],
};

// Claude: un token de suscripción (`claude setup-token`, sk-ant-oat…) o una API key (sk-ant-api…)
function claudeEnv(v) {
  return /^sk-ant-oat/i.test(v) ? { CLAUDE_CODE_OAUTH_TOKEN: v } : { ANTHROPIC_API_KEY: v };
}

/** Pone en el entorno las credenciales guardadas (si las hay, mandan sobre las del .env). */
export function applyCreds() {
  const c = readKey('claude', '__none__');
  if (c) { delete process.env.CLAUDE_CODE_OAUTH_TOKEN; delete process.env.ANTHROPIC_API_KEY; Object.assign(process.env, claudeEnv(c)); }
  const o = readKey('openai', '__none__');
  if (o) { process.env.CODEX_API_KEY = o; process.env.OPENAI_API_KEY = o; }
}

/** Qué hay puesto (sin valores): { claude: { configured, source }, openai: {...} } */
export function credsStatus() {
  const st = (id) => {
    const file = keySource(id, '__none__') === 'file';
    const env = ENV[id].some((k) => process.env[k]);
    return { configured: file || env, source: file ? 'ajustes' : env ? 'entorno' : null };
  };
  return { claude: st('claude'), openai: st('openai') };
}

/** Guarda las que vengan con valor (las vacías no se tocan). */
export async function saveCreds({ claude, openai } = {}) {
  if (claude?.trim()) await saveKey('claude', claude.trim());
  if (openai?.trim()) await saveKey('openai', openai.trim());
  applyCreds();
  return credsStatus();
}
