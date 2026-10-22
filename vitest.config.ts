import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/e2e/**"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/server.ts", "src/seed-cli.ts"],
      reporter: ["text", "json-summary"],
      // Guard rails, set a little below the measured numbers so a real regression fails CI.
      thresholds: { lines: 85, branches: 75 },
    },
  },
});
