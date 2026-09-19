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
  /** The containing folder, read off the path; a file at the top level is in the root folder `/`. */
  get parent(): TFolder | null {
    const folder = new TFolder();
    folder.path = this.path.includes('/') ? this.path.slice(0, this.path.lastIndexOf('/')) : '/';
    return folder;
  }
}

export class TFolder {
  path = '';
  get name(): string { return this.path.split('/').pop() ?? ''; }
  isRoot(): boolean { return this.path === '/'; }
}

/**
 * Obsidian's rules (app.js 1.14.2): forward slashes, no run of slashes, none leading or
 * trailing, the empty result is the root `/`. Nothing else: `.` and `..` segments stay.
 */
export function normalizePath(path: string): string {
  const normalized = path.replace(/[\\/]+/gu, '/').replace(/^\/+|\/+$/gu, '');
  return normalized === '' ? '/' : normalized;
}
