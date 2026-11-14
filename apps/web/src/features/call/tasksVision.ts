/**
 * The @mediapipe/tasks-vision release whose WebAssembly the site serves for
 * background blur. vite.config.ts copies that release's wasm/ folder to
 * TASKS_VISION_BASE unchanged (the loader asks for the files by their own
 * names, so they cannot be content-hashed) and refuses to build when the
 * installed package is another version. The folder is under /assets/, so it
 * is cached for good: a new release gets a new folder.
 */
export const TASKS_VISION_VERSION = '0.10.14';
export const TASKS_VISION_BASE = `/assets/tasks-vision-${TASKS_VISION_VERSION}`;
export const TASKS_VISION_FILES = [
  'vision_wasm_internal.js',
  'vision_wasm_internal.wasm',
  'vision_wasm_nosimd_internal.js',
  'vision_wasm_nosimd_internal.wasm',
] as const;
