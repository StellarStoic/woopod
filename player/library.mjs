const HISTORY_KEY = 'woopod-history';
const FAVORITES_KEY = 'woopod-favorites';
const MAX_HISTORY = 100;
const MAX_FAVORITES = 500;

function read(key) {
  try { return JSON.parse(localStorage.getItem(key) || '[]'); }
  catch { return []; }
}

function write(key, list) {
  const max = key === HISTORY_KEY ? MAX_HISTORY : MAX_FAVORITES;
  try { localStorage.setItem(key, JSON.stringify(list.slice(0, max))); }
  catch {}
}

function normalize(item) {
  return {
    url: String(item.url || location.href),
    title: String(item.title || '').slice(0, 300),
    podcast: String(item.podcast || '').slice(0, 200),
    mode: String(item.mode || 'episode'),
    artwork: item.artwork ? String(item.artwork).slice(0, 2048) : '',
    homepage: item.homepage ? String(item.homepage).slice(0, 2048) : '',
    feed: item.feed ? String(item.feed).slice(0, 2048) : '',
    timestamp: Number.isFinite(item.timestamp) ? item.timestamp : Date.now()
  };
}

export function addHistory(item) {
  const entry = normalize(item);
  const list = read(HISTORY_KEY).filter(it => it.url !== entry.url);
  list.unshift(entry);
  write(HISTORY_KEY, list);
}

export function listHistory() {
  return read(HISTORY_KEY);
}

export function isFavorite(url) {
  return read(FAVORITES_KEY).some(it => it.url === url);
}

export function addFavorite(item) {
  const entry = normalize(item);
  const list = read(FAVORITES_KEY).filter(it => it.url !== entry.url);
  list.unshift(entry);
  write(FAVORITES_KEY, list);
  return true;
}

export function removeFavorite(url) {
  const list = read(FAVORITES_KEY).filter(it => it.url !== url);
  write(FAVORITES_KEY, list);
  return false;
}

export function toggleFavorite(item) {
  const url = normalize(item).url;
  return isFavorite(url) ? removeFavorite(url) : addFavorite(item);
}

export function listFavorites() {
  return read(FAVORITES_KEY);
}

const $ = id => document.getElementById(id);

export function setupLikeButton(item) {
  const like = $('like');
  if (!like) return;
  function render() {
    const favorited = isFavorite(item.url);
    like.setAttribute('aria-pressed', String(favorited));
    like.setAttribute('aria-label', favorited ? 'Remove from favourites' : 'Add to favourites');
    like.querySelector('use').setAttribute('href', favorited ? '#icon-heart-filled' : '#icon-heart');
    like.classList.toggle('liked', favorited);
  }
  like.disabled = false;
  like.onclick = () => { toggleFavorite(item); render(); };
  render();
}

function renderLibraryList(kind) {
  const items = kind === 'favorites' ? listFavorites() : listHistory();
  const list = $('library-list');
  const empty = $('library-empty');
  const title = $('library-title');
  if (title) title.textContent = kind === 'favorites' ? 'Favourites' : 'History';
  list.innerHTML = '';
  empty.hidden = items.length > 0;
  for (const item of items) {
    const li = document.createElement('li');
    li.className = 'library-item';
    const link = document.createElement('a');
    link.href = item.url;
    link.className = 'library-item-link';
    const label = document.createElement('span');
    label.className = 'library-item-title';
    label.textContent = item.title || 'Untitled';
    const meta = document.createElement('span');
    meta.className = 'library-item-meta';
    meta.textContent = [item.podcast, kind === 'favorites' ? '' : new Date(item.timestamp).toLocaleString()].filter(Boolean).join(' · ');
    link.append(label, meta);
    li.append(link);
    if (kind === 'favorites') {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'library-item-remove';
      remove.setAttribute('aria-label', 'Remove from favourites');
      remove.textContent = '×';
      remove.onclick = e => { e.preventDefault(); removeFavorite(item.url); renderLibraryList(kind); };
      li.append(remove);
    }
    list.append(li);
  }
}

function openLibraryModal(kind) {
  renderLibraryList(kind);
  const modal = $('library-modal');
  if (modal) modal.showModal();
}

export function mountLibraryModal() {
  const historyOpen = $('history-open');
  const favoritesOpen = $('favorites-open');
  const closeLibrary = $('close-library');
  const libraryModal = $('library-modal');
  if (historyOpen) historyOpen.addEventListener('click', () => openLibraryModal('history'));
  if (favoritesOpen) favoritesOpen.addEventListener('click', () => openLibraryModal('favorites'));
  if (closeLibrary) closeLibrary.addEventListener('click', () => libraryModal?.close());
  if (libraryModal) libraryModal.addEventListener('click', e => { if (e.target === libraryModal) libraryModal.close(); });
}
