// Exportación sin tiempo real: cada fotograma se dibuja de forma determinista, se codifica a H.264 con
// WebCodecs (hardware si hay) y se sube al servidor por trozos; el audio se mezcla offline. ffmpeg une ambos.

export const canExportFast = () => typeof window.VideoEncoder === 'function' && typeof window.VideoFrame === 'function';

async function pickConfig(width, height, fps) {
  const base = { width, height, bitrate: width * height >= 1920 * 1080 ? 8_000_000 : 6_000_000, framerate: fps, avc: { format: 'annexb' }, latencyMode: 'quality' };
  for (const codec of ['avc1.640028', 'avc1.4d0028', 'avc1.42e028']) {
    for (const hardwareAcceleration of ['prefer-hardware', 'no-preference']) {
      const cfg = { ...base, codec, hardwareAcceleration };
      try { if ((await VideoEncoder.isConfigSupported(cfg)).supported) return cfg; } catch {}
    }
  }
  throw new Error('Este navegador no puede codificar H.264 con WebCodecs');
}

async function post(url, body, json = false) {
  const r = await fetch(url, { method: 'POST', body, headers: json ? { 'Content-Type': 'application/json' } : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `${url}: ${r.status}`);
  return data;
}

/**
 * opts: { width, height, fps, t0, t1, renderFrame(ctx, t) (puede ser async), audio (Blob|null), filename, onProgress(p, info), signal }
 * Devuelve { url, file, bytes }.
 */
export async function exportVideo({ width, height, fps = 30, t0 = 0, t1, renderFrame, audio, filename, onProgress, signal }) {
  const config = await pickConfig(width, height, fps);
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: false });
  const { id } = await post('/api/export/start');
  try {
    if (audio) { onProgress?.(0, { stage: 'audio' }); await post(`/api/export/${id}/audio`, audio); }

    // subida ordenada de trozos de vídeo
    let pending = [], pendingBytes = 0, uploads = Promise.resolve(), encErr = null;
    const flush = () => {
      if (!pendingBytes) return;
      const blob = new Blob(pending);
      pending = []; pendingBytes = 0;
      uploads = uploads.then(() => post(`/api/export/${id}/video`, blob));
    };
    const encoder = new VideoEncoder({
      output: (chunk) => {
        const buf = new Uint8Array(chunk.byteLength);
        chunk.copyTo(buf);
        pending.push(buf); pendingBytes += buf.byteLength;
        if (pendingBytes > 4 * 1024 * 1024) flush();
      },
      error: (e) => { encErr = e; },
    });
    encoder.configure(config);

    const total = Math.max(1, Math.round((t1 - t0) * fps));
    const started = performance.now();
    for (let i = 0; i < total; i++) {
      if (signal?.aborted) throw new Error('Exportación cancelada');
      if (encErr) throw encErr;
      await renderFrame(ctx, t0 + i / fps);
      const frame = new VideoFrame(canvas, { timestamp: Math.round((i * 1e6) / fps), duration: Math.round(1e6 / fps) });
      encoder.encode(frame, { keyFrame: i % (fps * 2) === 0 });
      frame.close();
      while (encoder.encodeQueueSize > 6) await new Promise((r) => setTimeout(r, 1));
      if (i % fps === 0) {
        const el = (performance.now() - started) / 1000;
        onProgress?.(i / total, { stage: 'video', frame: i, total, eta: (el / Math.max(1, i)) * (total - i) });
        await new Promise((r) => setTimeout(r, 0)); // deja respirar a la interfaz
      }
    }
    await encoder.flush();
    encoder.close();
    flush();
    await uploads;
    onProgress?.(1, { stage: 'mux' });
    return await post(`/api/export/${id}/finish`, JSON.stringify({ fps, filename }), true);
  } catch (e) {
    post(`/api/export/${id}/cancel`).catch(() => {});
    throw e;
  }
}

export function downloadUrl(url, name) {
  const a = document.createElement('a');
  a.href = url; a.download = name || '';
  document.body.appendChild(a); a.click(); a.remove();
}
