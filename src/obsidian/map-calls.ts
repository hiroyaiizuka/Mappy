import type { App, TFile } from 'obsidian';
import type { CallTarget, CallTargets } from '../core/calls';
import { embedOnlyTitle, readMapFromSource } from '../core/embed';
import { parseMarkdown, type MindDocument } from '../core/markdown';
import type { DocumentStore } from './document-store';
import { resolveEmbedTarget } from './embed-target';

/**
 * The maps a note's items call (§5 M12), read from the vault. An item whose title is one
 * `![[…]]` is resolved as a note embed is (`resolveEmbedTarget`: a Markdown note with
 * `mappy: true` in the cache, not a block reference), the note itself is refused, and the
 * note is read through the store (an open editor's buffer first) and must still be a map
 * by its own text (an unsaved edit that dropped `mappy: true` makes the item a link).
 * Each note is parsed once per read, whatever the number of items calling it, with the
 * previous parse as the identity reference, so the ids and with them the folds of a
 * called map survive an edit of that note; a note whose text did not change keeps the
 * very same document, so the caller can tell an unchanged result by reference. A note
 * that cannot be read makes its items links.
 */
export class CallReader {
  private readonly parsed = new Map<string, { source: string; document: MindDocument }>();
  /** Reads run one after another, so two overlapping reads cannot parse the same note twice under different ids. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly app: App, private readonly store: DocumentStore) {}

  read(document: MindDocument, hostPath: string): Promise<CallTargets> {
    const result = this.queue.then(() => this.readNow(document, hostPath));
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async readNow(document: MindDocument, hostPath: string): Promise<CallTargets> {
    const wanted = new Map<string, { file: TFile; callers: { id: string; subpath: string }[] }>();
    for (const node of document.nodes) {
      const linktext = embedOnlyTitle(node.title);
      if (!linktext) continue;
      const target = resolveEmbedTarget(this.app, linktext, hostPath);
      if (!target || target.file.path === hostPath) continue;
      const entry = wanted.get(target.file.path) ?? { file: target.file, callers: [] };
      entry.callers.push({ id: node.id, subpath: target.subpath });
      wanted.set(target.file.path, entry);
    }
    const targets = new Map<string, CallTarget>();
    for (const [path, { file, callers }] of wanted) {
      const parsed = await this.parse(file);
      if (!parsed) continue;
      for (const caller of callers) targets.set(caller.id, { path, subpath: caller.subpath, document: parsed });
    }
    for (const path of Array.from(this.parsed.keys())) if (!wanted.has(path)) this.parsed.delete(path);
    return targets;
  }

  /** True when the last read parsed this note: a change of it can alter what the host shows. */
  reads(path: string): boolean {
    return this.parsed.has(path);
  }

  private async parse(file: TFile): Promise<MindDocument | null> {
    let text: string;
    try {
      text = await this.store.read(file);
    } catch {
      this.parsed.delete(file.path);
      return null;
    }
    if (readMapFromSource(text) === null) {
      this.parsed.delete(file.path);
      return null;
    }
    const previous = this.parsed.get(file.path);
    if (previous && previous.source === text && previous.document.root.title === file.basename) return previous.document;
    const parsed = parseMarkdown(text, file.basename, previous?.document);
    this.parsed.set(file.path, { source: text, document: parsed });
    return parsed;
  }
}

/** True when two reads resolved the same items to the same documents and headings, so nothing on the map changes. */
export function sameTargets(left: CallTargets, right: CallTargets): boolean {
  if (left.size !== right.size) return false;
  for (const [id, target] of left) {
    const other = right.get(id);
    if (!other || other.document !== target.document || other.subpath !== target.subpath || other.path !== target.path) return false;
  }
  return true;
}
