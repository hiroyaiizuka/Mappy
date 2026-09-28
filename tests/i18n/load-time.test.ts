import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC = `${fileURLToPath(new URL('../../src', import.meta.url))}/`;
const I18N = resolve(SRC, 'i18n');

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

interface Module {
  name: string;
  file: ts.SourceFile;
  /** Local names bound to `t` (`import { t }`, `import { t as tr }`). */
  aliases: Set<string>;
  /** Local names of `import * as i18n`, read as `i18n.t()`. */
  namespaces: Set<string>;
  /** `import { en }` / `import { ja }` from the tables themselves, which only src/i18n may do. */
  tables: string[];
}

function parse(path: string, text = readFileSync(path, 'utf8')): Module {
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const module: Module = { name: relative(SRC, path), file, aliases: new Set(), namespaces: new Set(), tables: [] };
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const target = resolve(dirname(path), statement.moduleSpecifier.text);
    const bindings = statement.importClause?.namedBindings;
    if (target === I18N || target === join(I18N, 'index')) {
      if (bindings && ts.isNamespaceImport(bindings)) module.namespaces.add(bindings.name.text);
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) if ((element.propertyName ?? element.name).text === 't') module.aliases.add(element.name.text);
      }
    } else if (target.startsWith(`${I18N}/`) && !path.startsWith(`${I18N}/`) && !statement.importClause?.isTypeOnly
      && !(bindings && ts.isNamedImports(bindings) && bindings.elements.every(element => element.isTypeOnly))) {
      module.tables.push(`${module.name}: ${statement.moduleSpecifier.text}`);
    }
  }
  return module;
}

/** `f(...)` → `f`, `i18n.t(...)` → `i18n.t`, `new C(...)` → `new C`; anything else is not a call this check follows. */
function callee(node: ts.CallExpression | ts.NewExpression): string | null {
  const expression = node.expression;
  if (ts.isNewExpression(node)) return ts.isIdentifier(expression) ? `new ${expression.text}` : null;
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)) return `${expression.expression.text}.${expression.name.text}`;
  return null;
}

function readsText(module: Module, name: string | null, readers: Set<string>): boolean {
  if (!name) return false;
  if (module.aliases.has(name) || readers.has(name)) return true;
  const [namespace, member] = name.split('.');
  return member === 't' && namespace !== undefined && module.namespaces.has(namespace);
}

/**
 * The named functions of a module: declarations, `const f = () => …` / `const f = function …`, a class's static
 * methods as `C.m` (what `callee` names a call to one) and its constructor as `new C`. Instance methods are left out:
 * a call through an instance made while the module loads (`const l = new C(); l.m()`) is not followed.
 */
function functions(module: Module): { name: string; body: ts.Node }[] {
  const found: { name: string; body: ts.Node }[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) found.push({ name: node.name.text, body: node.body });
    if (ts.isMethodDeclaration(node) && node.body && ts.isIdentifier(node.name) && ts.isClassDeclaration(node.parent) && node.parent.name
      && node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.StaticKeyword)) found.push({ name: `${node.parent.name.text}.${node.name.text}`, body: node.body });
    if (ts.isConstructorDeclaration(node) && node.body && ts.isClassDeclaration(node.parent) && node.parent.name) found.push({ name: `new ${node.parent.name.text}`, body: node.body });
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
      && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) found.push({ name: node.name.text, body: node.initializer.body });
    ts.forEachChild(node, visit);
  };
  visit(module.file);
  return found;
}

/**
 * Function names that read the table when called, directly (`t()`) or through another such function
 * (`layoutLabel()`), across all modules. Matched by name, so a same-named function elsewhere is counted too:
 * that errs on the side of flagging.
 */
function textReaders(modules: Module[]): Set<string> {
  const readers = new Set<string>();
  for (let grew = true; grew;) {
    grew = false;
    for (const module of modules) {
      for (const { name, body } of functions(module)) {
        if (readers.has(name)) continue;
        let reads = false;
        const visit = (node: ts.Node): void => {
          if (reads) return;
          if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && readsText(module, callee(node), readers)) reads = true;
          ts.forEachChild(node, visit);
        };
        visit(body);
        if (reads) { readers.add(name); grew = true; }
      }
    }
  }
  return readers;
}

/**
 * A function run right where it is written, `(() => …)()`, runs with the module; so, as far as this check can
 * tell, does one handed to a call (`MODES.map(mode => …)`). A callback kept for later (a timer, a listener) would
 * be flagged too: none is registered while a module loads.
 */
function invokedInPlace(node: ts.Node): boolean {
  let outer = node.parent;
  let inner: ts.Node = node;
  while (ts.isParenthesizedExpression(outer)) { inner = outer; outer = outer.parent; }
  return (ts.isCallExpression(outer) || ts.isNewExpression(outer))
    && (outer.expression === inner || (outer.arguments?.includes(inner as ts.Expression) ?? false));
}

/** Nodes whose body runs later than the module's own evaluation. A static class member is not one of them. */
function defers(node: ts.Node): boolean {
  if (ts.isFunctionLike(node)) return !invokedInPlace(node);
  if (ts.isPropertyDeclaration(node)) return !node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.StaticKeyword);
  return false;
}

/** Calls that read the table while the module loads, as `file:line call`. */
function loadTimeReads(module: Module, readers: Set<string>): string[] {
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (defers(node)) return;
    const at = (): string => `${module.name}:${module.file.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
    if (ts.isNewExpression(node)) {
      const name = callee(node);
      if (readsText(module, name, readers)) found.push(`${at()} ${name}()`);
    }
    if (ts.isCallExpression(node)) {
      const name = callee(node);
      if (readsText(module, name, readers)) found.push(`${at()} ${name}()`);
      // `MODES.map(layoutLabel)`: the reader is called by the call it is handed to.
      for (const argument of node.arguments) {
        if (ts.isIdentifier(argument) && readsText(module, argument.text, readers)) found.push(`${at()} ${argument.text}()`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(module.file);
  return found;
}

function check(modules: Module[]): string[] {
  const readers = textReaders(modules);
  return [...modules.flatMap(module => loadTimeReads(module, readers)), ...modules.flatMap(module => module.tables)];
}

describe('text is read where it is used (architecture.md §9e)', () => {
  it('no module reads the text while it loads, which is before onload has set the language', () => {
    // A module-level `const X = t().key`, or anything built from it, would stay English for good.
    expect(check(sources(SRC).map(path => parse(path)))).toEqual([]);
  });

  it('the check follows aliases, namespaces, functions that read the text and code run in place, and lets deferred reads pass', () => {
    const probe = (text: string, other = ''): string[] => {
      const modules = [parse(join(SRC, 'ui', 'probe.ts'), text)];
      if (other) modules.push(parse(join(SRC, 'core', 'other.ts'), other));
      return check(modules).map(line => line.replace(/^.*?:\d+ /u, ''));
    };
    const imports = 'import { t } from "../i18n";\n';
    expect(probe(`${imports}export const A = { label: t().x };`)).toEqual(['t()']);
    expect(probe('import { t as tr } from "../i18n";\nconst A = tr().x;')).toEqual(['tr()']);
    expect(probe('import * as i18n from "../i18n/index";\nconst A = i18n.t().x;')).toEqual(['i18n.t()']);
    expect(probe(`${imports}const A = (() => t().x)();`)).toEqual(['t()']);
    expect(probe(`${imports}class C { static A = t().x; b = t().y; m() { return t().z; } }`)).toEqual(['t()']);
    // A function in another module that reads the text, called while this one loads.
    expect(probe('import { label } from "../core/other";\nconst A = label("mindmap");', `${imports}export function label(mode: string) { return t()[mode]; }`))
      .toEqual(['label()']);
    expect(probe('import { en } from "../i18n/en";\nconst A = en.x;')).toEqual(['ui/probe.ts: ../i18n/en']);
    expect(probe('import { type Messages } from "../i18n/en";\nexport function f(m: Messages) { return m; }')).toEqual([]);
    expect(probe(`${imports}class Labels { name = ""; constructor() { this.name = t().x; } }\nexport const L = new Labels();`)).toEqual(['new Labels()']);
    expect(probe(`${imports}const A = ["x"].map(key => t()[key]);`)).toEqual(['t()']);
    expect(probe('import { Labels } from "../core/other";\nconst A = Labels.of("mindmap");', `${imports}export class Labels { static of(mode: string) { return t()[mode]; } }`))
      .toEqual(['Labels.of()']);
    expect(probe('import { label } from "../core/other";\nconst A = ["mindmap"].map(label);', `${imports}export function label(mode: string) { return t()[mode]; }`))
      .toEqual(['label()']);
    expect(probe(`${imports}export function f() { return t().x; }\nconst g = () => t().y;\nclass C { m() { return ["x"].map(key => t()[key]); } }`)).toEqual([]);
  });
});
