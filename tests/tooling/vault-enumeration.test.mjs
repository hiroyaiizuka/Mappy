import { readdir, readFile } from "node:fs/promises";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * The community review's automated scan (0.4.1, LEV-253) recommends against listing the vault: each call below hands
 * the plugin every file path. Two features cannot work without it and are named here, with what README tells the
 * reader (the names are read on this device for the link suggestions and the map search, and never sent anywhere).
 * Anything else resolves a path directly (`getAbstractFileByPath`, a folder's own `children`). A new call fails this
 * test until it is added below with its reason, and README's privacy section says what it reads.
 */
// Read as tokens (TypeScript's scanner), not as text (review 3): comments, strings and regular expressions are skipped,
// and only a property reached with `.` counts, so a local `fileMap` is not a listing while `.bind`-ing one or keeping it
// in a variable still is (review 1). Besides the vault's own lists: Obsidian's walk from the root, the metadata cache's
// tables keyed by every file, and the adapter's directory listing. What this cannot see is a walk written by hand over
// `TFolder.children` from the root; `map-files.ts` walks only the children whose name matches the path, and a review
// has to judge a new walk.
const LISTING = new Set(["getFiles", "getMarkdownFiles", "getAllLoadedFiles", "getAllFolders", "recurseChildren",
  "resolvedLinks", "unresolvedLinks", "getCachedFiles", "fileMap"]);

/** The listing members `text` reaches: `.name` for a name in LISTING, and `adapter.list`. */
function listings(text) {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, text);
  const found = [];
  const previous = [];
  let templates = 0;
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    // A slash where an expression starts is a regular expression literal, not division.
    if ((kind === ts.SyntaxKind.SlashToken || kind === ts.SyntaxKind.SlashEqualsToken)
      && !(previous[0]?.kind === ts.SyntaxKind.Identifier || previous[0]?.kind === ts.SyntaxKind.CloseParenToken
        || previous[0]?.kind === ts.SyntaxKind.CloseBracketToken || previous[0]?.kind === ts.SyntaxKind.NumericLiteral)) {
      kind = scanner.reScanSlashToken();
    }
    // Inside a template literal, the `}` closing a substitution goes back to scanning the literal's text.
    if (kind === ts.SyntaxKind.CloseBraceToken && templates > 0) kind = scanner.reScanTemplateToken(false);
    if (kind === ts.SyntaxKind.TemplateHead) templates += 1;
    if (kind === ts.SyntaxKind.TemplateTail) templates -= 1;
    const token = { kind, text: scanner.getTokenText() };
    if (kind === ts.SyntaxKind.Identifier && previous[0]?.kind === ts.SyntaxKind.DotToken) {
      if (LISTING.has(token.text)) found.push(token.text);
      if (token.text === "list" && previous[1]?.text === "adapter") found.push("adapter.list");
    }
    previous.unshift(token);
    previous.length = 2;
  }
  return found;
}

const ALLOWED = {
  // [[ suggestions in the inline editor: every file and alias is a candidate, as in Obsidian's own suggester.
  "src/ui/link-suggest.ts": ["getFiles"],
  // Calling a map (§5 M12): the candidates are the Markdown notes marked `mappy: true`.
  "src/obsidian/map-search.ts": ["getMarkdownFiles"],
  // The AI input's attachment (LEV-271, docs/architecture.md §11.2): the candidates are the notes and PDFs, read only
  // when the license is active and the user presses 添付. README's disclosure of the AI (#41〜#48) comes with LEV-272.
  "src/ui/ai/ai-controller.ts": ["getFiles"],
};

async function sources(dir) {
  const entries = await readdir(new URL(`../../${dir}/`, import.meta.url), { withFileTypes: true });
  const nested = await Promise.all(entries.map(entry => entry.isDirectory() ? sources(`${dir}/${entry.name}`)
    : /\.(ts|mts|js|mjs)$/u.test(entry.name) ? [`${dir}/${entry.name}`] : []));
  return nested.flat();
}

describe("vault enumeration in src/", () => {
  it("reads tokens: a comment, a string or a regular expression hides nothing and names nothing (review 3)", () => {
    expect(listings("if (/^https?:\\/\\//u.test(url)) return app.vault.getFiles();")).toEqual(["getFiles"]);
    expect(listings("const glob = '**/*.md'; const all = app.vault.getMarkdownFiles(); // */")).toEqual(["getMarkdownFiles"]);
    expect(listings("// app.vault.getFiles()\nconst fileMap = new Map(); const s = 'vault.getFiles()';")).toEqual([]);
    expect(listings("const list = app.vault.getAllLoadedFiles.bind(app.vault); app.vault.adapter.list('/');")).toEqual(["getAllLoadedFiles", "adapter.list"]);
    expect(listings("const t = `${a}/${app.vault.getFiles().length}`;")).toEqual(["getFiles"]);
  });

  it("lists the vault only where a feature needs every path (LEV-253)", async () => {
    const found = {};
    for (const path of await sources("src")) {
      const text = await readFile(new URL(`../../${path}`, import.meta.url), "utf8");
      const calls = listings(text);
      if (calls.length > 0) found[path] = [...new Set(calls)].sort();
    }
    expect(found).toEqual(ALLOWED);
  });
});
