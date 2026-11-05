import { defineConfig } from 'shotest';

// Every test runs against a review server of its own: see tests/review-app.js.
export default defineConfig({
  testDir: './tests',
  timeout: 10000,
  workers: 1,
  retries: 0,
  use: {
    viewport: { width: 1000, height: 700 },
    screenshot: 'off',
    headless: true
  }
});
