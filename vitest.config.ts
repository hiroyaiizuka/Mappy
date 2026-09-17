import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { obsidian: new URL('./tests/mocks/obsidian.ts', import.meta.url).pathname },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.{ts,mjs}'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'scripts/validate-release.mjs'],
      exclude: ['src/main.ts'],
      reporter: ['text', 'html'],
    },
  },
});
