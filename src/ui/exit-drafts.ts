import { Notice, type App, type Component } from "obsidian";
import { applyEdits, type TextEdit } from "../core/commands";
import { backupId, sameBackupGeneration } from "../core/exit-backup";
import {
  EXIT_DRAFT_TTL, draftKey, readExitDrafts, rebaseExitEdits, rebaseOverDrafts, textFingerprint, withoutSources, type ExitDraft,
} from "../core/exit-drafts";
import type { DocumentStore } from "../obsidian/document-store";
import { ExitBackupError, type BackupSurvey, type ExitBackupStore } from "../obsidian/exit-backup-store";
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
 * Every write of a kept draft leaves a backup of the whole note first, read back before the note is written
 * (LEV-309, `src/obsidian/exit-backup-store.ts`); what the backups say at the next load decides which drafts may be
 * written at all, and nothing that is unclear is written, taken out of the entry or deleted.
 *
 * Not `workspace.on("quit")`'s tasks, though Obsidian waits for them: waiting cancels the quit, and on macOS only the
 * window closes after them, leaving Obsidian running with no window (1.14.2's `main.js`: `window-all-closed` does not
 * quit on darwin; seen on the real app).
 */
export function installExitDrafts(
  owner: Component, app: App, store: DocumentStore, backups: ExitBackupStore, views: () => readonly MindmapView[],
): () => Promise<void> {
  let unloaded = false;
  owner.register(() => { unloaded = true; });
  // The drafts this load has reported already: `pageshow` and the layout's readiness can both apply in one load, and a
  // draft not written is reported once per load, not once per pass (review 1 of LEV-240).
  const reported = new Set<string>();
  const apply = (): void => { if (!unloaded) void applyExitDrafts(app, store, backups, () => unloaded, reported); };
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
  // When the pass running now (if any) is over: for the tests, which cannot see the backups' hashing settle otherwise.
  return () => applying ?? Promise.resolve();
}

/** The pass running now: one at a time, and one asked for meanwhile is that one. */
let applying: Promise<void> | null = null;

/**
 * Each kept draft in turn. The entry keeps a draft until its write is done, so a page that goes meanwhile (the write
 * cut off) leaves it for the next load, which finds the edit in the note already or applies it; none is written twice
 * (`after`). Only a draft written, or one the note has already, leaves the entry: any other stays as it was kept, for
 * the next load and the rescue command (LEV-240). A Mappy unloaded meanwhile stops: the next load takes the rest.
 * The backup folder is read first (LEV-309): anything there that is not a backup of this format (a temporary file left
 * by a write cut off, one that does not read, one of another kind) stops every write of this load, and a draft that
 * has a backup already (a write that did not finish, or one that did while the draft stayed) is not written again.
 */
function applyExitDrafts(
  app: App, store: DocumentStore, backups: ExitBackupStore, unloaded: () => boolean, reported: Set<string>,
): Promise<void> {
  if (applying) return applying;
  const pass = applyEach(app, store, backups, unloaded, reported).finally(() => { applying = null; });
  applying = pass;
  return pass;
}

async function applyEach(
  app: App, store: DocumentStore, backups: ExitBackupStore, unloaded: () => boolean, reported: Set<string>,
): Promise<void> {
  let drafts: ExitDraft[] = [];
  try { drafts = readExitDrafts(app.loadLocalStorage(EXIT_DRAFTS_KEY)); } catch { return; }
  // Nothing readable: what is there (not of the drafts' shape) stays as it is (LEV-309; it was taken out before).
  if (drafts.length === 0) return;
  // What the backup folder holds; null when it could not be read, which stops every write of this load.
  let survey: BackupSurvey | null = null;
  try { survey = await backups.survey(); } catch { survey = null; }
  // The entry as last written in this pass (undefined: not yet; null: storage refused it). One not written stays as
  // it is, so the entry is written back once, to tell whether it holds the drafts the Notices say are kept.
  let written: ExitDraft[] | null | undefined;
  const known: KnownWrites = new Map();
  for (let index = 0; index < drafts.length && !unloaded(); index += 1) {
    const draft = drafts[index]!;
    let failure: unknown = null;
    let outcome: Outcome | null = null;
    try { outcome = await applyExitDraft(app, store, backups, survey, draft, known); } catch (error) { failure = error ?? new Error(""); }
    if (outcome === "had" || outcome === "written") {
      written = saveWithout(app, draft);
      // Once, as it is written: the backup is there for the rescue command.
      if (outcome === "written") new Notice(t().exitWrittenWithBackup(draft.title, draft.path, t().cmdRescueDrafts));
      continue;
    }
    const key = draftKey(draft);
    if (outcome === "unmarked") {
      // Written, but its backup still reads as unfinished: the draft stays, and the next load does not write it again.
      if (!reported.has(key)) { reported.add(key); new Notice(t().exitWrittenNotMarked(draft.title, draft.path, t().cmdRescueDrafts), 0); }
      continue;
    }
    if (written === undefined) written = saveWithout(app, null);
    // As the entry holds it: a `pagehide` meanwhile may have kept it again without the note's text.
    const kept = written?.find(item => sameDraft(item, draft)) ?? null;
    if (reported.has(key)) continue;
    reported.add(key);
    // Until dismissed: it holds the only copy of what was typed, and shows while the workspace is still loading.
    new Notice(exitDraftNotice(kept ?? draft, failure instanceof Error ? failure.message : "", kept !== null), 0);
  }
}

/**
 * The entry without `done` (none: as it is), read again first so a draft a `pagehide` added meanwhile (a page kept
 * after all) stays; what was written, or null when storage refused it (access, quota) and the entry is as it was.
 * Items that do not read as drafts stay in it as they are (LEV-309: nothing unreadable is dropped here), and an entry
 * that is not a list is not written at all.
 */
function saveWithout(app: App, done: ExitDraft | null): ExitDraft[] | null {
  try {
    const raw: unknown = app.loadLocalStorage(EXIT_DRAFTS_KEY);
    if (!Array.isArray(raw)) return readExitDrafts(raw);
    const items = (raw as unknown[]).slice();
    const key = done ? draftKey(done) : null;
    const at = key === null ? -1 : items.findIndex(item => readExitDrafts([item]).some(draft => draftKey(draft) === key));
    if (at !== -1) items.splice(at, 1);
    app.saveLocalStorage(EXIT_DRAFTS_KEY, items.length > 0 ? items : null);
    return readExitDrafts(items);
  } catch { return null; }
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

/**
 * The notes this pass wrote kept drafts into from the text they were planned on, by the note and the text each write
 * left (`path` and its fingerprint, a line apart): that text and the edits written, in order. Only this load's: a
 * draft whose note another draft was written into at an earlier load (the rest left when Mappy was unloaded midway)
 * is moved by the diff (`rebaseExitEdits`), as an unread change.
 */
type KnownWrites = Map<string, { before: string; steps: TextEdit[][] }>;

/** What became of a kept draft: in the note already, written (and its backup finished), or written with its backup not. */
type Outcome = "had" | "written" | "unmarked";

/**
 * `draft` written into its note; `known`, what this pass wrote before it, added to when this write is one of them;
 * throws, with the reason, when it is not written. Before anything is read of the note: the backup folder must hold
 * nothing unclear (`survey`), and a backup of this draft already there (of its very generation or not) keeps it
 * unwritten. Every write is backed up first (S1, S2) and the backup marked finished after (S4): a backup not made keeps
 * the note unwritten, and one not marked keeps the draft in the entry.
 */
async function applyExitDraft(
  app: App, store: DocumentStore, backups: ExitBackupStore, survey: BackupSurvey | null, draft: ExitDraft, known: KnownWrites,
): Promise<Outcome> {
  const text = t();
  // Never written, whatever the folder holds: its own reason is what it says.
  if ("refused" in draft) throw new Error(draft.refused);
  if (!survey) throw new Error(text.exitBackupUnlisted(backups.folder));
  if (survey.unchecked.length > 0) throw new Error(text.exitBackupUnverified(backups.folder));
  const id = await backupId(draft);
  const record = survey.records.get(id);
  if (record) {
    for (const kept of [record.prepared, record.applied]) {
      if (kept && !await sameBackupGeneration(kept.backup, draft)) throw new Error(text.exitBackupOtherGeneration);
    }
    throw new Error(record.applied ? text.exitBackupAlreadyApplied : text.exitBackupPending);
  }
  const file = app.vault.getFileByPath(draft.path);
  if (!file) throw new Error(text.exitNoteGone);
  const current = await store.read(file);
  const found = textFingerprint(current);
  // Written already (at an earlier load, the page gone before the entry let it go): its edits are in the note as they
  // were planned, for another draft of the note to move over (review 3 of LEV-309).
  if (found === draft.after) { known.set(`${draft.path}\n${found}`, { before: draft.before, steps: [draft.edits] }); return "had"; }
  if (Date.now() - draft.at > EXIT_DRAFT_TTL) throw new Error(text.exitDraftExpired);
  // The note the draft was planned on; one that other kept drafts planned on the same text left this pass (two maps
  // of the note), whose edits are known (LEV-309); or one changed elsewhere since (a change the map had not read) whose
  // change stays clear of a plain rename and does not look cut off.
  const over = known.get(`${draft.path}\n${found}`);
  const steps = found === draft.before ? [] : over?.before === draft.before ? over.steps : null;
  const edits = found === draft.before ? draft.edits : steps ? rebaseOverDrafts(draft.edits, steps)
    : draft.source === undefined ? null : rebaseExitEdits(draft.source, current, draft.edits);
  if (!edits) throw new Error(text.exitNoteChanged);
  // S1, S2: the whole note as it is now, backed up and read back, before it is written.
  try { await backups.prepare(draft, draft.path, current, applyEdits(current, edits), edits); } catch (error) { throw new Error(backupReason(error, backups)); }
  // S3: refused by the store if the note moved on since the read above; the prepared backup then stays (the next
  // load does not write this draft again).
  let write;
  try { write = await store.applyOver(file, current, edits); } catch (error) {
    throw new Error(joinSentences(error instanceof Error ? error.message : "", text.exitBackupLeftPrepared));
  }
  if (steps && write.before === current) known.set(`${draft.path}\n${textFingerprint(write.after)}`, { before: draft.before, steps: [...steps, write.edits] });
  // S4: the backup marked finished; until it is, the draft stays in the entry.
  try { await backups.markApplied(id); } catch { return "unmarked"; }
  return "written";
}

/** Why a backup was not made, in the Notice's words. */
function backupReason(error: unknown, backups: ExitBackupStore): string {
  const text = t();
  if (!(error instanceof ExitBackupError)) return text.exitBackupNotSaved(error instanceof Error && error.message ? error.message : text.rescueUnknownReason);
  switch (error.failure) {
    case "full": return text.exitBackupFull(`${backups.limit / (1024 * 1024)} MiB`);
    case "unmeasured": return text.exitBackupUnmeasured;
    case "unsaved": return text.exitBackupNotSaved(error.detail || text.rescueUnknownReason);
    case "mismatch": return text.exitBackupMismatch;
    case "taken": return text.exitBackupTaken;
    case "unverified": return text.exitBackupUnlisted(backups.folder);
  }
}
