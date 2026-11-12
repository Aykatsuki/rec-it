import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';

/**
 * Content-Security-Policy for the renderer (ARCHITECTURE §21). Development needs inline
 * scripts and a websocket for hot reload; production allows nothing beyond the app itself.
 */
function cspPlugin(): Plugin {
  const common = [
    "default-src 'self'",
    "img-src 'self' data: blob: recit-media:",
    "media-src 'self' blob: recit-media:",
    "font-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-src 'none'",
    "form-action 'none'",
  ];
  return {
    name: 'recit-csp',
    transformIndexHtml(html, ctx) {
      const dev = Boolean(ctx.server);
      const policy = [
        ...common,
        dev ? "script-src 'self' 'unsafe-inline'" : "script-src 'self'",
        dev
          ? "connect-src 'self' recit-media: ws://localhost:* http://localhost:*"
          : "connect-src 'self' recit-media:",
      ].join('; ');
      return html.replace('%CSP%', policy);
    },
  };
}

export default defineConfig({
  main: {
    // Workspace packages are TypeScript sources, so everything is bundled.
    build: {
      externalizeDeps: false,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          backend: resolve(__dirname, 'src/backend/index.ts'),
        },
      },
    },
  },
  preload: {
    // Sandboxed preloads cannot require modules, so the preload must be one self-contained file.
    build: { externalizeDeps: false },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react(), cspPlugin()],
    build: {
      rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') },
    },
  },
});
