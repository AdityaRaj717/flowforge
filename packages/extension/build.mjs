// Two Vite builds: ES modules for the side panel + service worker, and one classic IIFE for the
// content script (Chrome does not load content scripts as modules). Then the manifest is written.
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const dev = process.argv.includes('--dev');
const out = resolve(root, 'dist');
rmSync(out, { recursive: true, force: true });

const shared = {
  root,
  configFile: false,
  logLevel: 'warn',
  define: { __DEV__: JSON.stringify(dev) },
  resolve: { alias: { '@flowforge/core': resolve(root, '../core/src/index.ts') } },
};

await build({
  ...shared,
  plugins: [react()],
  build: {
    outDir: out,
    emptyOutDir: false,
    sourcemap: dev,
    minify: !dev,
    target: 'chrome116',
    // The preload helper touches `document`, which does not exist in the service worker.
    modulePreload: false,
    rollupOptions: {
      input: { sidepanel: resolve(root, 'sidepanel.html'), background: resolve(root, 'src/background/index.ts') },
      output: { entryFileNames: '[name].js', chunkFileNames: 'chunks/[name]-[hash].js', assetFileNames: 'assets/[name]-[hash][extname]' },
    },
  },
});

await build({
  ...shared,
  build: {
    outDir: out,
    emptyOutDir: false,
    sourcemap: dev ? 'inline' : false,
    minify: !dev,
    target: 'chrome116',
    lib: { entry: resolve(root, 'src/content/index.ts'), formats: ['iife'], name: 'FlowForgeContent', fileName: () => 'content.js' },
  },
});

await build({
  ...shared,
  build: {
    outDir: out,
    emptyOutDir: false,
    minify: !dev,
    target: 'chrome116',
    lib: { entry: resolve(root, 'src/content/picker-hook.ts'), formats: ['iife'], name: 'FlowForgePickerHook', fileName: () => 'picker-hook.js' },
  },
});

const manifest = JSON.parse(readFileSync(resolve(root, 'manifest.base.json'), 'utf8'));
if (dev) {
  // The mock Flow page used for testing without spending credits.
  manifest.name += ' (dev)';
  manifest.host_permissions.push('http://localhost:5179/*');
  manifest.content_scripts.forEach((c) => c.matches.push('http://localhost:5179/*'));
}
writeFileSync(resolve(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
mkdirSync(resolve(out, 'icons'), { recursive: true });
if (existsSync(resolve(root, 'public/icons'))) cpSync(resolve(root, 'public/icons'), resolve(out, 'icons'), { recursive: true });
console.log(`built ${dev ? 'dev' : 'release'} extension -> ${out}`);
