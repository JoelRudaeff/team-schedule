import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const root = import.meta.dirname;

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(root, 'src/shared'),
      '@renderer': resolve(root, 'src/renderer/src'),
    },
  },
  test: {
    environment: 'node',
    // unit: pure shared code + main-process helpers; integration: real git repositories;
    // renderer: the application store driven through a fake bridge (no DOM needed).
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts', 'tests/renderer/**/*.test.ts'],
    // Integration tests spawn real git processes, which is slow on Windows.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
