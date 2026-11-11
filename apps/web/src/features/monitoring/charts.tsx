import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent, ReactNode, RefObject } from 'react';
import type { MonitoringPoint } from '../../api/client';

/* Shared pieces of the /monitoring pages: formats, colours, charts, tiles. */

/* Series colours: the site's own tokens, so both themes carry them. */
export const C = {
  crimson: 'var(--accent)',
  amber: 'var(--mode-voice)',
  sand: 'var(--mode-voice)',
  green: 'var(--online)',
  ink: 'var(--ink-soft)',
  danger: 'var(--danger)',
};

export interface Line {
  name: string;
  color: string;
  points: MonitoringPoint[];
}

export type Format = (v: number) => string;

export const fmtCount: Format = (v) => Math.round(v).toLocaleString('en-US');
/** Axis ticks of a count chart: a half step reads 2.5, not 3. */
export const fmtCountTick: Format = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1));
export const fmtRate: Format = (v) =>
  v === 0 ? '0' : v < 0.01 ? '<0.01' : v < 10 ? v.toFixed(2) : v.toFixed(1);
export const fmtMs: Format = (v) =>
  v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${Math.round(v)} ms`;
export const fmtPct = (v: number) => `${(v * 100).toFixed(v >= 0.9995 || v === 0 ? 0 : 2)}%`;

export function clock(t: number): string {
  return new Date(t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function niceMax(v: number, floor: number): number {
  const m = Math.max(v, floor);
  const mag = 10 ** Math.floor(Math.log10(m));
  for (const step of [1, 2, 2.5, 5, 10]) {
    if (m <= step * mag) return step * mag;
  }
  return 10 * mag;
}

function useWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    ro.observe(el);
    setWidth(Math.floor(el.getBoundingClientRect().width));
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

/** Time-series chart: lines (or stacked areas) in plain SVG. */
export function TimeChart({
  lines,
  format,
  axisFormat,
  softMax,
  stacked = false,
  height = 180,
  label,
}: {
  lines: Line[];
  format: Format;
  axisFormat?: Format;
  softMax: number;
  stacked?: boolean;
  height?: number;
  label: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const stamps = useMemo(() => lines[0]?.points.map((p) => p[0]) ?? [], [lines]);

  const layers = useMemo(() => {
    const base = stamps.map(() => 0);
    return lines.map((l) => {
      const top = l.points.map((p, i) => {
        const v = p[1];
        if (v === null) return null;
        return stacked ? base[i] + v : v;
      });
      const bottom = stacked ? [...base] : stamps.map(() => 0);
      if (stacked) top.forEach((v, i) => (base[i] = v ?? base[i]));
      return { ...l, top, bottom };
    });
  }, [lines, stacked, stamps]);

  const max = niceMax(
    Math.max(0, ...layers.flatMap((l) => l.top.filter((v): v is number => v !== null))) * 1.08,
    softMax,
  );

  const padL = 44;
  const padR = 8;
  const padT = 8;
  const padB = 22;
  const w = Math.max(width, 120);
  const plotW = w - padL - padR;
  const plotH = height - padT - padB;
  const n = Math.max(stamps.length - 1, 1);
  const x = (i: number) => padL + (i / n) * plotW;
  const y = (v: number) => padT + plotH - (v / max) * plotH;

  const path = (vals: (number | null)[]) => {
    let d = '';
    let pen = false;
    vals.forEach((v, i) => {
      if (v === null) {
        pen = false;
        return;
      }
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  const area = (top: (number | null)[], bottom: number[]) => {
    const parts: string[] = [];
    let run: number[] = [];
    const flush = () => {
      if (run.length > 1) {
        const up = run.map((i) => `${x(i).toFixed(1)},${y(top[i] as number).toFixed(1)}`).join('L');
        const down = [...run]
          .reverse()
          .map((i) => `${x(i).toFixed(1)},${y(bottom[i]).toFixed(1)}`)
          .join('L');
        parts.push(`M${up}L${down}Z`);
      }
      run = [];
    };
    top.forEach((v, i) => (v === null ? flush() : run.push(i)));
    flush();
    return parts.join('');
  };

  const ticks = [0, max / 2, max];
  const xTicks = stamps.length ? [0, Math.floor(n / 2), n] : [];
  const gradId = useMemo(() => `g${Math.random().toString(36).slice(2, 8)}`, []);

  // Pointer events: mouse hover, and a tap or drag on touch screens.
  function onMove(e: PointerEvent<SVGSVGElement>) {
    const box = e.currentTarget.getBoundingClientRect();
    const rel = (e.clientX - box.left - padL) / plotW;
    if (rel < 0 || rel > 1 || !stamps.length) return setHover(null);
    setHover(Math.round(rel * n));
  }

  // Screen readers get the newest values in the chart's label (the tooltip is
  // pointer-only).
  const lastIdx = stamps.length - 1;
  const latestSummary =
    lastIdx >= 0
      ? [...lines]
          .map((l) => ({ name: l.name, v: l.points[lastIdx]?.[1] ?? null }))
          .filter((r) => r.v !== null)
          .sort((a, b) => (b.v as number) - (a.v as number))
          .slice(0, 6)
          .map((r) => `${r.name} ${format(r.v as number)}`)
          .join(', ')
      : '';
  const ariaLabel = latestSummary ? `${label}. Latest: ${latestSummary}.` : label;

  if (!lines.length) {
    return (
      <div className="mon-chart" ref={ref}>
        <p className="muted mon-nodata">No data yet.</p>
      </div>
    );
  }

  return (
    <div className="mon-chart" ref={ref}>
      {width > 0 ? (
        <svg
          width={w}
          height={height}
          role="img"
          aria-label={ariaLabel}
          onPointerMove={onMove}
          onPointerDown={onMove}
          onPointerLeave={(e) => {
            if (e.pointerType === 'mouse') setHover(null);
          }}
        >
          <defs>
            {layers.map((l, k) => (
              <linearGradient key={k} id={`${gradId}-${k}`} x1="0" y1="0" x2="0" y2="1">
                <stop
                  offset="0%"
                  style={{ stopColor: l.color, stopOpacity: stacked ? 0.55 : 0.28 }}
                />
                <stop
                  offset="100%"
                  style={{ stopColor: l.color, stopOpacity: stacked ? 0.3 : 0 }}
                />
              </linearGradient>
            ))}
          </defs>
          {ticks.map((t, i) => (
            <g key={i}>
              <line x1={padL} x2={w - padR} y1={y(t)} y2={y(t)} className="mon-grid" />
              <text x={padL - 8} y={y(t) + 4} className="mon-axis" textAnchor="end">
                {(axisFormat ?? format)(t)}
              </text>
            </g>
          ))}
          {xTicks.map((i, k) => (
            <text
              key={k}
              x={x(i)}
              y={height - 4}
              className="mon-axis"
              textAnchor={k === 0 ? 'start' : k === 2 ? 'end' : 'middle'}
            >
              {clock(stamps[i])}
            </text>
          ))}
          {layers.map((l, k) => (
            <path
              key={`a${k}`}
              d={area(l.top, l.bottom)}
              style={{ fill: `url(#${gradId}-${k})` }}
            />
          ))}
          {layers.map((l, k) => (
            <path
              key={`l${k}`}
              d={path(l.top)}
              style={{ stroke: l.color }}
              className="mon-line"
              fill="none"
            />
          ))}
          {hover !== null ? (
            <g>
              <line
                x1={x(hover)}
                x2={x(hover)}
                y1={padT}
                y2={padT + plotH}
                className="mon-cursor"
              />
              {layers.map((l, k) =>
                l.top[hover] !== null ? (
                  <circle
                    key={k}
                    cx={x(hover)}
                    cy={y(l.top[hover] as number)}
                    r={3.5}
                    style={{ fill: l.color }}
                  />
                ) : null,
              )}
            </g>
          ) : null}
        </svg>
      ) : null}
      {hover !== null && stamps[hover] !== undefined
        ? (() => {
            // Beside the cursor, never over it: right of it in the left half, left
            // of it in the right half. Centred on the cursor it hid the very point
            // being read, worst on charts with many series.
            const cx = x(hover);
            const onLeftHalf = cx < w / 2;
            const rows = [...lines]
              .map((l) => ({ l, v: l.points[hover]?.[1] ?? null }))
              .sort((a, b) => (b.v ?? -Infinity) - (a.v ?? -Infinity));
            const crowded = rows.length > 8;
            return (
              <div
                className={`mon-tip${crowded ? ' two-col' : ''}`}
                style={
                  onLeftHalf
                    ? { left: Math.min(cx + 14, Math.max(w - 150, 0)) }
                    : { right: Math.min(w - cx + 14, Math.max(w - 150, 0)) }
                }
              >
                <div className="mon-tip-time">{clock(stamps[hover])}</div>
                <div className="mon-tip-rows">
                  {rows.map(({ l, v }) => (
                    <div key={l.name} className="mon-tip-row">
                      <span className="mon-swatch" style={{ background: l.color }} />
                      {l.name}
                      <strong>{v === null ? '–' : format(v)}</strong>
                    </div>
                  ))}
                </div>
              </div>
            );
          })()
        : null}
      <div className="mon-legend">
        {lines.map((l) => (
          <span key={l.name}>
            <span className="mon-swatch" style={{ background: l.color }} />
            {l.name}
          </span>
        ))}
      </div>
    </div>
  );
}

/** A tiny trend line under a headline number. */
export function Spark({ points, color }: { points: MonitoringPoint[]; color: string }) {
  const vals = points.map((p) => p[1]);
  const real = vals.filter((v): v is number => v !== null);
  const max = Math.max(...real, 0);
  if (real.length < 2) return <div className="mon-spark" />;
  const d = vals
    .map((v, i) =>
      v === null
        ? ''
        : `${i === 0 ? 'M' : 'L'}${((i / (vals.length - 1)) * 100).toFixed(2)},${(38 - (max ? (v / max) * 34 : 0)).toFixed(2)}`,
    )
    .join('')
    .replace(/^L/, 'M');
  return (
    <svg className="mon-spark" viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true">
      <path d={d} style={{ stroke: color }} fill="none" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

// Big numbers count to their value (React Bits Count Up) and roll on refresh;
// the plain text shows until it loads, and for values that are not numbers.
// The counting effect loads on its own (it needs the animation library). Once
// it has loaded it renders directly: going through Suspense again would hold
// the plain number for React's reveal delay and then restart the count.
type CountUpComponent = typeof import('../../ui/reactbits/CountUp').default;
let CountUp: CountUpComponent | null = null;
let countUpModule: Promise<CountUpComponent> | null = null;
const loadCountUp = () =>
  (countUpModule ??= import('../../ui/reactbits/CountUp').then((mod) => {
    CountUp = mod.default;
    return mod.default;
  }));

/** Tiles whose number was on screen as plain text before the effect loaded:
 *  they stay put instead of dropping to zero and counting again. Kept outside
 *  the component, which can remount, and cleared when the page opens. */
const shownPlain = new Set<string>();

/** Called when the monitoring page opens, so the effect is ready before the data. */
export function preloadCountUp(): void {
  shownPlain.clear();
  void loadCountUp();
}

// The chunk is small and its animation library is already loading for the
// theme switch: start it with the app, so a first visit to /monitoring counts too.
if (typeof window !== 'undefined') {
  window.setTimeout(preloadCountUp, 0);
}

function TileValue({ id, value }: { id: string; value: string }) {
  const [Impl, setImpl] = useState<CountUpComponent | null>(() => CountUp);
  useEffect(() => {
    if (Impl) return;
    let alive = true;
    void loadCountUp()
      .then((c) => {
        if (alive) setImpl(() => c);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [Impl]);
  const m = /^(-?\d+(?:\.\d+)?)(\D*)$/.exec(value.replace(/,/g, ''));
  if (!m) return <>{value}</>;
  if (!Impl) {
    shownPlain.add(id);
    return <>{value}</>;
  }
  const to = Number(m[1]);
  const decimals = m[1]!.includes('.') ? m[1]!.split('.')[1]!.length : 0;
  // Later refreshes roll from the shown value.
  return (
    <Impl
      to={to}
      from={shownPlain.has(id) ? to : 0}
      decimals={decimals}
      suffix={m[2]}
      duration={1.1}
      trigger="load"
    />
  );
}

export function Tile({
  label,
  value,
  color,
  spark,
  small = false,
}: {
  label: string;
  value: string;
  color: string;
  spark?: MonitoringPoint[];
  small?: boolean;
}) {
  return (
    <div className={`mon-tile${small ? ' mon-tile-small' : ''}`}>
      <span className="mon-tile-label">{label}</span>
      <span className="mon-tile-value" style={{ color }}>
        <TileValue id={label} value={value} />
      </span>
      {spark ? <Spark points={spark} color={color} /> : null}
    </div>
  );
}

export function Card({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: ReactNode;
}) {
  return (
    <section className="mon-card">
      <header>
        {/* h2 under the page's h1 (an h3 skipped a level). */}
        <h2>{title}</h2>
        {note ? <span className="muted">{note}</span> : null}
      </header>
      {children}
    </section>
  );
}

export const fmtBytes: Format = (v) => {
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let n = v;
  let i = 0;
  while (Math.abs(n) >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
};
export const fmtBytesRate: Format = (v) => `${fmtBytes(v)}/s`;
export const fmtCores: Format = (v) =>
  v === 0 ? '0' : v < 0.001 ? '<0.001' : v < 1 ? v.toFixed(3) : v.toFixed(2);

export const show = (v: number | null | undefined, f: Format) =>
  v === null || v === undefined ? '–' : f(v);

/* Fixed colours for known names; everything else takes the palette in order. */
const KNOWN: Record<string, string> = {
  all: 'var(--ink-soft)',
  text: 'var(--accent)',
  voice: 'var(--mode-voice)',
  video: 'var(--mode-voice)',
  '2xx': 'var(--online)',
  '3xx': 'var(--ink-soft)',
  '4xx': 'var(--mode-voice)',
  '5xx': 'var(--danger)',
  gateway: 'var(--accent)',
  core: 'var(--mode-voice)',
  match: 'var(--mode-voice)',
  realtime: '#e8707a',
  web: 'var(--online)',
  postgres: '#b5525a',
  mongo: '#5f9e8f',
  redis: '#f2a65a',
  rabbitmq: '#8f5bb5',
  prometheus: '#9a8a86',
  grafana: '#6d7f9a',
  'kube-state-metrics': '#7a8a3a',
  send: 'var(--accent)',
  edit: 'var(--mode-voice)',
  delete: 'var(--ink-soft)',
  react: 'var(--mode-voice)',
  public: 'var(--online)',
  private: 'var(--accent)',
};
const PALETTE = [
  'var(--accent)',
  'var(--mode-voice)',
  'var(--online)',
  '#8f5bb5',
  '#3b82a0',
  'var(--mode-voice)',
  '#e8707a',
  '#7a8a3a',
  '#d4a017',
  '#6d7f9a',
  '#2f8f8f',
  '#a0522d',
];

/** Lines out of a breakdown: known names keep their colour, the rest share the palette. */
export function linesOf(
  breakdown: Record<string, MonitoringPoint[]> | undefined,
  prefix = '',
): Line[] {
  if (!breakdown) return [];
  let next = 0;
  return Object.entries(breakdown).map(([name, points]) => ({
    name: `${prefix}${name}`,
    color: KNOWN[name] ?? PALETTE[next++ % PALETTE.length],
    points,
  }));
}

/** Horizontal bars, one per name: a share between 0 and 1. */
export function BarList({ values }: { values: Record<string, number> }) {
  const rows = Object.entries(values).sort((a, b) => a[0].localeCompare(b[0]));
  if (!rows.length) return <p className="muted">No data yet.</p>;
  return (
    <ul className="mon-bars">
      {rows.map(([name, v]) => (
        <li key={name}>
          <span className="mon-bar-name">{name}</span>
          <span className="mon-bar-track">
            <span
              className={`mon-bar-fill${v < 1 ? ' mon-bar-short' : ''}`}
              style={{ width: `${Math.max(0, Math.min(1, v)) * 100}%` }}
            />
          </span>
          <strong>{fmtPct(v)}</strong>
        </li>
      ))}
    </ul>
  );
}
