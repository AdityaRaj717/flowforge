import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: { alias: { '@flowforge/core': resolve(__dirname, '../core/src/index.ts') } },
  test: { include: ['test/**/*.test.ts'] },
});
