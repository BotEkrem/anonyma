import { useEffect, useState } from 'react';
import { rubberSegment } from '../../ui/pieces';
import type { NoiseLevel } from './sensitivity';
import type { VoiceChainStatus } from './voiceChain';

const ITEMS: { value: NoiseLevel; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'light', label: 'Light' },
  { value: 'medium', label: 'Medium' },
];

const HINTS: Record<NoiseLevel, string> = {
  off: "Off: only your browser's own noise reduction.",
  light: 'Removes steady noise: fans, hum, traffic.',
  medium: 'Also clears noise while you speak, a little more delay.',
};

/**
 * Noise suppression in the call's settings: Off / Light / Medium (React Bits
 * Rubber Segment, as the lobby's mode picker). What the hint says follows what
 * the chain really runs (voiceChain.ts): a filter still loading or one that
 * would not start is said so, never shown as working.
 */
export function NoiseSuppression(props: {
  value: NoiseLevel;
  onChange: (value: NoiseLevel) => void;
  status: () => VoiceChainStatus;
}) {
  const { value, onChange, status } = props;
  const [now, setNow] = useState<VoiceChainStatus>(() => status());
  useEffect(() => {
    const timer = window.setInterval(() => {
      const next = status();
      setNow((prev) =>
        prev.on === next.on &&
        prev.noise === next.noise &&
        prev.loading === next.loading &&
        prev.failed === next.failed
          ? prev
          : next,
      );
    }, 200);
    return () => window.clearInterval(timer);
  }, [status]);

  const hint =
    now.loading === value
      ? 'Loading the filter…'
      : now.failed === value
        ? 'This filter would not start here, so it is off.'
        : value !== 'off' && now.noise !== value
          ? 'Starting the filter…'
          : HINTS[value];
  return (
    <div className="media-device-field media-noise">
      <span aria-hidden="true">Noise suppression</span>
      <rubberSegment.Piece
        fallback={<div className="rubber-segment-wait media-noise-wait" aria-hidden="true" />}
        aria-label="Noise suppression"
        items={ITEMS}
        value={value}
        onChange={(v) => onChange(v as NoiseLevel)}
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
