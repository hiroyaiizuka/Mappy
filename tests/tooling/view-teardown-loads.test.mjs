import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * scripts/check-view-teardown.mjs (LEV-239) lists a test file that builds a view (`BUILDS`) in a file that loads the
 * view or the harness (`LOADS`) and never closes it. `LOADS` names the harness mock by its path, so it follows the
 * harness when the harness moves: LEV-243 moved it to tests/browser-harness/ and at first left `LOADS` on
 * `harness/browser/obsidian`, which no import spells any more (`tests/ui/map-embed.test.ts` then went unchecked).
 *
 * The regression test is the first one: with `LOADS` on the old path it reports map-embed.test.ts. The script runs
 * vitest when imported, so its two patterns are read from its text.
 */
const root = fileURLToPath(new URL("../../", import.meta.url));
const script = readFileSync(join(root, "scripts/check-view-teardown.mjs"), "utf8");
const pattern = name => {
  const source = script.match(new RegExp(`^const ${name} = /(.+)/;$`, "mu"))?.[1];
  if (!source) throw new Error(`scripts/check-view-teardown.mjs has no ${name}`);
  return new RegExp(source, "u");
};
const testFiles = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
  const path = join(dir, entry.name);
  if (entry.isDirectory()) return testFiles(path);
  return /\.test\.ts$/u.test(entry.name) ? [path] : [];
});
const LOADS_HARNESS = /['"][./]+browser-harness\/obsidian['"]/u;

describe("check-view-teardown's LOADS", () => {
  const BUILDS = pattern("BUILDS");
  const LOADS = pattern("LOADS");

  it("sees every test file that builds a view with the harness mock", () => {
    const harness = testFiles(join(root, "tests"))
      .map(path => ({ path: path.slice(root.length), text: readFileSync(path, "utf8") }))
      .filter(({ text }) => BUILDS.test(text) && LOADS_HARNESS.test(text));
    expect(harness.map(({ path }) => path)).toContain("tests/ui/map-embed.test.ts");
    expect(harness.filter(({ text }) => !LOADS.test(text)).map(({ path }) => path)).toEqual([]);
  });
});
