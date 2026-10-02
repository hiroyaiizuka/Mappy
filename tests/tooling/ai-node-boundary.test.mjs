import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * One door to Node (docs/architecture.md §11.1, §11.7): only src/ai/runner-factory.ts may import a value from
 * src/ai/host/node-host.ts (and so call `loadNode()`); everything else that needs Node — the rest of src/ai/host/, the
 * runner, the settings rows — takes the `NodeHost` the factory made, importing the module for its types only. The
 * factory asks the license before loading, so with this rule the free state has no path to Node. The lint (§11.1)
 * keeps `window.require` out of the other files; this keeps the import graph from routing around the factory.
 */
const root = fileURLToPath(new URL("../../", import.meta.url));
const ALLOWED = "src/ai/runner-factory.ts";
const HOST = "src/ai/host/node-host.ts";

function sources(dir) {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap(entry => {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

/** The module specifiers a file takes values from (`import type` and `export type` left out), dynamic imports included. */
function valueImports(text) {
  const found = [];
  const statement = /(?:^|\n)\s*(import|export)\s+(?!type\b)([^;]*?)\s+from\s+["']([^"']+)["']/gu;
  for (const match of text.matchAll(statement)) {
    const clause = match[2] ?? "";
    // `import { type A, type B } from` brings no value.
    const names = clause.replace(/^[^{]*\{|\}[^}]*$/gu, "").split(",").map(name => name.trim()).filter(Boolean);
    const onlyTypes = clause.includes("{") && !/^\s*\w+\s*,/u.test(clause) && names.length > 0 && names.every(name => name.startsWith("type "));
    if (!onlyTypes) found.push(match[3]);
  }
  for (const match of text.matchAll(/import\(\s*["'`]([^"'`]+)["'`]\s*\)/gu)) found.push(match[1]);
  for (const match of text.matchAll(/(?:^|\n)\s*import\s+["']([^"']+)["']/gu)) found.push(match[1]);
  return found;
}

function resolves(from, specifier) {
  if (!specifier.startsWith(".")) return null;
  const parts = from.split("/").slice(0, -1);
  for (const part of specifier.split("/")) {
    if (part === "..") parts.pop();
    else if (part !== ".") parts.push(part);
  }
  return `${parts.join("/")}.ts`;
}

function importersOfHost(files) {
  return files.filter(file => valueImports(readFileSync(join(root, file), "utf8")).some(specifier => resolves(file, specifier) === HOST));
}

describe("the way to Node goes through the runner factory", () => {
  it("lets only src/ai/runner-factory.ts import node-host.ts for a value", () => {
    expect(importersOfHost(sources("src"))).toEqual([ALLOWED]);
  });

  it("calls loadNode() only in the factory (and defines it in node-host.ts)", () => {
    const callers = sources("src").filter(file => /\bloadNode\s*\(/u.test(readFileSync(join(root, file), "utf8")));
    expect(callers.sort()).toEqual([HOST, ALLOWED].sort());
  });

  it("would catch another importer (the scan reads value imports, not type imports)", () => {
    expect(valueImports('import { loadNode } from "./host/node-host";')).toEqual(["./host/node-host"]);
    expect(valueImports('import { type NodeHost, loadNode } from "./node-host";')).toEqual(["./node-host"]);
    expect(valueImports('import type { NodeHost } from "./node-host";')).toEqual([]);
    expect(valueImports('import { type NodeHost } from "./node-host";')).toEqual([]);
    expect(valueImports('export { loadNode } from "./node-host";')).toEqual(["./node-host"]);
    expect(valueImports('const m = await import("./host/node-host");')).toEqual(["./host/node-host"]);
    expect(resolves("src/ai/runner.ts", "./host/node-host")).toBe(HOST);
    expect(relative(root, join(root, ALLOWED))).toBe(ALLOWED);
  });
});
