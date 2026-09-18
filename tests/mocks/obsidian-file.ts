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

export function normalizePath(path: string): string {
  return path.replace(/\\/gu, '/').replace(/\/{2,}/gu, '/').replace(/^\.\//u, '').replace(/\/$/u, '');
}
