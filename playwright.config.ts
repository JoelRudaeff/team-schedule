import { defineConfig } from '@playwright/test';

// End-to-end tests drive the real built Electron app (run `npm run build` first).
export default defineConfig({
  testDir: './tests/e2e',
  // Playwright empties this folder before every run; screenshots go to test-results/screens.
  outputDir: './test-results/playwright',
  timeout: 180_000,
  expect: { timeout: 15_000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
});
