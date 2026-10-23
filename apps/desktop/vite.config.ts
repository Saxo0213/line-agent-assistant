import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { transformRendererHtml } from './src/renderer/dev-html.js';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig(({ command }) => ({ root: import.meta.dirname, plugins: [react(), { name: 'remove-production-csp-from-dev-html', transformIndexHtml: { order: 'post', handler: (html) => transformRendererHtml(html, command) } }], base: './', define: { __APP_VERSION__: JSON.stringify(version) }, build: { outDir: 'dist/renderer', emptyOutDir: true, target: 'es2022' }, server: { host: '127.0.0.1', port: 5173, strictPort: true } }));
