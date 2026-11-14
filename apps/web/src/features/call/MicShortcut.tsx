import { useEffect, useState } from 'react';
import { rubberSegment } from '../../ui/pieces';
import {
  bindingFromEvent,
  describeBinding,
  reservedReason,
  typesText,
  type KeyBinding,
  type MicShortcutMode,
} from './shortcutKeys';

const MODES: { value: MicShortcutMode; label: string }[] = [
  { value: 'toggle', label: 'Toggle' },
  { value: 'hold', label: 'Push to talk' },
];

/**
 * The microphone's keyboard shortcut in the call's settings: the mode (Toggle
 * / Push to talk) and the key, chosen by pressing it. While the recorder
 * listens it has every key first (Esc cancels it here instead of closing the
 * panel), and the call's own shortcut stands aside (onRecording).
 */
export function MicShortcut(props: {
  mode: MicShortcutMode;
  onModeChange: (mode: MicShortcutMode) => void;
  binding: KeyBinding;
  onBindingChange: (binding: KeyBinding) => void;
  onRecording: (recording: boolean) => void;
  mac: boolean;
}) {
  const { mode, onModeChange, binding, onBindingChange, onRecording, mac } = props;
  const [recording, setRecording] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    onRecording(recording);
    if (!recording) return undefined;
    const onKey = (e: KeyboardEvent) => {
      // First at the window, and nobody else: not the panel's Esc, not the
      // shortcut itself, not the page.
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.repeat) return;
      if (e.code === 'Escape' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
        setRecording(false);
        return;
      }
      const next = bindingFromEvent(e);
      if (!next) return; // only a modifier so far
      const why = reservedReason(next);
      if (why) {
        setProblem(why);
        return;
      }
      setProblem(null);
      onBindingChange(next);
      setRecording(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [recording, onBindingChange, onRecording]);
  // Closing the panel mid-recording gives the shortcut back.
  useEffect(() => () => onRecording(false), [onRecording]);

  const keyName = describeBinding(binding, mac);
  const what =
    mode === 'toggle'
      ? `Press ${keyName} to mute or unmute.`
      : `Your microphone stays muted; hold ${keyName} to talk.`;
  const where = typesText(binding)
    ? 'Works while this tab is in front, not while you type.'
    : 'Works while this tab is in front.';
  return (
    <div className="media-device-field media-noise media-shortcut">
      <span aria-hidden="true">Microphone shortcut</span>
      <rubberSegment.Piece
        fallback={<div className="rubber-segment-wait media-noise-wait" aria-hidden="true" />}
        aria-label="Microphone shortcut"
        items={MODES}
        value={mode}
        onChange={(v) => onModeChange(v as MicShortcutMode)}
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
      <div className="media-shortcut-row">
        <span className="media-shortcut-label">Key</span>
        <button
          type="button"
          className={`media-shortcut-key ${recording ? 'is-recording' : ''}`.trim()}
          aria-label={recording ? 'Press the key you want' : `Shortcut key ${keyName}, change`}
          onClick={() => {
            setProblem(null);
            setRecording((r) => !r);
          }}
          onBlur={() => setRecording(false)}
        >
          {recording ? 'Press a key…' : <kbd>{keyName}</kbd>}
        </button>
      </div>
      <span className="media-sensitivity-hint" aria-live="polite">
        {recording ? (problem ?? 'Press the key you want; Esc cancels.') : `${what} ${where}`}
      </span>
    </div>
  );
}
