/**
 * File members shared by the Node mock (`./obsidian.ts`) and the browser
 * harness (`harness/browser/obsidian.ts`), kept apart from the mocked module id
 * so a test can substitute the harness module for `obsidian` without a cycle.
 */
export class TFile {
  path = '';
  get name(): string { return this.path.split('/').pop() ?? ''; }
  get basename(): string { return this.name.replace(/\.[^.]+$/u, ''); }
  get extension(): string { return this.name.includes('.') ? this.name.split('.').pop() ?? '' : ''; }
}

/** Obsidian's rules: forward slashes, no run of slashes, none leading or trailing; the empty result is the root, `/`. */
export function normalizePath(path: string): string {
  const normalized = path.replace(/[\\/]+/gu, '/').replace(/^\.\//u, '').replace(/^\/+|\/+$/gu, '');
  return normalized === '' ? '/' : normalized;
}
