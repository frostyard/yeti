import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import path from "node:path";

const webRoot = path.dirname(fileURLToPath(import.meta.url));
const distPublic = path.resolve(webRoot, "..", "dist", "public");

// Yeti's daemon (SERVER_PORT default 9384) serves /api, /auth, /webhooks, /health.
const DAEMON = "http://localhost:9384";
const proxy = Object.fromEntries(
  ["/api", "/auth", "/webhooks", "/health"].map((p) => [
    p,
    { target: DAEMON, changeOrigin: true, ws: true },
  ]),
);

export default defineConfig({
  root: webRoot,
  plugins: [react(), tailwindcss()],
  server: { port: 5173, proxy },
  preview: { port: 5173, proxy },
  build: {
    outDir: distPublic,
    emptyOutDir: true,
    sourcemap: true,
  },
});
