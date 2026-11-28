import { mountConversation } from './conversation.mjs';
import { parseLink, publicUrl, bounds, timecode, BoundedPlayback, resolverError } from './core.mjs';

const $ = id => document.getElementById(id);
const audio = $('audio');
const mode = document.body.dataset.mode;
const page = new URL(location.href);
let request, controller, durationTimer, initialized = false;
const status = (message, error = false) => { $('status').textContent = message; $('status').classList.toggle('error', error); };
const icon = (id, name) => $(id).querySelector('use').setAttribute('href', `#icon-${name}`);
const showLink = (id, value) => {
  if (!value) return;
  try { $(id).href = publicUrl(value); $(id).hidden = false; } catch { /* Never turn unsafe publisher metadata into a link. */ }
};
function renderPosition() {
  if (!controller) return;
  const { start, end } = controller;
  const time = Math.min(end, Math.max(start, audio.currentTime));
  $('seek').value = String(time);
  $('seek').setAttribute('aria-valuetext', `${timecode(time)} of ${timecode(end)}`);
  $('timeline').style.setProperty('--progress', `${100 * (time - start) / (end - start)}%`);
  $('current').textContent = timecode(time);
  $('remaining').textContent = `−${timecode(end - time)}`;
  icon('play', audio.paused ? 'play' : 'pause');
  $('play').setAttribute('aria-label', audio.paused ? (time >= end ? 'Replay' : 'Play') : 'Pause');
}
function showError(message) {
  clearTimeout(durationTimer);
  if (controller) { controller.dispose(); controller = null; }
  status(message, true);
  for (const id of ['play', 'restart', 'back', 'forward', 'seek']) $(id).disabled = true;
  $('retry').hidden = !audio.src && !request?.feed;
}
const retry = document.createElement('button');
retry.id = 'retry'; retry.className = 'retry'; retry.hidden = true; retry.textContent = 'Try again';
$('status').after(retry);
retry.addEventListener('click', () => location.reload());

async function startEpisode() {
try {
  request = parseLink(page.search, mode);
  $('format').textContent = mode === 'clip' ? 'SHARED CLIP' : 'FULL EPISODE';
  $('playback-note').textContent = mode === 'clip'
    ? 'Leaving this tab pauses the clip. Tap play when you come back.'
    : 'The whole episode, at your pace. Nothing is posted when you listen.';
  if (request.comment) {
    $('quote').textContent = request.comment;
    $('quote').style.setProperty('--quote-size', `${Math.max(18, 37 - [...request.comment].length * .065)}px`);
    $('quote-section').hidden = false;
  }
  if (request.feed) showLink('feed', request.feed);
  if (mode === 'clip') {
    const whole = new URL('../p/', location.href);
    if (request.demo) whole.search = '?demo=1';
    else { whole.search = page.search; for (const k of ['s', 'e', 'c', 'n']) whole.searchParams.delete(k); }
    $('whole').href = whole.href; $('whole').hidden = false;
  }
  let metadata;
  if (request.demo) {
    document.querySelector('.demo-switch').hidden = false;
    document.querySelector(`.demo-switch a[href*="/${mode === 'clip' ? 'c' : 'p'}/"]`).setAttribute('aria-current', 'page');
    metadata = { title: 'A little room to listen.', podcast: 'Woopod / Player preview',
      summary: 'Original sound sample · no spoken recording', audio: new URL('./preview.mp3', import.meta.url).href };
  } else if (request.audio) {
    metadata = { title: request.title, podcast: request.podcast, audio: request.audio, summary: 'Shared audio · press play to begin' };
  } else {
    status('Finding this episode in its podcast feed…');
    const response = await fetch(new URL(`../api/v1/clip?${request.query}`, location.href), {
      signal: AbortSignal.timeout(22000), headers: { Accept: 'application/json' }, referrerPolicy: 'no-referrer'
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(resolverError(body));
    }
    metadata = await response.json();
    publicUrl(metadata.audio); // A resolver response never grants permission to load a non-HTTPS URL.
    if (!metadata.title || !metadata.podcast) throw new Error('The resolver returned incomplete episode information.');
  }
  $('episode-title').textContent = metadata.title;
  $('podcast-name').textContent = metadata.podcast;
  $('episode-meta').textContent = [metadata.episodeNumber ? `Episode ${metadata.episodeNumber}` : '', metadata.date || '', metadata.summary || ''].filter(Boolean).join(' · ');
  document.title = `${metadata.title} · woopod`;
  if (metadata.artwork) {
    try { $('cover').src = publicUrl(metadata.artwork); $('cover').referrerPolicy = 'no-referrer'; $('cover').hidden = false; $('cover').onerror = () => { $('cover').hidden = true; }; } catch { /* Keep branded fallback. */ }
  }
  if (!request.demo) showLink('publisher', metadata.audio);
  status('Loading the episode length…');
  durationTimer = setTimeout(() => showError('The audio is taking too long to load. Try again, or open the publisher audio.'), 22000);
  const initialize = () => {
    if (initialized || !Number.isFinite(audio.duration) || audio.duration <= 0) return;
    clearTimeout(durationTimer);
    try {
      const selected = bounds(request, audio.duration);
      initialized = true;
      controller = new BoundedPlayback(audio, selected, { clip: mode === 'clip', update: renderPosition, failure: m => status(m, true) });
      audio.currentTime = selected.start;
      $('seek').min = String(selected.start); $('seek').max = String(selected.end);
      $('range-label').textContent = mode === 'clip' ? `${timecode(selected.start)} — ${timecode(selected.end)}` : timecode(selected.end);
      for (const id of ['play', 'restart', 'back', 'forward', 'seek', 'share']) $(id).disabled = false;
      status(request.demo ? 'Original sound sample.' : 'Ready when you are.');
      renderPosition();
    } catch (e) { showError(e.message); }
  };
  audio.addEventListener('loadedmetadata', initialize);
  audio.addEventListener('durationchange', () => {
    initialize();
    if (controller && Number.isFinite(audio.duration) && controller.end > audio.duration + .001) showError('The episode length changed; this selection no longer fits.');
  });
  audio.addEventListener('playing', () => status('Listening.'));
  audio.addEventListener('play', () => status('Starting audio…'));
  audio.addEventListener('waiting', () => { if (initialized && !audio.paused) status('Buffering…'); });
  audio.addEventListener('pause', () => { if (controller) status(audio.currentTime >= controller.end ? 'A good place to pause. Replay whenever you like.' : 'Paused. Take your time.'); });
  audio.addEventListener('error', () => showError('This audio could not load. The publisher may be unavailable or this browser may not support the recording.'));
  audio.src = metadata.audio;
  mountConversation({request, metadata, shareUrl: () => {
    const shared = new URL(location.href); shared.protocol = 'https:'; shared.host = 'woopod.com'; shared.pathname = mode === 'clip' ? '/c' : '/p';
    if(!page.search) shared.search = '?demo=1';
    return shared.href;
  }, onClipRoot: root => {
    const updated = new URL(location.href); updated.searchParams.set('n', root);
    if(new TextEncoder().encode(updated.search.slice(1)).length > 2048) { status('Your public clip was posted, but this note makes the conversation link too long. Shorten the note before sharing.', true); $('share').disabled=true; return; }
    history.replaceState(null, '', updated); request.clipRoot = root;
  }});
  $('open-conversation').disabled = false;
} catch (e) {
  showError(e.name === 'TimeoutError' ? 'Finding this episode timed out. Try the original feed below.' : e.message);
}
}

/**
 * A live radio stream, which is an episode player with the length taken out.
 *
 * `initialize()` above waits for a finite `audio.duration` before it enables anything, and a live stream
 * reports `Infinity` — so the episode path would sit on "Loading the episode length…" and then declare a
 * failure. Radio therefore never waits for a length: play is live from the first frame, and the controls
 * that only make sense inside a recording (seek, timeline, restart, ±15/30, speed, "whole episode") are
 * removed rather than disabled, because a disabled button still reads as an error.
 */
function startRadio() {
  try {
    request = parseLink(page.search, mode);
  } catch (e) {
    showError(e.message);
    return;
  }
  $('format').textContent = 'LIVE RADIO';
  $('playback-note').textContent = 'A live stream. Playback joins the station where it is now, and nothing is posted while you listen.';
  $('range-label').textContent = 'LIVE';
  $('episode-title').textContent = request.title;
  $('podcast-name').textContent = 'Radio';
  $('episode-meta').textContent = 'Live stream · press play to listen';
  document.title = `${request.title} · woopod`;
  showLink('publisher', request.homepage);
  // the episode controls have no meaning on a stream that is being broadcast right now
  for (const id of ['restart', 'back', 'forward', 'seek']) $(id).hidden = true;
  $('timeline').hidden = true;
  $('current').hidden = true;
  $('remaining').hidden = true;
  $('whole').hidden = true;
  $('open-conversation').hidden = true;
  document.querySelector('.speed-control').hidden = true;
  document.querySelector('.times').hidden = true;
  $('play').disabled = false;
  status('Press play to listen live.');
  audio.preload = 'none';
  audio.src = request.audio;
  audio.addEventListener('playing', () => { status('Listening live.'); renderRadio(); });
  audio.addEventListener('pause', () => status('Paused. The station plays live, so you rejoin where it is now.'));
  audio.addEventListener('waiting', () => { if (!audio.paused) status('Buffering…'); });
  audio.addEventListener('error', () => showError('This stream could not load. The station may be offline, or this browser may not support its format.'));
  $('share').disabled = false;
  renderRadio();
}
function renderRadio() {
  icon('play', audio.paused ? 'play' : 'pause');
  $('play').setAttribute('aria-label', audio.paused ? 'Play' : 'Pause');
}

if (mode === 'radio') startRadio(); else startEpisode();

$('play').addEventListener('click', () => {
  // radio has no BoundedPlayback to lean on: the stream is played and paused directly
  if (controller) audio.paused ? controller.play() : audio.pause();
  else if (mode === 'radio') { if (audio.paused) audio.play().then(renderRadio).catch(() => status('The browser refused to start the stream. Press play again, or open the stream directly.', true)); else { audio.pause(); renderRadio(); } }
});
$('restart').addEventListener('click', () => { if (controller) { controller.seek(controller.start); controller.play(); } });
$('back').addEventListener('click', () => controller?.seek(audio.currentTime - 15));
$('forward').addEventListener('click', () => controller?.seek(audio.currentTime + 30));
$('seek').addEventListener('input', () => controller?.seek(Number($('seek').value)));
$('speed').addEventListener('input', () => { audio.playbackRate = Number($('speed').value); $('speed-value').textContent = `${Number($('speed').value)}×`; });
$('volume').addEventListener('input', () => { audio.volume = Number($('volume').value); $('volume-value').textContent = `${Math.round(audio.volume * 100)}%`; });
$('share').addEventListener('click', async () => {
  const url = new URL(location.href);
  if (request.demo) url.search = '?demo=1';
  try {
    if (navigator.share) await navigator.share({ title: document.title, url: url.href });
    else { await navigator.clipboard.writeText(url.href); status('Link copied.'); }
  } catch (e) { if (e.name !== 'AbortError') status('Copy the address from your browser to share this listen.'); }
});
document.addEventListener('click', e => { const settings = document.querySelector('.settings'); if (!settings.contains(e.target)) settings.open = false; });
window.addEventListener('pagehide', () => { controller?.dispose(); clearTimeout(durationTimer); });

// Fit episode titles; long notes scroll independently at a readable font size.
function fitCopy() {
  const shell = document.querySelector('.player-shell');
  shell.classList.remove('compact-copy');
  const fit = (id, minimum) => {
    const element = $(id);
    if (!element.getClientRects().length) return true;
    element.style.fontSize = '';
    let size = parseFloat(getComputedStyle(element).fontSize);
    while (element.scrollHeight > element.clientHeight + 1 && size > minimum) {
      size -= .5; element.style.fontSize = `${size}px`;
    }
    return element.scrollHeight <= element.clientHeight + 1;
  };
  const quote = $('quote');
  const scrolling = quote.scrollHeight > quote.clientHeight + 1;
  if (scrolling) quote.tabIndex = 0; else quote.removeAttribute('tabindex');
  if (!fit('episode-title', 14)) {
    shell.classList.add('compact-copy');
    fit('episode-title', 12);
  }
}

let fitFrame;
const scheduleFit = () => { cancelAnimationFrame(fitFrame); fitFrame = requestAnimationFrame(fitCopy); };
const layoutObserver = new ResizeObserver(scheduleFit);
layoutObserver.observe(document.querySelector('main'));
layoutObserver.observe($('quote')); 
scheduleFit();
