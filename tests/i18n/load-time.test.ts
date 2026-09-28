import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC = new URL('../../src/', import.meta.url).pathname;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

/** Nodes whose body runs later than the module's own evaluation. A static class member is not one of them. */
function defers(node: ts.Node): boolean {
  if (ts.isFunctionLike(node)) return true;
  if (ts.isPropertyDeclaration(node)) return !node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.StaticKeyword);
  return false;
}

/** `t()` calls that run while the module loads, as `file:line`. */
function loadTimeReads(path: string): string[] {
  const file = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (defers(node)) return;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 't' && node.arguments.length === 0) {
      found.push(`${relative(SRC, path)}:${file.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

describe('text is read where it is used (architecture.md §9e)', () => {
  it('no module reads t() while it loads, which is before onload has set the language', () => {
    // A module-level `const X = t().key` (or an object built from it) would stay English for good.
    expect(sources(SRC).flatMap(loadTimeReads)).toEqual([]);
  });

  it('the check sees a load-time read and lets a deferred one pass', () => {
    const probe = (text: string): number => {
      const file = ts.createSourceFile('probe.ts', text, ts.ScriptTarget.Latest, true);
      let count = 0;
      const visit = (node: ts.Node): void => {
        if (defers(node)) return;
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 't') count += 1;
        ts.forEachChild(node, visit);
      };
      visit(file);
      return count;
    };
    expect(probe('export const A = { label: t().x };')).toBe(1);
    expect(probe('class C { static A = t().x; b = t().y; m() { return t().z; } }')).toBe(1);
    expect(probe('export function f() { return t().x; }\nconst g = () => t().y;')).toBe(0);
  });
});
