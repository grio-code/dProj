(() => {
  const fnav = document.getElementById('fnav');
  const links = document.getElementById('fnavLinks');
  const pill = links.querySelector('.fnav-pill');
  const dock = document.getElementById('dock');
  const fab = document.getElementById('dockFab');
  const menu = document.getElementById('dockMenu');
  const current = () => links.querySelector('[aria-current="page"]');

  // Mark the link matching the current URL as active
  const path = location.pathname;
  document.querySelectorAll('.fnav-links a, .dock-items a').forEach(a => {
    a.getAttribute('href') === path ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current');
  });

  // Sliding pill under the active / hovered top link
  function movePill(el) {
    if (!el || !links.offsetParent) return;
    pill.style.width = el.offsetWidth + 'px';
    pill.style.transform = `translateX(${el.offsetLeft}px)`;
  }
  links.querySelectorAll('a').forEach(a => a.addEventListener('mouseenter', () => movePill(a)));
  links.addEventListener('mouseleave', () => movePill(current()));

  // Compact top bar on scroll; hide dock when scrolling down
  let lastY = window.scrollY, ticking = false;
  function onScroll() {
    const y = window.scrollY;
    fnav.classList.toggle('is-compact', y > 40);
    if (Math.abs(y - lastY) > 6) {
      dock.classList.toggle('is-hidden', y > lastY && y > 120 && !menu.classList.contains('is-open'));
      lastY = y;
    }
    ticking = false;
  }
  window.addEventListener('scroll', () => { if (!ticking) { requestAnimationFrame(onScroll); ticking = true; } }, { passive: true });
  fnav.addEventListener('transitionend', e => { if (e.propertyName === 'width') movePill(current()); });

  // Create menu
  function toggleMenu(open) {
    const isOpen = open ?? !menu.classList.contains('is-open');
    menu.classList.toggle('is-open', isOpen);
    fab.setAttribute('aria-expanded', String(isOpen));
  }
  fab.addEventListener('click', e => { e.stopPropagation(); toggleMenu(); });
  document.addEventListener('click', e => { if (!menu.contains(e.target)) toggleMenu(false); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') toggleMenu(false); });

  window.addEventListener('resize', () => movePill(current()));
  document.fonts?.ready.then(() => movePill(current()));
  movePill(current());
})();
