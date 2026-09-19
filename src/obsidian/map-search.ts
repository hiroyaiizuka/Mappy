import { FuzzySuggestModal, type App, type FuzzyMatch, type SearchMatches, type TFile } from 'obsidian';
import { isMapNote } from './embed-target';

/**
 * The maps a note can call (§5 M12): every other Markdown note the metadata cache
 * marks with `mappy: true`, in path order. The note asking is left out, so the list
 * never offers a self-embed; a `#heading` subtree is written by hand, not chosen here.
 */
export function listMapNotes(app: App, except: TFile | null): TFile[] {
  return app.vault.getMarkdownFiles()
    .filter((file) => file.path !== except?.path && isMapNote(app, file))
    .sort((left, right) => left.path.localeCompare(right.path));
}

/** The folder a suggestion shows under the title; nothing for the vault root. */
function folderOf(file: TFile): string {
  const parent = file.parent;
  return parent && !parent.isRoot() ? parent.path : '';
}

/**
 * What the fuzzy search reads: the path without its extension, so a query can name
 * the title, a folder, or `folder/title`. The title comes last, and the suggestion
 * shows it with the matches shifted by the folder's length.
 */
export function searchText(file: TFile): string {
  const folder = folderOf(file);
  return folder ? `${folder}/${file.basename}` : file.basename;
}

/**
 * `text`, the slice of the searched string that starts at `offset`, with the matched
 * ranges wrapped the way Obsidian's own suggestions mark them (`.suggestion-highlight`).
 */
function renderHighlighted(el: HTMLElement, text: string, matches: SearchMatches, offset: number): void {
  let cursor = 0;
  for (const [start, end] of [...matches].sort((left, right) => left[0] - right[0])) {
    const from = Math.max(cursor, Math.min(text.length, start - offset));
    const to = Math.max(from, Math.min(text.length, end - offset));
    if (to === from) continue;
    if (from > cursor) el.appendText(text.slice(cursor, from));
    el.createSpan({ cls: 'suggestion-highlight', text: text.slice(from, to) });
    cursor = to;
  }
  if (cursor < text.length) el.appendText(text.slice(cursor));
}

/**
 * The search a map opens to call another map (§5 M12): the candidates are the
 * vault's other map notes, filtered by title and path and shown as the note's name
 * over its folder. Choosing one hands the file back; the caller decides where the
 * `![[…]]` item goes and how the link is written.
 */
export class MapSearchModal extends FuzzySuggestModal<TFile> {
  /** Listed once per opening; the search asks again on every keystroke, and a note added meanwhile shows up next time. */
  private items: TFile[] | undefined;

  constructor(app: App, private readonly except: TFile | null, private readonly choose: (file: TFile) => void) {
    super(app);
    this.setPlaceholder('マップを検索（タイトルとパス）');
    this.emptyStateText = 'マップがありません';
    this.setInstructions([
      { command: '↑↓', purpose: '移動' },
      { command: '↵', purpose: '呼び出す' },
      { command: 'esc', purpose: '閉じる' },
    ]);
  }

  getItems(): TFile[] {
    this.items ??= listMapNotes(this.app, this.except);
    return this.items;
  }

  getItemText(file: TFile): string { return searchText(file); }

  renderSuggestion(match: FuzzyMatch<TFile>, el: HTMLElement): void {
    const file = match.item;
    const folder = folderOf(file);
    el.addClass('mod-complex');
    const content = el.createDiv({ cls: 'suggestion-content' });
    renderHighlighted(content.createDiv({ cls: 'suggestion-title' }), file.basename, match.match.matches, folder ? folder.length + 1 : 0);
    if (folder) renderHighlighted(content.createDiv({ cls: 'suggestion-note' }), folder, match.match.matches, 0);
  }

  onChooseItem(file: TFile): void { this.choose(file); }
}
