import { defineConfig } from '@playwright/test';

// End-to-end tests replay both README walkthroughs against the real Python server
// serving the React build. They reset the demo through the UI first, and leave it
// in its repaired end state (run `npm run seed` afterwards for a fresh presentation).
const PORT = Number(process.env.E2E_PORT || 8767);
// E2E_UI=dist replays the same walkthroughs against the original string-template UI (parity check).
const UI = process.env.E2E_UI === 'dist' ? '' : 'web';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  workers: 1,
  fullyParallel: false,
  reporter: 'list',
  use: { baseURL: `http://127.0.0.1:${PORT}`, channel: 'chrome', headless: true, trace: 'retain-on-failure' },
  webServer: {
    command: `cd .. && RECONCILE_STATIC=${UI} python3 reconcile-mock-first-kit/reconcile_mock.py serve --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
