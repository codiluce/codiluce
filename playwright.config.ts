import { defineConfig, devices } from '@playwright/test';

// Browser tests for critical visualizer interactions. Run `npm run test:e2e`
// (builds the static UI first). Uses the fixture repository, not a real index.
const port = Number(process.env.E2E_PORT ?? 4399);
const historyPort = Number(process.env.E2E_HISTORY_PORT ?? 4398);
export default defineConfig({
  testDir: 'web/e2e',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: `http://127.0.0.1:${port}`, ...devices['Desktop Chrome'], viewport: { width: 1400, height: 860 }, deviceScaleFactor: 2, reducedMotion: 'reduce', trace: 'retain-on-failure' },
  webServer: [
    { command: 'node --experimental-sqlite --import tsx web/e2e/server.ts', url: `http://127.0.0.1:${port}/api`, reuseExistingServer: false, timeout: 60_000, env: { E2E_PORT: String(port) } },
    // A scripted Git history indexed into a timeline (tests/history-fixture.ts).
    { command: 'node --experimental-sqlite --import tsx web/e2e/history-server.ts', url: `http://127.0.0.1:${historyPort}/api`, reuseExistingServer: false, timeout: 90_000, env: { E2E_HISTORY_PORT: String(historyPort) }, gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 } },
  ],
});
