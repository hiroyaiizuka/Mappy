import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { harnessObsidian } from "../../scripts/browser-harness.mjs";
import { BUILDS, LOADS, testFiles } from "../../scripts/view-teardown-files.mjs";

/**
 * scripts/check-view-teardown.mjs (LEV-239) lists a test file that builds a view (`BUILDS`) in a file that loads the
 * view or the harness (`LOADS`) and never closes it. `LOADS` names the harness mock by its path, so it has to follow
 * the harness when the harness moves: LEV-243 moved it to tests/browser-harness/ and at first left `LOADS` on
 * `harness/browser/obsidian`, which no import spells any more (`tests/ui/map-embed.test.ts` then went unchecked).
 *
 * The regression test is the first one: with `LOADS` on the old path it reports map-embed.test.ts. Which files load
 * the mock is found by resolving each relative specifier against the file, and compared with the module the browser
 * harness build aliases `obsidian` to, so the test does not spell the path a second time.
 */
const root = fileURLToPath(new URL("../../", import.meta.url));
const SPECIFIER = /(?:from\s+|import\(\s*)["'](\.{1,2}\/[^"']+)["']/gu;
const loadsHarness = (path, text) => [...text.matchAll(SPECIFIER)]
  .some(([, specifier]) => relative(root, resolve(dirname(path), `${specifier}.ts`)) === harnessObsidian);

describe("check-view-teardown's LOADS", () => {
  const withHarness = testFiles(join(root, "tests"))
    .map(path => ({ path: relative(root, path), text: readFileSync(path, "utf8"), harness: loadsHarness(path, readFileSync(path, "utf8")) }))
    .filter(({ text, harness }) => harness && BUILDS.test(text));

  it("sees every test file that builds a view with the harness mock", () => {
    expect(withHarness.filter(({ text }) => !LOADS.test(text)).map(({ path }) => path)).toEqual([]);
  });

  it("has files to look at", () => {
    // Guards the first test: with no file found, it passes with nothing checked.
    expect(withHarness.length).toBeGreaterThan(0);
  });
});
