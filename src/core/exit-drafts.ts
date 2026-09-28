import type { TextEdit } from './commands';

/**
 * A title draft that was open when the page went (a window reload, LEV-230), kept until the plugin loads again:
 * the edit its save would have made, planned on the note the map showed, or the reason it could not be planned.
 * Kept by the path and the text's fingerprint rather than the text itself, so a large note does not overflow the
 * vault's `localStorage` at the moment nothing else can be done.
 */
export type ExitDraft =
  | { path: string; title: string; before: string; after: string; edits: TextEdit[] }
  | { path: string; title: string; refused: string };

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
    const { path, title } = draft;
    if (typeof path !== 'string' || typeof title !== 'string') return [];
    if (typeof draft.refused === 'string') return [{ path, title, refused: draft.refused }];
    const { before, after, edits } = draft;
    if (typeof before !== 'string' || typeof after !== 'string' || !Array.isArray(edits) || edits.length === 0 || !edits.every(isEdit)) return [];
    return [{ path, title, before, after, edits: edits.map(edit => ({ from: edit.from, to: edit.to, text: edit.text })) }];
  });
}
