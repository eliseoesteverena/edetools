// build-tiptap-bundle.js  (corrés con node)
import { build } from 'esbuild';
build({
  entryPoints: ['tiptap-entry.js'],
  bundle: true, format: 'iife', globalName: 'TiptapBundle',
  outfile: 'public/tiptap-bundle.js', minify: true,
});