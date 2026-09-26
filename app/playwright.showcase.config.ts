import { defineConfig, devices } from "@playwright/test";

// `npm run showcase`: records the README screenshots and demo video against a fake receiver
export default defineConfig({
  testDir: "showcase",
  timeout: 120_000,
  use: {
    ...devices["Pixel 7"],
    colorScheme: "dark",
    baseURL: "http://localhost:1432",
    video: { mode: "on", size: { width: 412, height: 915 } },
  },
  outputDir: "showcase/out",
  webServer: { command: "npx vite --port 1432", url: "http://localhost:1432", reuseExistingServer: false },
});
