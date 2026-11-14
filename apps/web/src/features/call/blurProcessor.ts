/**
 * Background blur on your camera: LiveKit's processor (loaded on first use),
 * its MediaPipe runtime and model served by the site itself (tasksVision.ts,
 * models/), every frame through the guard (cameraBlur.ts).
 */
import type { BackgroundProcessorWrapper } from '@livekit/track-processors';
import modelUrl from './models/selfie_segmenter.tflite?url';
import { TASKS_VISION_BASE } from './tasksVision';
import {
  BLUR_RADIUS,
  guardFrames,
  type BlurLevel,
  type FrameGuard,
  type GuardedTransformer,
} from './cameraBlur';

let lib: Promise<typeof import('@livekit/track-processors')> | null = null;
function load() {
  lib ??= import('@livekit/track-processors').catch((err: unknown) => {
    lib = null;
    throw err;
  });
  return lib;
}

/** A processor for one camera track, and the guard on its frames. */
export interface CameraBlurHandle {
  processor: BackgroundProcessorWrapper;
  guard: FrameGuard;
  /** The level it runs at now ('off' = passing frames through). */
  level: BlurLevel;
}

/** A new processor (one per camera track: a failed one is not reused). */
export async function createCameraBlur(level: Exclude<BlurLevel, 'off'>): Promise<CameraBlurHandle> {
  const { BackgroundProcessor } = await load();
  const processor = BackgroundProcessor(
    {
      mode: 'background-blur',
      blurRadius: BLUR_RADIUS[level],
      assetPaths: { tasksVisionFileSet: TASKS_VISION_BASE, modelAssetPath: modelUrl },
    },
    'anonyma-blur',
  );
  const guard = guardFrames(processor.transformer as unknown as GuardedTransformer);
  return { processor, guard, level };
}

/**
 * Changes the level on the running processor (no restart: LiveKit's restart
 * path leaves the camera black when it fails). Going back to a blur, the guard
 * holds frames until a fresh mask before the blur is even switched on.
 */
export async function setCameraBlurLevel(handle: CameraBlurHandle, level: BlurLevel) {
  if (level === 'off') {
    handle.guard.setPassThrough(true);
    await handle.processor.switchTo({ mode: 'disabled' });
  } else {
    handle.guard.setPassThrough(false);
    handle.guard.reset();
    await handle.processor.switchTo({ mode: 'background-blur', blurRadius: BLUR_RADIUS[level] });
  }
  handle.level = level;
}

let warmed = false;
/**
 * Fetches the blur ahead (blur chosen, or a video call opening with it on):
 * its script, and its model and runtime into the browser's cache (they are
 * cached for good), so turning the camera on does not wait for ~3 MB first.
 * Only the SIMD runtime: every browser that can run the blur has SIMD.
 */
export function preloadCameraBlur() {
  void load().catch(() => undefined);
  if (warmed || typeof fetch === 'undefined') return;
  warmed = true;
  for (const url of [
    modelUrl,
    `${TASKS_VISION_BASE}/vision_wasm_internal.js`,
    `${TASKS_VISION_BASE}/vision_wasm_internal.wasm`,
  ]) {
    void fetch(url)
      .then((r) => r.arrayBuffer())
      .catch(() => {
        warmed = false;
      });
  }
}
