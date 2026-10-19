// Bundles the agent (and the shared core) into one ESM file; runtime deps stay external.
import { build } from 'esbuild';
import { chmodSync } from 'node:fs';
await build({
  entryPoints: ['src/cli.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: 'dist/cli.mjs',
  banner: { js: '#!/usr/bin/env node' },
  external: ['ws', '@modelcontextprotocol/sdk', 'zod'],
  logLevel: 'warning',
});
try { chmodSync('dist/cli.mjs', 0o755); } catch {}
console.log('built agent -> dist/cli.mjs');
