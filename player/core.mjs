export function publicUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('Use a public HTTPS link without a password or fragment.');
  if (!url.hostname || ['localhost', 'localhost.localdomain'].includes(url.hostname)) throw new Error('Use a public podcast link.');
  return url.href;
}

// Many stations only stream over plain HTTP; a live stream is public broadcast, so http is fine for radio.
export function radioUrl(value) {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('Use a public stream link without a password or fragment.');
  if (!url.hostname || ['localhost', 'localhost.localdomain'].includes(url.hostname)) throw new Error('Use a public radio link.');
  return url.href;
}

export function seconds(value) {
  if (!/^\d+(?:\.\d{1,3})?$/.test(value ?? '')) throw new Error('Clip times must be positive seconds, with up to three decimal places.');
  const time = Number(value);
  if (!Number.isSafeInteger(Math.round(time * 1000))) throw new Error('This clip time is too large.');
  return time;
}

export function resolverError(body) {
  const message = typeof body?.error === 'string' ? body.error : body?.error?.message;
  return typeof message === 'string' && message.trim() ? message.trim().slice(0, 300) : 'The podcast resolver is unavailable. You can still open the original feed below.';
}

export function decodeComment(encoded) {
  if (!encoded) return '';
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error('The comment in this link is not valid.');
  let text;
  try {
    const raw = atob(encoded.replace(/-/g, '+').replace(/_/g, '/'));
    if (raw.length > 1024) throw new Error();
    text = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(raw, c => c.charCodeAt(0)));
  } catch { throw new Error('The comment in this link is not valid UTF-8 text.'); }
  if ([...text].length > 280) throw new Error('The clip comment exceeds 280 characters.');
  return text;
}

export function parseLink(search, mode) {
  if (new TextEncoder().encode(search.replace(/^\?/, '')).length > 2048) throw new Error('This shared link is too long.');
  const q = new URLSearchParams(search);
  for (const key of q.keys()) if (q.getAll(key).length !== 1) throw new Error(`This link repeats the ${key} field.`);
  if (q.has('demo')) {
    if (q.get('demo') !== '1' || q.size !== 1) throw new Error('The preview link is not valid.');
    return { demo: true, mode, start: mode === 'clip' ? 15 : 0, end: mode === 'clip' ? 45 : null,
      comment: mode === 'clip' ? 'Leave a little room in your day for a voice that makes you think.' : '' };
  }
  const result = { mode, start: 0, end: null, comment: decodeComment(q.get('c')) };
  if (mode === 'radio') {
    // A live station: one stream, an optional name and an optional homepage. No feed, no bounds and no
    // clip conversation — a stream has no length to select inside and nothing to resolve.
    if (!q.has('audio')) throw new Error('This radio link is missing its stream.');
    if (q.has('f') || q.has('s') || q.has('e')) throw new Error('A radio link carries only the stream, a name and a homepage.');
    result.audio = radioUrl(q.get('audio'));
    result.title = (q.get('title') || 'Radio').slice(0, 200);
    result.homepage = q.has('homepage') ? radioUrl(q.get('homepage')) : '';
    result.query = q;
    return result;
  }
  if (mode === 'clip') {
    result.start = seconds(q.get('s')); result.end = seconds(q.get('e'));
    if (result.end <= result.start) throw new Error('The clip must end after it starts.');
  } else if (q.has('s') || q.has('e')) throw new Error('Use a clip link to share selected times.');
  if (q.has('audio')) {
    if (mode === 'clip') throw new Error('A clip needs its original podcast feed and episode identity.');
    result.audio = publicUrl(q.get('audio'));
    result.title = (q.get('title') || 'Shared episode').slice(0, 300);
    result.podcast = (q.get('podcast') || 'Direct audio').slice(0, 200);
  } else {
    if (!q.has('f')) throw new Error('This link is missing its podcast feed.');
    result.feed = publicUrl(q.get('f'));
    const ids = ['eg', 'ea', 'eu'].filter(k => q.has(k));
    if (ids.length !== 1 || !q.get(ids[0])) throw new Error('This link needs exactly one episode identity.');
    result.identity = ids[0]; result.id = q.get(ids[0]);
  }
  if(q.has('n') && (mode !== 'clip' || !/^[0-9a-f]{64}$/.test(q.get('n')))) throw new Error('This clip conversation identifier is invalid.');
  result.clipRoot = q.get('n');
  result.query = q;
  return result;
}

export function bounds(request, duration) {
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('The episode length is not available yet.');
  const end = request.mode === 'clip' ? request.end : duration;
  if (request.start >= duration || end > duration + .001) throw new Error('The clip extends beyond the episode.');
  return { start: request.start, end: Math.min(end, duration) };
}

export function timecode(value) {
  const time = Math.max(0, Math.floor(value || 0));
  const s = String(time % 60).padStart(2, '0');
  const m = Math.floor(time / 60) % 60; const h = Math.floor(time / 3600);
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

// Media events, a precise end timer and animation-frame updates all enforce the same bounds.
// Buffer recovery never seeks back to the start. Hidden clip tabs pause before cancelling timers.
export class BoundedPlayback {
  constructor(audio, { start, end }, { clip = true, update = () => {}, failure = () => {} } = {}) {
    this.audio = audio; this.start = start; this.end = end; this.clip = clip;
    this.update = update; this.failure = failure; this.listeners = []; this.timer = null; this.frame = null; this.advancing = false;
    const on = (name, fn) => { audio.addEventListener(name, fn); this.listeners.push([name, fn]); };
    on('playing', () => { this.advancing = true; this.enforce(); this.arm(); this.animate(); });
    for (const event of ['pause', 'waiting', 'seeking', 'ended']) on(event, () => { this.advancing = false; this.cancel(); this.update(); });
    on('seeked', () => { this.enforce(); if (!audio.paused && !audio.seeking && audio.readyState >= 3) { this.advancing = true; this.arm(); this.animate(); } this.update(); });
    on('ratechange', () => { this.cancel(); if (this.advancing) { this.arm(); this.animate(); } this.update(); });
    on('timeupdate', () => { this.enforce(); this.update(); });
    this.hide = () => { if (clip && document.hidden) { audio.pause(); this.cancel(); this.update(); } };
    document.addEventListener('visibilitychange', this.hide);
  }
  cancel() { clearTimeout(this.timer); cancelAnimationFrame(this.frame); this.timer = null; this.frame = null; }
  enforce() {
    const a = this.audio;
    if (a.seeking) return true;
    if (a.currentTime >= this.end) { a.pause(); this.cancel(); if (a.currentTime > this.end) a.currentTime = this.end; return false; }
    if (a.currentTime < this.start) a.currentTime = this.start;
    return true;
  }
  arm() {
    clearTimeout(this.timer);
    if (this.audio.paused || !this.advancing || this.audio.seeking) return;
    const ms = (this.end - this.audio.currentTime) * 1000 / this.audio.playbackRate;
    this.timer = setTimeout(() => { if (this.enforce()) this.arm(); this.update(); }, Math.min(2147483647, Math.max(4, ms)));
  }
  animate() {
    cancelAnimationFrame(this.frame);
    if (this.audio.paused || !this.advancing) return;
    this.enforce(); this.update();
    if (!this.audio.paused) this.frame = requestAnimationFrame(() => this.animate());
  }
  async play() {
    if (this.clip && document.hidden) return;
    if (this.audio.currentTime < this.start || this.audio.currentTime >= this.end - .02) this.audio.currentTime = this.start;
    try { await this.audio.play(); } catch { this.failure('Playback could not start. Try again, or open the publisher audio.'); }
  }
  seek(time) { this.audio.currentTime = Math.max(this.start, Math.min(this.end, time)); this.enforce(); this.update(); }
  dispose() { this.audio.pause(); this.cancel(); this.listeners.forEach(([n, f]) => this.audio.removeEventListener(n, f)); document.removeEventListener('visibilitychange', this.hide); }
}
