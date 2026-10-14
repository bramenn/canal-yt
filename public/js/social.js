// Texto listo para pegar en YouTube Shorts o TikTok (los campos los escribe la IA con lib/social.js).
const tags = (list) => (list ?? []).map((h) => `#${String(h).replace(/^#/, '').replace(/\s+/g, '')}`).join(' ');

/** platform: 'youtube' | 'tiktok'. extra: líneas al final (crédito del audio, episodio original…). */
export function copyText(platform, c, extra = []) {
  const tail = extra.filter(Boolean).length ? ['', ...extra.filter(Boolean)] : [];
  if (platform === 'youtube') return [c.yt_title, '', c.yt_description, '', tags(c.yt_hashtags), ...tail].join('\n');
  return [c.tt_caption, '', tags(c.tt_hashtags), ...tail].join('\n');
}
