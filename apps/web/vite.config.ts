import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const reviewOrigin = process.env.PALIMORA_REVIEW_ORIGIN;
const reviewHost = reviewOrigin ? new URL(reviewOrigin).hostname : undefined;

export default defineConfig({
  plugins: [
    react(),
    {
      name: "palimora-offline-shell",
      apply: "build",
      closeBundle() {
        const root = resolve("dist");
        const files = [
          "/index.html",
          "/manifest.webmanifest",
          "/icon.svg",
          "/icon-192.png",
          "/icon-512.png",
          ...readdirSync(resolve(root, "assets")).map(
            (name) => "/assets/" + name,
          ),
        ];
        const template = readFileSync(resolve(root, "push-worker.js"), "utf8");
        const hash = createHash("sha256").update(template);
        for (const file of files)
          hash.update(readFileSync(resolve(root, "." + file)));
        writeFileSync(
          resolve(root, "push-worker.js"),
          template
            .replace("__PALIMORA_BUILD__", hash.digest("hex").slice(0, 20))
            .replace("/* PALIMORA_FILES */ []", JSON.stringify(files)),
        );
      },
    },
  ],
  preview: {
    headers: process.env.PALIMORA_PREVIEW_CSP
      ? { "Content-Security-Policy": process.env.PALIMORA_PREVIEW_CSP }
      : undefined,
    port: 5173,
    strictPort: true,
    proxy: { "/api": "http://127.0.0.1:3000" },
  },
  cacheDir: process.env.VITE_CACHE_DIR,
  server: {
    strictPort: true,
    allowedHosts: reviewHost ? [reviewHost] : undefined,
    hmr: reviewHost
      ? { host: reviewHost, protocol: "wss", clientPort: 443 }
      : undefined,
    proxy: { "/api": "http://127.0.0.1:3000" },
  },
});
