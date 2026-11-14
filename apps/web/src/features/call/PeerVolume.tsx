import { wakeSlider } from '../../ui/pieces';

// The wake slider loads on its own (the call preloads it); until then the
// plain range input does the same job.

/** Per-person volume along the bottom edge of a call tile (0–1). */
export function PeerVolume({
  name,
  volume,
  onChange,
}: {
  name: string;
  volume: number;
  onChange: (volume: number) => void;
}) {
  const percent = Math.round(volume * 100);
  const fallback = (
    <label className="media-peer-volume-native">
      <span className="sr-only">Volume for {name}</span>
      <input
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={volume}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-valuetext={`${percent}%`}
      />
    </label>
  );
  return (
    <div className="media-peer-volume">
      <wakeSlider.Piece
        fallback={fallback}
        value={percent}
        min={0}
        max={100}
        step={5}
        bars={24}
        height={20}
        restHeight={5}
        gap={2}
        fillColor="var(--stage-ink)"
        trackColor="rgb(255 255 255 / 0.2)"
        crestColor="var(--accent)"
        ariaLabel={`Volume for ${name}`}
        formatValue={(v) => `${v}%`}
        onChange={(v) => onChange(v / 100)}
      />
    </div>
  );
}
