import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// GitHub Pages serves the site from /<repo>/ — override with BASE_PATH for other hosts.
export default defineConfig({
  base: process.env.BASE_PATH ?? '/CrocheProjectt3D/',
  worker: { format: 'es' },
  // strand.html: one strand of yarn drawn by hand (a magic ring and two rounds)
  build: { rollupOptions: { input: { main: resolve(import.meta.dirname, 'index.html'), strand: resolve(import.meta.dirname, 'strand.html') } } },
  test: { environment: 'node' },
} as any);
