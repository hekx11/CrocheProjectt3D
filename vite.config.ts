import { defineConfig } from 'vite';

// GitHub Pages serves the site from /<repo>/ — override with BASE_PATH for other hosts.
export default defineConfig({
  base: process.env.BASE_PATH ?? '/CrocheProjectt3D/',
  worker: { format: 'es' },
  test: { environment: 'node' },
} as any);
