import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';

export default defineConfig({
  // output: 'hybrid' permite que la mayoría del sitio sea estático
  // pero habilita endpoints de servidor (las Functions/Workers)
  // para las rutas que lo necesiten (como el API de PDF).
  output: 'hybrid',
  adapter: cloudflare({
    platformProxy: {
      enabled: true, // habilita wrangler en dev local
    },
  }),
  site: 'https://edetools.pages.dev',
});
