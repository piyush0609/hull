import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  use: { baseURL: 'http://127.0.0.1:4179', trace: 'retain-on-failure' },
  webServer: {
    command: 'npx tsx tests/browser/fixtures/widget-host.ts',
    port: 4179,
    reuseExistingServer: false,
  },
});
