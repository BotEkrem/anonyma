/**
 * Input sensitivity's scale and stored value (the pure part: the bar,
 * localStorage and tests use it; voiceChain.ts does the work).
 */

/** The bar's scale, in dBFS (the level of the last ~10 ms). The far left is off. */
export const SENSITIVITY_OFF_DB = -70;
export const SENSITIVITY_MAX_DB = -10;
export const SENSITIVITY_PREF_KEY = 'anonyma.inputSensitivity';

/** A stored or typed threshold; off (null) for anything not a level on the bar. */
export function parseSensitivity(raw: string | null | undefined): number | null {
  if (raw == null || raw.trim() === '') return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  const db = Math.round(value);
  if (db <= SENSITIVITY_OFF_DB) return null;
  return Math.min(SENSITIVITY_MAX_DB, db);
}

/** Where a level sits along the bar, 0 (left) to 1 (right). */
export function sensitivityShare(db: number): number {
  const share = (db - SENSITIVITY_OFF_DB) / (SENSITIVITY_MAX_DB - SENSITIVITY_OFF_DB);
  return Math.min(1, Math.max(0, share));
}

/**
 * Noise suppression on top of the browser's own: off, light (RNNoise) or
 * medium (GTCRN), both from @sapphi-red/web-noise-suppressor (voiceChain.ts).
 */
export type NoiseLevel = 'off' | 'light' | 'medium';
export const NOISE_LEVELS: readonly NoiseLevel[] = ['off', 'light', 'medium'];
export const NOISE_PREF_KEY = 'anonyma.noiseSuppression';

/** A stored noise level; off for anything else. */
export function parseNoise(raw: string | null | undefined): NoiseLevel {
  return NOISE_LEVELS.includes(raw as NoiseLevel) ? (raw as NoiseLevel) : 'off';
}

/**
 * iPhone and iPad (an iPad reports itself as a Mac with touch): the noise
 * filters are not offered there; iOS has its own (Voice Isolation, in
 * Control Center), and a filter's audio context there is untested.
 */
export function isApplePhoneOrTablet(userAgent: string, maxTouchPoints: number): boolean {
  return /iPhone|iPad|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1);
}
