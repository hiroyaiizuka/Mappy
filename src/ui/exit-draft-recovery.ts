import { Modal, Notice, Setting, TFolder, type App } from "obsidian";
import { readExitDrafts, textFingerprint, type ExitDraft } from "../core/exit-drafts";
import { t, type Messages } from "../i18n";
import { EXIT_DRAFTS_KEY, sameDraft } from "./exit-drafts";

/**
 * The command 保存できなかった下書きを救出 (LEV-240). A draft kept at `pagehide` that the next load could not write
 * (`src/ui/exit-drafts.ts`) stays kept, and here the person saves what it holds to a new note of its own: the note's
 * text as it was planned on, when it was small enough to keep, the title typed and the edit planned. Nothing is
 * applied, the original note is not touched and the draft stays kept (rescuing it again makes another file); only
 * `vault.create` writes, so no file that exists is ever overwritten. Why the note emptied is not fixed here (LEV-240).
 */

/** The folder the rescued drafts go to, at the vault's top level. */
export const RECOVERY_FOLDER = "Mappy Recovery";
/** How many names (` 2`, ` 3`, …) are tried before the rescue gives up. */
export const RECOVERY_ATTEMPTS = 20;
/** The longest part of a rescued file's name taken from the original note's (code points). */
const NAME_LIMIT = 80;

/** The parts of the vault the rescue uses. */
type RescueVault = Pick<App["vault"], "getAbstractFileByPath" | "createFolder" | "create">;
interface RescueApp { vault: RescueVault; loadLocalStorage(key: string): unknown }

/** The command's route: the kept drafts listed, one chosen, confirmed, then saved to a separate file. */
export function rescueExitDrafts(app: App): void {
  let drafts: ExitDraft[] = [];
  try { drafts = readExitDrafts(app.loadLocalStorage(EXIT_DRAFTS_KEY)); } catch { /* Unreadable: none. */ }
  if (drafts.length === 0) { new Notice(t().rescueNone); return; }
  new ExitDraftListModal(app, drafts, draft => {
    new ExitDraftConfirmModal(app, draft, () => { void rescueExitDraft(app, draft).then(message => { new Notice(message); }); }).open();
  }).open();
}

/** One draft saved to a separate file; what the Notice says, whether it was saved or not. */
export async function rescueExitDraft(app: RescueApp, draft: ExitDraft): Promise<string> {
  const text = t();
  try {
    return text.rescueSaved(await saveRescuedDraft(app, draft));
  } catch (error) {
    // Only what was checked is said: the draft is kept only when it is still in the entry.
    const kept = stillKept(app, draft);
    if (error instanceof FolderIsFile) {
      const said = text.rescueFolderIsFile(RECOVERY_FOLDER);
      // No space after a Japanese full stop.
      return !kept ? said : said.endsWith("。") ? `${said}${text.rescueDraftKept}` : `${said} ${text.rescueDraftKept}`;
    }
    const said = text.rescueFailed(error instanceof NoFreeName ? text.rescueNoFreeName
      : error instanceof Error && error.message ? error.message : text.rescueUnknownReason);
    return kept ? `${said} ${text.rescueDraftKept}` : said;
  }
}

class FolderIsFile extends Error {}
/** Every name up to `RECOVERY_ATTEMPTS` is taken: nothing was created or refused. */
class NoFreeName extends Error {}

/** Whether the draft is still in the entry, read again: the failure Notice says it is kept only then. */
function stillKept(app: RescueApp, draft: ExitDraft): boolean {
  try { return readExitDrafts(app.loadLocalStorage(EXIT_DRAFTS_KEY)).some(item => sameDraft(item, draft)); } catch { return false; }
}

/**
 * Creates the rescued file under `RECOVERY_FOLDER` and resolves to its path. A file in the folder's place is left as it
 * is; a folder that appeared meanwhile (created elsewhere, the create refused for it) is used. A name taken, or a create
 * refused, moves to the next number; nothing is modified.
 */
export async function saveRescuedDraft(app: RescueApp, draft: ExitDraft): Promise<string> {
  const vault = app.vault;
  const isFolder = (): boolean => vault.getAbstractFileByPath(RECOVERY_FOLDER) instanceof TFolder;
  const found = vault.getAbstractFileByPath(RECOVERY_FOLDER);
  if (found && !(found instanceof TFolder)) throw new FolderIsFile();
  if (!found) {
    try { await vault.createFolder(RECOVERY_FOLDER); } catch (error) { if (!isFolder()) throw error; }
  }
  const content = rescuedNoteText(draft);
  const base = rescuedFileBase(draft);
  let failure: unknown = null;
  for (let number = 1; number <= RECOVERY_ATTEMPTS; number += 1) {
    const path = `${RECOVERY_FOLDER}/${base}${number === 1 ? "" : ` ${number}`}.md`;
    if (vault.getAbstractFileByPath(path)) continue;
    try {
      await vault.create(path, content);
      return path;
    } catch (error) { failure = error; }
  }
  if (failure === null) throw new NoFreeName();
  throw failure instanceof Error ? failure : new Error(t().rescueUnknownReason);
}

/** The original note's name without its folder and `.md`. */
export function noteBasename(path: string): string {
  return (path.split("/").pop() ?? path).replace(/\.md$/iu, "");
}

/**
 * A name a file can take on every desktop system and that a link can reach: `\ / : * ? " < > | # ^ [ ]` and control
 * characters as `_`, no leading dot or space (a hidden file, one the vault does not list), at most `NAME_LIMIT` code
 * points; `draft` when nothing is left.
 */
export function safeFileName(name: string): string {
  const replaced = Array.from(name.replace(/[\\/:*?"<>|#^[\]]/gu, "_"), char => char < " " || char === "\u007f" ? "_" : char)
    .join("").replace(/^[.\s]+/u, "");
  const cut = Array.from(replaced).slice(0, NAME_LIMIT).join("").trimEnd();
  return cut === "" ? "draft" : cut;
}

const pad = (value: number, width = 2): string => String(value).padStart(width, "0");

/** `at` (epoch ms) in local time, as `YYYY-MM-DD HH:mm:ss` (`separator` between the time's parts). */
export function localTime(at: number, separator = ":"): string {
  const date = new Date(at);
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

/** One line per kept draft: where, when, the title, and what it holds. */
class ExitDraftListModal extends Modal {
  constructor(app: App, private readonly drafts: readonly ExitDraft[], private readonly choose: (draft: ExitDraft) => void) { super(app); }

  onOpen(): void {
    const text = t();
    this.setTitle(text.cmdRescueDrafts);
    this.contentEl.createEl("p", { text: text.rescueLead });
    for (const draft of this.drafts) {
      const holds = "refused" in draft ? text.rescueRefused(draft.refused)
        : draft.source === undefined ? text.rescueNoSource : text.rescueHasSource(String(draft.source.length));
      new Setting(this.contentEl)
        .setName(draft.path)
        .setDesc(`${text.rescueKeptAt(localTime(draft.at))} · ${text.rescueTitleLine(draft.title)} · ${holds}`)
        .addButton(button => button.setButtonText(text.rescuePick).onClick(() => { this.close(); this.choose(draft); }));
    }
  }

  onClose(): void { this.contentEl.empty(); }
}

/** Where the draft goes and what goes in, before anything is written. */
class ExitDraftConfirmModal extends Modal {
  constructor(app: App, private readonly draft: ExitDraft, private readonly save: () => void) { super(app); }

  onOpen(): void {
    const text = t();
    const draft = this.draft;
    this.setTitle(text.rescueConfirmTitle);
    this.contentEl.createEl("p", { text: text.rescueConfirmPath(`${RECOVERY_FOLDER}/${rescuedFileBase(draft)}.md`) });
    this.contentEl.createEl("p", { text: "refused" in draft ? text.rescueConfirmRefused
      : draft.source === undefined ? text.rescueConfirmEdits : text.rescueConfirmSource(String(draft.source.length)) });
    this.contentEl.createEl("p", { text: text.rescueConfirmUnchanged });
    new Setting(this.contentEl)
      .addButton(button => button.setButtonText(text.rescueSave).setCta().onClick(() => { this.close(); this.save(); }))
      .addButton(button => button.setButtonText(text.rescueCancel).onClick(() => { this.close(); }));
  }

  onClose(): void { this.contentEl.empty(); }
}
