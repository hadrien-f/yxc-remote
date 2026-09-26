import { defineConfig, devices } from "@playwright/test";

// Own Vite server on 1430 so tests never reuse (or fight) a running `tauri dev` on 1420
export default defineConfig({
  testDir: "e2e",
  use: { ...devices["Pixel 7"], baseURL: "http://localhost:1430" },
  webServer: { command: "npx vite --port 1430", url: "http://localhost:1430", reuseExistingServer: false },
});
