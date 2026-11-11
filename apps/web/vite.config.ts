import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
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
