import { useEffect, useRef, useState } from 'react';
import { grainient } from '../../ui/pieces';

/** The brand amber, from the Dusk canvas up to the accent; Grainient's light
 *  mode turns the same ramp into its pale version for Mist. */
export const GLOW_COLORS = ['#1E2022', '#2B1806', '#7A3E0C', '#C8732A', '#F0A35E'];

/** The lens's own look in each theme, three colours each: Dusk deep amber,
 *  bright amber and cream, Mist cream, peach and soft amber, with
 *  firmer edges than a blur. The colours are given as they are (Grainient's
 *  light mode adds white and the dark end). Each colour covers about the same
 *  share of the round face at any angle: Grainient switches colour halfway
 *  between two stops, so the end stops are doubled to move the edges where a
 *  circle splits into about equal areas (3/8 and 5/8),
 *  and fitCircle spreads the ramp over the lens itself rather than the square
 *  canvas (whose corners hid the ends). */
const LENS_LOOK = {
  dusk: {
    colors: ['#A3520F', '#A3520F', '#F0A35E', '#F8D9B5', '#F8D9B5'],
    fitCircle: true,
    softness: 0.55,
    contrast: 1.1,
    saturation: 1.2,
    silk: 0.5,
  },
  mist: {
    colors: ['#FFF4DE', '#FFF4DE', '#FAD3A6', '#F2AE6E', '#F2AE6E'],
    fitCircle: true,
    softness: 0.22,
    contrast: 1,
    saturation: 1.1,
    silk: 0.6,
  },
};

/** How long the lens takes to move from one pattern to the next (slow, so the
 *  change reads as a calm flow rather than a jump). */
export const MORPH_MS = 4000;

type Pattern = { angle: number; variation: number; scale: number; flow: number };

const START: Pattern = { angle: 55, variation: 0, scale: 1, flow: 0.8 };

/** Somewhere clearly different from `from`: the gradient turns a quarter to
 *  three quarters round and its size and waves change. The noise itself only
 *  moves a little: it used to jump 2 to 5 (6 to 16 noise cells), and scrolling
 *  that much noise through the lens in a few seconds made it shimmer. */
function nextPattern(from: Pattern): Pattern {
  return {
    angle: from.angle + 90 + Math.random() * 180,
    variation: from.variation + 0.3 + Math.random() * 0.3,
    scale: 0.7 + Math.random() * 0.7,
    flow: 0.5 + Math.random() * 0.7,
  };
}

/** Gentle at both ends and at most about 1.6 times the average speed in the
 *  middle (the cubic curve before peaked at 3 times). */
const easeInOut = (t: number) => (1 - Math.cos(Math.PI * t)) / 2;

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

/**
 * The moving gradient inside the landing lens. Each time `turn` changes (a new
 * round of the lens clock) it flows over to a new pattern.
 */
export function LensPattern({ turn, light }: { turn: number; light: boolean }) {
  const [pattern, setPattern] = useState<Pattern>(START);
  const shownRef = useRef<Pattern>(START);

  useEffect(() => {
    if (turn === 0) return undefined;
    const from = shownRef.current;
    const to = nextPattern(from);
    if (reducedMotion()) {
      shownRef.current = to;
      setPattern(to);
      return undefined;
    }
    let raf = 0;
    const started = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - started) / MORPH_MS);
      const k = easeInOut(t);
      const p: Pattern = {
        angle: from.angle + (to.angle - from.angle) * k,
        variation: from.variation + (to.variation - from.variation) * k,
        scale: from.scale + (to.scale - from.scale) * k,
        flow: from.flow + (to.flow - from.flow) * k,
      };
      shownRef.current = p;
      setPattern(p);
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [turn]);

  return (
    <grainient.Piece
      fallback={null}
      {...(light ? LENS_LOOK.mist : LENS_LOOK.dusk)}
      grainAmount={0}
      interactive={false}
      clickSwirl={false}
      angle={pattern.angle}
      variation={pattern.variation}
      scale={pattern.scale}
      flow={pattern.flow}
    />
  );
}
