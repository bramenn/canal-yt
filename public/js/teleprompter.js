// Teleprompter sincronizado con el reloj del reproductor + grabación (canvas + micrófono).
import { wordAt, sectionColor } from './engine/timeline.js';

export class Teleprompter {
  constructor(container, inner) {
    this.container = container;
    this.inner = inner;
    this.spans = [];
    this.last = -1;
    this.y = 0;
    this.target = 0;
    const loop = () => {
      this.y += (this.target - this.y) * 0.12;
      if (Math.abs(this.target - this.y) < 0.3) this.y = this.target;
      this.inner.style.transform = `translateY(${-this.y}px)`;
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  render(tl) {
    this.tl = tl;
    this.inner.innerHTML = '';
    this.spans = [];
    this.last = -1;
    let gi = 0;
    for (const seg of tl.segments) {
      const box = document.createElement('div');
      box.className = 'tp-seg';
      box.innerHTML = `<div class="tp-label"><i style="background:${sectionColor(seg.section)}"></i>${String(seg.index + 1).padStart(2, '0')} · ${seg.section}</div>`;
      let para = null, pi = -1;
      for (const w of seg.words) {
        if (w.para !== pi) {
          para = document.createElement('p');
          para.className = 'tp-para';
          box.appendChild(para);
          pi = w.para;
        }
        const span = document.createElement('span');
        span.className = 'w' + (w.em ? ' em' : '');
        span.textContent = w.text;
        span.dataset.i = gi++;
        para.appendChild(span);
        para.appendChild(document.createTextNode(' '));
        this.spans.push(span);
      }
      this.inner.appendChild(box);
    }
    this.update(0, true);
  }

  update(t, force = false) {
    if (!this.tl || !this.spans.length) return;
    const idx = Math.max(0, wordAt(this.tl, t));
    if (idx === this.last && !force) return;
    if (force || idx < this.last) {
      this.spans.forEach((s, k) => { s.classList.toggle('said', k < idx); s.classList.remove('on'); });
    } else {
      for (let k = Math.max(0, this.last); k < idx; k++) { this.spans[k].classList.add('said'); this.spans[k].classList.remove('on'); }
    }
    const cur = this.spans[idx];
    cur.classList.add('on');
    this.last = idx;
    this.target = Math.max(0, cur.offsetTop - this.container.clientHeight * 0.34 + cur.offsetHeight / 2);
  }

  setSize(px) {
    this.inner.style.setProperty('--tp-size', `${px}px`);
    if (this.last >= 0) this.update(this.tl ? this.tl.words[this.last].t0 : 0, true);
  }
}

const pick = (types) => types.find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';

export const VIDEO_TYPES = ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
export const AUDIO_TYPES = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/webm'];

/** Graba el canvas (y opcionalmente el micrófono) en un archivo de vídeo y otro de solo voz. */
export class Recorder {
  constructor(canvas) { this.canvas = canvas; }

  /**
   * audioStream: mezcla del mezclador (voz IA/efectos/música). Con micro, onMic(stream) lo conecta al mezclador
   * para que el vídeo lleve tu voz + efectos + música, y aparte se graba tu voz limpia.
   */
  async start({ mic = true, onLevel, audioStream = null, onMic = null } = {}) {
    const tracks = [...this.canvas.captureStream(30).getVideoTracks()];
    if (mic) {
      this.micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: false, channelCount: 1, sampleRate: 48000 },
      });
      onMic?.(this.micStream);
    }
    // una sola pista de audio en el vídeo: la mezcla si existe; si no, el micro tal cual
    if (audioStream) tracks.push(...audioStream.getAudioTracks());
    else if (this.micStream) tracks.push(...this.micStream.getAudioTracks());
    if (mic) {
      if (onLevel) {
        this.audioCtx = new AudioContext();
        const an = this.audioCtx.createAnalyser();
        an.fftSize = 512;
        this.audioCtx.createMediaStreamSource(this.micStream).connect(an);
        const data = new Uint8Array(an.fftSize);
        const tick = () => {
          if (!this.audioCtx) return;
          an.getByteTimeDomainData(data);
          let peak = 0;
          for (const v of data) peak = Math.max(peak, Math.abs(v - 128) / 128);
          onLevel(peak);
          requestAnimationFrame(tick);
        };
        tick();
      }
    }
    const vType = pick(VIDEO_TYPES);
    this.video = new MediaRecorder(new MediaStream(tracks), { mimeType: vType || undefined, videoBitsPerSecond: 10_000_000, audioBitsPerSecond: 192_000 });
    this.vChunks = [];
    this.video.ondataavailable = (e) => e.data.size && this.vChunks.push(e.data);
    if (mic) {
      const aType = pick(AUDIO_TYPES);
      this.audio = new MediaRecorder(this.micStream, { mimeType: aType || undefined, audioBitsPerSecond: 192_000 });
      this.aChunks = [];
      this.audio.ondataavailable = (e) => e.data.size && this.aChunks.push(e.data);
      this.audio.start(1000);
    }
    this.video.start(1000);
  }

  pause() { this.video?.state === 'recording' && this.video.pause(); this.audio?.state === 'recording' && this.audio.pause(); }
  resume() { this.video?.state === 'paused' && this.video.resume(); this.audio?.state === 'paused' && this.audio.resume(); }

  async stop() {
    const done = (rec) => new Promise((r) => { if (!rec || rec.state === 'inactive') return r(); rec.onstop = r; rec.stop(); });
    await Promise.all([done(this.video), done(this.audio)]);
    this.micStream?.getTracks().forEach((t) => t.stop());
    this.audioCtx?.close();
    this.audioCtx = null;
    const video = this.vChunks?.length ? new Blob(this.vChunks, { type: this.video.mimeType }) : null;
    const audio = this.aChunks?.length ? new Blob(this.aChunks, { type: this.audio.mimeType }) : null;
    return { video, audio };
  }
}

export const extOf = (blob) => (/mp4/.test(blob?.type) ? 'mp4' : /ogg/.test(blob?.type) ? 'ogg' : 'webm');
