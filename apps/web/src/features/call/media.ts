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

/** Screen-share quality presets: picked before sharing, changeable while it runs. */
export type ShareQualityId = 'text' | 'motion' | 'best' | 'saver';

export type ShareQuality = {
  id: ShareQualityId;
  label: string;
  /** Size and frame rate, shown beside the label. */
  detail: string;
  width: number;
  height: number;
  fps: number;
  /** Most bits per second the encoder may send. */
  bitrate: number;
  /** Tells the encoder what to keep when the link is tight. */
  hint: 'detail' | 'motion';
  degradation: 'maintain-resolution' | 'maintain-framerate';
};

export const SHARE_QUALITIES: readonly ShareQuality[] = [
  {
    id: 'text',
    label: 'Sharp text',
    detail: '1080p · 15 fps',
    width: 1920,
    height: 1080,
    fps: 15,
    bitrate: 2_500_000,
    hint: 'detail',
    degradation: 'maintain-resolution',
  },
  {
    id: 'motion',
    label: 'Smooth motion',
    detail: '720p · 30 fps',
    width: 1280,
    height: 720,
    fps: 30,
    bitrate: 2_000_000,
    hint: 'motion',
    degradation: 'maintain-framerate',
  },
  {
    id: 'best',
    label: 'Best',
    detail: '1080p · 30 fps',
    width: 1920,
    height: 1080,
    fps: 30,
    bitrate: 5_000_000,
    hint: 'motion',
    degradation: 'maintain-framerate',
  },
  {
    id: 'saver',
    label: 'Data saver',
    detail: '720p · 5 fps',
    width: 1280,
    height: 720,
    fps: 5,
    bitrate: 800_000,
    hint: 'detail',
    degradation: 'maintain-resolution',
  },
];

/** The preset for an id (a stale or unknown one falls back to Sharp text). */
export function shareQuality(id: string | null | undefined): ShareQuality {
  return SHARE_QUALITIES.find((q) => q.id === id) ?? SHARE_QUALITIES[0]!;
}

/** This browser can share a screen (phones' browsers cannot). */
export function canShareScreen(
  devices: { getDisplayMedia?: unknown } | undefined | null,
): boolean {
  return typeof devices?.getDisplayMedia === 'function';
}

/**
 * What to tell people when sharing did not start; null when they closed the
 * browser's picker themselves (nothing went wrong).
 */
export function shareErrorHint(err: unknown): string | null {
  const name = (err as { name?: string })?.name ?? '';
  const msg = ((err as Error)?.message || String(err || '')).toLowerCase();
  if (msg.includes('by system')) {
    return 'Your computer blocked screen capture. Allow this browser under Screen Recording in your system settings, then try again.';
  }
  if (name === 'NotAllowedError' || name === 'AbortError' || msg.includes('permission denied')) {
    return null;
  }
  if (name === 'NotReadableError') return 'Your browser could not capture that screen. Try another window.';
  return 'Screen sharing did not start. Try again.';
}
