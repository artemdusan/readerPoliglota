import fs from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

// Systemowe Chromium (np. /opt/pw-browsers w środowisku cloud) — bez pobierania
// przeglądarki przy każdej sesji. Lokalnie: zwykłe `npx playwright install chromium`.
const SYS_CHROMIUM = '/opt/pw-browsers/chromium';
const executablePath = process.env.CHROMIUM_PATH
  || (fs.existsSync(SYS_CHROMIUM) ? SYS_CHROMIUM : undefined);

export default defineConfig({
  testDir: 'e2e',
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  use: {
    baseURL: 'http://localhost:5173',
    launchOptions: executablePath ? { executablePath } : {},
  },
  webServer: {
    command: 'npm run dev',
    port: 5173,
    reuseExistingServer: true,
  },
});
