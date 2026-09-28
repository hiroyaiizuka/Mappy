import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { obsidian: new URL("./tests/mocks/obsidian.ts", import.meta.url).pathname },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.{ts,mjs}"],
    // Japanese, as the plugin owner runs Obsidian: the tests' expected text is the Japanese table.
    setupFiles: ["tests/setup-language.ts", "tests/setup-view-teardown.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts", "scripts/validate-release.mjs", "scripts/version-bump.mjs"],
      exclude: ["src/main.ts"],
      reporter: ["text", "html"],
    },
  },
});
