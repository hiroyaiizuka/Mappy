import type { App, TFile } from 'obsidian';
import { insertWikiLink, wikiLinkContext } from '../core/wiki-link';
import type { InlineSuggestion } from './inline-editor';

interface LinkOption { file: TFile; label: string; alias?: string }
let suggestionId = 0;

/** Public Vault/MetadataCache APIs supply candidates for the node's multiline input. */
export class LinkSuggest implements InlineSuggestion {
  private readonly popup: HTMLDivElement;
  private readonly cleanup: (() => void)[] = [];
  private options: LinkOption[] = [];
  private active = 0;
  private composing = false;
  private disposed = false;

  constructor(private readonly app: App, private readonly input: HTMLTextAreaElement, private readonly sourcePath: string) {
    this.popup = input.ownerDocument.body.createDiv();
    this.popup.remove();
    this.popup.className = 'mappy-link-suggest';
    this.popup.id = `mappy-link-suggest-${++suggestionId}`;
    this.popup.setAttribute('role', 'listbox');
    this.popup.setAttribute('aria-label', 'リンク先の候補');
    input.setAttribute('aria-autocomplete', 'list');
    this.listen(input, 'input', () => { this.refresh(); });
    this.listen(input, 'click', () => { this.refresh(); });
    this.listen(input, 'keyup', event => {
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) this.refresh();
    });
    this.listen(input, 'blur', () => { this.close(); });
    this.listen(input, 'compositionstart', () => { this.composing = true; this.close(); });
    this.listen(input, 'compositionend', () => { this.composing = false; this.refresh(); });
    this.listen(this.popup, 'pointerdown', event => { event.preventDefault(); });
    this.listen(this.popup, 'mousedown', event => { event.preventDefault(); });
    const doc = input.ownerDocument;
    const onMove = (event: Event): void => {
      if (!event.composedPath().includes(this.popup)) this.close();
    };
    doc.addEventListener('scroll', onMove, true);
    doc.addEventListener('wheel', onMove, true);
    doc.defaultView?.addEventListener('resize', onMove);
    this.cleanup.push(() => {
      doc.removeEventListener('scroll', onMove, true);
      doc.removeEventListener('wheel', onMove, true);
      doc.defaultView?.removeEventListener('resize', onMove);
    });
  }

  private listen<K extends keyof HTMLElementEventMap>(target: HTMLElement, type: K, callback: (event: HTMLElementEventMap[K]) => void): void {
    target.addEventListener(type, callback);
    this.cleanup.push(() => { target.removeEventListener(type, callback); });
  }

  private refresh(): void {
    if (this.disposed || this.composing || this.input.readOnly || this.input.ownerDocument.activeElement !== this.input
      || this.input.selectionStart !== this.input.selectionEnd) {
      this.close(); return;
    }
    const context = wikiLinkContext(this.input.value, this.input.selectionStart);
    if (!context) { this.close(); return; }
    const query = context.query.toLocaleLowerCase();
    const options: LinkOption[] = [];
    for (const file of this.app.vault.getFiles()) {
      const markdown = file.extension.toLocaleLowerCase() === 'md';
      const frontmatter = markdown ? this.app.metadataCache.getFileCache(file)?.frontmatter : undefined;
      const aliases: unknown = frontmatter?.aliases ?? frontmatter?.alias;
      const labels = typeof aliases === 'string' ? [aliases]
        : Array.isArray(aliases) ? aliases.filter((value): value is string => typeof value === 'string') : [];
      if (file.path.toLocaleLowerCase().includes(query)) options.push({ file, label: markdown ? file.basename : file.name });
      for (const alias of labels) {
        if (alias.toLocaleLowerCase().includes(query)) options.push({ file, label: alias, alias });
      }
    }
    options.sort((left, right) => {
      const rank = (option: LinkOption): number => option.label.toLocaleLowerCase() === query ? 0
        : option.label.toLocaleLowerCase().startsWith(query) ? 1 : 2;
      return rank(left) - rank(right) || left.label.localeCompare(right.label) || left.file.path.localeCompare(right.file.path);
    });
    this.options = options.slice(0, 50);
    this.active = 0;
    if (!this.options.length) { this.close(); return; }
    this.popup.replaceChildren();
    this.options.forEach((option, index) => {
      const item = this.popup.createDiv();
      item.className = 'mappy-link-option';
      item.id = `${this.popup.id}-${index}`;
      item.setAttribute('role', 'option');
      const title = item.createSpan();
      title.className = 'mappy-link-title';
      title.textContent = option.label;
      const path = item.createSpan();
      path.className = 'mappy-link-path';
      path.textContent = option.file.path;
      item.append(title, path);
      item.addEventListener('pointermove', () => { this.active = index; this.highlight(); });
      item.addEventListener('click', event => {
        event.preventDefault(); event.stopPropagation(); this.choose(index);
      });
      this.popup.append(item);
    });
    this.input.ownerDocument.body.append(this.popup);
    this.input.setAttribute('aria-controls', this.popup.id);
    this.input.setAttribute('aria-expanded', 'true');
    this.highlight();
    this.position();
  }

  private position(): void {
    const rect = this.input.getBoundingClientRect();
    const win = this.input.ownerDocument.defaultView;
    const width = win?.innerWidth ?? 1024;
    const height = win?.innerHeight ?? 768;
    const availableBelow = height - rect.bottom - 12;
    const above = availableBelow < 180 && rect.top > availableBelow;
    const available = Math.max(64, above ? rect.top - 12 : availableBelow);
    this.popup.style.maxHeight = `${Math.min(280, available)}px`;
    const popupHeight = this.popup.getBoundingClientRect().height;
    const popupWidth = this.popup.getBoundingClientRect().width;
    this.popup.style.left = `${Math.max(12, Math.min(rect.left, width - popupWidth - 12))}px`;
    this.popup.style.top = `${Math.max(12, above ? rect.top - popupHeight - 4 : rect.bottom + 4)}px`;
  }

  private highlight(): void {
    Array.from(this.popup.children).forEach((item, index) => {
      item.classList.toggle('is-selected', index === this.active);
      item.setAttribute('aria-selected', String(index === this.active));
    });
    this.input.setAttribute('aria-activedescendant', `${this.popup.id}-${this.active}`);
  }

  handleKey(event: KeyboardEvent): boolean {
    if (event.isComposing || this.composing || event.key === 'Process' || !this.popup.isConnected) return false;
    if (!['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(event.key)) return false;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape') this.close();
    else if (event.key === 'Enter' || event.key === 'Tab') this.choose(this.active);
    else {
      this.active = (this.active + (event.key === 'ArrowDown' ? 1 : -1) + this.options.length) % this.options.length;
      this.highlight();
      this.popup.children[this.active]?.scrollIntoView({ block: 'nearest' });
    }
    return true;
  }

  private choose(index: number): void {
    const option = this.options[index];
    const context = wikiLinkContext(this.input.value, this.input.selectionStart);
    if (!option || !context || this.composing || this.input.readOnly) return;
    const linktext = this.app.metadataCache.fileToLinktext(option.file, this.sourcePath, true);
    const insertion = insertWikiLink(this.input.value, context, linktext, option.alias);
    this.input.setRangeText(insertion.value.slice(context.from, insertion.cursor), context.from, context.to, 'end');
    this.close();
    this.input.focus({ preventScroll: true });
    this.input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  private close(): void {
    this.popup.remove();
    this.options = [];
    this.input.setAttribute('aria-expanded', 'false');
    this.input.removeAttribute('aria-controls');
    this.input.removeAttribute('aria-activedescendant');
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.close();
    for (const cleanup of this.cleanup) cleanup();
    this.cleanup.length = 0;
    this.input.removeAttribute('aria-autocomplete');
    this.input.removeAttribute('aria-expanded');
  }
}
