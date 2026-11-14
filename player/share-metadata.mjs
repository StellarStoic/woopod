// Server-side share cards. The resolver is supplied by the host; this module never fetches URLs.
const ORIGIN = 'https://woopod.com';
const FALLBACK_IMAGE = `${ORIGIN}/assets/app-icon-dark.png`;
const START = '<!-- WOOPOD_SHARE_META_START -->';
const END = '<!-- WOOPOD_SHARE_META_END -->';
const clean = value => String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
const limit = (s, n) => Array.from(s).length > n ? Array.from(s).slice(0, n - 1).join('') + '…' : s;
const escape = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&#39;');
function imageUrl(value) {
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.username || u.password || u.port || u.hash || u.hostname === 'localhost' || u.hostname.endsWith('.localhost') || /^\[/.test(u.hostname) || /^\d+\.\d+\.\d+\.\d+$/.test(u.hostname)) return FALLBACK_IMAGE;
    return u.href;
  } catch { return FALLBACK_IMAGE; }
}
function comment(value) {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value) || value.length > 1366) return '';
  try {
    const raw = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
    const text = new TextDecoder('utf-8', {fatal: true}).decode(Uint8Array.from(raw, c => c.charCodeAt(0)));
    return Array.from(text).length <= 280 ? clean(text) : '';
  } catch { return ''; }
}
function timestamp(value) {
  if (!/^\d+(?:\.\d{1,3})?$/.test(value || '')) return '';
  const n = Number(value);
  if (!Number.isSafeInteger(Math.floor(n)) || n > 31536000) return '';
  const seconds = Math.floor(n), hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds / 60) % 60;
  return (hours ? `${hours}:${String(minutes).padStart(2, '0')}` : String(minutes)) + ':' + String(seconds % 60).padStart(2, '0');
}
export function shareMetadata(requestUrl, episode = null) {
  const u = new URL(requestUrl, ORIGIN);
  const mode = /^\/c\/?$/.test(u.pathname) ? 'clip' : 'episode';
  const path = mode === 'clip' ? '/c' : '/p';
  const validQuery = new TextEncoder().encode(u.search.slice(1)).length <= 2048 && [...u.searchParams.keys()].every(k => u.searchParams.getAll(k).length === 1);
  const q = validQuery ? u.searchParams : new URLSearchParams();
  const title = limit(clean(episode?.title || (q.has('audio') ? q.get('title') : '')), 150);
  const podcast = limit(clean(episode?.podcast || (q.has('audio') ? q.get('podcast') : '')), 100);
  const heading = title ? limit([title, podcast].filter(Boolean).join(' · '), 200) : 'A good listen, shared with Woopod';
  const start = timestamp(q.get('s')), end = timestamp(q.get('e'));
  const range = start && end && Number(q.get('e')) > Number(q.get('s')) ? ` · ${start}–${end}` : '';
  const note = mode === 'clip' ? comment(q.get('c')) : '';
  const description = limit(note ? `“${note}”${range}` : `${mode === 'clip' ? 'Listen to a clip' : 'Listen to this episode'}${podcast ? ` from ${podcast}` : ''} on Woopod${mode === 'clip' ? range : ''}.`, 220);
  return { title: heading, description, image: imageUrl(episode?.artwork), url: ORIGIN + path + (validQuery ? u.search : '') };
}
export function renderShareMetadata(html, metadata) {
  if (!html.includes(START) || !html.includes(END) || html.indexOf(START) > html.indexOf(END)) throw new Error('Missing share metadata markers');
  const meta = (key, name, value) => `<meta ${key}="${name}" content="${escape(value)}">`;
  const tags = [meta('name','description',metadata.description), meta('property','og:type','website'), meta('property','og:site_name','Woopod'), meta('property','og:title',metadata.title), meta('property','og:description',metadata.description), meta('property','og:url',metadata.url), meta('property','og:image',metadata.image), meta('property','og:image:alt', 'Podcast artwork'), meta('name','twitter:card','summary_large_image'), meta('name','twitter:title',metadata.title), meta('name','twitter:description',metadata.description), meta('name','twitter:image',metadata.image)].join('\n  ');
  return html.slice(0, html.indexOf(START)) + START + '\n  ' + tags + '\n  ' + html.slice(html.indexOf(END));
}
