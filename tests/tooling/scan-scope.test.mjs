import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The community directory's automated review reads the repository's source and leaves out only the names its FAQ
 * lists ("Why are my test or development files being included in the scan?", the 2026-08-07 version;
 * docs/community-submission.md #33). A tracked code file outside those names is read as if it were the plugin, so
 * the only code left in scan range is the plugin itself: `src/` and `styles.css`. Anything else that is not the
 * plugin (the browser harness, the vitest config) goes under an excluded name (LEV-243).
 *
 * The regression test is the first one: before LEV-243 it reports the nine files of `harness/browser/` and
 * `vitest.config.ts`. Configs that the list already covers (`*.mjs`) and files that are not code (Markdown, JSON,
 * the pre-commit hook) stay where they are.
 */
const EXCLUDED_NAMES = new Set([
  "node_modules", "dist", "build", "pkg", "test-vault", ".pnpm-store", ".obsidian", "esbuild.config.mjs",
  "version-bump.mjs", "automation", "test", "tests", "__tests__", "testUtils", "e2e-tests", "mocks", "__mocks__",
  "vite", "scripts", "docs", "i18n", "i18next", "locale", "locales", "translations", "l10n",
]);
const EXCLUDED_PATTERNS = [/\.tests?\./u, /\.specs?\./u, /\.(?:cjs|mjs|cts|mts)$/u];
const CODE = /\.(?:[cm]?[jt]sx?|css|html?)$/u;
const PLUGIN = [/^src\//u, /^styles\.css$/u];

const excluded = path => path.split("/").some(part => EXCLUDED_NAMES.has(part) || EXCLUDED_PATTERNS.some(pattern => pattern.test(part)));

describe("code the directory's scanner reads", () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const tracked = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean);

  it("is only the plugin", () => {
    const scanned = tracked.filter(path => CODE.test(path) && !excluded(path));
    expect(scanned.filter(path => !PLUGIN.some(pattern => pattern.test(path)))).toEqual([]);
  });

  it("still sees the plugin", () => {
    // Guards the filter above: a list that excluded everything would pass the first test with nothing scanned.
    expect(tracked.filter(path => CODE.test(path) && !excluded(path))).toEqual(expect.arrayContaining(["src/main.ts", "styles.css"]));
    expect(excluded("tests/browser-harness/obsidian.ts")).toBe(true);
    expect(excluded("src/i18n/en.ts")).toBe(true);
  });
});
