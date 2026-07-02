import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Two projects: the Node daemon tests (src) and the jsdom SPA tests (web).
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "server",
          environment: "node",
          include: ["src/**/*.test.ts"],
        },
      },
      {
        plugins: [react()],
        test: {
          name: "web",
          environment: "jsdom",
          include: ["web/**/*.test.{ts,tsx}"],
          setupFiles: ["web/src/test-setup.ts"],
          globals: true,
        },
      },
    ],
  },
});
