// From React Bits (reactbits.dev), MIT + Commons Clause: see LICENSE.md in this folder.
// Anonyma: reduced to the list's entrance. The selection ring, keyboard and hover
// selection, the scroll box with its fades and the demo items (and their icon
// set) are gone; the page renders its own <li> rows. What stays is React Bits'
// motion: rows pop in one after another (same poses, spring and stagger) when
// the list comes into view, and a row that arrives later pops in on its own.
// Reduced motion only fades.
import { useLayoutEffect, useRef, type HTMLAttributes, type ReactNode } from 'react';

type Animation = 'pop' | 'slide' | 'fade';

export interface AnimatedListProps extends HTMLAttributes<HTMLUListElement> {
  children: ReactNode;
  animation?: Animation;
  /** Seconds between rows on the first entrance. */
  stagger?: number;
}

const HIDDEN: Record<Animation, string> = {
  pop: 'translate3d(0, 12px, 0) scale(0.8)',
  slide: 'translate3d(0, 28px, 0) scale(0.98)',
  fade: 'translate3d(0, 4px, 0)',
};

const SPRING =
  'linear(0, 0.0603, 0.2033, 0.3821, 0.5633, 0.7258, 0.8584, 0.9574, 1.0242, 1.0634, 1.0809, 1.0828, 1.0747, 1.0613, 1.046, 1.0313, 1.0186, 1.0085, 1.0012, 0.9965, 0.994, 0.9931, 0.9933, 0.9941, 0.9953, 0.9966, 0.9978, 0.9988, 1)';

const AnimatedList = ({
  children,
  animation = 'pop',
  stagger = 0.05,
  ...rest
}: AnimatedListProps) => {
  const listRef = useRef<HTMLUListElement>(null);
  const enteredRef = useRef(false);

  // After every render: rows the list has not seen yet start hidden and pop in
  // (all together on the first entrance, one after another).
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return undefined;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const pose = HIDDEN[reduced ? 'fade' : animation];
    const ease = CSS.supports?.('transition-timing-function', 'linear(0, 1)')
      ? SPRING
      : 'cubic-bezier(0.34, 1.4, 0.64, 1)';
    // Rows still waiting (a render before the list came into view) count too.
    // A row marked data-al-still (a placeholder such as "Loading…" or an empty
    // state) is never animated: swapping one for the next must not pop twice.
    const fresh = [...list.children].filter(
      (el): el is HTMLElement =>
        el instanceof HTMLElement && el.dataset.alState !== 'in' && !('alStill' in el.dataset),
    );
    if (!fresh.length) return undefined;
    for (const row of fresh) {
      if (row.dataset.alState) continue;
      row.dataset.alState = 'below';
      row.style.transition = 'none';
      row.style.transform = pose;
      row.style.opacity = '0';
    }
    const reveal = () => {
      void list.offsetHeight;
      fresh.forEach((row, i) => {
        const delay = enteredRef.current ? 0 : i * Math.max(0, stagger);
        row.style.transition = `transform 620ms ${ease} ${delay}s, opacity 300ms cubic-bezier(0.22, 1, 0.36, 1) ${delay}s`;
        row.dataset.alState = 'in';
        row.style.transform = '';
        row.style.opacity = '';
      });
      enteredRef.current = true;
    };
    if (enteredRef.current || typeof IntersectionObserver === 'undefined') {
      const raf = requestAnimationFrame(reveal);
      return () => cancelAnimationFrame(raf);
    }
    const gate = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        gate.disconnect();
        reveal();
      },
      { rootMargin: '0px 0px -10% 0px' },
    );
    gate.observe(list);
    return () => gate.disconnect();
  });

  return (
    <ul ref={listRef} {...rest}>
      {children}
    </ul>
  );
};

export default AnimatedList;
