import { readFileSync } from "node:fs";
import { defineConfig } from "@playwright/test";
import base from "./playwright.config";
export default defineConfig({
  ...base,
  timeout: 120000,
  use: { ...base.use, actionTimeout: 15000 },
  testMatch: "offline.spec.ts",
  testIgnore: [],
  webServer: [
    ...(Array.isArray(base.webServer) ? [base.webServer[0]] : []),
    {
      command:
        "npm exec -w @palimora/web -- vite preview --host 127.0.0.1 --port 5173",
      url: "http://localhost:5173",
      reuseExistingServer: false,
      env: {
        PALIMORA_PREVIEW_CSP: readFileSync(
          "infra/nginx/gateway.conf.template",
          "utf8",
        ).match(/add_header Content-Security-Policy "([^"]+)"/)![1],
      },
    },
  ],
});
