import { defineConfig } from 'shotest';

export default defineConfig({
  testDir: './tests',
  timeout: 10000,
  workers: 1,
  retries: 0,
  use: {
    baseURL: 'http://127.0.0.1:4173',
    viewport: { width: 420, height: 700 },
    screenshot: 'off',
    headless: true
  },
  webServer: {
    command: 'node ./server.mjs',
    port: 4173,
    reuseExistingServer: true,
    timeout: 15000
  }
});
