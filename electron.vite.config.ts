import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';

const shared = resolve(__dirname, 'src/shared');

/**
 * Injects the Content-Security-Policy meta tag into index.html.
 * Production: strict (only bundled files, no inline/remote script).
 * Dev server: relaxed just enough for Vite's hot-reload client.
 */
function cspPlugin(): Plugin {
  return {
    name: 'team-schedule-csp',
    transformIndexHtml(html, ctx) {
      const dev = Boolean(ctx.server);
      const csp = dev
        ? "default-src 'self' 'unsafe-inline' ws://localhost:* http://localhost:*; img-src 'self' data: blob:"
        : "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'none'; base-uri 'none'; form-action 'none'";
      return html.replace('<!--csp-->', `<meta http-equiv="Content-Security-Policy" content="${csp}" />`);
    },
  };
}

export default defineConfig({
  main: {
    resolve: { alias: { '@shared': shared } },
  },
  preload: {
    resolve: { alias: { '@shared': shared } },
  },
  renderer: {
    resolve: {
      alias: {
        '@shared': shared,
        '@renderer': resolve(__dirname, 'src/renderer/src'),
      },
    },
    plugins: [react(), cspPlugin()],
  },
});
