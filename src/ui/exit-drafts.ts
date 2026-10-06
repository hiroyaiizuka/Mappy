import { Notice, type App, type Component } from "obsidian";
import { EXIT_DRAFT_TTL, readExitDrafts, rebaseExitEdits, rebaseOverDraft, textFingerprint, withoutSources, type ExitDraft } from "../core/exit-drafts";
import type { DocumentStore } from "../obsidian/document-store";
import { messagesFor, t } from "../i18n";
import type { MindmapView } from "./mindmap-view";

/** Where the kept drafts wait for the next load: the vault's own `localStorage` entry (`App.saveLocalStorage`). */
export const EXIT_DRAFTS_KEY = "mappy-exit-drafts";

/**
 * A title draft open when the page goes without closing its view (LEV-230): a window reload (`app:reload`), Obsidian
 * quitting, its main window closing. Obsidian 1.14.2 sends the page `pagehide` in each, and no `onClose` (LEV-215's
 * save on close). A vault write started then does not finish, and can stop after the file was opened for writing:
 * measured, it left the note empty (artifacts/lev-230). So nothing is written: at `pagehide` each draft is planned as
 * the edit its save would make and kept in the vault's `localStorage`, which writes at once. When Mappy loads again
 * and the layout is ready, each is applied through the store, only to the note it was planned on; a note that has the
 * edit already is left as it is, one changed elsewhere takes a plain rename where the change stays clear of it
 * (`rebaseExitEdits`), and any other is left, with a Notice naming the draft; so is one kept longer than a day. A draft
 * not written stays kept as it is, and is tried and reported again at every load until it is written or the note has
 * it (LEV-240: a write cut off as the page went left a note empty, and the draft holding its text was then dropped);
 * the command 保存できなかった下書きを救出 saves what it holds to a separate file (`src/ui/exit-draft-recovery.ts`).
 *
 * Not `workspace.on("quit")`'s tasks, though Obsidian waits for them: waiting cancels the quit, and on macOS only the
 * window closes after them, leaving Obsidian running with no window (1.14.2's `main.js`: `window-all-closed` does not
 * quit on darwin; seen on the real app).
 */
export function installExitDrafts(owner: Component, app: App, store: DocumentStore, views: () => readonly MindmapView[]): void {
  let unloaded = false;
  owner.register(() => { unloaded = true; });
  // The drafts this load has reported already: `pageshow` and the layout's readiness can both apply in one load, and a
  // draft not written is reported once per load, not once per pass (review 1 of LEV-240).
  const reported = new Set<string>();
  const apply = (): void => { if (!unloaded) void applyExitDrafts(app, store, () => unloaded, reported); };
  owner.registerDomEvent(window, "pagehide", (event: PageTransitionEvent) => {
    // A page kept for coming back to (a WebView's back／forward cache) keeps its drafts open.
    if (event.persisted) return;
    const drafts = views().map(view => view.takeExitDraft()).filter((draft): draft is ExitDraft => draft !== null);
    if (drafts.length === 0) return;
    // Added to any kept by an earlier page that this one went before applying (the layout was not ready yet).
    let waiting: ExitDraft[] = [];
    try { waiting = readExitDrafts(app.loadLocalStorage(EXIT_DRAFTS_KEY)); } catch { /* Unreadable: nothing waiting. */ }
    // A full localStorage takes the drafts without the note texts (they then apply only to the note unchanged), then
    // this page's alone, the newest input; else they go, as they did before LEV-230.
    for (const kept of [[...waiting, ...drafts], withoutSources([...waiting, ...drafts]), withoutSources(drafts)]) {
      try { app.saveLocalStorage(EXIT_DRAFTS_KEY, kept); return; } catch { /* Try a smaller one. */ }
    }
  });
  // A page that was not unloaded after all (a WebView that sends `pagehide` and keeps the page) applies them at once.
  owner.registerDomEvent(window, "pageshow", apply);
  app.workspace.onLayoutReady(apply);
}

let applying = false;

/**
 * Each kept draft in turn. The entry keeps a draft until its write is done, so a page that goes meanwhile (the write
 * cut off) leaves it for the next load, which finds the edit in the note already or applies it; none is written twice
 * (`after`). Only a draft written, or one the note has already, leaves the entry: any other stays as it was kept, for
 * the next load and the rescue command (LEV-240). A Mappy unloaded meanwhile stops: the next load takes the rest.
 */
async function applyExitDrafts(app: App, store: DocumentStore, unloaded: () => boolean, reported: Set<string>): Promise<void> {
  if (applying) return;
  applying = true;
  try {
    let drafts: ExitDraft[] = [];
    try { drafts = readExitDrafts(app.loadLocalStorage(EXIT_DRAFTS_KEY)); } catch { return; }
    // Nothing readable: what is there (not of the drafts' shape) goes.
    if (drafts.length === 0) { saveWithout(app, null); return; }
    // The entry as last written in this pass (undefined: not yet; null: storage refused it). One not written stays as
    // it is, so the entry is written back once, to tell whether it holds the drafts the Notices say are kept.
    let written: ExitDraft[] | null | undefined;
    for (let index = 0; index < drafts.length && !unloaded(); index += 1) {
      const draft = drafts[index]!;
      let failure: unknown = null;
      try { await applyExitDraft(app, store, draft, drafts); } catch (error) { failure = error ?? new Error(""); }
      if (failure === null) { written = saveWithout(app, draft); continue; }
      if (written === undefined) written = saveWithout(app, null);
      // As the entry holds it: a `pagehide` meanwhile may have kept it again without the note's text.
      const kept = written?.find(item => sameDraft(item, draft)) ?? null;
      const key = draftKey(draft);
      if (reported.has(key)) continue;
      reported.add(key);
      // Until dismissed: it holds the only copy of what was typed, and shows while the workspace is still loading.
      new Notice(exitDraftNotice(kept ?? draft, failure instanceof Error ? failure.message : "", kept !== null), 0);
    }
  } finally { applying = false; }
}

/**
 * The entry without `done` (none: as it is), read again first so a draft a `pagehide` added meanwhile (a page kept
 * after all) stays; what was written, or null when storage refused it (access, quota) and the entry is as it was.
 */
function saveWithout(app: App, done: ExitDraft | null): ExitDraft[] | null {
  try {
    const stored = readExitDrafts(app.loadLocalStorage(EXIT_DRAFTS_KEY));
    const key = done ? draftKey(done) : null;
    const at = key === null ? -1 : stored.findIndex(item => draftKey(item) === key);
    if (at !== -1) stored.splice(at, 1);
    app.saveLocalStorage(EXIT_DRAFTS_KEY, stored.length > 0 ? stored : null);
    return stored;
  } catch { return null; }
}

/** A kept draft without the note text it may carry: what `withoutSources` leaves of it when storage is short. */
function draftKey(draft: ExitDraft): string {
  return JSON.stringify("refused" in draft ? [draft.path, draft.title, draft.at, draft.refused]
    : [draft.path, draft.title, draft.at, draft.before, draft.after, draft.edits]);
}

/**
 * Whether two kept drafts are the same one: every field but the note's text, which a `pagehide` short of storage
 * takes off (`withoutSources`) while the draft stays.
 */
export function sameDraft(a: ExitDraft, b: ExitDraft): boolean {
  return draftKey(a) === draftKey(b);
}

/** What the Notice for a draft not written says is kept: its text and the note's, its edit alone, or only the reason. */
function exitDraftNotice(draft: ExitDraft, reason: string, kept: boolean): string {
  const text = t();
  const command = text.cmdRescueDrafts;
  const tail = !kept ? text.exitKeepUnconfirmed : "refused" in draft ? text.exitKeptRefused(command)
    : draft.source === undefined ? text.exitKeptEdits(command) : text.exitKeptSource(command);
  return joinSentences(text.exitDraftNotWritten(draft.title, draft.path), reason, tail);
}

/**
 * Sentences of a Notice in a row, by the table's language: in the Japanese one none between after a full-width stop or
 * closing bracket, a space otherwise; in the English one always a space, whatever ends the sentence before (a reason
 * from elsewhere can end in 「。」). An empty one (a reason without a message) adds nothing.
 */
export function joinSentences(...sentences: string[]): string {
  const japanese = t() === messagesFor("ja");
  return sentences.filter(sentence => sentence !== "").reduce((joined, sentence) => joined === "" ? sentence
    : japanese && /[。！？」）]$/u.test(joined) ? `${joined}${sentence}` : `${joined} ${sentence}`, "");
}

/** `draft` written into its note; `kept`, the drafts this pass read, for another draft of the note written first. */
async function applyExitDraft(app: App, store: DocumentStore, draft: ExitDraft, kept: readonly ExitDraft[]): Promise<void> {
  if ("refused" in draft) throw new Error(draft.refused);
  const file = app.vault.getFileByPath(draft.path);
  if (!file) throw new Error(t().exitNoteGone);
  const current = await store.read(file);
  const found = textFingerprint(current);
  if (found === draft.after) return;
  if (Date.now() - draft.at > EXIT_DRAFT_TTL) throw new Error(t().exitDraftExpired);
  // The note the draft was planned on; one that another kept draft planned on the same text left (two maps of the
  // note), whose edits are known (LEV-309); or one changed elsewhere since (a change the map had not read) whose
  // change stays clear of a plain rename and does not look cut off.
  const first = kept.find((item): item is Exclude<ExitDraft, { refused: string }> => item !== draft && !("refused" in item)
    && item.path === draft.path && item.before === draft.before && item.after === found);
  const edits = found === draft.before ? draft.edits : first ? rebaseOverDraft(draft.edits, first.edits)
    : draft.source === undefined ? null : rebaseExitEdits(draft.source, current, draft.edits);
  if (!edits) throw new Error(t().exitNoteChanged);
  // Refused by the store if the note moved on since the read above.
  await store.applyOver(file, current, edits);
}
