/**
 * The signature moment of a message that reaches its ten minutes: the bubble is
 * cut into vertical strips that curl and fall away, then the row closes.
 * The idea follows the strip effect of React Bits' Shredder; this is a small
 * DOM version for one bubble (no canvas, no snapshot), with the Web Animations API.
 */

const prefersReducedMotion = () =>
  typeof window !== 'undefined' &&
  (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);

const cssTime = (name: string, fallback: number): number => {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const n = parseFloat(raw);
  if (!Number.isFinite(n)) return fallback;
  return raw.endsWith('ms') ? n : n * 1000;
};

const cssValue = (name: string, fallback: string): string =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

/** Collapses the row's height so the list closes over the gap. */
function collapse(row: HTMLElement, duration: number, easing: string): Promise<void> {
  const h = row.getBoundingClientRect().height;
  const cs = getComputedStyle(row);
  const anim = row.animate(
    [
      { height: `${h}px`, marginTop: cs.marginTop, opacity: 1 },
      { height: '0px', marginTop: '0px', opacity: 0 },
    ],
    { duration, easing, fill: 'forwards' },
  );
  row.style.overflow = 'hidden';
  return anim.finished.then(() => undefined);
}

/**
 * Plays the shred on `bubble` (inside `row`) and resolves when the row has
 * closed. Reduced motion: a plain fade. The caller removes the message after.
 */
export async function shred(row: HTMLElement, bubble: HTMLElement): Promise<void> {
  const exit = cssValue('--ease-exit', 'cubic-bezier(0.55, 0, 1, 0.45)');
  const soft = cssValue('--ease-soft', 'cubic-bezier(0.22, 0.8, 0.24, 1)');
  const base = cssTime('--dur-base', 240);

  if (prefersReducedMotion()) {
    await row.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, fill: 'forwards' })
      .finished;
    await collapse(row, 120, soft);
    return;
  }

  const signature = cssTime('--dur-signature', 900);
  const host = bubble.parentElement;
  if (!host) return;
  const w = bubble.offsetWidth;
  const h = bubble.offsetHeight;
  const left = bubble.offsetLeft;
  const top = bubble.offsetTop;
  const count = Math.max(6, Math.min(28, Math.round(w / 9)));
  const stripW = w / count;
  const mine = row.classList.contains('mine');

  const layer = document.createElement('div');
  layer.setAttribute('aria-hidden', 'true');
  Object.assign(layer.style, {
    position: 'absolute',
    left: `${left}px`,
    top: `${top}px`,
    width: `${w}px`,
    height: `${h}px`,
    pointerEvents: 'none',
    zIndex: '3',
  });

  // A bubble on the canvas is the canvas colour and shows only by its shadow;
  // cut into strips it needs a fill of its own (the overlay tone) to read as
  // paper. Your own bubble keeps its tint.
  const fill = mine ? '' : 'var(--surface-overlay)';
  const animations: Animation[] = [];
  for (let i = 0; i < count; i += 1) {
    const strip = bubble.cloneNode(true) as HTMLElement;
    strip.removeAttribute('tabindex');
    strip.removeAttribute('aria-haspopup');
    const x0 = i * stripW;
    Object.assign(strip.style, {
      position: 'absolute',
      left: '0',
      top: '0',
      width: `${w}px`,
      height: `${h}px`,
      margin: '0',
      maxWidth: 'none',
      boxShadow: 'none',
      clipPath: `inset(0 ${Math.max(0, w - x0 - stripW - 0.5)}px 0 ${x0}px)`,
    });
    if (fill) strip.style.background = fill;
    // The shadow sits on a wrapper so it follows the cut edge of the strip.
    const piece = document.createElement('div');
    Object.assign(piece.style, {
      position: 'absolute',
      inset: '0',
      filter: 'drop-shadow(0 2px 3px rgb(0 0 0 / 0.28))',
      transformOrigin: `${x0 + stripW / 2}px 0`,
    });
    piece.appendChild(strip);
    layer.appendChild(piece);
    // Strips go in order from the speaker's side, each a little different:
    // a fall, a sideways drift, a twist and a curl.
    const order = mine ? count - 1 - i : i;
    const t = order / Math.max(1, count - 1);
    const fall = h * (2.2 + Math.random() * 1.6) + 40;
    const drift = (Math.random() - 0.5) * 26;
    const twist = (Math.random() - 0.5) * 34;
    const curl = (Math.random() - 0.5) * 22;
    animations.push(
      piece.animate(
        [
          { transform: 'translate(0, 0) rotate(0deg) skewY(0deg)', opacity: 1 },
          {
            transform: `translate(${drift * 0.3}px, ${h * 0.35}px) rotate(${twist * 0.25}deg) skewY(${curl * 0.4}deg)`,
            opacity: 1,
            offset: 0.35,
          },
          {
            transform: `translate(${drift}px, ${fall}px) rotate(${twist}deg) skewY(${curl}deg)`,
            opacity: 0,
          },
        ],
        {
          duration: signature * (0.75 + Math.random() * 0.3),
          delay: t * signature * 0.45,
          easing: exit,
          fill: 'forwards',
        },
      ),
    );
  }

  host.appendChild(layer);
  bubble.style.visibility = 'hidden';
  try {
    await Promise.all(animations.map((a) => a.finished));
  } finally {
    layer.remove();
  }
  await collapse(row, base, soft);
}
