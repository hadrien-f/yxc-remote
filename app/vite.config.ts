import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import process from "node:process";
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
// Browser dev only: set RECEIVER_IP in app/.env.local (git-ignored), e.g. RECEIVER_IP=192.168.1.20
const receiver = `http://${loadEnv("", process.cwd(), "").RECEIVER_IP ?? "192.0.2.10"}`;

export default defineConfig(() => ({
  plugins: [react()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    // Browser dev only: forward YXC calls to the receiver (Tauri uses plugin-http instead)
    proxy: {
      "/YamahaExtendedControl": receiver,
      "/YamahaRemoteControl": receiver,
    },
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
  test: { include: ["src/**/*.test.ts"] },
}));
