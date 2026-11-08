import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/browser",
  testMatch: process.env.OPERATIONS_SPEC ?? "operations.spec.ts",
  workers: 1,
  timeout: 300000,
  use: {
    baseURL: "http://localhost:5173",
    locale: "it-IT",
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "npm exec -w @palimora/web -- vite preview --host 127.0.0.1 --strictPort",
      url: "http://localhost:5173",
      reuseExistingServer: false,
    },
  ],
});
