import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30000,
  expect: { timeout: 5000 },
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:3100',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'node tests/e2e/start-server.js',
    port: 3100,
    timeout: 15000,
    reuseExistingServer: !process.env.CI,
    env: {
      CANVAS_PORT: '3100',
      HOST: 'localhost',
      EXCALIDRAW_DB_PATH: '/tmp/excalidraw-e2e-test.db',
    },
  },
});
