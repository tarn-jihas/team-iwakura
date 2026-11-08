/// <reference types="vitest" />
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { cpSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const LEGACY_DIST = resolve(__dirname, '../Reconcile/dist');
const OUT = resolve(__dirname, '../Reconcile/web');

/** The legacy offline fixture lab is a separate read-only page; ship it unchanged next to the React app. */
function copyLegacyLab(): Plugin {
  const files = ['legacy.html', 'app.js', 'engine.js', 'styles.css', 'fonts', 'data'];
  return {
    name: 'copy-legacy-lab',
    apply: 'build',
    closeBundle() {
      for (const f of files) {
        const src = resolve(LEGACY_DIST, f);
        if (existsSync(src)) cpSync(src, resolve(OUT, f), { recursive: true });
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), copyLegacyLab()],
  build: {
    outDir: OUT,
    emptyOutDir: true,
    rollupOptions: { input: { index: resolve(__dirname, 'index.html'), access: resolve(__dirname, 'access.html') } },
  },
  server: {
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:8765', '/mock': 'http://127.0.0.1:8765', '/legacy.html': 'http://127.0.0.1:8765' },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/unit/**/*.test.ts', 'tests/component/**/*.test.tsx'],
  },
});
