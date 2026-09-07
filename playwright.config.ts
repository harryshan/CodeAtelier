import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  use: {
    baseURL: "http://127.0.0.1:4143",
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
  },
  webServer: {
    command: "pnpm exec tsx tests/fixtures/server.ts",
    url: "http://127.0.0.1:4143",
    reuseExistingServer: false,
    timeout: 30000,
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
