import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import {
  SENSITIVITY_MAX_DB,
  SENSITIVITY_OFF_DB,
  parseSensitivity,
  sensitivityShare,
} from './sensitivity';

/** How fast the shown level falls back after a sound (dB per second). */
const FALL_DB_PER_S = 45;
/** A set level not in effect for this long is said so (ms): not the moment it is being put on. */
const IDLE_AFTER_MS = 1000;

/**
 * Input sensitivity in the call's settings: one bar that shows how loud your
 * microphone is right now, and on it the thumb you set. Sound left of the
 * thumb is not sent; the far left is off (everything is sent).
 *
 * Seeing your own level under the thumb is the point: you speak, watch where
 * your voice reaches, and put the line under it and above the room.
 */
export function InputSensitivity(props: {
  /** The threshold (dBFS); null: off. */
  value: number | null;
  onChange: (value: number | null) => void;
  /** Your microphone's loudest level since the last read (dBFS); null: nothing to show. */
  readDb: () => number | null;
  /** The cut is really on the microphone now (it fails open: see voiceChain.ts). */
  isCutting: () => boolean;
  muted: boolean;
}) {
  const { value, onChange, readDb, isCutting, muted } = props;
  const cuttingRef = useRef(isCutting);
  cuttingRef.current = isCutting;
  // Whether a set level has failed to take effect for a while (a browser that
  // has not let the call's sound start, a gate that came off): said in the
  // hint, so the bar never claims a cut that is not happening.
  const [idle, setIdle] = useState(false);
  const labelId = useId();
  const barRef = useRef<HTMLDivElement | null>(null);
  const readRef = useRef(readDb);
  readRef.current = readDb;
  const valueRef = useRef(value);
  valueRef.current = value;

  // The level follows the microphone every frame (a held peak, falling back
  // gently, so a word stays readable); React is not involved.
  useEffect(() => {
    let raf = 0;
    let shown = -100;
    let last = performance.now();
    let idleSince: number | null = null;
    let idleShown = false;
    const frame = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const read = readRef.current();
      shown = Math.max(read ?? -100, shown - FALL_DB_PER_S * dt);
      const bar = barRef.current;
      if (bar) {
        bar.style.setProperty('--level', sensitivityShare(shown).toFixed(4));
        bar.dataset.quiet = shown <= SENSITIVITY_OFF_DB ? 'true' : 'false';
        const threshold = valueRef.current;
        bar.dataset.passing = threshold === null || shown >= threshold ? 'true' : 'false';
      }
      const waiting = valueRef.current !== null && !cuttingRef.current();
      idleSince = waiting ? (idleSince ?? now) : null;
      const nextIdle = idleSince !== null && now - idleSince > IDLE_AFTER_MS;
      if (nextIdle !== idleShown) {
        idleShown = nextIdle;
        setIdle(nextIdle);
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  const valueText = value === null ? 'Off' : `${value} dB`;
  const hint = muted
    ? 'Unmute to see your level.'
    : value === null
      ? 'Off: everything your microphone hears is sent.'
      : idle
        ? 'Not active right now, so everything is sent.'
        : 'Sound left of the line is not sent.';
  return (
    <div className="media-device-field media-sensitivity">
      <span className="media-sensitivity-head">
        <span id={labelId}>Input sensitivity</span>
        <span className="media-sensitivity-value" aria-hidden="true">
          {valueText}
        </span>
      </span>
      <div
        ref={barRef}
        className="media-sensitivity-bar"
        data-off={value === null ? 'true' : 'false'}
        style={{ '--cut': sensitivityShare(value ?? SENSITIVITY_OFF_DB).toFixed(4) } as CSSProperties}
      >
        <span className="media-sensitivity-level" aria-hidden="true" />
        <input
          type="range"
          min={SENSITIVITY_OFF_DB}
          max={SENSITIVITY_MAX_DB}
          step={1}
          value={value ?? SENSITIVITY_OFF_DB}
          aria-labelledby={labelId}
          aria-valuetext={valueText}
          onChange={(e) => onChange(parseSensitivity(e.target.value))}
        />
      </div>
      <span className="media-sensitivity-hint">{hint}</span>
    </div>
  );
}
