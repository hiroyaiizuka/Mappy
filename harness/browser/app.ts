/**
 * In-memory stand-in for the parts of `App` the map view touches. Reads and
 * writes stay in this page: nothing reaches a vault, so the save path,
 * link resolution and frontmatter persistence remain Obsidian-only checks.
 */
import { Events, Notice, Scope, TFile, WorkspaceLeaf } from "./obsidian";

interface VaultEntry {
  file: TFile;
  content: string;
  /** Resource URL for binary attachments; Markdown has none. */
  url: string | undefined;
  /** Frontmatter as the map view sees it; `processFrontMatter` edits this object only. */
  frontmatter: Record<string, unknown> | undefined;
}

export interface HarnessActivity {
  kind: "link" | "layout-saved" | "frontmatter" | "split" | "attachment";
  detail: string;
  at: number;
}

/** A tiny YAML subset: scalars and `- item` lists, enough for `mappy`, `mappy-layout` and aliases. */
export function parseFrontmatter(source: string): Record<string, unknown> | undefined {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u);
  if (!match?.[1]) return undefined;
  const result: Record<string, unknown> = {};
  let listKey: string | null = null;
  for (const line of match[1].split(/\r?\n/u)) {
    const item = line.match(/^\s+-\s+(.*)$/u);
    if (item && listKey) {
      const list = result[listKey];
      if (Array.isArray(list)) list.push(unquote(item[1] ?? ""));
      continue;
    }
    const pair = line.match(/^([\w-]+):\s*(.*)$/u);
    if (!pair?.[1]) continue;
    const [, key, raw = ""] = pair;
    listKey = null;
    if (raw === "") { result[key] = []; listKey = key; }
    else if (raw === "true" || raw === "false") result[key] = raw === "true";
    else if (raw.startsWith("[") && raw.endsWith("]")) result[key] = raw.slice(1, -1).split(",").map(value => unquote(value.trim()));
    else result[key] = unquote(raw);
  }
  return result;
}

function unquote(value: string): string {
  return /^(['"]).*\1$/u.test(value) ? value.slice(1, -1) : value;
}

export class HarnessApp {
  readonly vaultEvents = new Events();
  readonly workspaceEvents = new Events();
  /** The root scope a view's own scope names as its parent; no keymap consults it in this page. */
  readonly scope = new Scope();
  readonly activity: HarnessActivity[] = [];
  private readonly entries = new Map<string, VaultEntry>();
  private attachmentCount = 0;

  readonly vault = {
    on: (name: string, callback: (...data: unknown[]) => unknown) => this.vaultEvents.on(name, callback),
    offref: (ref: unknown) => { this.vaultEvents.offref(ref as never); },
    getAbstractFileByPath: (path: string): TFile | null => this.entries.get(path)?.file ?? null,
    getFileByPath: (path: string): TFile | null => this.entries.get(path)?.file ?? null,
    getFiles: (): TFile[] => Array.from(this.entries.values(), entry => entry.file),
    getResourcePath: (file: TFile): string => this.entries.get(file.path)?.url ?? "",
    read: (file: TFile): Promise<string> => Promise.resolve(this.entry(file).content),
    cachedRead: (file: TFile): Promise<string> => Promise.resolve(this.entry(file).content),
    process: (file: TFile, change: (current: string) => string): Promise<string> => {
      const entry = this.entry(file);
      const next = change(entry.content);
      if (next !== entry.content) {
        entry.content = next;
        entry.frontmatter = parseFrontmatter(next);
        this.vaultEvents.trigger("modify", file);
      }
      return Promise.resolve(next);
    },
    createBinary: (path: string, data: ArrayBuffer): Promise<TFile> => {
      const url = URL.createObjectURL(new Blob([data]));
      const file = this.put(path, "", url);
      this.record("attachment", `${path} をページ内に保持（Vault へは書きません）`);
      return Promise.resolve(file);
    },
  };

  readonly workspace = {
    on: (name: string, callback: (...data: unknown[]) => unknown) => this.workspaceEvents.on(name, callback),
    offref: (ref: unknown) => { this.workspaceEvents.offref(ref as never); },
    getLeavesOfType: (): { view: unknown }[] => [],
    requestSaveLayout: (): void => { this.record("layout-saved", "requestSaveLayout（ページ内で記録のみ）"); },
    openLinkText: (link: string, sourcePath: string, newLeaf: unknown): Promise<void> => {
      this.record("link", `${link}（${sourcePath} から${newLeaf ? "、新しいペイン" : ""}）`);
      new Notice(`リンク解決はこのページの対象外です: ${link}`);
      return Promise.resolve();
    },
    createLeafBySplit: (): WorkspaceLeaf => {
      this.record("split", "createLeafBySplit（Markdown エディタはこのページにありません）");
      return new WorkspaceLeaf(this.asApp());
    },
  };

  readonly metadataCache = {
    on: (name: string, callback: (...data: unknown[]) => unknown) => this.vaultEvents.on(`metadata:${name}`, callback),
    getFileCache: (file: TFile): { frontmatter?: Record<string, unknown> } | null => {
      const entry = this.entries.get(file.path);
      if (!entry) return null;
      return entry.frontmatter ? { frontmatter: entry.frontmatter } : {};
    },
    getFirstLinkpathDest: (linkpath: string): TFile | null => {
      const wanted = linkpath.trim().toLowerCase();
      if (!wanted) return null;
      for (const entry of this.entries.values()) {
        const path = entry.file.path.toLowerCase();
        if (path === wanted || path === `${wanted}.md` || entry.file.name.toLowerCase() === wanted
          || entry.file.basename.toLowerCase() === wanted) return entry.file;
      }
      return null;
    },
    fileToLinktext: (file: TFile, _sourcePath: string, omitExtension?: boolean): string =>
      omitExtension && file.extension === "md" ? file.basename : file.name,
  };

  readonly fileManager = {
    processFrontMatter: (file: TFile, change: (properties: Record<string, unknown>) => void): Promise<void> => {
      const entry = this.entry(file);
      const properties = { ...(entry.frontmatter ?? {}) };
      change(properties);
      entry.frontmatter = properties;
      this.record("frontmatter", `${file.path}: ${JSON.stringify(properties)}（原文は書き換えません）`);
      return Promise.resolve();
    },
    getAvailablePathForAttachment: (name: string): Promise<string> => {
      this.attachmentCount += 1;
      return Promise.resolve(`Attachments/${this.attachmentCount}-${name}`);
    },
    generateMarkdownLink: (file: TFile): string => `[[${file.name}]]`,
  };

  /** Replace or add a file; the map view observes the change like an external edit. */
  put(path: string, content: string, url?: string): TFile {
    let entry = this.entries.get(path);
    if (!entry) {
      const file = new TFile();
      file.path = path;
      entry = { file, content, url, frontmatter: parseFrontmatter(content) };
      this.entries.set(path, entry);
      return file;
    }
    const changed = entry.content !== content;
    entry.content = content;
    entry.url = url;
    entry.frontmatter = parseFrontmatter(content);
    if (changed) this.vaultEvents.trigger("modify", entry.file);
    return entry.file;
  }

  content(file: TFile): string { return this.entry(file).content; }

  /** The product code only sees the `App` type; this page owns the runtime shape. */
  asApp<T>(): T { return this as unknown as T; }

  private entry(file: TFile): VaultEntry {
    const entry = this.entries.get(file.path);
    if (!entry) throw new Error(`Unknown file in the harness vault: ${file.path}`);
    return entry;
  }

  private record(kind: HarnessActivity["kind"], detail: string): void {
    this.activity.push({ kind, detail, at: performance.now() });
    if (this.activity.length > 200) this.activity.shift();
  }
}
