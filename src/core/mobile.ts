/**
 * iOS/mobile hygiene: no pinch/double-tap zoom, no rubber-band scroll, no text selection or callouts,
 * safe-area insets exposed as CSS vars, and a portrait "rotate" prompt (pure CSS, see style.css).
 */
export function installMobileGuards(): void {
  const prevent = (e: Event) => e.preventDefault();
  // Safari pinch gestures
  document.addEventListener('gesturestart', prevent as EventListener, { passive: false });
  document.addEventListener('gesturechange', prevent as EventListener, { passive: false });
  document.addEventListener('gestureend', prevent as EventListener, { passive: false });
  // rubber-band + multi-touch zoom (allow scrolling inside .scroll panels)
  document.addEventListener(
    'touchmove',
    (e) => {
      const t = e.target as HTMLElement;
      if (e.touches.length > 1 || !t.closest?.('.panel')) e.preventDefault();
    },
    { passive: false },
  );
  // double-tap zoom
  let lastTouch = 0;
  document.addEventListener(
    'touchend',
    (e) => {
      const now = performance.now();
      const t = e.target as HTMLElement;
      if (now - lastTouch < 320 && !t.closest?.('input')) e.preventDefault();
      lastTouch = now;
    },
    { passive: false },
  );
  document.addEventListener('dblclick', prevent, { passive: false });
  document.addEventListener('selectstart', (e) => {
    const t = e.target as HTMLElement;
    if (!t.closest?.('input')) e.preventDefault();
  });
  document.addEventListener('contextmenu', (e) => {
    const t = e.target as HTMLElement;
    if (!t.closest?.('a')) e.preventDefault();
  });
  const standalone = matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone;
  if (standalone) document.documentElement.classList.add('standalone');
  // keep viewport height correct when the iOS toolbar shows/hides
  const setVh = () => document.documentElement.style.setProperty('--vh', `${window.innerHeight * 0.01}px`);
  setVh();
  window.addEventListener('resize', setVh);
}
