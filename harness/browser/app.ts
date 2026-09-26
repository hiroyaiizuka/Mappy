/**
 * In-memory stand-in for the parts of `App` the map view touches. Reads and
 * writes stay in this page: nothing reaches a vault, so the save path,
 * link resolution and frontmatter persistence remain Obsidian-only checks.
 */
import { Events, Notice, Scope, TFile, WorkspaceLeaf } from "./obsidian";
import { frontmatterLayout } from "../../src/core/markdown";
import { locateFrontmatterKey, parseYamlValue } from "../../src/core/yaml-lite";

interface VaultEntry {
  file: TFile;
  content: string;
  /** Resource URL for binary attachments; Markdown has none. */
  url: string | undefined;
  /** Frontmatter as the map view sees it, read from `content` whenever it changes. */
  frontmatter: Record<string, unknown> | undefined;
}

export interface HarnessActivity {
  kind: "link" | "layout-saved" | "frontmatter" | "split" | "attachment";
  detail: string;
  at: number;
}

/** A top-level key and its colon: the key part of yaml-lite's `mappingEntry`, copied because yaml-lite does not export it. */
const TOP_LEVEL_KEY = /^(?!-(?:[ \t]|$))("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s"'#{}[\],][^:]*?)[ \t]*:(?:[ \t]|$)/u;

/** A key as YAML reads it: yaml-lite's `unquote` (`\"`, `\n`, `\t`, `''`). */
function keyName(token: string): string {
  if (token.startsWith('"')) return token.slice(1, -1).replace(/\\(.)/gu, (_match, char: string) => char === "n" ? "\n" : char === "t" ? "\t" : char);
  if (token.startsWith("'")) return token.slice(1, -1).replace(/''/gu, "'");
  return token;
}

type Header = NonNullable<ReturnType<typeof frontmatterLayout>>;

/** Each top-level key line at or after `from`, in order: the name it reads as, and where its line starts. */
function* topLevelKeys(text: string, header: Header, from = header.bodyFrom): Generator<{ key: string; spelled: string; from: number }> {
  let offset = from;
  while (offset < header.closingFrom) {
    const newline = text.indexOf("\n", offset);
    const next = newline === -1 || newline >= header.closingFrom ? header.closingFrom : newline + 1;
    const token = text.slice(offset, next).replace(/\r?\n$/u, "").match(TOP_LEVEL_KEY)?.[1];
    if (token !== undefined) yield { key: keyName(token), spelled: /^["']/u.test(token) ? token.slice(1, -1) : token, from: offset };
    offset = next;
  }
}

/**
 * The first line at or after `from` that holds `key`, with the lines of its value (`locateFrontmatterKey` on the key as
 * it is spelled there, so a quoted key with an escape is found by the name it reads as).
 */
function locateKey(text: string, header: Header, key: string, from = header.bodyFrom): { from: number; to: number; inline: string; nested: string[] } | null {
  for (const line of topLevelKeys(text, header, from)) {
    if (line.key === key) return locateFrontmatterKey(text, { ...header, bodyFrom: line.from }, line.spelled);
  }
  return null;
}

/**
 * A note's frontmatter as the product reads it: each top-level key from its first line, as `frontmatterReader` (the
 * reader behind `readMapFromSource`) reads one key — a repeated key keeps its first value, and a line that is not a key
 * is passed over, not the end of the header. A BOM, a `...` closing line, a quoted key, `True`, a comment, a quoted
 * comma in a flow list and a nested mapping (`mappy-topics`) read as they do there. Undefined without a closed header
 * or without a key in it. The cache and `processFrontMatter` both read through it (LEV-214).
 */
export function parseFrontmatter(source: string): Record<string, unknown> | undefined {
  const header = frontmatterLayout(source);
  if (!header?.closed) return undefined;
  const result: Record<string, unknown> = {};
  const seen = new Set<string>();
  for (const { key } of topLevelKeys(source, header)) {
    if (seen.has(key)) continue;
    seen.add(key);
    const block = locateKey(source, header, key);
    if (block) result[key] = parseYamlValue(block.inline, block.nested);
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * A string as YAML text: plain under the rule the product writes a topic's key by (`yamlKey` in `topics.ts`), double-quoted
 * otherwise with the escapes yaml-lite reads back. A character yaml-lite cannot read back (`\r`, other controls) throws.
 */
function yamlString(value: string): string {
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/u.test(value)) throw new Error(`検証ページの frontmatter は制御文字を書きません: ${JSON.stringify(value)}`);
  const plain = /^[^\s"'#{}[\],\-?:&*!|>%@`][^:#\t\n]*$/u.test(value) && !/\s$/u.test(value)
    && !/^(?:true|false|null|~|yes|no|on|off|y|n)$/iu.test(value) && !/^[-+.]?\d/u.test(value) && !/^[-+]?\.(?:inf|nan)$/iu.test(value);
  return plain ? value : `"${value.replace(/[\\"]/gu, char => `\\${char}`).replace(/\t/gu, "\\t").replace(/\n/gu, "\\n")}"`;
}

/** Throws on a value, at any depth, that yaml-lite would not read back as it is: a control character, `NaN`, `Infinity`. */
function assertWritable(value: unknown): void {
  if (typeof value === "string") yamlString(value);
  else if (typeof value === "number" && !Number.isFinite(value)) throw new Error(`検証ページの frontmatter は ${value} を書きません`);
  else if (Array.isArray(value)) value.forEach(assertWritable);
  else if (value !== null && typeof value === "object") for (const [key, item] of Object.entries(value)) { yamlString(key); assertWritable(item); }
}

function yamlScalar(value: unknown): string {
  assertWritable(value);
  if (typeof value === "string") return yamlString(value);
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  return JSON.stringify(value ?? null);
}

/** A key's lines: a list as `- item` lines below it, a mapping as a flow collection. */
function serializeFrontmatterEntry(key: string, value: unknown, eol: string): string {
  if (Array.isArray(value)) {
    return value.length === 0 ? `${yamlString(key)}: []${eol}` : `${yamlString(key)}:${eol}${value.map(item => `  - ${yamlScalar(item)}${eol}`).join("")}`;
  }
  return `${yamlString(key)}: ${yamlScalar(value)}${eol}`;
}

/**
 * The note's text with its header rewritten from `before` to `after`, Obsidian's `processFrontMatter` in this page
 * (LEV-214). Only a key whose value changed moves: its first line is replaced where it is and any repeat of it removed;
 * every other key keeps its bytes. Obsidian re-serializes the whole YAML instead, so a case may read the keys but must
 * not pin the header's formatting. The header's own line ending is kept and a BOM stays first. A header left without a
 * line is dropped; a note without one gets one in front. An unclosed leading `---` throws: the product reads it as a
 * header that runs to the end and its own writer refuses it. How Obsidian treats these two edges is not checked.
 */
function rewriteFrontmatter(text: string, before: Record<string, unknown>, after: Record<string, unknown>): string {
  const bom = text.startsWith("\uFEFF") ? "\uFEFF" : "";
  const changed = (key: string) => JSON.stringify(before[key]) !== JSON.stringify(after[key]);
  const opened = frontmatterLayout(text);
  if (opened && !opened.closed) throw new Error("frontmatter が閉じていません（製品の書き込みと同じく、検証ページも書きません）");
  if (!opened) {
    const eol = /^[^\n]*\r\n/u.test(text) ? "\r\n" : "\n";
    const lines = Object.keys(after).filter(key => after[key] !== undefined).map(key => serializeFrontmatterEntry(key, after[key], eol)).join("");
    return lines ? `${bom}---${eol}${lines}---${eol}${text.slice(bom.length)}` : text;
  }
  const eol = text.slice(0, opened.bodyFrom).endsWith("\r\n") ? "\r\n" : "\n";
  let next = text;
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (!changed(key)) continue;
    const line = after[key] === undefined ? "" : serializeFrontmatterEntry(key, after[key], eol);
    const header = frontmatterLayout(next) as Header;
    const found = locateKey(next, header, key);
    if (!found) {
      if (key in before) throw new Error(`検証ページの frontmatter でキー ${key} の行が見つかりません`);
      if (line) next = next.slice(0, header.closingFrom) + line + next.slice(header.closingFrom);
      continue;
    }
    next = next.slice(0, found.from) + line + next.slice(found.to);
    const rest = found.from + line.length;
    for (let repeat = locateKey(next, frontmatterLayout(next) as Header, key, rest); repeat;
      repeat = locateKey(next, frontmatterLayout(next) as Header, key, rest)) next = next.slice(0, repeat.from) + next.slice(repeat.to);
  }
  if (next === text) return text;
  const rewritten = frontmatterLayout(next);
  return rewritten && next.slice(rewritten.bodyFrom, rewritten.closingFrom).trim() === "" ? bom + next.slice(rewritten.end) : next;
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
    getMarkdownFiles: (): TFile[] => Array.from(this.entries.values(), entry => entry.file).filter(file => file.extension === "md"),
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
        this.vaultEvents.trigger("metadata:changed", file, next, { frontmatter: entry.frontmatter });
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
    /** The sidebars, as identities a leaf's `getRoot()` can be compared with; this page has no leaf in either. */
    leftSplit: { side: "left" },
    rightSplit: { side: "right" },
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
    /**
     * Rewrites the header in the note's text (`rewriteFrontmatter`) through `vault.process`, so the view hears
     * `modify` and the cache re-reads the text, as with Obsidian's. Before LEV-214 it changed the cache only and a
     * case reading the text after the product's conversion (`writeMapLayout`) saw the note as it was. The callback
     * gets the header as the product reads it (`parseFrontmatter`); an entry in `activity` means the text changed.
     */
    processFrontMatter: async (file: TFile, change: (properties: Record<string, unknown>) => void): Promise<void> => {
      let written = false;
      await this.vault.process(file, text => {
        const before = parseFrontmatter(text) ?? {};
        const after = structuredClone(before);
        change(after);
        const next = rewriteFrontmatter(text, before, after);
        written = next !== text;
        return next;
      });
      if (written) this.record("frontmatter", `${file.path}: ${JSON.stringify(this.entry(file).frontmatter ?? {})}`);
    },
    getAvailablePathForAttachment: (name: string): Promise<string> => {
      this.attachmentCount += 1;
      return Promise.resolve(`Attachments/${this.attachmentCount}-${name}`);
    },
    generateMarkdownLink: (file: TFile): string => `[[${file.name}]]`,
  };

  /**
   * Replace or add a file; the map view observes the change like an external edit, and the
   * in-memory cache reports it the way Obsidian's metadata cache does once it has re-read the file.
   */
  put(path: string, content: string, url?: string): TFile {
    let entry = this.entries.get(path);
    if (!entry) {
      const file = new TFile();
      file.path = path;
      entry = { file, content, url, frontmatter: parseFrontmatter(content) };
      this.entries.set(path, entry);
      this.vaultEvents.trigger("create", file);
      this.vaultEvents.trigger("metadata:changed", file, content, { frontmatter: entry.frontmatter });
      return file;
    }
    const changed = entry.content !== content;
    entry.content = content;
    entry.url = url;
    entry.frontmatter = parseFrontmatter(content);
    if (changed) {
      this.vaultEvents.trigger("modify", entry.file);
      this.vaultEvents.trigger("metadata:changed", entry.file, content, { frontmatter: entry.frontmatter });
    }
    return entry.file;
  }

  /** Rename a file: the same `TFile` under its new path, reported as Obsidian's vault reports it (the file, then the old path). */
  rename(path: string, next: string): TFile {
    const entry = this.entries.get(path);
    if (!entry) throw new Error(`Unknown file in the harness vault: ${path}`);
    this.entries.delete(path);
    entry.file.path = next;
    this.entries.set(next, entry);
    this.vaultEvents.trigger("rename", entry.file, path);
    return entry.file;
  }

  /** Delete a file; open maps and embeds observe it, and the cache reports it gone. */
  remove(path: string): void {
    const entry = this.entries.get(path);
    if (!entry) return;
    this.entries.delete(path);
    this.vaultEvents.trigger("delete", entry.file);
    this.vaultEvents.trigger("metadata:deleted", entry.file, entry.frontmatter ? { frontmatter: entry.frontmatter } : null);
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
