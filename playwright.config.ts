import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/browser",
  workers: 1,
  timeout: 60000,
  use: { baseURL: "http://localhost:5173", trace: "retain-on-failure" },
  webServer: [
    {
      command: "node apps/api/dist/main.js",
      url: "http://127.0.0.1:3000/api/v1/health",
      reuseExistingServer: false,
      env: {
        DATABASE_URL: process.env.TEST_DATABASE_URL!,
        AUTH_KEY: "ab".repeat(32),
        APP_ORIGIN: "http://localhost:5173",
        PORT: "3000",
        PALIMORA_DEV: "1",
      },
    },
    {
      command: "npm run dev -w @palimora/web -- --host 127.0.0.1 --strictPort",
      url: "http://localhost:5173",
      reuseExistingServer: false,
    },
  ],
});
