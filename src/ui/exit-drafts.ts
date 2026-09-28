import { Notice, type App, type Component, type Tasks } from "obsidian";
import { readExitDrafts, textFingerprint, type ExitDraft } from "../core/exit-drafts";
import type { DocumentStore } from "../obsidian/document-store";
import { t } from "../i18n";
import type { MindmapView } from "./mindmap-view";

/** Where the kept drafts wait for the next load: the vault's own `localStorage` entry (`App.saveLocalStorage`). */
export const EXIT_DRAFTS_KEY = "mappy-exit-drafts";

/**
 * A title draft open when the page goes without closing its view (LEV-230). Obsidian 1.14.2:
 *
 * - Quitting (and closing the main window) triggers `workspace.on("quit")` and waits for the tasks added there before
 *   the window closes (`App.registerQuitHook`): each open draft is saved there, as a close saves it (LEV-215).
 * - A window reload (`app:reload`, ⌘R) sends the page `beforeunload`, `pagehide` and `unload` and nothing else. A vault
 *   write started then does not finish, and can stop after the file was opened for writing: measured, it left the
 *   note empty (artifacts/lev-230). So nothing is written: at `pagehide` each draft is planned as the edit its save
 *   would make and kept in the vault's `localStorage`, which writes at once. When Mappy loads again and the layout is
 *   ready, each is applied through the store, only to the note it was planned on; a note that has the edit already
 *   (a save that landed after all) is left as it is, and any other is left too, with a Notice naming the draft.
 *
 * The kept drafts are read once and removed, whatever becomes of them.
 */
export function installExitDrafts(owner: Component, app: App, store: DocumentStore, views: () => readonly MindmapView[]): void {
  owner.registerEvent(app.workspace.on("quit", (tasks: Tasks) => {
    const open = views().filter(view => view.hasTitleDraft());
    // An empty task list lets the window close at once; any task makes Obsidian show 「Saving...」 until it ends.
    if (open.length > 0) tasks.addPromise(Promise.all(open.map(view => view.saveDraftOnQuit())));
  }));
  owner.registerDomEvent(window, "pagehide", () => {
    const drafts = views().map(view => view.exitDraft()).filter((draft): draft is ExitDraft => draft !== null);
    try { app.saveLocalStorage(EXIT_DRAFTS_KEY, drafts.length > 0 ? drafts : null); }
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
