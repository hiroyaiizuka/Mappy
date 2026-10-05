import { Notice, type App, type Component } from "obsidian";
import { EXIT_DRAFT_TTL, readExitDrafts, rebaseExitEdits, textFingerprint, withoutSources, type ExitDraft } from "../core/exit-drafts";
import type { DocumentStore } from "../obsidian/document-store";
import { t } from "../i18n";
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
  const apply = (): void => { if (!unloaded) void applyExitDrafts(app, store, () => unloaded); };
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
async function applyExitDrafts(app: App, store: DocumentStore, unloaded: () => boolean): Promise<void> {
  if (applying) return;
  applying = true;
  try {
    let drafts: ExitDraft[] = [];
    try { drafts = readExitDrafts(app.loadLocalStorage(EXIT_DRAFTS_KEY)); } catch { return; }
    // Nothing readable: what is there (not of the drafts' shape) goes.
    if (drafts.length === 0) { saveWithout(app, null); return; }
    for (let index = 0; index < drafts.length && !unloaded(); index += 1) {
      const draft = drafts[index]!;
      let failure: unknown = null;
      try { await applyExitDraft(app, store, draft); } catch (error) { failure = error ?? new Error(""); }
      if (failure === null) { saveWithout(app, draft); continue; }
      // Written back as it is, so the Notice says it is kept only when the entry was written and holds it.
      const kept = saveWithout(app, null)?.some(item => sameDraft(item, draft)) ?? false;
      // Until dismissed: it holds the only copy of what was typed, and shows while the workspace is still loading.
      new Notice(exitDraftNotice(draft, failure instanceof Error ? failure.message : "", kept), 0);
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
    const at = done ? stored.findIndex(item => sameDraft(item, done)) : -1;
    if (at !== -1) stored.splice(at, 1);
    app.saveLocalStorage(EXIT_DRAFTS_KEY, stored.length > 0 ? stored : null);
    return stored;
  } catch { return null; }
}

/** Whether two kept drafts are the same one: every field, as `readExitDrafts` reads them back. */
export function sameDraft(a: ExitDraft, b: ExitDraft): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** What the Notice for a draft not written says is kept: its text and the note's, its edit alone, or only the reason. */
function exitDraftNotice(draft: ExitDraft, reason: string, kept: boolean): string {
  const text = t();
  if (!kept) return text.exitDraftKeepUnconfirmed(draft.title, draft.path, reason);
  if ("refused" in draft) return text.exitDraftKeptRefused(draft.title, draft.path, reason);
  return draft.source === undefined ? text.exitDraftKeptEdits(draft.title, draft.path, reason)
    : text.exitDraftKeptSource(draft.title, draft.path, reason);
}

async function applyExitDraft(app: App, store: DocumentStore, draft: ExitDraft): Promise<void> {
  if ("refused" in draft) throw new Error(draft.refused);
  const file = app.vault.getFileByPath(draft.path);
  if (!file) throw new Error(t().exitNoteGone);
  const current = await store.read(file);
  const found = textFingerprint(current);
  if (found === draft.after) return;
  if (Date.now() - draft.at > EXIT_DRAFT_TTL) throw new Error(t().exitDraftExpired);
  // The note the draft was planned on, or one changed elsewhere since (a change the map had not read, another kept
  // draft of the same note applied first) whose change stays clear of a plain rename.
  const edits = found === draft.before ? draft.edits : draft.source === undefined ? null : rebaseExitEdits(draft.source, current, draft.edits);
  if (!edits) throw new Error(t().exitNoteChanged);
  // Refused by the store if the note moved on since the read above.
  await store.applyOver(file, current, edits);
}
