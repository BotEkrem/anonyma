import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import {
  TASKS_VISION_BASE,
  TASKS_VISION_FILES,
  TASKS_VISION_VERSION,
} from './src/features/call/tasksVision';

/**
 * Background blur's WebAssembly, served by the site itself (never a CDN): the
 * installed @mediapipe/tasks-vision wasm/ files, unchanged, at
 * TASKS_VISION_BASE (see tasksVision.ts).
 */
function tasksVisionWasm(): Plugin {
  const pkg = fileURLToPath(new URL('./node_modules/@mediapipe/tasks-vision/', import.meta.url));
  const installed = (JSON.parse(readFileSync(`${pkg}package.json`, 'utf8')) as { version: string })
    .version;
  if (installed !== TASKS_VISION_VERSION) {
    throw new Error(
      `@mediapipe/tasks-vision is ${installed}, tasksVision.ts says ${TASKS_VISION_VERSION}`,
    );
  }
  const read = (name: string) => readFileSync(`${pkg}wasm/${name}`);
  const files: readonly string[] = TASKS_VISION_FILES;
  return {
    name: 'anonyma-tasks-vision-wasm',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? '').split('?')[0]!;
        const name = path.startsWith(`${TASKS_VISION_BASE}/`)
          ? path.slice(TASKS_VISION_BASE.length + 1)
          : '';
        if (!files.includes(name)) return next();
        res.setHeader('Content-Type', name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
        res.end(read(name));
      });
    },
    generateBundle() {
      for (const name of files) {
        this.emitFile({
          type: 'asset',
          fileName: `${TASKS_VISION_BASE.slice(1)}/${name}`,
          source: read(name),
        });
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), tasksVisionWasm()],
  // The segmentation model for background blur, imported with ?url.
  assetsInclude: ['**/*.tflite'],
  resolve: {
    alias: {
      // Shared API views, limits and error codes, compiled from source.
      '@anonyma/contracts': fileURLToPath(
        new URL('../../packages/shared/src/contracts.ts', import.meta.url),
      ),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/healthz': 'http://localhost:3000',
    },
  },
});
