// From React Bits (reactbits.dev), MIT + Commons Clause: see LICENSE.md in this folder.
// Anonyma: the recorder (press to record, slide to cancel, the clock and its own
// microphone) is reduced to the call's mute button. `open` says you are
// speaking (the call already knows); while it is, the button widens into live
// level bars drawn from `level()`, read from the call's own microphone track.
// The bars and the widening are React Bits' Voice Pill; the rest is a toggle.
import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import './VoicePill.css';

export interface VoicePillProps {
  /** You are speaking: widen and draw the level bars. */
  open: boolean;
  /** The microphone level now, 0 to 1 (any scale: the bars adapt to it). */
  level?: () => number;
  onToggle: () => void;
  /** The glyph (microphone on or off). */
  icon: ReactNode;
  accentColor?: string;
  size?: number;
  attack?: number;
  release?: number;
  floor?: number;
  openDuration?: number;
  disabled?: boolean;
  ariaLabel?: string;
  ariaPressed?: boolean;
  title?: string;
  className?: string;
}

interface Wave {
  hist: number[];
  tick: number;
  acc: number;
}

const DT_MAX = 0.05;

/** How wide the level bars open (px) for a pill of `size`: the dock reads it too. */
export const voicePillWaveWidth = (size = 48) => Math.round(size * 1.9);
const WAVE_EVERY = 4;
const WAVE_MAX = 80;

const drawWave = (s: Wave, canvas: HTMLCanvasElement, level: number, color: string, floor: number) => {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const rect = canvas.getBoundingClientRect();
  const W = Math.max(1, Math.round(rect.width * dpr));
  const H = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== W || canvas.height !== H) {
    canvas.width = W;
    canvas.height = H;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  s.acc = Math.max(s.acc, level);
  s.tick = (s.tick + 1) % WAVE_EVERY;
  if (s.tick === 0) {
    s.hist.push(s.acc);
    s.acc = 0;
    if (s.hist.length > WAVE_MAX) s.hist.shift();
  }
  const bw = 2 * dpr;
  const step = 3 * dpr;
  const shift = (s.tick / WAVE_EVERY) * step;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = color;
  for (let i = 0; i < s.hist.length; i += 1) {
    const v = s.hist[s.hist.length - 1 - i];
    const x = W - (i + 1) * step - shift;
    if (x + bw < 0) break;
    const h = Math.max(bw, (floor + (1 - floor) * v) * H);
    const t = Math.min(1, Math.max(0, (x + bw / 2) / (W * 0.55)));
    const fade = t * t * (3 - 2 * t);
    ctx.globalAlpha = (0.35 + 0.65 * v) * fade;
    ctx.beginPath();
    ctx.roundRect(x, (H - h) / 2, bw, h, bw / 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
};

const VoicePill = ({
  open,
  level,
  onToggle,
  icon,
  accentColor = '#f5f5f5',
  size = 48,
  attack = 40,
  release = 240,
  floor = 0.1,
  openDuration = 220,
  disabled = false,
  ariaLabel = 'Microphone',
  ariaPressed,
  title,
  className = '',
}: VoicePillProps) => {
  const rootRef = useRef<HTMLButtonElement>(null);
  const waveRef = useRef<HTMLCanvasElement>(null);
  const levelRef = useRef(level);
  levelRef.current = level;

  // While open: follow the level with React Bits' attack / release envelope,
  // scaled by a slowly falling peak so quiet and loud microphones both fill
  // the bars, and draw them. Nothing runs while closed.
  useEffect(() => {
    if (!open || disabled) return undefined;
    const root = rootRef.current;
    const color = (root && getComputedStyle(root).getPropertyValue('--vp-accent').trim()) || accentColor;
    const wave: Wave = { hist: [], tick: 0, acc: 0 };
    let env = 0;
    let peak = 0.05;
    let last = performance.now();
    let raf = 0;
    const frame = (now: number) => {
      const dt = Math.min((now - last) / 1000, DT_MAX);
      last = now;
      const raw = Math.max(0, levelRef.current?.() ?? 0);
      peak = Math.max(raw, peak * Math.exp(-dt / 3), 0.05);
      const target = Math.min(1, raw / peak);
      const tau = Math.max(1, target > env ? attack : release) / 1000;
      env += (target - env) * (1 - Math.exp(-dt / tau));
      if (waveRef.current) drawWave(wave, waveRef.current, env, color, floor);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [open, disabled, attack, release, floor, accentColor]);

  const waveW = voicePillWaveWidth(size);

  return (
    <button
      ref={rootRef}
      type="button"
      disabled={disabled}
      aria-label={ariaLabel}
      aria-pressed={ariaPressed}
      title={title}
      className={`voice-pill${className ? ` ${className}` : ''}`}
      data-state={open && !disabled ? 'listening' : 'idle'}
      onClick={onToggle}
      style={
        {
          '--vp-accent': accentColor,
          '--vp-size': `${size}px`,
          '--vp-radius': `${size / 2}px`,
          '--vp-wave-w': `${waveW}px`,
          '--vp-icon-size': `${Math.round(size * 0.4)}px`,
          '--vp-open': `${openDuration}ms`,
        } as CSSProperties
      }
    >
      <span className="voice-pill__capsule" aria-hidden="true" />
      <canvas ref={waveRef} className="voice-pill__wave" aria-hidden="true" />
      <span className="voice-pill__glyph">
        <span className="voice-pill__mic">{icon}</span>
      </span>
    </button>
  );
};

export default VoicePill;
