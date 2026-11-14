// From React Bits (reactbits.dev), MIT + Commons Clause: see LICENSE.md in this folder.
// Anonyma: reduced to the chat's message box. The @ sources, / commands, model
// and effort pickers, attachments, dictation and the effort sparks are gone; the
// text is controlled by the page (edits, drafts and the typing signal live
// there). What stays is React Bits' field: a box that grows with the text up to
// `maxRows`, Enter to send and Shift+Enter for a new line, and the send button
// inside the box whose glyph morphs with a little squash and tilt, here between
// the arrow (send) and a tick (save an edit) instead of arrow and stop. The morph
// runs on requestAnimationFrame instead of Motion, so the box needs no lazy load.
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
} from 'react';
import './PromptBar.css';

export interface PromptBarProps {
  value: string;
  onChange: (value: string) => void;
  /** Enter or the send button, with something in the box. */
  onSubmit: () => void;
  /** 'save' shows a tick instead of the arrow (editing a message). */
  mode?: 'send' | 'save';
  inputRef?: Ref<HTMLTextAreaElement>;
  id?: string;
  placeholder?: string;
  maxLength?: number;
  disabled?: boolean;
  /** Runs first; preventDefault() there stops Enter from sending. */
  onKeyDown?: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  onBlur?: () => void;
  /** Wraps the send button (the chat puts Click Spark round it). */
  wrapSend?: (button: ReactElement) => ReactNode;
  background?: string;
  color?: string;
  sendColor?: string;
  sendInk?: string;
  radius?: number;
  maxRows?: number;
  morphDuration?: number;
  squash?: number;
  tilt?: number;
  pressScale?: number;
  className?: string;
}

const ARROW_UP = [12, 4.5, 18.5, 11, 14.25, 11, 14.25, 19.5, 9.75, 19.5, 9.75, 11, 5.5, 11];
// A tick with the arrow's seven corners, in the same turn, so each corner has
// somewhere to go: the long arm's end, down its outer edge to the elbow, the
// short arm's end, and back along the inner edge.
const TICK = [18.5, 6.2, 19.8, 7.6, 14.9, 13, 10, 18.4, 4.2, 12.7, 5.5, 11.3, 10, 15.9];
const LINE = 22;

const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const pathAt = (a: number[], b: number[], t: number) => {
  let d = '';
  for (let i = 0; i < a.length; i += 2) {
    d += `${i ? 'L' : 'M'}${mix(a[i], b[i], t).toFixed(2)} ${mix(a[i + 1], b[i + 1], t).toFixed(2)}`;
  }
  return `${d}Z`;
};
// React Bits' cubic-bezier(0.77, 0, 0.175, 1) is the ease-in-out quart.
const easeInOutQuart = (t: number) => (t < 0.5 ? 8 * t ** 4 : 1 - (-2 * t + 2) ** 4 / 2);
const reducedMotion = () =>
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

function SendGlyph({
  tick,
  morphDuration,
  squash,
  tilt,
}: {
  tick: boolean;
  morphDuration: number;
  squash: number;
  tilt: number;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const pathRef = useRef<SVGPathElement>(null);
  const t = useRef(tick ? 1 : 0);

  useEffect(() => {
    const target = tick ? 1 : 0;
    const dir = tick ? 1 : -1;
    const from = t.current;
    if (from === target) return undefined;
    const paint = (v: number, goo: number) => {
      t.current = v;
      pathRef.current?.setAttribute('d', pathAt(ARROW_UP, TICK, v));
      const sx = 1 - squash * goo;
      if (svgRef.current) {
        svgRef.current.style.transform = goo
          ? `rotate(${dir * tilt * goo}deg) scale(${sx}, ${1 / sx})`
          : '';
      }
    };
    if (reducedMotion()) {
      paint(target, 0);
      return undefined;
    }
    const span = Math.max(1, morphDuration * Math.abs(target - from));
    const start = performance.now();
    let raf = 0;
    const frame = (now: number) => {
      const k = Math.min(1, (now - start) / span);
      const v = mix(from, target, easeInOutQuart(k));
      paint(v, k < 1 ? Math.sin(v * Math.PI) : 0);
      if (k < 1) raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [tick, morphDuration, squash, tilt]);

  return (
    <svg
      ref={svgRef}
      className="prompt-bar__glyph"
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="currentColor"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinejoin="round"
    >
      <path ref={pathRef} d={pathAt(ARROW_UP, TICK, t.current)} />
    </svg>
  );
}

const PromptBar = ({
  value,
  onChange,
  onSubmit,
  mode = 'send',
  inputRef,
  id,
  placeholder = 'Ask anything',
  maxLength,
  disabled = false,
  onKeyDown,
  onBlur,
  wrapSend,
  background = '#27272a',
  color = '#f5f5f5',
  sendColor,
  sendInk,
  radius = 16,
  maxRows = 5,
  morphDuration = 240,
  squash = 0.12,
  tilt = 8,
  pressScale = 0.96,
  className = '',
}: PromptBarProps) => {
  const ownRef = useRef<HTMLTextAreaElement | null>(null);
  const sendRef = useRef<HTMLButtonElement>(null);
  const [pressed, setPressed] = useState(false);
  const armed = !disabled && value.trim().length > 0;
  const label = mode === 'save' ? 'Save' : 'Send';

  const setInput = (el: HTMLTextAreaElement | null) => {
    ownRef.current = el;
    if (typeof inputRef === 'function') inputRef(el);
    else if (inputRef) inputRef.current = el;
  };

  // Grow with the text, then scroll inside once it reaches maxRows.
  useLayoutEffect(() => {
    const el = ownRef.current;
    if (!el) return;
    const pad =
      parseFloat(getComputedStyle(el).paddingTop) + parseFloat(getComputedStyle(el).paddingBottom);
    el.style.height = '0px';
    const max = LINE * maxRows + pad;
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden';
  }, [value, maxRows]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    onKeyDown?.(e);
    if (e.defaultPrevented) return;
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      // Through the button, like a form's Enter, so whatever wraps it (sparks)
      // sees the send too.
      if (armed) sendRef.current?.click();
    }
  };

  const up = () => setPressed(false);
  const button = (
    <button
      ref={sendRef}
      type="button"
      className="prompt-bar__send"
      disabled={!armed}
      aria-label={label}
      title={label}
      data-armed={armed ? '' : undefined}
      data-pressed={pressed ? '' : undefined}
      // Keep the focus (and a phone's keyboard) in the box.
      onMouseDown={(e) => e.preventDefault()}
      onPointerDown={(e) => {
        if (e.button === 0 && armed) setPressed(true);
      }}
      onPointerUp={up}
      onPointerCancel={up}
      onPointerLeave={up}
      onClick={() => {
        if (armed) onSubmit();
      }}
    >
      <SendGlyph tick={mode === 'save'} morphDuration={morphDuration} squash={squash} tilt={tilt} />
    </button>
  );

  return (
    <div
      className={`prompt-bar${className ? ` ${className}` : ''}`}
      data-disabled={disabled ? '' : undefined}
      style={
        {
          '--pb-bg': background,
          '--pb-ink': color,
          '--pb-send': sendColor ?? color,
          '--pb-send-ink': sendInk ?? background,
          '--pb-radius': `${radius}px`,
          '--pb-press': pressScale,
        } as CSSProperties
      }
    >
      <div
        className="prompt-bar__field"
        role="presentation"
        onClick={(e) => {
          if (e.target === e.currentTarget) ownRef.current?.focus({ preventScroll: true });
        }}
      >
        <textarea
          ref={setInput}
          id={id}
          className="prompt-bar__input"
          rows={1}
          value={value}
          placeholder={placeholder}
          maxLength={maxLength}
          disabled={disabled}
          enterKeyHint={mode === 'save' ? 'done' : 'send'}
          autoComplete="off"
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={onBlur}
        />
        {wrapSend ? wrapSend(button) : button}
      </div>
    </div>
  );
};

export default PromptBar;
