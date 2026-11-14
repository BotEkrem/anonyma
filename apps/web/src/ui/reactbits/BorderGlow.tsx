// From React Bits (reactbits.dev), MIT + Commons Clause: see LICENSE.md in this folder.
// Anonyma: reduced to the glowing edge, laid over a call tile instead of being a
// card of its own (no fill, no pointer tracking, no shadow). While `active` (the
// person is speaking) the edge light comes up and its cone keeps turning round
// the tile; it fades out when they stop. React Bits' mesh-gradient border, its
// soft edge fill and the glow's layered shadows are the same; reduced motion
// keeps the cone still.
import { useEffect, useRef, type CSSProperties } from 'react';
import './BorderGlow.css';

export interface BorderGlowProps {
  active: boolean;
  /** Three colours for the mesh border. */
  colors?: string[];
  /** The glow's own colour, as "h s l" (React Bits' format). */
  glowColor?: string;
  glowIntensity?: number;
  borderRadius?: number;
  coneSpread?: number;
  /** Seconds for the cone to go round once. */
  period?: number;
  className?: string;
}

function parseHSL(hslStr: string): { h: number; s: number; l: number } {
  const match = hslStr.match(/([\d.]+)\s*([\d.]+)%?\s*([\d.]+)%?/);
  if (!match) return { h: 40, s: 80, l: 80 };
  return { h: parseFloat(match[1]), s: parseFloat(match[2]), l: parseFloat(match[3]) };
}

function buildGlowVars(glowColor: string, intensity: number): Record<string, string> {
  const { h, s, l } = parseHSL(glowColor);
  const base = `${h}deg ${s}% ${l}%`;
  const opacities = [100, 60, 50, 40, 30, 20, 10];
  const keys = ['', '-60', '-50', '-40', '-30', '-20', '-10'];
  const vars: Record<string, string> = {};
  for (let i = 0; i < opacities.length; i++) {
    vars[`--glow-color${keys[i]}`] = `hsl(${base} / ${Math.min(opacities[i] * intensity, 100)}%)`;
  }
  return vars;
}

const GRADIENT_POSITIONS = [
  '80% 55%',
  '69% 34%',
  '8% 6%',
  '41% 38%',
  '86% 85%',
  '82% 18%',
  '51% 4%',
];
const GRADIENT_KEYS = [
  '--gradient-one',
  '--gradient-two',
  '--gradient-three',
  '--gradient-four',
  '--gradient-five',
  '--gradient-six',
  '--gradient-seven',
];
const COLOR_MAP = [0, 1, 2, 0, 1, 2, 1];

function buildGradientVars(colors: string[]): Record<string, string> {
  const vars: Record<string, string> = {};
  for (let i = 0; i < 7; i++) {
    const c = colors[Math.min(COLOR_MAP[i], colors.length - 1)];
    vars[GRADIENT_KEYS[i]] =
      `radial-gradient(at ${GRADIENT_POSITIONS[i]}, ${c} 0px, transparent 50%)`;
  }
  vars['--gradient-base'] = `linear-gradient(${colors[0]} 0 100%)`;
  return vars;
}

const BorderGlow = ({
  active,
  colors = ['#F0A35E', '#C8732A', '#F8D9B5'],
  glowColor = '28 82 66',
  glowIntensity = 1,
  borderRadius = 16,
  coneSpread = 25,
  period = 3.2,
  className = '',
}: BorderGlowProps) => {
  const ref = useRef<HTMLSpanElement>(null);

  // Turn the cone while speaking (React Bits drives --cursor-angle from the
  // pointer or a one-off sweep; here it is a steady turn).
  useEffect(() => {
    const el = ref.current;
    if (!active || !el) return undefined;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      el.style.setProperty('--cursor-angle', '135deg');
      return undefined;
    }
    let raf = 0;
    const start = performance.now();
    const from = parseFloat(el.style.getPropertyValue('--cursor-angle')) || 0;
    const frame = (now: number) => {
      const angle = (from + ((now - start) / 1000 / Math.max(0.5, period)) * 360) % 360;
      el.style.setProperty('--cursor-angle', `${angle.toFixed(2)}deg`);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [active, period]);

  return (
    <span
      ref={ref}
      aria-hidden="true"
      className={`border-glow${className ? ` ${className}` : ''}`}
      data-active={active ? '' : undefined}
      style={
        {
          '--border-radius': `${borderRadius}px`,
          '--cone-spread': coneSpread,
          ...buildGlowVars(glowColor, glowIntensity),
          ...buildGradientVars(colors),
        } as CSSProperties
      }
    >
      <span className="border-glow__light" />
    </span>
  );
};

export default BorderGlow;
