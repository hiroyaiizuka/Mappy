import { Notice, type App, type Component } from "obsidian";
import { readExitDrafts, textFingerprint, type ExitDraft } from "../core/exit-drafts";
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
 * edit already is left as it is, and any other is left too, with a Notice naming the draft.
 *
 * Not `workspace.on("quit")`'s tasks, though Obsidian waits for them: waiting cancels the quit, and on macOS only the
 * window closes after them, leaving Obsidian running with no window (1.14.2's `main.js`: `window-all-closed` does not
 * quit on darwin; seen on the real app). The kept drafts are read once and removed, whatever becomes of them.
 */
export function installExitDrafts(owner: Component, app: App, store: DocumentStore, views: () => readonly MindmapView[]): void {
  owner.registerDomEvent(window, "pagehide", () => {
    const drafts = views().map(view => view.takeExitDraft()).filter((draft): draft is ExitDraft => draft !== null);
    // None kept leaves the entry alone: what is there was put by this page (the load removed any older one).
    if (drafts.length === 0) return;
    try { app.saveLocalStorage(EXIT_DRAFTS_KEY, drafts); }
    catch { /* A full localStorage: the drafts go, as they did before LEV-230. */ }
  });
  app.workspace.onLayoutReady(() => { void applyExitDrafts(app, store); });
}

async function applyExitDrafts(app: App, store: DocumentStore): Promise<void> {
  const drafts = readExitDrafts(app.loadLocalStorage(EXIT_DRAFTS_KEY));
  app.saveLocalStorage(EXIT_DRAFTS_KEY, null);
  for (const draft of drafts) {
    try { await applyExitDraft(app, store, draft); }
    catch (error) { new Notice(t().exitDraftNotSaved(draft.title, error instanceof Error ? error.message : "")); }
  }
}

async function applyExitDraft(app: App, store: DocumentStore, draft: ExitDraft): Promise<void> {
  if ("refused" in draft) throw new Error(draft.refused);
  const file = app.vault.getFileByPath(draft.path);
  if (!file) throw new Error(t().exitNoteGone);
  const current = await store.read(file);
  const found = textFingerprint(current);
  if (found === draft.after) return;
  if (found !== draft.before) throw new Error(t().exitNoteChanged);
  // Refused by the store if the note moved on since the read above.
  await store.applyOver(file, current, draft.edits);
}
