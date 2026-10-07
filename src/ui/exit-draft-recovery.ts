import { Modal, Notice, Platform, Setting, TFolder, type App, type TAbstractFile } from "obsidian";
import { readExitDrafts, textFingerprint, type ExitDraft } from "../core/exit-drafts";
import { ExitBackupError, type BackupRecord, type BackupSurvey, type ExitBackupStore } from "../obsidian/exit-backup-store";
import { t, type Messages } from "../i18n";
import {
  EXIT_DRAFTS_KEY, discardExitBackup, discardExitDraft, exitDraftsApplying, joinSentences, keptBackupIds, keptCount, type BackupDiscard,
  type DraftDiscard,
} from "./exit-drafts";

/**
 * The command 保存できなかった下書きを救出 (LEV-240). A draft kept at `pagehide` that the next load could not write
 * (`src/ui/exit-drafts.ts`) stays kept, and here the person saves what it holds to a new note of its own: the note's
 * text as it was planned on, when it was small enough to keep, the title typed and the edit planned. Nothing is
 * applied, the original note is not touched and the draft stays kept (rescuing it again makes another file); only
 * `vault.create` writes, so no file that exists is ever overwritten. Why the note emptied is not fixed here (LEV-240).
 * The backups the writes of kept drafts leave (LEV-309, `src/obsidian/exit-backup-store.ts`) are listed too, finished
 * or not, and saved the same way, the whole note before the write first; a file in the backup folder that does not
 * read as one is listed by its path alone. Saving changes no draft and no backup. A kept draft or a backup goes only
 * when the person presses 破棄 on its line and confirms (LEV-310): that one alone, the draft taken out of the entry,
 * the backup moved to a trash (the system's, else the vault's), and never one whose kept draft it holds back
 * (`discardExitBackup`).
 */

/** The folder the rescued drafts go to, at the vault's top level. */
export const RECOVERY_FOLDER = "Mappy Recovery";
/** How many names (` 2`, ` 3`, …) are tried before the rescue gives up. */
export const RECOVERY_ATTEMPTS = 20;
/** The longest part of a rescued file's name taken from the original note's (code points). */
const NAME_LIMIT = 80;
/**
 * The same in UTF-8 bytes: a file name holds 255 on the usual file systems, and the rescue adds at most 31 (` YYYY-MM-DD
 * HHmmss abcdef 20.md`), so a long Japanese or emoji name still fits (review 2).
 */
const NAME_BYTES = 200;

/** The parts of the vault the rescue uses. */
type RescueVault = Pick<App["vault"], "getAbstractFileByPath" | "getRoot" | "createFolder" | "create">;
interface RescueApp { vault: RescueVault; loadLocalStorage(key: string): unknown }

/** What the list offers: the kept drafts, the backups' records, and the backup folder's paths that are not records. */
interface RescueChoices { drafts: ExitDraft[]; records: BackupRecord[]; unchecked: string[]; unlisted: string | null }

/** The command's route: the kept drafts and the backups listed, one chosen, confirmed, then saved to a separate file. */
export async function rescueExitDrafts(app: App, backups: ExitBackupStore): Promise<void> {
  let drafts: ExitDraft[] = [];
  try { drafts = readExitDrafts(app.loadLocalStorage(EXIT_DRAFTS_KEY)); } catch { /* Unreadable: none. */ }
  // Read through the backups' chain: never while a load is writing one.
  let survey: BackupSurvey | null = null;
  try { survey = await backups.survey(); } catch { /* Listed as a folder that could not be read. */ }
  const records = survey ? [...survey.records.values()].flatMap(entry => [entry.prepared, entry.applied])
    .filter((record): record is BackupRecord => record !== undefined).sort((a, b) => b.backup.createdAt - a.backup.createdAt) : [];
  const choices: RescueChoices = { drafts, records, unchecked: survey?.unchecked ?? [], unlisted: survey ? null : backups.folder };
  if (drafts.length === 0 && records.length === 0 && choices.unchecked.length === 0 && choices.unlisted === null) {
    new Notice(t().rescueNone);
    return;
  }
  new ExitDraftListModal(app, choices, choice => {
    const save = "draft" in choice
      ? () => { void rescueExitDraft(app, choice.draft).then(message => { new Notice(message); }); }
      : () => { void rescueExitBackup(app, choice.record).then(message => { new Notice(message); }); };
    new ExitDraftConfirmModal(app, choice, save).open();
  }, choice => {
    if ("draft" in choice) {
      const discard = () => {
        sayWaiting();
        void discardExitDraft(app, choice.draft).then(outcome => { new Notice(draftDiscardText(outcome, choice.draft)); });
      };
      new ExitDraftDiscardModal(app, choice, null, discard).open();
      return;
    }
    const discard = () => {
      sayWaiting();
      void discardExitBackup(app, backups, choice.record).then(backupDiscardText, (error: unknown) => t().discardBackupFailed(reasonOf(error)))
        .then(message => { new Notice(message); });
    };
    // Whether a kept draft holds the backup back, as the entry is when 破棄 is pressed (it may have lost the draft since
    // the list was read); not told, nothing is offered.
    void keptBackupIds(app).then(kept => {
      const blocked = kept === null ? "unread" : kept.has(choice.record.backup.id) ? "draftKept" : null;
      new ExitDraftDiscardModal(app, choice, blocked, discard).open();
    });
  }).open();
}

/**
 * Why a step failed, in its own words: the adapter's message an `ExitBackupError` carries (not its failure's code when
 * it has none: review 3), or the error's.
 */
function reasonOf(error: unknown): string {
  if (error instanceof ExitBackupError) return error.detail || t().rescueUnknownReason;
  return error instanceof Error && error.message ? error.message : t().rescueUnknownReason;
}

/** A discard that has to wait for a load writing the kept drafts says so at once, not only when it is done (review 3). */
function sayWaiting(): void {
  if (exitDraftsApplying()) new Notice(t().discardWaiting);
}

/** What a discarded draft's Notice says (LEV-310). */
function draftDiscardText(outcome: DraftDiscard, draft: ExitDraft): string {
  const text = t();
  switch (outcome) {
    case "discarded": return text.discardedDraft(draft.title);
    case "gone": return text.discardDraftGone;
    case "failed": return text.discardDraftFailed;
    case "busy": return text.discardBusy;
    case "unknown": return text.discardDraftUnconfirmed;
  }
}

/** What a discarded backup's Notice says (LEV-310). */
function backupDiscardText(outcome: BackupDiscard): string {
  const text = t();
  switch (outcome) {
    case "trashed": return text.discardedBackupTrash;
    case "localTrashed": return text.discardedBackupLocalTrash;
    case "movedUnconfirmed": return text.discardedBackupUnconfirmed;
    case "stillThere": return text.discardBackupStillThere;
    case "gone": return text.discardBackupGone;
    case "draftKept": return text.discardBackupDraftKept;
    case "unread": return text.discardBackupDraftsUnread;
    case "busy": return text.discardBusy;
  }
}

/** One draft saved to a separate file; what the Notice says, whether it was saved or not. */
export async function rescueExitDraft(app: RescueApp, draft: ExitDraft): Promise<string> {
  const text = t();
  try {
    const path = await saveRescuedDraft(app, draft);
    // The draft is said to be kept only when it still is (a load in between may have written it: review 3).
    return stillKept(app, draft) ? text.rescueSaved(path) : text.rescueSavedNotKept(path);
  } catch (error) {
    // Only what was checked is said: the draft is kept only when it is still in the entry.
    const kept = stillKept(app, draft);
    const said = failureText(error);
    return kept ? joinSentences(said, text.rescueDraftKept) : said;
  }
}

/** One backup saved to a separate file (the backup itself is not touched); what the Notice says. */
export async function rescueExitBackup(app: RescueApp, record: BackupRecord): Promise<string> {
  try {
    return t().rescueSavedBackup(await saveRescued(app, rescuedFileBase(record.backup.draft), rescuedBackupText(record)));
  } catch (error) { return failureText(error); }
}

/** What a rescue that failed says. */
function failureText(error: unknown): string {
  const text = t();
  return error instanceof FolderIsFile ? text.rescueFolderIsFile(RECOVERY_FOLDER)
    : text.rescueFailed(error instanceof NoFreeName ? text.rescueNoFreeName
      : error instanceof Error && error.message ? error.message : text.rescueUnknownReason);
}

class FolderIsFile extends Error {}
/** Every name up to `RECOVERY_ATTEMPTS` is taken: nothing was created or refused. */
class NoFreeName extends Error {}

/** Whether the draft is still in the entry, read again: the failure Notice says it is kept only then. */
function stillKept(app: RescueApp, draft: ExitDraft): boolean {
  try { return keptCount(app, draft) > 0; } catch { return false; }
}

/**
 * Creates the rescued file under `RECOVERY_FOLDER` and resolves to its path. A file in the folder's place is left as it
 * is; a folder that appeared meanwhile (created elsewhere, the create refused for it) is used. A name taken, or a create
 * refused, moves to the next number; nothing is modified.
 */
export function saveRescuedDraft(app: RescueApp, draft: ExitDraft): Promise<string> {
  return saveRescued(app, rescuedFileBase(draft), rescuedNoteText(draft));
}

/** `content` saved as a new file named after `base` in the recovery folder, as `saveRescuedDraft`. */
async function saveRescued(app: RescueApp, base: string, content: string): Promise<string> {
  const vault = app.vault;
  const found = findRecoveryFolder(vault);
  if (found && !(found instanceof TFolder)) throw new FolderIsFile();
  let folder = found?.path ?? RECOVERY_FOLDER;
  if (!found) {
    try { await vault.createFolder(RECOVERY_FOLDER); } catch (error) {
      const appeared = findRecoveryFolder(vault);
      if (!(appeared instanceof TFolder)) throw error;
      folder = appeared.path;
    }
  }
  let failure: unknown = null;
  for (const path of freeRescuePaths(vault, folder, base)) {
    try {
      await vault.create(path, content);
      return path;
    } catch (error) { failure = error; }
  }
  if (failure === null) throw new NoFreeName();
  throw failure instanceof Error ? failure : new Error(t().rescueUnknownReason);
}

/**
 * What is at the vault's top under `RECOVERY_FOLDER`'s name. On macOS and Windows the disk usually ignores case, so a
 * folder `mappy recovery` is the one to use and a file `MAPPY RECOVERY` blocks the folder as the exact name would
 * (review 2); on Linux, where it usually does not, only the exact name counts (review of 22215d0).
 */
function findRecoveryFolder(vault: RescueVault): TAbstractFile | null {
  const exact = vault.getAbstractFileByPath(RECOVERY_FOLDER);
  if (exact || Platform.isLinux) return exact;
  const wanted = RECOVERY_FOLDER.toLowerCase();
  return vault.getRoot().children.find(child => child.name.toLowerCase() === wanted) ?? null;
}

/**
 * The names a rescued file may take in `folder`, `<base>.md`, then `<base> 2.md`, … up to `RECOVERY_ATTEMPTS`, each
 * yielded only when nothing is there as it is reached: the save and the confirmation take them from here alike.
 */
function* freeRescuePaths(vault: RescueVault, folder: string, base: string): Generator<string> {
  for (let number = 1; number <= RECOVERY_ATTEMPTS; number += 1) {
    const path = `${folder}/${base}${number === 1 ? "" : ` ${number}`}.md`;
    if (!vault.getAbstractFileByPath(path)) yield path;
  }
}

/**
 * Where the rescue would save the draft now: the first free name in the folder there (or the one it would create);
 * `file` when a file has the folder's name (review 3), `full` when every name up to `RECOVERY_ATTEMPTS` is taken: the
 * save would be refused either way, and nothing is overwritten.
 */
export function plannedRescuePath(vault: RescueVault, draft: ExitDraft): { path: string } | { blocked: "file" | "full" } {
  const found = findRecoveryFolder(vault);
  if (found && !(found instanceof TFolder)) return { blocked: "file" };
  const first = freeRescuePaths(vault, found?.path ?? RECOVERY_FOLDER, rescuedFileBase(draft)).next();
  return first.done ? { blocked: "full" } : { path: first.value };
}

/** The original note's name without its folder and `.md`. */
export function noteBasename(path: string): string {
  return (path.split("/").pop() ?? path).replace(/\.md$/iu, "");
}

/**
 * A name a file can take on every desktop system and that a link can reach: `\ / : * ? " < > | # ^ [ ]` and control
 * characters as `_`, no leading dot or space (a hidden file, one the vault does not list), at most `NAME_LIMIT` code
 * points and `NAME_BYTES` UTF-8 bytes; `draft` when nothing is left.
 */
export function safeFileName(name: string): string {
  const replaced = Array.from(name.replace(/[\\/:*?"<>|#^[\]]/gu, "_"), char => char < " " || char === "\u007f" ? "_" : char)
    .join("").replace(/^[.\s]+/u, "");
  const encoder = new TextEncoder();
  let cut = "";
  let bytes = 0;
  for (const char of Array.from(replaced).slice(0, NAME_LIMIT)) {
    bytes += encoder.encode(char).length;
    if (bytes > NAME_BYTES) break;
    cut += char;
  }
  cut = cut.trimEnd();
  return cut === "" ? "draft" : cut;
}

const pad = (value: number, width = 2): string => String(value).padStart(width, "0");

/**
 * `at` (epoch ms) in local time, as `YYYY-MM-DD HH:mm:ss` (`separator` between the time's parts); `unknown time` for
 * one no date has (a finite `at` out of range, which `readExitDrafts` keeps).
 */
export function localTime(at: number, separator = ":"): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "unknown time";
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return `${day} ${[date.getHours(), date.getMinutes(), date.getSeconds()].map(part => pad(part)).join(separator)}`;
}

/** Six characters that tell drafts of the same note and second apart: from its path, time and title. */
export function draftId(draft: ExitDraft): string {
  const hash = textFingerprint(`${draft.path}\n${draft.at}\n${draft.title}\n${"refused" in draft ? draft.refused : draft.before}`).split(":")[1] ?? "";
  return hash.padStart(6, "0").slice(-6);
}

/** The rescued file's name before the number and `.md`: `<note> <YYYY-MM-DD HHmmss> <id>`. */
export function rescuedFileBase(draft: ExitDraft): string {
  return `${safeFileName(noteBasename(draft.path))} ${localTime(draft.at, "")} ${draftId(draft)}`;
}

/** The longest run of backticks in `text`. */
function longestBacktickRun(text: string): number {
  let longest = 0;
  for (const run of text.match(/`+/gu) ?? []) longest = Math.max(longest, run.length);
  return longest;
}

/**
 * `text` in a backtick fence no line of it can close (longer than any run of backticks in it, at least three), with no
 * info string. A text not ending in a line break gets one before the closing fence.
 */
export function fenced(text: string): string {
  const fence = "`".repeat(Math.max(3, longestBacktickRun(text) + 1));
  return `${fence}\n${text}${text.endsWith("\n") || text === "" ? "" : "\n"}${fence}`;
}

/** `text` as inline code (a path, a fingerprint): nothing in it is read as Markdown. */
function inlineCode(text: string): string {
  const ticks = "`".repeat(longestBacktickRun(text) + 1);
  const padded = text.startsWith("`") || text.endsWith("`") || text === "" ? ` ${text} ` : text;
  return `${ticks}${padded}${ticks}`;
}

/**
 * The rescued note: a plain note (no frontmatter, so it is never a map, and the original's `---` header and
 * `mappy: true` stay inside a fence). What the draft holds is shown as it was kept, each part fenced; nothing in it is
 * claimed to be restored.
 */
export function rescuedNoteText(draft: ExitDraft, text: Messages = t()): string {
  const lines: string[] = [`# ${text.recHeading(inlineCode(noteBasename(draft.path)))}`, ""];
  lines.push(`- ${text.recPath(inlineCode(draft.path))}`, `- ${text.recKeptAt(localTime(draft.at))}`, `- ${text.recTitleRef}`, `- ${text.recUnchanged}`);
  if (!("refused" in draft)) {
    const length = draft.source?.length ?? Number(draft.before.split(":")[0]);
    lines.push(`- ${text.recLength(String(length), inlineCode(draft.before))}`);
    if (draft.source !== undefined) lines.push(`- ${draft.source.endsWith("\n") ? text.recEndsWithNewline : text.recEndsWithoutNewline}`);
  }
  lines.push("", `## ${text.recSourceHeading}`, "");
  if ("refused" in draft || draft.source === undefined) lines.push(text.recNoSource, "");
  else {
    if (draft.source !== "" && !draft.source.endsWith("\n")) lines.push(text.recAddedNewline, "");
    lines.push(fenced(draft.source), "");
  }
  lines.push(`## ${text.recTitleHeading}`, "", fenced(draft.title), "");
  if ("refused" in draft) lines.push(`## ${text.recReasonHeading}`, "", fenced(draft.refused), "");
  else {
    lines.push(`## ${text.recEditsHeading}`, "");
    draft.edits.forEach((edit, index) => {
      lines.push(text.recEdit(String(index + 1), String(edit.from), String(edit.to)), "", fenced(edit.text), "");
    });
  }
  return lines.join("\n");
}

/**
 * The rescued note of a backup: as `rescuedNoteText`, with the whole note as it was just before the write first, then
 * the draft's own note text (when it was kept), the title and the change written. A backup of a draft that kept no note
 * text holds the note as it was at the write, not a text lost before it, and says so; nothing is said to be restored.
 */
export function rescuedBackupText(record: BackupRecord, text: Messages = t()): string {
  const { backup } = record;
  const { draft, note } = backup;
  const lines: string[] = [`# ${text.recBackupHeading(inlineCode(noteBasename(note.path)))}`, ""];
  lines.push(`- ${text.recPath(inlineCode(note.path))}`, `- ${text.recBackupAt(localTime(backup.createdAt))}`,
    `- ${record.state === "applied" ? text.recBackupApplied : text.recBackupPrepared}`, `- ${text.recKeptAt(localTime(draft.at))}`,
    `- ${text.recTitleRef}`, `- ${text.recUnchanged}`, `- ${text.recBeforeLength(String(note.beforeLength), inlineCode(note.beforeSha256))}`);
  lines.push("", `## ${text.recBeforeHeading}`, "", draft.source === undefined ? text.recBeforeNotOriginal : text.recBeforeIs, "");
  if (note.before !== "" && !note.before.endsWith("\n")) lines.push(text.recAddedNewline, "");
  lines.push(fenced(note.before), "", `## ${text.recSourceHeading}`, "");
  if (draft.source === undefined) lines.push(text.recNoSource, "");
  else {
    if (draft.source !== "" && !draft.source.endsWith("\n")) lines.push(text.recAddedNewline, "");
    lines.push(fenced(draft.source), "");
  }
  lines.push(`## ${text.recTitleHeading}`, "", fenced(draft.title), "", `## ${text.recWrittenEditsHeading}`, "");
  backup.edits.forEach((edit, index) => {
    lines.push(text.recWrittenEdit(String(index + 1), String(edit.from), String(edit.to)), "", fenced(edit.text), "");
  });
  return lines.join("\n");
}

/** A choice of the list: a kept draft or a backup's record. */
type RescueChoice = { draft: ExitDraft } | { record: BackupRecord };

/**
 * One line per kept draft (where, when, the title, and what it holds), per backup record (where, whether its write
 * finished, when) and per path in the backup folder that is not one (shown, not offered: it does not read). A draft's
 * or a record's line offers 選ぶ (save it to a separate file) and 破棄 (LEV-310); each opens its confirmation. Each line
 * says what it is in `data-mappy-rescue` (`draft`, `applied`, `prepared`, `unchecked`), and each button what it does
 * in `data-mappy-rescue-action` (`pick`, `discard`), for the real-app case.
 */
class ExitDraftListModal extends Modal {
  constructor(
    app: App, private readonly choices: RescueChoices, private readonly choose: (choice: RescueChoice) => void,
    private readonly discard: (choice: RescueChoice) => void,
  ) { super(app); }

  onOpen(): void {
    const text = t();
    this.setTitle(text.cmdRescueDrafts);
    this.contentEl.createEl("p", { text: text.rescueLead });
    for (const draft of this.choices.drafts) {
      const holds = "refused" in draft ? text.rescueRefused(draft.refused)
        : draft.source === undefined ? text.rescueNoSource : text.rescueHasSource(String(draft.source.length));
      this.line("draft", draft.path, `${text.rescueKeptAt(localTime(draft.at))} · ${text.rescueTitleLine(draft.title)} · ${holds}`, { draft });
    }
    for (const record of this.choices.records) {
      const { backup } = record;
      const state = record.state === "applied" ? text.rescueBackupApplied : text.rescueBackupPrepared;
      this.line(record.state, backup.note.path,
        `${state} · ${text.rescueBackupAt(localTime(backup.createdAt))} · ${text.rescueTitleLine(backup.draft.title)}`, { record });
    }
    for (const path of this.choices.unchecked) this.line("unchecked", path, text.rescueUnchecked, null);
    if (this.choices.unlisted !== null) this.line("unchecked", this.choices.unlisted, text.rescueUnlisted, null);
  }

  private line(kind: string, name: string, desc: string, choice: RescueChoice | null): void {
    const setting = new Setting(this.contentEl).setName(name).setDesc(desc);
    setting.settingEl.dataset.mappyRescue = kind;
    if (!choice) return;
    setting.addButton(button => {
      button.setButtonText(t().rescuePick).onClick(() => { this.close(); this.choose(choice); });
      button.buttonEl.dataset.mappyRescueAction = "pick";
    });
    setting.addButton(button => {
      button.setButtonText(t().rescueDiscard).onClick(() => { this.close(); this.discard(choice); });
      button.buttonEl.dataset.mappyRescueAction = "discard";
    });
  }

  onClose(): void { this.contentEl.empty(); }
}

/** Where the draft or the backup goes and what goes in, before anything is written. */
class ExitDraftConfirmModal extends Modal {
  constructor(app: App, private readonly choice: RescueChoice, private readonly save: () => void) { super(app); }

  onOpen(): void {
    const text = t();
    const draft = "draft" in this.choice ? this.choice.draft : this.choice.record.backup.draft;
    this.setTitle(text.rescueConfirmTitle);
    const planned = plannedRescuePath(this.app.vault, draft);
    // A file in the folder's place, or no free name: said here, and nothing is offered to save.
    const blocked = "blocked" in planned;
    this.contentEl.createEl("p", { text: !blocked ? text.rescueConfirmPath(planned.path)
      : planned.blocked === "file" ? text.rescueConfirmFolderIsFile(RECOVERY_FOLDER) : text.rescueConfirmNoFreeName });
    this.contentEl.createEl("p", { text: "record" in this.choice ? text.rescueConfirmBackup(String(this.choice.record.backup.note.beforeLength))
      : "refused" in draft ? text.rescueConfirmRefused
        : draft.source === undefined ? text.rescueConfirmEdits : text.rescueConfirmSource(String(draft.source.length)) });
    this.contentEl.createEl("p", { text: text.rescueConfirmUnchanged });
    new Setting(this.contentEl)
      .addButton(button => button.setButtonText(text.rescueSave).setCta().setDisabled(blocked).onClick(() => { this.close(); this.save(); }))
      .addButton(button => button.setButtonText(text.rescueCancel).onClick(() => { this.close(); }));
  }

  onClose(): void { this.contentEl.empty(); }
}

/**
 * LEV-310: what discarding the draft or the backup takes away, before anything is: 破棄する (a warning) and キャンセル,
 * which changes nothing. A backup a kept draft is held back by (`draftKept`), or one when the kept drafts could not be
 * told (`unread`), says so and offers no discard.
 */
class ExitDraftDiscardModal extends Modal {
  constructor(
    app: App, private readonly choice: RescueChoice, private readonly blocked: "draftKept" | "unread" | null, private readonly discard: () => void,
  ) { super(app); }

  onOpen(): void {
    const text = t();
    if ("draft" in this.choice) {
      const { draft } = this.choice;
      this.setTitle(text.discardDraftTitle);
      this.contentEl.createEl("p", { text: text.discardDraftWhat(draft.title, draft.path) });
      this.contentEl.createEl("p", { text: "refused" in draft ? text.discardDraftLostRefused : text.discardDraftLost });
    } else {
      const { backup } = this.choice.record;
      this.setTitle(text.discardBackupTitle);
      this.contentEl.createEl("p", { text: text.discardBackupWhat(backup.draft.title, backup.note.path, localTime(backup.createdAt)) });
      this.contentEl.createEl("p", { text: this.blocked === "draftKept" ? text.discardBackupDraftKept : this.blocked === "unread" ? text.discardBackupDraftsUnread
        : text.discardBackupLost(String(backup.note.beforeLength)) });
    }
    this.contentEl.createEl("p", { text: text.discardUnchanged });
    new Setting(this.contentEl)
      .addButton(button => button.setButtonText(text.discardConfirm).setWarning().setDisabled(this.blocked !== null).onClick(() => { this.close(); this.discard(); }))
      .addButton(button => button.setButtonText(text.rescueCancel).onClick(() => { this.close(); }));
  }

  onClose(): void { this.contentEl.empty(); }
}
