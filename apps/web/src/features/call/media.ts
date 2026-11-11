/**
 * Pure helpers of the call panel (no LiveKit, no DOM), so they can be tested
 * with `node --test`. MediaCall keeps the LiveKit lifecycle.
 */

export type MediaDeviceOption = {
  deviceId: string;
  label: string;
};

/** The CSS class for a grid of n tiles. */
export function gridCountClass(n: number): string {
  if (n <= 1) return 'count-1';
  if (n === 2) return 'count-2';
  if (n <= 4) return 'count-4';
  if (n <= 6) return 'count-6';
  return 'count-9';
}

/** The preferred device when it is still there, else the first one. */
export function pickDeviceId(list: MediaDeviceOption[], preferred: string): string {
  if (preferred && list.some((d) => d.deviceId === preferred)) return preferred;
  return list[0]?.deviceId ?? '';
}

/** Microphones and cameras, named "Microphone 2" etc. when the browser hides labels. */
export function deviceOptions(all: Pick<MediaDeviceInfo, 'deviceId' | 'kind' | 'label'>[]): {
  mics: MediaDeviceOption[];
  cams: MediaDeviceOption[];
} {
  const named = (kind: MediaDeviceKind, word: string) =>
    all
      .filter((d) => d.kind === kind)
      .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `${word} ${i + 1}` }));
  return { mics: named('audioinput', 'Microphone'), cams: named('videoinput', 'Camera') };
}

/** What to tell people when the browser refused the microphone or camera. */
export function permissionHint(err: unknown, mode: 'voice' | 'video'): string {
  const msg = (err as Error)?.message || String(err || '');
  const lower = msg.toLowerCase();
  if (
    lower.includes('permission') ||
    lower.includes('notallowed') ||
    lower.includes('denied') ||
    lower.includes('not allowed')
  ) {
    return mode === 'video'
      ? 'Camera or microphone permission denied. Allow access and try again.'
      : 'Microphone permission denied. Allow access and try again.';
  }
  if (lower.includes('notfound') || lower.includes('not found') || lower.includes('device')) {
    return mode === 'video'
      ? 'No camera or microphone found. Check devices and try again.'
      : 'No microphone found. Check your device and try again.';
  }
  return msg || 'Could not join call';
}
