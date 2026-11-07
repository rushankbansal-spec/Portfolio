// Scroll owns the motion. No scroll hijacking, timers, or hidden content.
export function createScrollMotion() {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const root = document.documentElement;
  const journey = document.querySelector('.hero-journey');
  const hero = document.querySelector('.hero');
  let paused = false, frame = 0, entries = [], pageHeight = 1;
  const clamp = v => Math.max(0, Math.min(1, v));
  const ease = v => v * v * (3 - 2 * v);
  function measure() {
    const y = window.scrollY;
    entries = [...document.querySelectorAll('.section-shell, .project-card, .experience-row, .about-art')].map(element => {
      const rect = element.getBoundingClientRect();
      return { element, top: rect.top + y, height: rect.height,
        kind: element.matches('.project-card') ? 'project' : element.matches('.experience-row') ? 'row' : element.matches('.about-art') ? 'art' : 'section' };
    });
    pageHeight = Math.max(1, document.documentElement.scrollHeight - innerHeight);
    request();
  }
  function paint() {
    frame = 0;
    if (paused || reduced.matches) return;
    const y = window.scrollY, vh = innerHeight;
    const distance = Math.max(1, journey.offsetHeight - hero.offsetHeight);
    const progress = clamp((y - journey.offsetTop) / distance);
    root.style.setProperty('--journey', progress.toFixed(4));
    const chapterProgress = Math.min(progress * 2.5, 2);
    document.querySelectorAll('.story-panel').forEach((panel,index) => {
      const distance = chapterProgress - index;
      const active = index === Math.round(chapterProgress);
      const opacity = active ? 1 : 0;
      panel.style.setProperty('--chapter-opacity', opacity.toFixed(4));
      panel.style.setProperty('--chapter-shift', `${(-distance * 60).toFixed(2)}px`);
      panel.inert = !active;
      panel.setAttribute('aria-hidden', String(!active));
      if (active) journey.dataset.chapter = String(index);
    });
    root.style.setProperty('--page-progress', clamp(y / pageHeight).toFixed(4));
    for (const { element, top, height, kind } of entries) {
      const relative = top - y;
      if (relative > vh * 1.3 || relative + height < -vh * .3) continue;
      const entrance = ease(clamp((vh - relative) / (vh * .85)));
      const travel = Math.max(-1, Math.min(1, (relative + height * .5 - vh * .5) / vh));
      if (kind === 'section') {
        element.style.setProperty('--section-enter', entrance.toFixed(4));
        element.style.setProperty('--heading-travel', `${(travel * 35).toFixed(2)}px`);
      } else if (kind === 'project') {
        const direction = element.matches(':nth-child(even)') ? 1 : -1;
        element.style.setProperty('--card-turn', `${(direction * (1 - entrance) * 6).toFixed(2)}deg`);
        element.style.setProperty('--card-lift', `${((1 - entrance) * 85).toFixed(2)}px`);
        element.style.setProperty('--image-travel', `${(travel * 38).toFixed(2)}px`);
      } else if (kind === 'row') {
        element.style.setProperty('--row-slide', `${((1 - entrance) * 65).toFixed(2)}px`);
      } else {
        element.style.setProperty('--art-turn', `${(travel * -9).toFixed(2)}deg`);
        element.style.setProperty('--art-travel', `${(travel * 45).toFixed(2)}px`);
      }
    }
  }
  function request() { if (!frame && !paused && !reduced.matches) frame = requestAnimationFrame(paint); }
  const resize = new ResizeObserver(measure);
  resize.observe(document.querySelector('main'));
  const onPreference = () => {
    document.body.classList.toggle('scroll-effects', !reduced.matches && !paused);
    document.body.classList.toggle('motion-static', reduced.matches || paused);
    document.querySelectorAll('.story-panel').forEach(panel => { panel.inert=false; panel.removeAttribute('aria-hidden'); });
    if (reduced.matches) root.style.setProperty('--journey', '0');
    measure();
  };
  window.addEventListener('scroll', request, { passive: true });
  window.addEventListener('resize', measure, { passive: true });
  window.addEventListener('portfolio:rendered', measure);
  reduced.addEventListener('change', onPreference);
  onPreference();
  return { setPaused(value) { paused = value; onPreference(); }, destroy() {
    cancelAnimationFrame(frame); resize.disconnect();
    window.removeEventListener('scroll', request); window.removeEventListener('resize', measure);
    window.removeEventListener('portfolio:rendered', measure); reduced.removeEventListener('change', onPreference);
  } };
}
