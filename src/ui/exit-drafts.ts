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
 * (`rebaseExitEdits`), and any other is left, with a Notice naming the draft; so is one kept longer than a day.
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
    const kept = [...waiting, ...drafts];
    // A full localStorage takes the drafts without the note texts (they then apply only to the note unchanged), or
    // none: they go, as they did before LEV-230.
    try { app.saveLocalStorage(EXIT_DRAFTS_KEY, kept); }
    catch {
      try { app.saveLocalStorage(EXIT_DRAFTS_KEY, withoutSources(kept)); } catch { /* Nothing fits. */ }
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
 * (`after`). A Mappy unloaded meanwhile stops: the next load takes the rest.
 */
async function applyExitDrafts(app: App, store: DocumentStore, unloaded: () => boolean): Promise<void> {
  if (applying) return;
  applying = true;
  try {
    const drafts = readExitDrafts(app.loadLocalStorage(EXIT_DRAFTS_KEY));
    if (drafts.length === 0) app.saveLocalStorage(EXIT_DRAFTS_KEY, null);
    for (let index = 0; index < drafts.length && !unloaded(); index += 1) {
      const draft = drafts[index]!;
      try { await applyExitDraft(app, store, draft); }
      catch (error) { new Notice(t().exitDraftNotSaved(draft.title, error instanceof Error ? error.message : "")); }
      const rest = drafts.slice(index + 1);
      app.saveLocalStorage(EXIT_DRAFTS_KEY, rest.length > 0 ? rest : null);
    }
  } finally { applying = false; }
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
  const planned = draft.source !== undefined && textFingerprint(draft.source) === draft.before ? draft.source : null;
  const edits = found === draft.before ? draft.edits : planned === null ? null : rebaseExitEdits(planned, current, draft.edits);
  if (!edits) throw new Error(t().exitNoteChanged);
  // Refused by the store if the note moved on since the read above.
  await store.applyOver(file, current, edits);
}
