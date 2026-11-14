import { useEffect, useState } from 'react';
import { rubberSegment } from '../../ui/pieces';
import type { BlurLevel } from './cameraBlur';

/**
 * What the blur is doing now: 'waiting' while the camera is off (or before
 * joining), 'loading' until the first blurred frame, 'failed' when it would
 * not run (the camera is then off: nothing unblurred is sent).
 */
export type BlurStatus = 'waiting' | 'loading' | 'on' | 'failed';

const ITEMS: { value: BlurLevel; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'light', label: 'Light' },
  { value: 'strong', label: 'Strong' },
];

const HINTS: Record<BlurLevel, string> = {
  off: 'Off: your camera is sent as it is.',
  light: 'Softens what is behind you.',
  strong: 'Blurs what is behind you past making out.',
};

/**
 * Background blur in the call's settings: Off / Light / Strong (React Bits
 * Rubber Segment, as noise suppression). The hint follows what the camera
 * really sends (blurProcessor.ts), never a blur that is not running.
 */
export function BackgroundBlur(props: {
  value: BlurLevel;
  onChange: (value: BlurLevel) => void;
  status: () => BlurStatus;
}) {
  const { value, onChange, status } = props;
  const [now, setNow] = useState<BlurStatus>(() => status());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(status()), 200);
    return () => window.clearInterval(timer);
  }, [status]);

  const hint =
    value === 'off'
      ? HINTS.off
      : now === 'failed'
        ? 'Blur would not start here, so your camera is off.'
        : now === 'loading'
          ? 'Starting the blur… nothing is sent until it is ready.'
          : now === 'waiting'
            ? `${HINTS[value]} From your camera's first frame.`
            : HINTS[value];
  return (
    <div className="media-device-field media-noise media-blur">
      <span aria-hidden="true">Background blur</span>
      <rubberSegment.Piece
        fallback={<div className="rubber-segment-wait media-noise-wait" aria-hidden="true" />}
        aria-label="Background blur"
        items={ITEMS}
        value={value}
        onChange={(v) => onChange(v as BlurLevel)}
        size="sm"
        equalSlots
        radius={999}
        inset={3}
        trackColor="var(--surface-sunken)"
        thumbColor="var(--canvas)"
        textColor="var(--ink-soft)"
        activeTextColor="var(--ink)"
        className="media-noise-segment"
      />
      <span className="media-sensitivity-hint" aria-live="polite">
        {hint}
      </span>
    </div>
  );
}
