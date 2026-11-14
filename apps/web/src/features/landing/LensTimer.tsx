import { useRef, useState, type AnimationEvent, type CSSProperties } from 'react';
import { fallInStrips } from '../../ui/shred';

/** One round of the clock: the long hand goes round once in this time. */
const ROUND_MS = 10_000;
/** A mark starts to go this long before the long hand reaches it, so it is gone as the hand touches it. */
const LEAD_MS = 120;
/** Twelve marks round the face, like a clock's, one for each of the twelve
 *  minutes of a message's life. */
const MARKS = Array.from({ length: 12 }, (_, i) => {
  const a = (i / 12) * 2 * Math.PI;
  return {
    x: 50 + Math.sin(a) * 39,
    y: 50 - Math.cos(a) * 39,
    // The long hand starts at twelve and reaches mark i after i twelfths of the
    // round (the mark at twelve last, as the round closes).
    at: ((i === 0 ? 12 : i) / 12) * ROUND_MS - LEAD_MS,
  };
});

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

/** A new round: the short hand starts somewhere new each time. */
const newRound = (n: number) => ({ n, start: Math.round(Math.random() * 360) });

/** Pins the hands where they are and stops the face's animations, so the strips
 *  cut from it show this moment (a copy would start its animations again). */
function freeze(face: HTMLElement) {
  face.querySelectorAll<SVGElement | HTMLElement>('.lens-hand, .lens-sweep').forEach((el) => {
    el.style.transform = getComputedStyle(el).transform;
  });
  face.classList.add('is-still');
}

/**
 * A clock in the landing lens, a quick picture of a message's life rather than
 * a real countdown, made of the page's own material: soft raised hands, a knob
 * and twelve marks pressed out of the canvas colour. Each round the long hand goes
 * round once and wipes the marks away as it passes them, with a soft light
 * trailing it, while the short hand moves on from a random hour; when the long
 * hand is back at twelve the hands fall apart in strips (the chat's expiry
 * effect) and the marks come back one by one.
 * Decorative: the headline says it in words.
 */
export function LensTimer({ onRoundEnd }: { onRoundEnd?: () => Promise<void> }) {
  const [round, setRound] = useState(() => newRound(0));
  const faceRef = useRef<HTMLDivElement>(null);
  const endingRef = useRef(false);

  // The round ends with the long hand's own animation, so the strips always
  // start with the hand back at twelve. One after the other: the hands fall
  // away completely, then the lens flows to its new pattern (onRoundEnd), and
  // only when that has settled does the clock come back.
  const onTurned = async (e: AnimationEvent<SVGGElement>) => {
    if (e.animationName !== 'lens-turn' || endingRef.current) return;
    endingRef.current = true;
    const face = faceRef.current;
    if (face && !document.hidden && !reducedMotion()) {
      freeze(face);
      await fallInStrips(face, { calm: true }).catch(() => undefined);
    }
    await onRoundEnd?.();
    endingRef.current = false;
    setRound((r) => newRound(r.n + 1));
  };

  return (
    <div className="lens-timer" aria-hidden="true" style={{ '--round': `${ROUND_MS}ms` } as CSSProperties}>
      <svg className="lens-marks" viewBox="0 0 100 100" key={`marks-${round.n}`}>
        {MARKS.map((m, i) => (
          <circle
            key={i}
            className="lens-mark"
            style={{ '--i': i, '--at': `${m.at}ms` } as CSSProperties}
            cx={m.x}
            cy={m.y}
            r={i === 0 ? 2.3 : 1.8}
          />
        ))}
      </svg>
      <div className="lens-face" ref={faceRef} key={`face-${round.n}`}>
        <span className="lens-sweep" />
        <svg className="lens-hands" viewBox="0 0 100 100">
          <g className="lens-hand is-short" style={{ '--from': `${round.start}deg` } as CSSProperties}>
            <line x1="50" y1="52.5" x2="50" y2="30" />
          </g>
          <g className="lens-hand is-long" onAnimationEnd={(e) => void onTurned(e)}>
            <line x1="50" y1="56" x2="50" y2="17" />
          </g>
          <circle className="lens-knob" cx="50" cy="50" r="4.4" />
          <circle className="lens-knob-core" cx="50" cy="50" r="1.5" />
        </svg>
      </div>
    </div>
  );
}
