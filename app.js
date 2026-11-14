(() => {
  const root = document.documentElement;
  const header = document.querySelector('[data-header]');
  const menuButton = document.querySelector('[data-menu]');
  const nav = document.querySelector('[data-nav]');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const hexToRgb = (hex) => {
    const value = hex.replace('#', '');
    return [0, 2, 4].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16));
  };

  const colorInput = document.querySelector('[data-color]');
  const colorValue = document.querySelector('[data-color-value]');
  const applyColor = (hex) => {
    const normalized = hex.toUpperCase();
    root.style.setProperty('--accent', normalized);
    root.style.setProperty('--accent-rgb', hexToRgb(normalized).join(', '));
    colorInput.value = normalized;
    colorValue.value = normalized;
    try { localStorage.setItem('woopod-demo-color', normalized); } catch (_) { /* browser storage is optional */ }
  };
  let savedColor;
  try { savedColor = localStorage.getItem('woopod-demo-color'); } catch (_) { savedColor = null; }
  if (/^#[0-9A-F]{6}$/i.test(savedColor || '')) applyColor(savedColor);
  colorInput.addEventListener('input', () => applyColor(colorInput.value));

  const fontButton = document.querySelector('[data-font]');
  const fontMoods = [
    ['Clean grotesk', '"Arial Narrow", "Aptos Display", "Helvetica Neue", Arial, sans-serif'],
    ['Editorial serif', 'Iowan Old Style, Palatino Linotype, Book Antiqua, Georgia, serif'],
    ['Technical mono', 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'],
    ['Soft humanist', 'Aptos, Candara, Segoe UI, sans-serif']
  ];
  let fontIndex = 0;
  fontButton.addEventListener('click', () => {
    fontIndex = (fontIndex + 1) % fontMoods.length;
    root.style.setProperty('--display', fontMoods[fontIndex][1]);
    fontButton.firstChild.textContent = `${fontMoods[fontIndex][0]} `;
  });

  const closeMenu = () => {
    nav.classList.remove('open');
    document.body.classList.remove('menu-open');
    menuButton.setAttribute('aria-expanded', 'false');
  };
  menuButton.addEventListener('click', () => {
    const open = !nav.classList.contains('open');
    nav.classList.toggle('open', open);
    document.body.classList.toggle('menu-open', open);
    menuButton.setAttribute('aria-expanded', String(open));
  });
  nav.querySelectorAll('a').forEach((link) => link.addEventListener('click', closeMenu));
  window.addEventListener('resize', () => { if (window.innerWidth > 1050) closeMenu(); });

  const reveals = document.querySelectorAll('.reveal');
  if ('IntersectionObserver' in window && !reduceMotion) {
    const revealObserver = new IntersectionObserver((entries, observer) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('in-view');
          observer.unobserve(entry.target);
        }
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    reveals.forEach((element) => revealObserver.observe(element));
  } else {
    reveals.forEach((element) => element.classList.add('in-view'));
  }

  const navLinks = [...nav.querySelectorAll('a[href^="#"]')];
  const navSections = navLinks.map((link) => document.querySelector(link.getAttribute('href'))).filter(Boolean);
  if ('IntersectionObserver' in window) {
    const sectionObserver = new IntersectionObserver((entries) => {
      const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      if (!visible) return;
      navLinks.forEach((link) => link.classList.toggle('active', link.getAttribute('href') === `#${visible.target.id}`));
    }, { rootMargin: '-25% 0px -58% 0px', threshold: [0, .15, .5] });
    navSections.forEach((section) => sectionObserver.observe(section));
  }

  const depthElements = [...document.querySelectorAll('[data-depth]')];
  let ticking = false;
  const renderScroll = () => {
    header.classList.toggle('scrolled', window.scrollY > 28);
    if (!reduceMotion) {
      const viewportCenter = window.innerHeight / 2;
      depthElements.forEach((element) => {
        const rect = element.getBoundingClientRect();
        if (rect.bottom > -300 && rect.top < window.innerHeight + 300) {
          const depth = Number.parseFloat(element.dataset.depth || '0');
          const offset = (rect.top + rect.height / 2 - viewportCenter) * depth;
          element.style.transform = `translate3d(0, ${offset.toFixed(2)}px, 0)`;
        }
      });
    }
    ticking = false;
  };
  const onScroll = () => {
    if (!ticking) { requestAnimationFrame(renderScroll); ticking = true; }
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll);
  renderScroll();

  const search = document.querySelector('[data-doc-search]');
  const groups = [...document.querySelectorAll('.doc-group')];
  const items = [...document.querySelectorAll('.doc-item')];
  const count = document.querySelector('[data-doc-count]');
  const noResults = document.querySelector('[data-no-results]');
  count.textContent = String(items.length);

  search.addEventListener('input', () => {
    const terms = search.value.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
    let visibleCount = 0;
    groups.forEach((group) => {
      let visibleInGroup = 0;
      group.querySelectorAll('.doc-item').forEach((item) => {
        const haystack = `${item.dataset.search || ''} ${item.textContent}`.toLocaleLowerCase();
        const matches = terms.every((term) => haystack.includes(term));
        item.hidden = !matches;
        if (matches) { visibleInGroup += 1; visibleCount += 1; }
      });
      group.hidden = visibleInGroup === 0;
      if (terms.length && visibleInGroup) group.open = true;
    });
    count.textContent = String(visibleCount);
    noResults.hidden = visibleCount !== 0;
  });
})();
