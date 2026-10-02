import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * docs/architecture.md §11.7, step 1 (LEV-273): the AI feature reaches the outside through two doors only, so the
 * free state's test can count them. Node is reached only through `src/ai/host/node-host.ts`, whose values only
 * `src/ai/runner-factory.ts` imports (others take the `NodeHost` it makes, importing types only); the license
 * server only through `src/ai/license/client.ts`, which only `src/ai/license/entitlement.ts` imports; and Obsidian's
 * `requestUrl` is imported by that client and by the export's remote images alone. Read from the import
 * declarations of every file under src/, type-only imports excepted.
 */
const project = fileURLToPath(new URL('../../', import.meta.url));
const src = join(project, 'src');

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') ? [path] : [];
  });
}

const posix = path => path.split(sep).join('/');

/** The code without its comments, so a comment naming the storage does not count as touching it. */
function stripComments(text) {
  const source = ts.createSourceFile('file.ts', text, ts.ScriptTarget.Latest, true);
  const printer = ts.createPrinter({ removeComments: true });
  return printer.printFile(source);
}

/** Every value import of a file under src/: the resolved module (src-relative, without .ts) or the bare name, and its named values. */
function valueImports(file, text = readFileSync(file, 'utf8')) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const imports = [];
  const add = (specifier, names) => {
    const target = specifier.startsWith('.') ? posix(relative(src, resolve(dirname(file), specifier))) : specifier;
    imports.push({ target, names });
  };
  const visit = node => {
    if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      const names = [];
      if (clause?.name) names.push('default');
      if (bindings && ts.isNamespaceImport(bindings)) names.push('*');
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) if (!element.isTypeOnly) names.push((element.propertyName ?? element.name).text);
      }
      // `import type`-only lists and `import {}` reach no value; a bare `import './x'` runs the module.
      if (names.length > 0 || !clause) add(node.moduleSpecifier.text, names);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && !node.isTypeOnly) {
      add(node.moduleSpecifier.text, ['*']);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && ts.isStringLiteral(node.arguments[0])) {
      add(node.arguments[0].text, ['*']);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return imports;
}

let parsed;
/** Every file under src/ with its value imports, parsed once for the whole file. */
function sourceImports() {
  parsed ??= sourceFiles(src).map(file => [file, valueImports(file)]);
  return parsed;
}

function importersOf(target, predicate = () => true) {
  return sourceImports()
    .filter(([, imports]) => imports.some(entry => entry.target === target && predicate(entry)))
    .map(([file]) => file)
    .map(file => posix(relative(project, file)))
    .sort();
}

// Parsing every file under src/ takes seconds on a loaded machine.
describe('the AI feature\'s doors to the outside (§11.7 step 1)', { timeout: 60_000 }, () => {
  // Holds since LEV-270 is in (tests/tooling/ai-node-boundary.test.mjs pins the same with its own scan).
  it('only src/ai/runner-factory.ts imports a value of src/ai/host/node-host.ts', () => {
    const importers = importersOf('ai/host/node-host');
    expect(importers.filter(file => file !== 'src/ai/runner-factory.ts')).toEqual([]);
  });

  it('only src/ai/license/entitlement.ts imports src/ai/license/client.ts', () => {
    expect(importersOf('ai/license/client')).toEqual(['src/ai/license/entitlement.ts']);
  });

  it('reads and writes the license in src/ai/license/store.ts only, which alone picks the storage (2026-10-02 decision)', () => {
    // The storage is to follow TaskChute for Obsidian's once the engineer says where that is: one file to change.
    const touching = sourceFiles(src).filter(file => {
      const text = readFileSync(file, 'utf8');
      return /\blocalStorage\b|LICENSE_STORAGE_KEY|['"`]mappy-ai-license['"`]|\bcreateWindowLicenseStore\b/u.test(stripComments(text));
    }).map(file => posix(relative(project, file)));
    expect(touching).toEqual(['src/ai/license/store.ts']);
    // The device storage for the runner's paths (LEV-270's wiring) comes from the same file, so it moves with the license.
    expect(importersOf('ai/license/store', entry => entry.names.some(name => name !== 'createLicenseStore' && name !== 'createDeviceStorage'))).toEqual([]);
    expect(importersOf('ai/license/store', entry => entry.names.includes('createLicenseStore'))).toEqual(['src/ai/license/entitlement.ts']);
    expect(importersOf('ai/license/store', entry => entry.names.includes('createDeviceStorage'))).toEqual(['src/main.ts']);
  });

  it('imports Obsidian\'s requestUrl or request in the license client and the export\'s remote images only', () => {
    expect(importersOf('obsidian', entry => entry.names.includes('requestUrl') || entry.names.includes('request') || entry.names.includes('*')))
      .toEqual(['src/ai/license/client.ts', 'src/obsidian/image-export.ts']);
  });

  it('opens no other way to the network in src/: no fetch, XMLHttpRequest, WebSocket, EventSource or sendBeacon', () => {
    const others = sourceFiles(src)
      .filter(file => /\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b|\bEventSource\b|\bsendBeacon\b/u.test(stripComments(readFileSync(file, 'utf8'))))
      .map(file => posix(relative(project, file)));
    expect(others).toEqual([]);
  });

  it('reads type-only imports as no import, and named value imports, re-exports and import() as imports', () => {
    const file = join(src, 'ai', 'example.ts');
    expect(valueImports(file, "import type { NodeHost } from './host/node-host';\nimport { type NodeHost as H } from './host/node-host';\n")).toEqual([]);
    expect(valueImports(file, "import { loadNode } from './host/node-host';\n")).toEqual([{ target: 'ai/host/node-host', names: ['loadNode'] }]);
    expect(valueImports(file, "export * from './host/node-host';\n")).toEqual([{ target: 'ai/host/node-host', names: ['*'] }]);
    expect(valueImports(file, "void import('./host/node-host');\n")).toEqual([{ target: 'ai/host/node-host', names: ['*'] }]);
    expect(valueImports(file, "import * as obsidian from 'obsidian';\n")).toEqual([{ target: 'obsidian', names: ['*'] }]);
  });
});
