/**
 * Background blur's levels, the stored choice and the frame guard: the pure
 * part (the settings, the tests and blurProcessor.ts use it).
 *
 * Blur exists to hide the room, so it fails closed: a frame leaves only once
 * it has been drawn with a fresh person mask. LiveKit's processor would send
 * the camera's first frame as it is (and draws with whatever mask it has
 * before the first one is ready); the guard holds those back.
 */
export type BlurLevel = 'off' | 'light' | 'strong';
export const BLUR_LEVELS: readonly BlurLevel[] = ['off', 'light', 'strong'];
export const BLUR_PREF_KEY = 'anonyma.backgroundBlur';

export function parseBlur(raw: string | null | undefined): BlurLevel {
  return raw === 'light' || raw === 'strong' ? raw : 'off';
}

/** The blur radius per level (LiveKit's own default is 10). */
export const BLUR_RADIUS: Record<Exclude<BlurLevel, 'off'>, number> = { light: 10, strong: 28 };

/** A mask older than this is not trusted: frames drawn with it are not sent. */
export const MASK_STALE_MS = 1000;
/** Blur that has drawn no mask this long after starting (or since its last) has failed. */
export const BLUR_STALL_MS = 10_000;

interface Closable {
  close(): void;
}
interface Enqueuer {
  enqueue(frame: Closable): void;
}
/** What the guard needs of LiveKit's BackgroundTransformer. */
export interface GuardedTransformer {
  init(...args: never[]): Promise<void>;
  transform(frame: Closable, controller: Enqueuer): Promise<void> | void;
  updateMask(mask: unknown): Promise<void> | void;
}

export interface FrameGuard {
  /** Let frames through as they are: the level is off, there is nothing to hide. */
  setPassThrough(on: boolean): void;
  /** Hold frames back until the next mask (a level turned back on). */
  reset(): void;
  /**
   * Whether it is working: 'loading' until the first mask after a (re)start,
   * 'failed' when none came within BLUR_STALL_MS, or when frames kept coming
   * that long after the last one. Only meaningful while the camera is on.
   */
  health(now?: number): 'off' | 'loading' | 'ok' | 'failed';
}

/**
 * Wraps the transformer in place (its own methods call these through `this`):
 * a frame is sent only while the last mask is fresh, or while passing through.
 * A (re)start (camera switched, camera back on) forgets the old mask.
 */
export function guardFrames(
  t: GuardedTransformer,
  now: () => number = () => performance.now(),
): FrameGuard {
  let pass = false;
  let maskAt = 0;
  let startedAt = now();
  let lastFrameAt = 0;

  const init = t.init.bind(t);
  t.init = (...args: never[]) => {
    maskAt = 0;
    startedAt = now();
    lastFrameAt = 0;
    return init(...args);
  };
  const updateMask = t.updateMask.bind(t);
  t.updateMask = (mask: unknown) => {
    // LiveKit uploads the mask synchronously: it is in place once this returns.
    const done = updateMask(mask);
    if (mask) maskAt = now();
    return done;
  };
  const transform = t.transform.bind(t);
  t.transform = (frame: Closable, controller: Enqueuer) => {
    lastFrameAt = now();
    return transform(frame, {
      enqueue(out: Closable) {
        const fresh = maskAt > 0 && now() - maskAt <= MASK_STALE_MS;
        if (pass || fresh) controller.enqueue(out);
        else out.close();
      },
    });
  };

  return {
    setPassThrough(on) {
      pass = on;
    },
    reset() {
      maskAt = 0;
      startedAt = now();
    },
    health(at = now()) {
      if (pass) return 'off';
      if (maskAt === 0) return at - startedAt > BLUR_STALL_MS ? 'failed' : 'loading';
      return lastFrameAt - maskAt > BLUR_STALL_MS ? 'failed' : 'ok';
    },
  };
}

let supported: boolean | undefined;
/**
 * Whether this browser can run the blur (the checks LiveKit's processor makes
 * itself, without loading it): VideoFrame, OffscreenCanvas and WebGL 2, and
 * either insertable streams or canvas capture.
 */
export function canBlurBackground(): boolean {
  if (supported !== undefined) return supported;
  supported = false;
  if (typeof window === 'undefined' || typeof document === 'undefined') return supported;
  const g = globalThis as Record<string, unknown>;
  if (
    typeof g.OffscreenCanvas === 'undefined' ||
    typeof g.VideoFrame === 'undefined' ||
    typeof g.createImageBitmap === 'undefined'
  ) {
    return supported;
  }
  const streams =
    typeof g.MediaStreamTrackGenerator !== 'undefined' &&
    typeof g.MediaStreamTrackProcessor !== 'undefined';
  const capture =
    typeof HTMLCanvasElement !== 'undefined' && 'captureStream' in HTMLCanvasElement.prototype;
  if (!streams && !capture) return supported;
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    supported = !!gl;
    // Give the context back at once: a page has only a few.
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
  } catch {
    supported = false;
  }
  return supported;
}
