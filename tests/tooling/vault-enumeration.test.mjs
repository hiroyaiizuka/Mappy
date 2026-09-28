import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/**
 * The community review's automated scan (0.4.1, LEV-253) recommends against listing the vault: each call below hands
 * the plugin every file path. Two features cannot work without it and are named here, with what README tells the
 * reader (the names are read on this device for the link suggestions and the map search, and never sent anywhere).
 * Anything else resolves a path directly (`getAbstractFileByPath`, a folder's own `children`). A new call fails this
 * test until it is added below with its reason, and README's privacy section says what it reads.
 */
// Named, not only called: a reference passed on (`.bind`, a variable) lists the vault as well (review 1). The other ways to
// reach every path go in too: Obsidian's own walk from the root, the metadata cache's tables keyed by every file, and
// the adapter's directory listing. Comments are left out (review 2: naming an API in a comment lists nothing). What
// this cannot see is a walk written by hand over `TFolder.children` from the root; `map-files.ts` walks only the
// children whose name matches the path, and a review has to judge a new walk.
const LISTING = /\b(getFiles|getMarkdownFiles|getAllLoadedFiles|getAllFolders|recurseChildren|resolvedLinks|unresolvedLinks|getCachedFiles|fileMap)\b|\badapter\s*\.\s*(list)\b/gu;
const ALLOWED = {
  // [[ suggestions in the inline editor: every file and alias is a candidate, as in Obsidian's own suggester.
  "src/ui/link-suggest.ts": ["getFiles"],
  // Calling a map (§5 M12): the candidates are the Markdown notes marked `mappy: true`.
  "src/obsidian/map-search.ts": ["getMarkdownFiles"],
};

async function sources(dir) {
  const entries = await readdir(new URL(`../../${dir}/`, import.meta.url), { withFileTypes: true });
  const nested = await Promise.all(entries.map(entry => entry.isDirectory() ? sources(`${dir}/${entry.name}`)
    : /\.(ts|mts|js|mjs)$/u.test(entry.name) ? [`${dir}/${entry.name}`] : []));
  return nested.flat();
}

describe("vault enumeration in src/", () => {
  it("lists the vault only where a feature needs every path (LEV-253)", async () => {
    const found = {};
    for (const path of await sources("src")) {
      const text = await readFile(new URL(`../../${path}`, import.meta.url), "utf8");
      const code = text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gmu, "");
      const calls = [...code.matchAll(LISTING)].map(match => match[1] ?? `adapter.${match[2]}`);
      if (calls.length > 0) found[path] = [...new Set(calls)].sort();
    }
    expect(found).toEqual(ALLOWED);
  });
});
