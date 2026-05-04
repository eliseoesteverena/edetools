import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';

export default defineConfig({
  output: 'hybrid',
  adapter: cloudflare({
    platformProxy: { enabled: true },
  }),
  site: 'https://edetools.pages.dev',
  vite: {
    // pdfjs-dist tiene referencias a Node built-ins en rutas que no usamos.
    // Marcarlos como externos evita que Vite intente bundlearlos.
    ssr: {
      external: ['pdfjs-dist'],
    },
    optimizeDeps: {
      exclude: ['pdfjs-dist'],
    },
  },
});
