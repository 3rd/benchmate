import { defineConfig, type PlaywrightTestConfig } from "@playwright/test";

const config: PlaywrightTestConfig = defineConfig({
  testDir: "./tests/browser",
  workers: 1,
  reporter: "line",
  use: {
    browserName: "chromium",
    headless: true,
    serviceWorkers: "block",
  },
  outputDir: ".cache/playwright",
});

export default config;
