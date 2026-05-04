import { defineConfig } from 'astro/config';

export default defineConfig({
  // Cloudflare Pages: output static por defecto.
  // Cuando incorpores Auth0 con SSR, cambiar a:
  //   output: 'server',
  //   adapter: cloudflare()
  output: 'static',
  site: 'https://edetools.com', // actualizar con el dominio real
});
