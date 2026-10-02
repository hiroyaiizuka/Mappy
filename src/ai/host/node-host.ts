/**
 * The one place Mappy touches Node (docs/architecture.md §11.1). `loadNode()` takes `child_process`, `fs`, `os` and
 * `path` at run time through Electron's `window.require` and wraps them in the small `NodeHost` the rest of
 * `src/ai/host/` receives as an argument. Nothing is imported statically: the bundle is built for the browser, and on
 * mobile (or anywhere without `window.require`) the plugin must still load, only without AI. Only
 * `src/ai/runner-factory.ts` calls `loadNode()`, and only when the license allows it (§11.6, §11.7).
 *
 * The Node types are written here as the few structural shapes used, so `@types/node` stays out of `src/`.
 */

export interface ByteStream {
  on(event: 'data', listener: (chunk: Uint8Array) => void): unknown;
}

export interface ChildInput {
  write(data: string): unknown;
  end(): unknown;
  on(event: 'error', listener: (error: unknown) => void): unknown;
}

export interface ChildProcess {
  readonly pid?: number | undefined;
  readonly stdin: ChildInput | null;
  readonly stdout: ByteStream | null;
  readonly stderr: ByteStream | null;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'close', listener: (code: number | null, signal: string | null) => void): unknown;
}

export interface NodeHost {
  /** `process.platform` and `process.arch`. */
  readonly platform: string;
  readonly arch: string;
  /** Starts `file` in a process group of its own (`detached`), with all three standard streams piped. */
  spawn(file: string, args: readonly string[], options: { cwd: string; env: Record<string, string> }): ChildProcess;
  /** Sends `signal` to the whole process group led by `pid`. False when there is no such group any more. */
  killGroup(pid: number, signal: 'SIGTERM' | 'SIGKILL'): boolean;
  /** A copy of `process.env`. */
  env(): Record<string, string | undefined>;
  homedir(): string;
  tmpdir(): string;
  /** A new empty directory `<tmpdir>/<prefix>XXXXXX`. */
  mkdtemp(prefix: string): Promise<string>;
  /** Removes a directory this run made, with what is in it. */
  rm(path: string): Promise<void>;
  /** A regular file the user may execute. */
  isExecutable(path: string): Promise<boolean>;
  /** The path with every symbolic link resolved, or null when it does not exist. */
  realpath(path: string): Promise<string | null>;
  /** The names in a directory, or an empty list when it cannot be read. */
  readdir(path: string): Promise<string[]>;
  readText(path: string): Promise<string>;
}

interface NodeModules {
  childProcess: {
    spawn(file: string, args: readonly string[], options: { cwd: string; env: Record<string, string>; detached: boolean; stdio: string[] }): ChildProcess;
  };
  fs: {
    constants: { X_OK: number };
    promises: {
      mkdtemp(prefix: string): Promise<string>;
      rm(path: string, options: { recursive: boolean; force: boolean }): Promise<void>;
      access(path: string, mode: number): Promise<void>;
      stat(path: string): Promise<{ isFile(): boolean }>;
      realpath(path: string): Promise<string>;
      readdir(path: string): Promise<string[]>;
      readFile(path: string, encoding: 'utf8'): Promise<string>;
    };
  };
  os: { homedir(): string; tmpdir(): string };
  path: { join(...parts: string[]): string };
  process: {
    platform: string;
    arch: string;
    env: Record<string, string | undefined>;
    kill(pid: number, signal: string): boolean;
  };
}

/** What Electron's renderer exposes when Node integration is on (Obsidian's desktop app). */
interface ElectronWindow { require?: (id: string) => unknown; process?: NodeModules['process'] }

function takeModules(): NodeModules | null {
  const electron = window as unknown as ElectronWindow;
  if (typeof electron.require !== 'function' || !electron.process) return null;
  try {
    return {
      childProcess: electron.require('child_process') as NodeModules['childProcess'],
      fs: electron.require('fs') as NodeModules['fs'],
      os: electron.require('os') as NodeModules['os'],
      path: electron.require('path') as NodeModules['path'],
      process: electron.process,
    };
  } catch {
    return null;
  }
}

function wrap(node: NodeModules): NodeHost {
  const { childProcess, fs, os, path, process } = node;
  return {
    platform: process.platform,
    arch: process.arch,
    spawn: (file, args, options) => childProcess.spawn(file, args, { ...options, detached: true, stdio: ['pipe', 'pipe', 'pipe'] }),
    killGroup: (pid, signal) => {
      try {
        // A negative pid names the process group, which `detached` made the child lead.
        return process.kill(-pid, signal);
      } catch {
        return false;
      }
    },
    env: () => ({ ...process.env }),
    homedir: () => os.homedir(),
    tmpdir: () => os.tmpdir(),
    mkdtemp: prefix => fs.promises.mkdtemp(path.join(os.tmpdir(), prefix)),
    rm: target => fs.promises.rm(target, { recursive: true, force: true }),
    isExecutable: async target => {
      try {
        await fs.promises.access(target, fs.constants.X_OK);
        return (await fs.promises.stat(target)).isFile();
      } catch {
        return false;
      }
    },
    realpath: async target => {
      try { return await fs.promises.realpath(target); } catch { return null; }
    },
    readdir: async target => {
      try { return await fs.promises.readdir(target); } catch { return []; }
    },
    readText: target => fs.promises.readFile(target, 'utf8'),
  };
}

/**
 * The Node surface, or null when this is not the desktop app or Node is not reachable. `isDesktopApp` is Obsidian's
 * `Platform.isDesktopApp`, read by the caller; when it is false nothing is taken.
 */
export function loadNode(isDesktopApp: boolean): NodeHost | null {
  if (!isDesktopApp) return null;
  const modules = takeModules();
  return modules ? wrap(modules) : null;
}
