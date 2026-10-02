import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // As esbuild.config.mjs defines it for every build but the AI development one (src/build-flags.d.ts).
  define: { MAPPY_AI_DEV_UNLOCK: "false" },
  resolve: {
    alias: { obsidian: fileURLToPath(new URL("./tests/mocks/obsidian.ts", import.meta.url)) },
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
