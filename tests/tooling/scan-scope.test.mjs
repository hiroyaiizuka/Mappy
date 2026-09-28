import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The community directory's automated review reads the repository's source and leaves out only the names its FAQ
 * lists ("Why are my test or development files being included in the scan?", the 2026-08-07 version;
 * docs/community-submission.md #33). A code file outside those names is read as if it were the plugin, so the only
 * code left in scan range is the plugin itself: `src/` and `styles.css`. Anything else that is not the plugin (the
 * browser harness, the vitest config) goes under an excluded name (LEV-243).
 *
 * The list is copied from the FAQ, not fetched: when the FAQ changes, this copy and #33 are redone by hand. The FAQ
 * does not say whether a directory name counts below the top level, so this reads it the narrow way: a directory
 * name excludes only as the first segment (`tests/...`), a file name or pattern only the file itself. `src/i18n/`
 * is then scanned, which is fine: it is the plugin.
 *
 * The files are the ones git tracks plus the ones it would add (untracked and not ignored), so a new file shows up
 * before `git add`. The regression test is the first one: before LEV-243 it reports the nine files of
 * `harness/browser/` and `vitest.config.ts`. Configs that the list already covers (`*.mjs`) and files that are not
 * code (Markdown, JSON, the pre-commit hook) stay where they are.
 */
const EXCLUDED_NAMES = new Set([
  "node_modules", "dist", "build", "pkg", "test-vault", ".pnpm-store", ".obsidian", "esbuild.config.mjs",
  "version-bump.mjs", "automation", "test", "tests", "__tests__", "testUtils", "e2e-tests", "mocks", "__mocks__",
  "vite", "scripts", "docs", "i18n", "i18next", "locale", "locales", "translations", "l10n",
]);
const EXCLUDED_PATTERNS = [/\.tests?\./u, /\.specs?\./u, /\.(?:cjs|mjs|cts|mts)$/u];
const CODE = /\.(?:[cm]?[jt]sx?|css|html?)$/u;
const PLUGIN = [/^src\//u, /^styles\.css$/u];

const excluded = path => {
  const parts = path.split("/");
  const name = parts[parts.length - 1] ?? "";
  return EXCLUDED_NAMES.has(parts[0]) || EXCLUDED_NAMES.has(name) || EXCLUDED_PATTERNS.some(pattern => pattern.test(name));
};

describe("code the directory's scanner reads", () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  // -z: no quoting of non-ASCII names (core.quotePath), which would put a `"` in front of the first segment.
  const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" })
    .split("\0").filter(Boolean);
  const scanned = files.filter(path => CODE.test(path) && !excluded(path));

  it("is only the plugin", () => {
    expect(scanned.filter(path => !PLUGIN.some(pattern => pattern.test(path)))).toEqual([]);
  });

  it("still sees the plugin", () => {
    // Guards the filter above: a list that excluded everything would pass the first test with nothing scanned.
    expect(scanned).toEqual(expect.arrayContaining(["src/main.ts", "src/i18n/en.ts", "styles.css"]));
    expect(excluded("tests/browser-harness/obsidian.ts")).toBe(true);
    expect(excluded("vitest.config.mts")).toBe(true);
    expect(excluded("tools/i18n/x.ts")).toBe(false);
  });
});
