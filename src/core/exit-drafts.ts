import type { TextEdit } from './commands';
import { diffEdit, rebaseEdits } from './text-edits';

/**
 * A title draft that was open when the page went (a window reload, Obsidian quitting, LEV-230), kept until the plugin
 * loads again: the edit its save would have made, planned on the note the map showed, or the reason it could not be
 * planned; `at` is when (epoch ms). The note it was planned on is kept by its fingerprint, and by its text too when
 * that is small enough (`EXIT_SOURCE_LIMIT`), so a large note does not overflow the vault's `localStorage` at the
 * moment nothing else can be done; with the text, a note changed elsewhere in the meantime can still take a plain
 * rename (`rebaseExitEdits`).
 */
export type ExitDraft =
  | { path: string; title: string; at: number; before: string; after: string; edits: TextEdit[]; source?: string }
  | { path: string; title: string; at: number; refused: string };

/** The longest note (UTF-16 units) whose text is kept with its draft: `localStorage` holds about 5M per origin. */
export const EXIT_SOURCE_LIMIT = 256 * 1024;

/**
 * How long a kept draft may wait to be written (ms). The next load normally comes within seconds (a reload) or at the
 * next launch; one kept longer (Mappy disabled, the vault opened elsewhere meanwhile) is not written unasked into a
 * note the person has worked on since, and is reported with its text instead.
 */
export const EXIT_DRAFT_TTL = 24 * 60 * 60 * 1000;

/**
 * `edits`, planned on `before`, moved onto a different `current`, or null. Only a plan of one edit moves — a plain
 * title rename — and only over a change clear of it (not touching it either: `diffEdit`, then `rebaseEdits`), so what
 * it replaces is still there with the same text around it. A plan of more edits (a topic's frontmatter keys and
 * position, which depend on the other topics in the note) applies only to the note it was planned on, as nothing is
 * planned again here (review 2). Where the change sits is ambiguous in repeated text (「- A\n- A\n」 losing a line
 * could have lost either): it is placed both as far forward and as far back as it goes, and the edit moves only when
 * both leave it clear on the same side, so a same-titled node never takes another's draft (review 3, AGENTS.md: 同名
 * 見出し). Nothing is guessed either when the change reaches the edit (E05), nor when it takes the note's end off, even
 * placed as early as it goes (`cutsEnd`): a write cut off as the page went leaves the first part of the note, and the
 * draft, the one copy of the rest, would go once written (LEV-309).
 */
export function rebaseExitEdits(before: string, current: string, edits: readonly TextEdit[]): TextEdit[] | null {
  if (edits.length !== 1) return null;
  const late = diffEdit(before, current);
  const early = diffFromEnd(before, current);
  if (cutsEnd(before, early)) return null;
  const side = (change: TextEdit, edit: TextEdit): number => change.to < edit.from ? -1 : change.from > edit.to ? 1 : 0;
  for (const edit of edits) {
    const at = side(late, edit);
    if (at === 0 || side(early, edit) !== at) return null;
  }
  return rebaseEdits(edits, [late]) ?? null;
}

/**
 * Whether `change` takes the end off `text`, as a write that stopped part way does: what it takes away reaches into
 * the last line with text, and runs to the very end or takes a line break with it. A change within the last line that
 * keeps its line break does not, nor one that only inserts (all of `text` is still there). Not told apart: a change
 * the person made there of the same shape (the last line taken out, or changed to the very end of a note without a
 * final line break), refused too; and a cut that leaves a whole line equal to the last one at the end, let through.
 */
function cutsEnd(text: string, change: TextEdit): boolean {
  if (change.to === change.from) return false;
  const end = text.trimEnd().length;
  const last = end === 0 ? 0 : text.lastIndexOf('\n', end - 1) + 1;
  return change.to > last && (change.to === text.length || /[\n\r]/u.test(text.slice(change.from, change.to)));
}

/** `diffEdit` with the common end taken first: the same change placed as early in the text as it goes. */
function diffFromEnd(from: string, to: string): TextEdit {
  let end = 0;
  while (end < from.length && end < to.length && from[from.length - 1 - end] === to[to.length - 1 - end]) end += 1;
  let start = 0;
  while (start < from.length - end && start < to.length - end && from[start] === to[start]) start += 1;
  return { from: start, to: from.length - end, text: to.slice(start, to.length - end) };
}

/**
 * What stands for a note's text in an `ExitDraft`: its length and a 53-bit hash (cyrb53). Only compared with the
 * fingerprint of the note read again, to tell the note the draft was planned on (or the one its save leaves) from
 * any other.
 */
export function textFingerprint(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `${text.length}:${(4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)}`;
}

const isEdit = (value: unknown): value is TextEdit => {
  if (!value || typeof value !== 'object') return false;
  const edit = value as Record<string, unknown>;
  return Number.isInteger(edit.from) && Number.isInteger(edit.to) && typeof edit.text === 'string'
    && (edit.from as number) >= 0 && (edit.to as number) >= (edit.from as number);
};

/** The kept drafts in what `localStorage` gave back; anything not of their shape is left out. */
export function readExitDrafts(value: unknown): ExitDraft[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item: unknown): ExitDraft[] => {
    if (!item || typeof item !== 'object') return [];
    const draft = item as Record<string, unknown>;
    const { path, title, at } = draft;
    if (typeof path !== 'string' || typeof title !== 'string' || typeof at !== 'number' || !Number.isFinite(at)) return [];
    if (typeof draft.refused === 'string') return [{ path, title, at, refused: draft.refused }];
    const { before, after, edits } = draft;
    if (typeof before !== 'string' || typeof after !== 'string' || !Array.isArray(edits) || edits.length === 0 || !edits.every(isEdit)) return [];
    const kept = edits.map(edit => ({ from: edit.from, to: edit.to, text: edit.text }));
    return [{ path, title, at, before, after, edits: kept, ...(typeof draft.source === 'string' ? { source: draft.source } : {}) }];
  });
}

/** The same drafts without the note texts they carry: what still fits when `localStorage` refuses them all. */
export function withoutSources(drafts: readonly ExitDraft[]): ExitDraft[] {
  return drafts.map(draft => 'refused' in draft ? draft
    : { path: draft.path, title: draft.title, at: draft.at, before: draft.before, after: draft.after, edits: draft.edits });
}
