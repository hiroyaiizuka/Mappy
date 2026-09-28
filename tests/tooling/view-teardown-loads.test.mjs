import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { harnessObsidian } from "../../scripts/browser-harness.mjs";
import { BUILDS, LOADS, testFiles } from "../../scripts/view-teardown-files.mjs";

/**
 * scripts/check-view-teardown.mjs (LEV-239) lists a test file that builds a view (`BUILDS`) in a file that loads the
 * view or the harness (`LOADS`) and never closes it. `LOADS` names the harness mock by its path: LEV-243 moved the
 * harness to tests/browser-harness/ and at first left `LOADS` on `harness/browser/obsidian`, which no import spells
 * any more (`tests/ui/map-embed.test.ts` then went unchecked). `LOADS` is now built from `harnessObsidian`, the
 * module the browser harness build aliases `obsidian` to.
 *
 * The regression test is the first one: with `LOADS` on the old path it reports map-embed.test.ts. Which files load
 * the mock is found apart from `LOADS`, by resolving each relative specifier against the file.
 */
const root = fileURLToPath(new URL("../../", import.meta.url));
const SPECIFIER = /(?:from\s+|import\(\s*)["'](\.{1,2}\/[^"']+)["']/gu;
const posix = path => path.split(sep).join("/");
const loadsHarness = (path, text) => [...text.matchAll(SPECIFIER)]
  .some(([, specifier]) => posix(relative(root, resolve(dirname(path), specifier))).replace(/\.ts$/u, "") === harnessObsidian.replace(/\.ts$/u, ""));

describe("check-view-teardown's LOADS", () => {
  const withHarness = testFiles(join(root, "tests"))
    .map(path => ({ path: posix(relative(root, path)), text: readFileSync(path, "utf8") }))
    .map(file => ({ ...file, harness: loadsHarness(join(root, file.path), file.text) }))
    .filter(({ text, harness }) => harness && BUILDS.test(text));

  it("sees every test file that builds a view with the harness mock", () => {
    expect(withHarness.filter(({ text }) => !LOADS.test(text)).map(({ path }) => path)).toEqual([]);
  });

  it("has files to look at", () => {
    // Guards the first test: with no file found, it passes with nothing checked.
    expect(withHarness.length).toBeGreaterThan(0);
  });
});
