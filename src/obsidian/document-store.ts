import { MarkdownView, type App, type Editor, type TFile } from 'obsidian';
import { applyEdits, type TextEdit } from '../core/commands';
import { rebaseEdits } from '../core/text-edits';

interface DocumentStoreApp {
  workspace: {
    getLeavesOfType(viewType: string): readonly { view: unknown }[];
  };
  vault: Pick<App['vault'], 'read' | 'process'>;
}

type DocumentEditor = Pick<Editor, 'getValue' | 'offsetToPos' | 'transaction'>;

interface HistoryEntry {
  before: string;
  after: string;
  forward: TextEdit[];
  inverse: TextEdit[];
}

/** A write `applyLatest` made: the text before and after it, and its edits. */
export interface LatestWrite { before: string; after: string; edits: TextEdit[] }

interface DocumentSession {
  source: string | null;
  revision: number;
  past: HistoryEntry[];
  future: HistoryEntry[];
  /** `applyLatest`'s writes since the last edit or change of the note, in order; see `carry`. */
  latest: LatestWrite[];
  pending: Promise<void>;
  writing: boolean;
}

const historyLimit = 50;
/** `applyLatest` writes kept to carry an edit over; an edit planned before more layout switches than this is refused. */
const latestLimit = 16;
/** What a refused write says; the map view swaps it out once it has re-read the note. */
export const conflictMessage = 'Markdown が変更されています。マップを更新してから再編集してください。';

/** One file's map operations share a queue and a bounded, source-checked history. */
export class DocumentStore {
  private readonly sessions = new WeakMap<TFile, DocumentSession>();

  constructor(private readonly app: DocumentStoreApp) {}

  read(file: TFile): Promise<string> {
    return this.enqueue(file, async (session) => {
      const source = await this.readCurrent(file);
      this.observe(session, source);
      return source;
    });
  }

  apply(file: TFile, expectedSource: string, edits: TextEdit[]): Promise<string> {
    return this.applyOver(file, expectedSource, edits).then(({ after }) => after);
  }

  /**
   * `apply`, telling what it wrote: the text it found, the text it left, and the edits between — the caller's,
   * or the caller's carried over `applyLatest` writes that landed after `expectedSource` (`carry`, LEV-196).
   */
  applyOver(file: TFile, expectedSource: string, edits: TextEdit[]): Promise<LatestWrite> {
    const requested = edits.map((edit) => ({ ...edit }));
    return this.enqueue(file, async (session) => {
      const before = await this.readCurrent(file);
      this.observe(session, before);
      const requestedEdits = this.carry(session, expectedSource, requested, before);
      // Validate the caller's ranges before merging adjacent edits for inversion.
      const after = applyEdits(before, requestedEdits);
      if (after === before) return { before, after, edits: requestedEdits };
      const forward = mergeAdjacentEdits(requestedEdits);
      const inverse = invertEdits(before, forward);
      await this.writeSafely(file, session, before, after, forward);
      session.past.push({ before, after, forward, inverse });
      if (session.past.length > historyLimit) session.past.shift();
      session.future = [];
      session.latest = [];
      return { before, after, edits: requestedEdits };
    });
  }

  /**
   * Whether an edit planned on `expectedSource` still applies (`apply` would not refuse it for the text): the note
   * holds that text, or only `applyLatest` writes changed it since. Queued, so it answers for the note as the edits
   * queued before it leave it. For a caller with work to do between planning and applying (an image to store).
   */
  applies(file: TFile, expectedSource: string): Promise<boolean> {
    return this.enqueue(file, async (session) => {
      const current = await this.readCurrent(file);
      this.observe(session, current);
      try { this.carry(session, expectedSource, [], current); return true; } catch { return false; }
    });
  }

  /**
   * A write planned on whatever the note holds when its turn in the queue comes, not on a text the caller
   * saw: a preference the map keeps in the frontmatter (the layout buttons, LEV-196), which no edit of the
   * note's content decides for or against. Queued with the map's edits, so an edit already on its way lands
   * first, and one planned before it but queued after it is carried over it (`carry`). It is no step of the history — Undo would revert
   * a key the view does not read back — and the steps before it are dropped, as after any change the history
   * did not make. Returns the text before and after, and the edits between (none when nothing changed).
   */
  applyLatest(file: TFile, plan: (source: string) => TextEdit[]): Promise<LatestWrite> {
    return this.enqueue(file, async (session) => {
      const before = await this.readCurrent(file);
      this.observe(session, before);
      const edits = plan(before);
      const after = applyEdits(before, edits);
      if (after === before) return { before, after, edits: [] };
      await this.writeSafely(file, session, before, after, edits);
      session.past = [];
      session.future = [];
      session.latest.push({ before, after, edits });
      if (session.latest.length > latestLimit) session.latest.shift();
      return { before, after, edits };
    });
  }

  /**
   * The edits planned on `expectedSource`, as they apply to `current`: unchanged when the note still holds that
   * text; carried over the `applyLatest` writes that lead from it to `current` otherwise (LEV-196: an edit planned
   * right before a layout button, which the view could not have seen). Those writes change only the lines of a
   * preference key, which no planned edit decides for or against, so an edit clear of their lines is the same
   * edit after them (`rebaseEdits`). Anything else — an edit that touches their lines, a text they do not lead
   * to (someone else's change, E05) — is the refusal it always was.
   */
  private carry(session: DocumentSession, expectedSource: string, edits: TextEdit[], current: string): TextEdit[] {
    if (expectedSource === current) return edits;
    let at = expectedSource;
    let carried = edits;
    for (const write of session.latest) {
      if (write.before !== at) continue;
      const rebased = rebaseEdits(carried, write.edits);
      if (!rebased) break;
      carried = rebased;
      at = write.after;
      if (at === current) return carried;
    }
    throw new Error(conflictMessage);
  }

  undo(file: TFile): Promise<string> {
    return this.navigateHistory(file, 'undo');
  }

  redo(file: TFile): Promise<string> {
    return this.navigateHistory(file, 'redo');
  }

  canUndo(file: TFile): boolean {
    return this.hasHistory(file, 'past');
  }

  canRedo(file: TFile): boolean {
    return this.hasHistory(file, 'future');
  }

  private sessionFor(file: TFile): DocumentSession {
    let session = this.sessions.get(file);
    if (!session) {
      session = { source: null, revision: 0, past: [], future: [], latest: [], pending: Promise.resolve(), writing: false };
      this.sessions.set(file, session);
    }
    return session;
  }

  private enqueue<T>(file: TFile, operation: (session: DocumentSession) => Promise<T>): Promise<T> {
    const session = this.sessionFor(file);
    const result = session.pending.then(() => operation(session));
    // A failed operation must not poison later reads or edits on this file.
    session.pending = result.then(() => undefined, () => undefined);
    return result;
  }

  private editorsFor(file: TFile): DocumentEditor[] {
    const editors = new Set<DocumentEditor>();
    for (const { view } of this.app.workspace.getLeavesOfType('markdown')) {
      // Deferred views do not expose an editor and must remain deferred.
      if (view instanceof MarkdownView && view.file?.path === file.path) {
        editors.add(view.editor);
      }
    }
    return [...editors];
  }

  private editorSource(editors: DocumentEditor[]): string | undefined {
    const source = editors[0]?.getValue();
    if (editors.some((editor) => editor.getValue() !== source)) {
      throw new Error('同じノートの編集内容が複数のタブで一致しません。Markdown 側の内容を揃えてから操作してください。');
    }
    return source;
  }

  private async readCurrent(file: TFile): Promise<string> {
    const buffer = this.editorSource(this.editorsFor(file));
    if (buffer !== undefined) return buffer;
    const disk = await this.app.vault.read(file);
    // An editor may have opened while the disk read was pending.
    return this.editorSource(this.editorsFor(file)) ?? disk;
  }

  private observe(session: DocumentSession, source: string): boolean {
    const changed = session.source !== null && session.source !== source;
    if (changed) {
      session.past = [];
      session.future = [];
      session.latest = [];
    }
    if (session.source !== source) session.revision += 1;
    session.source = source;
    return changed;
  }

  private invalidate(session: DocumentSession): void {
    session.source = null;
    session.revision += 1;
    session.past = [];
    session.future = [];
    session.latest = [];
  }

  private hasHistory(file: TFile, direction: 'past' | 'future'): boolean {
    const session = this.sessions.get(file);
    if (!session) return false;
    if (session.writing) return session[direction].length > 0;
    try {
      const buffer = this.editorSource(this.editorsFor(file));
      if (buffer !== undefined) this.observe(session, buffer);
      return session[direction].length > 0;
    } catch {
      this.invalidate(session);
      return false;
    }
  }

  private navigateHistory(file: TFile, direction: 'undo' | 'redo'): Promise<string> {
    return this.enqueue(file, async (session) => {
      const current = await this.readCurrent(file);
      if (this.observe(session, current)) throw new Error(conflictMessage);
      const from = direction === 'undo' ? session.past : session.future;
      const to = direction === 'undo' ? session.future : session.past;
      const entry = from[from.length - 1];
      if (!entry) return current;
      const before = direction === 'undo' ? entry.after : entry.before;
      const after = direction === 'undo' ? entry.before : entry.after;
      const edits = direction === 'undo' ? entry.inverse : entry.forward;
      if (current !== before) {
        this.invalidate(session);
        throw new Error(conflictMessage);
      }
      await this.writeSafely(file, session, before, after, edits);
      session.latest = [];
      from.pop();
      to.push(entry);
      return after;
    });
  }

  private async writeSafely(
    file: TFile,
    session: DocumentSession,
    before: string,
    after: string,
    edits: TextEdit[],
  ): Promise<void> {
    session.writing = true;
    try {
      const editors = this.editorsFor(file);
      if (editors.length > 0) {
        if (this.editorSource(editors) !== before) throw new Error(conflictMessage);
        for (const editor of editors) {
          const current = editor.getValue();
          // Obsidian may already have propagated a transaction to a shared buffer.
          if (current === after) continue;
          if (current !== before) throw new Error(conflictMessage);
          editor.transaction({
            changes: edits.map(({ from, to, text }) => ({
              from: editor.offsetToPos(from),
              to: editor.offsetToPos(to),
              text,
            })),
          }, 'mappy');
        }
        if (this.editorSource(this.editorsFor(file)) !== after) throw new Error(conflictMessage);
      } else {
        const saved = await this.app.vault.process(file, (current) => {
          if (this.editorsFor(file).length > 0) {
            throw new Error('保存中に Markdown エディタが開かれました。マップを更新して再度お試しください。');
          }
          if (current !== before) throw new Error(conflictMessage);
          return applyEdits(current, edits);
        });
        if (saved !== after) throw new Error(conflictMessage);
      }
      session.source = after;
      session.revision += 1;
    } catch (error) {
      this.invalidate(session);
      throw error;
    } finally {
      session.writing = false;
    }
  }
}

function mergeAdjacentEdits(edits: TextEdit[]): TextEdit[] {
  const merged: TextEdit[] = [];
  for (const edit of [...edits].sort((left, right) => left.from - right.from)) {
    const previous = merged[merged.length - 1];
    if (previous && previous.to === edit.from) {
      previous.to = edit.to;
      previous.text += edit.text;
    } else {
      merged.push({ ...edit });
    }
  }
  return merged;
}

function invertEdits(source: string, edits: TextEdit[]): TextEdit[] {
  let delta = 0;
  return edits.map(({ from, to, text }) => {
    const inverse = { from: from + delta, to: from + delta + text.length, text: source.slice(from, to) };
    delta += text.length - (to - from);
    return inverse;
  });
}
