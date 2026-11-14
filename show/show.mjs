import { publicUrl, resolverError } from '../player/core.mjs';
const $ = id => document.getElementById(id);
const url = new URL(location.href);
let feed;
function text(value) {
  const t = document.createElement('template'); t.innerHTML = String(value || '');
  return (t.content.textContent || '').replace(/\s*\n\s*/g, '\n').trim();
}
function episodeLink(item, show) {
  if (!['eg', 'ea', 'eu'].includes(item.identitySource) || !item.identity) return null;
  const q = new URLSearchParams({f: feed});
  if (show.podcastGuid) q.set('pg', show.podcastGuid);
  q.set(item.identitySource, item.identity);
  if (new TextEncoder().encode(q.toString()).length > 2048) return null;
  return `../p/?${q}`;
}
function render(show) {
  $('title').textContent = show.title || 'Podcast';
  document.title = `${show.title || 'Podcast'} · woopod`;
  $('description').textContent = text(show.description);
  if (show.artwork) try { $('cover').src = publicUrl(show.artwork); } catch {}
  $('cover').onerror = () => { $('cover').onerror = null; $('cover').src = '../assets/app-icon-dark.png'; };
  const list = Array.isArray(show.episodes) ? show.episodes : [];
  $('count').textContent = `${list.length} ${list.length === 1 ? 'episode' : 'episodes'}`;
  const container = $('episode-list'); container.replaceChildren();
  list.forEach((item, index) => {
    const details = document.createElement('details'), summary = document.createElement('summary');
    const number = document.createElement('span'); number.className = 'num'; number.textContent = item.number ? `#${item.number}` : String(index + 1).padStart(2, '0');
    const title = document.createElement('span'); title.className = 'episode-title'; title.textContent = item.title || 'Untitled episode';
    const plus = document.createElement('span'); plus.className = 'plus'; plus.setAttribute('aria-hidden', 'true'); plus.textContent = '+';
    summary.append(number, title, plus); details.append(summary);
    const body = document.createElement('div'); body.className = 'details';
    const description = document.createElement('p'); description.textContent = text(item.description) || 'Listen to the full episode.'; body.append(description);
    if (item.date) { const date = document.createElement('p'); date.textContent = item.date; body.append(date); }
    const href = show.demo ? '../p/?demo=1' : episodeLink(item, show);
    if (href) { const a = document.createElement('a'); a.className = 'listen'; a.href = href; a.textContent = '▶  Listen to episode'; body.append(a); }
    else { const p = document.createElement('p'); p.textContent = 'This episode cannot be opened from the feed.'; body.append(p); }
    details.append(body); container.append(details);
  });
  $('status').textContent = list.length ? '' : 'No playable episodes are available in this feed.';
}
async function load() {
  $('retry').hidden = true; $('status').textContent = 'Finding the podcast…';
  try {
    if (url.search === '?demo=1') { render({demo:true, title:'A little room to listen.', description:'Conversations that stay with you. A quiet corner for curious minds.', episodes:[{title:'A voice worth hearing',description:'An original sound sample to explore the Woopod player.'},{title:'Make room for a new idea',description:'Open an episode and enjoy the full player.'}]}); return; }
    if (new TextEncoder().encode(url.search.slice(1)).length > 2048) throw new Error('This podcast link is too long.');
    const q = url.searchParams;
    if ([...q.keys()].length !== 1 || q.getAll('f').length !== 1) throw new Error('This link needs one podcast feed.');
    feed = q.get('f'); publicUrl(feed); $('feed').href = feed; $('feed').hidden = false;
    const response = await fetch(`../api/v1/show?${new URLSearchParams({f:feed})}`, {headers:{Accept:'application/json'}, signal:AbortSignal.timeout(22000), referrerPolicy:'no-referrer'});
    if (!response.ok) throw new Error(resolverError(await response.json().catch(() => ({}))));
    const show = await response.json();
    if (!show || typeof show.title !== 'string' || !Array.isArray(show.episodes)) throw new Error('The podcast details are incomplete.');
    render(show);
  } catch (e) {
    $('status').textContent = e.name === 'TimeoutError' ? 'The podcast took too long to load.' : e.message;
    $('retry').hidden = !feed;
  }
}
$('retry').addEventListener('click', load);
$('share').addEventListener('click', async () => {
  const target = new URL(location.href); target.protocol = 'https:'; target.host = 'woopod.com'; target.pathname = '/show';
  try { if (navigator.share) await navigator.share({title:document.title,url:target.href}); else { await navigator.clipboard.writeText(target.href); $('status').textContent = 'Link copied.'; } }
  catch (e) { if (e.name !== 'AbortError') $('status').textContent = 'Copy the address from your browser to share.'; }
});
load();
