import type { ChildProcess, NodeHost } from '../../src/ai/host/node-host';

/**
 * A `NodeHost` with no Node behind it: spawned processes are `FakeChild`ren a test drives (lines out, exit codes,
 * whether a signal ends them), the file system is a map, and every call is recorded.
 */

type Listener = (...args: never[]) => void;

class Emitter {
  private listeners = new Map<string, Listener[]>();
  on(event: string, listener: Listener): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }
  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) (listener as (...values: unknown[]) => void)(...args);
  }
}

export class FakeChild implements ChildProcess {
  readonly stdinText: string[] = [];
  stdinEnded = false;
  closed = false;
  readonly stdout = new Emitter();
  readonly stderr = new Emitter();
  private readonly events = new Emitter();
  readonly stdin = {
    write: (data: string) => { this.stdinText.push(data); return true; },
    end: () => { this.stdinEnded = true; },
    on: () => this.stdin,
  };
  constructor(readonly pid: number | undefined, readonly file: string, readonly args: readonly string[], readonly options: { cwd: string; env: Record<string, string> }) {}

  on(event: 'error' | 'close' | 'exit', listener: Listener): this {
    this.events.on(event, listener);
    return this;
  }
  /** Bytes on standard output, as Node delivers them (a chunk may end inside a line or a character). */
  out(text: string | Uint8Array): void { this.stdout.emit('data', typeof text === 'string' ? new TextEncoder().encode(text) : text); }
  err(text: string): void { this.stderr.emit('data', new TextEncoder().encode(text)); }
  lines(lines: readonly string[]): void { for (const line of lines) this.out(`${line}\n`); }
  /** The process ends and its pipes close, as Node reports it: 'exit', then 'close'. */
  close(code: number | null, signal: string | null = null): void {
    if (this.closed) return;
    this.closed = true;
    this.events.emit('exit', code, signal);
    this.events.emit('close', code, signal);
  }
  /** The process ends but something still holds its standard output: 'exit' and no 'close'. */
  exitHoldingPipes(code: number | null): void { this.closed = true; this.events.emit('exit', code, null); }
  fail(error: Error): void { this.events.emit('error', error); }
}

export interface FakeHostOptions {
  /** What a spawn does: drive the child (synchronously or later). Unset: the child waits for the test. */
  onSpawn?: (child: FakeChild) => void;
  /** Called on killGroup; return false to report "no such group". By default SIGTERM and SIGKILL close the child. */
  onKill?: (child: FakeChild, signal: 'SIGTERM' | 'SIGKILL') => boolean;
  executables?: string[];
  links?: Record<string, string>;
  files?: Record<string, string>;
  dirs?: Record<string, string[]>;
  env?: Record<string, string | undefined>;
  platform?: string;
  arch?: string;
  spawnThrows?: Error;
  /** Modification times (ms) by path, for sweeping old temporary directories. */
  mtimes?: Record<string, number>;
}

export class FakeHost implements NodeHost {
  readonly platform: string;
  readonly arch: string;
  readonly children: FakeChild[] = [];
  readonly kills: { pid: number; signal: string }[] = [];
  readonly made: string[] = [];
  readonly removed: string[] = [];
  readonly files: Map<string, string>;
  private nextPid = 1000;
  private nextDir = 0;

  constructor(private readonly options: FakeHostOptions = {}) {
    this.platform = options.platform ?? 'darwin';
    this.arch = options.arch ?? 'arm64';
    this.files = new Map(Object.entries(options.files ?? {}));
  }

  spawn(file: string, args: readonly string[], options: { cwd: string; env: Record<string, string> }): FakeChild {
    if (this.options.spawnThrows) throw this.options.spawnThrows;
    const child = new FakeChild(this.nextPid++, file, args, options);
    this.children.push(child);
    this.options.onSpawn?.(child);
    return child;
  }
  killGroup(pid: number, signal: 'SIGTERM' | 'SIGKILL'): boolean {
    this.kills.push({ pid, signal });
    const child = this.children.find(candidate => candidate.pid === pid);
    if (!child || child.closed) return false;
    if (this.options.onKill) return this.options.onKill(child, signal);
    queueMicrotask(() => { child.close(null, signal); });
    return true;
  }
  env(): Record<string, string | undefined> { return { ...(this.options.env ?? { USER: 'user', HOME: '/Users/user', PATH: '/usr/bin:/bin' }) }; }
  homedir(): string { return '/Users/user'; }
  tmpdir(): string { return '/tmp'; }
  mkdtemp(prefix: string): Promise<string> {
    const dir = `/tmp/${prefix}${String(this.nextDir++).padStart(6, '0')}`;
    this.made.push(dir);
    return Promise.resolve(dir);
  }
  rm(path: string): Promise<void> { this.removed.push(path); return Promise.resolve(); }
  isExecutable(path: string): Promise<boolean> { return Promise.resolve((this.options.executables ?? []).includes(path)); }
  realpath(path: string): Promise<string | null> {
    const known = (this.options.executables ?? []).includes(path) || this.files.has(path);
    return Promise.resolve(this.options.links?.[path] ?? (known ? path : null));
  }
  readdir(path: string): Promise<string[]> {
    const listed = this.options.dirs?.[path] ?? [];
    const inFiles = [...this.files.keys()].filter(file => file.startsWith(`${path}/`)).map(file => file.slice(path.length + 1));
    return Promise.resolve([...listed, ...inFiles]);
  }
  readText(path: string): Promise<string> {
    const text = this.files.get(path);
    return text === undefined ? Promise.reject(new Error(`ENOENT ${path}`)) : Promise.resolve(text);
  }
  modifiedAt(path: string): Promise<number | null> { return Promise.resolve(this.options.mtimes?.[path] ?? null); }
}
