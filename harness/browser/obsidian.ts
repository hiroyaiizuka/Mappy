/**
 * Browser stand-in for the `obsidian` module, the counterpart of
 * `tests/mocks/obsidian.ts` for a real DOM. The esbuild alias points `obsidian`
 * here, so `src/ui`, `src/obsidian/document-store.ts` and `src/obsidian/frontmatter.ts`
 * run unchanged. Everything below is a mock: Markdown rendering, link
 * resolution, notices and menus approximate Obsidian's DOM, they do not prove it.
 */
import type { App, EventRef, KeymapContext, KeymapEventHandler, KeymapEventListener, Modifier, TFile as ObsidianFile, ViewState } from "obsidian";

export { TFile, TFolder, normalizePath } from "../../tests/mocks/obsidian-file";

interface HarnessEventRef extends EventRef {
  events: Events;
  name: string;
  callback: (...data: unknown[]) => unknown;
}

/** Same contract as Obsidian's Events: `on` returns a ref that `offref` removes. */
export class Events {
  private readonly listeners = new Map<string, Set<HarnessEventRef>>();

  on(name: string, callback: (...data: unknown[]) => unknown): EventRef {
    const ref: HarnessEventRef = { events: this, name, callback };
    let refs = this.listeners.get(name);
    if (!refs) { refs = new Set(); this.listeners.set(name, refs); }
    refs.add(ref);
    return ref;
  }

  off(name: string, callback: (...data: unknown[]) => unknown): void {
    for (const ref of this.listeners.get(name) ?? []) if (ref.callback === callback) this.offref(ref);
  }

  offref(ref: EventRef): void {
    const own = ref as HarnessEventRef;
    this.listeners.get(own.name)?.delete(own);
  }

  trigger(name: string, ...data: unknown[]): void {
    for (const ref of Array.from(this.listeners.get(name) ?? [])) ref.callback(...data);
  }

  /** Live subscriptions, so a test can show that a component released every one of its own. */
  count(): number {
    let total = 0;
    for (const refs of this.listeners.values()) total += refs.size;
    return total;
  }
}

/** Lifecycle follows the public Component contract: children load with the parent, cleanups run on unload. */
export class Component {
  private loaded = false;
  private readonly children: Component[] = [];
  private cleanups: (() => void)[] = [];

  load(): void {
    if (this.loaded) return;
    this.loaded = true;
    this.onload();
    for (const child of this.children) child.load();
  }

  unload(): void {
    if (!this.loaded) return;
    this.loaded = false;
    for (const child of [...this.children].reverse()) child.unload();
    for (const cleanup of this.cleanups.reverse()) cleanup();
    this.cleanups = [];
    this.onunload();
  }

  onload(): void { /* Subclass lifecycle hook. */ }
  onunload(): void { /* Subclass lifecycle hook. */ }

  addChild<T extends Component>(component: T): T {
    this.children.push(component);
    if (this.loaded) component.load();
    return component;
  }

  removeChild<T extends Component>(component: T): T {
    const index = this.children.indexOf(component);
    if (index >= 0) {
      this.children.splice(index, 1);
      component.unload();
    }
    return component;
  }

  register(cleanup: () => unknown): void { this.cleanups.push(() => { cleanup(); }); }

  registerEvent(ref: EventRef): void {
    const own = ref as HarnessEventRef;
    this.register(() => { own.events.offref(own); });
  }

  registerDomEvent<K extends keyof HTMLElementEventMap>(
    element: HTMLElement | Document | Window,
    type: K,
    callback: (event: HTMLElementEventMap[K]) => void,
    options?: boolean | AddEventListenerOptions,
  ): void {
    const listener = callback as EventListener;
    element.addEventListener(type, listener, options);
    this.register(() => { element.removeEventListener(type, listener, options); });
  }

  registerInterval(id: number): number {
    this.register(() => { window.clearInterval(id); });
    return id;
  }
}

/** A component whose life is tied to an element of a rendered section; the renderer (or a test) unloads it when the element goes. */
export class MarkdownRenderChild extends Component {
  constructor(public containerEl: HTMLElement) { super(); }
}

/** `Note#Heading` → path and `#Heading`; the subpath keeps its leading `#`, as Obsidian's does. */
export function parseLinktext(linktext: string): { path: string; subpath: string } {
  const index = linktext.indexOf("#");
  return index < 0 ? { path: linktext, subpath: "" } : { path: linktext.slice(0, index), subpath: linktext.slice(index) };
}

/** A registered handler with its callback, so a test can call the one a view registered. */
export interface HarnessKeymapHandler extends KeymapEventHandler { func: KeymapEventListener }

/** `Mod` is Meta on macOS and Ctrl elsewhere; the rest sorted and joined, as Obsidian's `Keymap.compileModifiers` stores them. */
export function compileModifiers(modifiers: readonly Modifier[]): string {
  const mac = navigator.platform.startsWith("Mac");
  return modifiers.map(modifier => modifier === "Mod" ? (mac ? "Meta" : "Ctrl") : modifier).sort().join(",");
}

/** The modifier string of a keyboard event, in the same form (`Keymap.getModifiers`). */
export function eventModifiers(event: KeyboardEvent): string {
  const held: Modifier[] = [];
  if (event.ctrlKey) held.push("Ctrl");
  if (event.metaKey) held.push("Meta");
  if (event.altKey) held.push("Alt");
  if (event.shiftKey) held.push("Shift");
  return compileModifiers(held);
}

/**
 * Same registration contract as Obsidian's Scope, and the same key dispatch as its 1.14.2 `handleKey`
 * (read from app.js, artifacts/lev-48-f2-scope): handlers are tried in registration order; the first
 * match that returns anything ends the search with that value, a match on a key- or modifier-specific
 * handler ends it even on `undefined`, and only a catch-all (`null`, `null`) match falls through to the
 * next handler and then the parent scope. Obsidian's Keymap then prevents and stops the event on
 * `false`; this page has no Keymap, so nothing routes a real keydown here — tests call `handleKey`.
 */
export class Scope {
  readonly keys: HarnessKeymapHandler[] = [];
  constructor(readonly parent?: Scope) {}
  register(modifiers: Modifier[] | null, key: string | null, func: KeymapEventListener): KeymapEventHandler {
    const handler: HarnessKeymapHandler = { scope: this, modifiers: modifiers ? compileModifiers(modifiers) : null, key, func };
    this.keys.push(handler);
    return handler;
  }
  unregister(handler: KeymapEventHandler): void {
    const index = this.keys.indexOf(handler as HarnessKeymapHandler);
    if (index >= 0) this.keys.splice(index, 1);
  }
  handleKey(event: KeyboardEvent, context: KeymapContext = { modifiers: eventModifiers(event), key: event.key, vkey: event.key }): unknown {
    for (const handler of this.keys) {
      const matches = (handler.modifiers === null || handler.modifiers === context.modifiers)
        && (!handler.key || handler.key === context.vkey || (!!context.key && handler.key.toLowerCase() === context.key.toLowerCase()));
      if (!matches) continue;
      const result: unknown = handler.func(event, context);
      if (result !== undefined) return result;
      if (handler.key !== null || handler.modifiers !== null) return result;
    }
    return this.parent?.handleKey(event, context);
  }
}

/** A leaf only needs to carry the app and remember the last requested state. */
export class WorkspaceLeaf {
  view: View | null = null;
  states: ViewState[] = [];
  constructor(readonly app: App) {}
  setViewState(state: ViewState): Promise<void> {
    this.states.push(state);
    return Promise.resolve();
  }
}

export abstract class View extends Component {
  app: App;
  containerEl: HTMLElement;
  navigation = false;
  /** Hotkeys for when the view is in focus; Obsidian's workspace reads it on each key, this page never does. */
  scope: Scope | null = null;
  constructor(readonly leaf: WorkspaceLeaf) {
    super();
    this.app = leaf.app;
    this.containerEl = document.createElement("div");
    this.containerEl.className = "workspace-leaf-content";
  }
  onOpen(): Promise<void> { return Promise.resolve(); }
  onClose(): Promise<void> { return Promise.resolve(); }
  abstract getViewType(): string;
  abstract getDisplayText(): string;
  getIcon(): string { return "document"; }
  getState(): Record<string, unknown> { return {}; }
  setState(): Promise<void> { return Promise.resolve(); }
  getEphemeralState(): Record<string, unknown> { return {}; }
  setEphemeralState(): void { /* Not needed in the harness. */ }
  onResize(): void { /* Subclasses re-measure. */ }
}

export abstract class ItemView extends View {
  contentEl: HTMLElement;
  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
    this.contentEl = this.containerEl.createDiv({ cls: "view-content" });
  }
}

/** Only used for `instanceof` checks; the harness never opens a Markdown editor. */
export class MarkdownView extends ItemView {
  file: ObsidianFile | null = null;
  getViewType(): string { return "markdown"; }
  getDisplayText(): string { return this.file?.basename ?? "Markdown"; }
}

export class Notice {
  static container: HTMLElement | null = null;
  static log: string[] = [];
  readonly noticeEl: HTMLElement;

  constructor(message: string | DocumentFragment, duration = 4000) {
    Notice.log.push(typeof message === "string" ? message : message.textContent ?? "");
    let container = Notice.container;
    if (!container?.isConnected) {
      container = document.body.createDiv({ cls: "notice-container" });
      Notice.container = container;
    }
    this.noticeEl = container.createDiv({ cls: "notice" });
    this.noticeEl.setText(message);
    this.noticeEl.addEventListener("click", () => { this.hide(); });
    if (duration > 0) window.setTimeout(() => { this.hide(); }, duration);
  }

  setMessage(message: string | DocumentFragment): this { this.noticeEl.setText(message); return this; }
  hide(): void { this.noticeEl.remove(); }
}

export class MenuItem {
  readonly element: HTMLElement;
  private handler: ((event: MouseEvent | KeyboardEvent) => unknown) | null = null;
  private disabled = false;

  constructor(parent: HTMLElement, private readonly menu: Menu) {
    this.element = parent.createDiv({ cls: "menu-item", attr: { role: "menuitem", tabindex: "0" } });
    this.element.createSpan({ cls: "menu-item-icon" });
    this.element.createSpan({ cls: "menu-item-title" });
    this.element.addEventListener("click", event => {
      if (this.disabled) return;
      this.menu.hide();
      this.handler?.(event);
    });
  }

  setTitle(title: string | DocumentFragment): this {
    this.element.querySelector(".menu-item-title")?.setText(title);
    return this;
  }
  setIcon(icon: string | null): this {
    const holder = this.element.querySelector<HTMLElement>(".menu-item-icon");
    if (holder) { holder.empty(); if (icon) setIcon(holder, icon); }
    return this;
  }
  setChecked(checked: boolean | null): this { this.element.toggleClass("is-checked", checked === true); return this; }
  setDisabled(disabled: boolean): this {
    this.disabled = disabled;
    this.element.toggleClass("is-disabled", disabled);
    this.element.setAttribute("aria-disabled", String(disabled));
    return this;
  }
  setIsLabel(isLabel: boolean): this { this.element.toggleClass("is-label", isLabel); return this; }
  setSection(section: string): this { this.element.dataset.section = section; return this; }
  onClick(callback: (event: MouseEvent | KeyboardEvent) => unknown): this { this.handler = callback; return this; }
}

/** Context menu with the same item API; closes on outside pointer, Escape, or wheel. */
export class Menu extends Component {
  readonly dom: HTMLElement;
  private hideCallbacks: (() => unknown)[] = [];

  constructor() {
    super();
    this.dom = document.createElement("div");
    this.dom.className = "menu";
    this.dom.setAttribute("role", "menu");
  }

  setNoIcon(): this { this.dom.addClass("mod-no-icon"); return this; }
  setUseNativeMenu(): this { return this; }
  addItem(callback: (item: MenuItem) => unknown): this { callback(new MenuItem(this.dom, this)); return this; }
  addSeparator(): this { this.dom.createDiv({ cls: "menu-separator" }); return this; }
  onHide(callback: () => unknown): void { this.hideCallbacks.push(callback); }

  showAtMouseEvent(event: MouseEvent): this {
    return this.showAtPosition({ x: event.clientX, y: event.clientY });
  }

  showAtPosition(position: { x: number; y: number }): this {
    document.body.appendChild(this.dom);
    this.load();
    const rect = this.dom.getBoundingClientRect();
    const x = Math.max(4, Math.min(position.x, window.innerWidth - rect.width - 4));
    const y = Math.max(4, Math.min(position.y, window.innerHeight - rect.height - 4));
    this.dom.style.left = `${x}px`;
    this.dom.style.top = `${y}px`;
    const onPointer = (pointer: Event): void => { if (!this.dom.contains(pointer.target as Node)) this.hide(); };
    // Consume Escape like Obsidian's menu does; an unhandled key would go on to the native menu bar.
    const onKey = (key: KeyboardEvent): void => {
      if (key.key !== "Escape") return;
      key.preventDefault();
      key.stopPropagation();
      this.hide();
    };
    window.setTimeout(() => {
      if (!this.dom.isConnected) return;
      document.addEventListener("pointerdown", onPointer, true);
      document.addEventListener("wheel", onPointer, true);
      document.addEventListener("keydown", onKey, true);
    }, 0);
    this.register(() => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("wheel", onPointer, true);
      document.removeEventListener("keydown", onKey, true);
    });
    return this;
  }

  hide(): this {
    if (!this.dom.isConnected) return this;
    this.dom.remove();
    this.unload();
    for (const callback of this.hideCallbacks) callback();
    return this;
  }

  close(): void { this.hide(); }
}

export class Modal {
  readonly containerEl: HTMLElement;
  readonly modalEl: HTMLElement;
  readonly titleEl: HTMLElement;
  readonly contentEl: HTMLElement;
  private readonly onKey = (event: KeyboardEvent): void => { if (event.key === "Escape") this.close(); };

  constructor(readonly app: App) {
    this.containerEl = document.createElement("div");
    this.containerEl.className = "modal-container";
    const background = this.containerEl.createDiv({ cls: "modal-bg" });
    background.addEventListener("click", () => { this.close(); });
    this.modalEl = this.containerEl.createDiv({ cls: "modal", attr: { role: "dialog", "aria-modal": "true" } });
    const closeButton = this.modalEl.createDiv({ cls: "modal-close-button", attr: { "aria-label": "閉じる", role: "button", tabindex: "0" } });
    closeButton.addEventListener("click", () => { this.close(); });
    this.titleEl = this.modalEl.createDiv({ cls: "modal-title" });
    this.contentEl = this.modalEl.createDiv({ cls: "modal-content" });
  }

  open(): void {
    document.body.appendChild(this.containerEl);
    document.addEventListener("keydown", this.onKey, true);
    this.onOpen();
  }

  close(): void {
    if (!this.containerEl.isConnected) return;
    document.removeEventListener("keydown", this.onKey, true);
    this.onClose();
    this.containerEl.remove();
  }

  onOpen(): void { /* Subclass hook. */ }
  onClose(): void { /* Subclass hook. */ }
  setTitle(title: string): this { this.titleEl.setText(title); return this; }
  setContent(content: string | DocumentFragment): this { this.contentEl.setText(content); return this; }
}

export type SearchMatches = [number, number][];
export interface SearchResult { score: number; matches: SearchMatches }
export interface FuzzyMatch<T> { item: T; match: SearchResult }
export interface Instruction { command: string; purpose: string }

/**
 * A case-insensitive subsequence match: every character of the query in order, the
 * matched runs as ranges, fewer gaps scoring higher. Enough to drive a suggest modal on
 * this page; Obsidian's own scoring (word starts, camel case) is not modelled.
 */
export function prepareFuzzySearch(query: string): (text: string) => SearchResult | null {
  const wanted = query.toLowerCase().replace(/\s+/gu, "");
  return text => {
    if (!wanted) return { score: 0, matches: [] };
    const haystack = text.toLowerCase();
    const matches: SearchMatches = [];
    let position = 0;
    let gaps = 0;
    for (const char of wanted) {
      const index = haystack.indexOf(char, position);
      if (index === -1) return null;
      const last = matches[matches.length - 1];
      if (last && last[1] === index) last[1] = index + 1;
      else { matches.push([index, index + 1]); if (matches.length > 1) gaps += 1; }
      position = index + 1;
    }
    return { score: -gaps, matches };
  };
}

/**
 * Obsidian's own marking of matched ranges (`.suggestion-highlight`), step for step as 1.14.2 does it
 * (read from the running app, LEV-71): `offset` is added to each match, a match ending at or before the
 * start of `text` is skipped, one starting past its end stops the loop, which also stops once the cursor
 * has reached the end. The ranges are taken in the order given and cut with `substring` (so an overlapping
 * range repeats the overlap, as the real one does); Obsidian's fuzzy search hands them sorted and disjoint.
 */
export function renderMatches(el: HTMLElement | DocumentFragment, text: string, matches: SearchMatches | null, offset = 0): void {
  if (!matches || matches.length === 0) { el.appendText(text); return; }
  let cursor = 0;
  for (const [start, end] of matches) {
    if (cursor >= text.length) break;
    const to = end + offset;
    if (to <= 0) continue;
    const from = Math.max(0, start + offset);
    if (from >= text.length) break;
    if (from !== cursor) el.appendText(text.substring(cursor, from));
    el.createSpan({ cls: "suggestion-highlight", text: text.substring(from, to) });
    cursor = to;
  }
  if (cursor < text.length) el.appendText(text.substring(cursor));
}

/**
 * Obsidian's prompt: a text input over a list of suggestions, re-queried on every
 * keystroke, chosen by click or Enter, moved through with the arrow keys. The DOM
 * classes (`prompt`, `prompt-results`, `suggestion-item`, `is-selected`,
 * `suggestion-empty`) follow app.css so a test can read the same structure.
 */
export abstract class SuggestModal<T> extends Modal {
  limit = 100;
  emptyStateText = "No match found.";
  readonly inputEl: HTMLInputElement;
  readonly resultContainerEl: HTMLElement;
  private readonly instructionsEl: HTMLElement;
  private suggestions: T[] = [];
  private active = 0;
  /** The query being answered; an older query's late answer is dropped. */
  private query = 0;

  constructor(app: App) {
    super(app);
    this.modalEl.addClass("prompt");
    this.titleEl.remove();
    this.contentEl.remove();
    const container = this.modalEl.createDiv({ cls: "prompt-input-container" });
    this.inputEl = container.createEl("input", { cls: "prompt-input", type: "text", attr: { spellcheck: "false" } });
    this.resultContainerEl = this.modalEl.createDiv({ cls: "prompt-results" });
    this.instructionsEl = this.modalEl.createDiv({ cls: "prompt-instructions" });
    this.inputEl.addEventListener("input", () => { this.refresh(); });
    this.inputEl.addEventListener("keydown", event => {
      // Obsidian ignores keys the IME is still composing (keyCode 229): a conversion's Enter never chooses.
      if (event.isComposing || event.key === "Process") return;
      if (event.key === "ArrowDown") { event.preventDefault(); this.setActive(this.active + 1); }
      else if (event.key === "ArrowUp") { event.preventDefault(); this.setActive(this.active - 1); }
      else if (event.key === "Enter") { event.preventDefault(); this.selectActiveSuggestion(event); }
    });
  }

  setPlaceholder(placeholder: string): void { this.inputEl.placeholder = placeholder; }

  setInstructions(instructions: Instruction[]): void {
    this.instructionsEl.empty();
    for (const { command, purpose } of instructions) {
      const item = this.instructionsEl.createDiv({ cls: "prompt-instruction" });
      item.createSpan({ cls: "prompt-instruction-command", text: command });
      item.createSpan({ text: purpose });
    }
  }

  onOpen(): void {
    this.inputEl.focus();
    this.refresh();
  }

  onNoSuggestion(): void {
    this.resultContainerEl.empty();
    this.resultContainerEl.createDiv({ cls: "suggestion-empty", text: this.emptyStateText });
  }

  selectSuggestion(value: T, evt: MouseEvent | KeyboardEvent): void {
    this.close();
    this.onChooseSuggestion(value, evt);
  }

  selectActiveSuggestion(evt: MouseEvent | KeyboardEvent): void {
    const value = this.suggestions[this.active];
    if (value !== undefined) this.selectSuggestion(value, evt);
  }

  abstract getSuggestions(query: string): T[] | Promise<T[]>;
  abstract renderSuggestion(value: T, el: HTMLElement): void;
  abstract onChooseSuggestion(item: T, evt: MouseEvent | KeyboardEvent): void;

  private refresh(): void {
    const query = ++this.query;
    const result = this.getSuggestions(this.inputEl.value);
    if (result instanceof Promise) { void result.then(values => { if (query === this.query) this.show(values); }); return; }
    this.show(result);
  }

  private show(values: T[]): void {
    this.suggestions = values.slice(0, this.limit);
    this.active = 0;
    if (this.suggestions.length === 0) { this.onNoSuggestion(); return; }
    this.resultContainerEl.empty();
    this.suggestions.forEach((value, index) => {
      const item = this.resultContainerEl.createDiv({ cls: "suggestion-item" });
      item.toggleClass("is-selected", index === 0);
      this.renderSuggestion(value, item);
      item.addEventListener("click", event => { this.selectSuggestion(value, event); });
      item.addEventListener("mousemove", () => { this.setActive(index); });
    });
  }

  private setActive(index: number): void {
    if (this.suggestions.length === 0) return;
    this.active = (index + this.suggestions.length) % this.suggestions.length;
    Array.from(this.resultContainerEl.children).forEach((item, position) => { item.toggleClass("is-selected", position === this.active); });
  }
}

/** Items searched by `getItemText`; the default rendering marks the matched characters. */
export abstract class FuzzySuggestModal<T> extends SuggestModal<FuzzyMatch<T>> {
  getSuggestions(query: string): FuzzyMatch<T>[] {
    const search = prepareFuzzySearch(query);
    const matches: FuzzyMatch<T>[] = [];
    for (const item of this.getItems()) {
      const match = search(this.getItemText(item));
      if (match) matches.push({ item, match });
    }
    return matches.sort((left, right) => right.match.score - left.match.score);
  }

  renderSuggestion(match: FuzzyMatch<T>, el: HTMLElement): void {
    renderMatches(el, this.getItemText(match.item), match.match.matches);
  }

  onChooseSuggestion(match: FuzzyMatch<T>, evt: MouseEvent | KeyboardEvent): void { this.onChooseItem(match.item, evt); }

  abstract getItems(): T[];
  abstract getItemText(item: T): string;
  abstract onChooseItem(item: T, evt: MouseEvent | KeyboardEvent): void;
}

export class ButtonComponent {
  readonly buttonEl: HTMLButtonElement;
  constructor(container: HTMLElement) {
    this.buttonEl = container.createEl("button", { attr: { type: "button" } });
  }
  setButtonText(text: string): this { this.buttonEl.setText(text); return this; }
  setCta(): this { this.buttonEl.addClass("mod-cta"); return this; }
  removeCta(): this { this.buttonEl.removeClass("mod-cta"); return this; }
  setWarning(): this { this.buttonEl.addClass("mod-warning"); return this; }
  setDisabled(disabled: boolean): this { this.buttonEl.disabled = disabled; return this; }
  setTooltip(tooltip: string): this { this.buttonEl.setAttribute("aria-label", tooltip); return this; }
  setIcon(icon: string): this { setIcon(this.buttonEl, icon); return this; }
  onClick(callback: (event: MouseEvent) => unknown): this {
    this.buttonEl.addEventListener("click", callback);
    return this;
  }
}

/** A `<select>` whose value the setting tab reads and writes; `onChange` fires on the DOM event, as in Obsidian. */
export class DropdownComponent {
  readonly selectEl: HTMLSelectElement;
  constructor(container: HTMLElement) {
    this.selectEl = container.createEl("select", { cls: "dropdown" });
  }
  addOption(value: string, display: string): this { this.selectEl.createEl("option", { value, text: display }); return this; }
  addOptions(options: Record<string, string>): this { for (const [value, display] of Object.entries(options)) this.addOption(value, display); return this; }
  getValue(): string { return this.selectEl.value; }
  setValue(value: string): this { this.selectEl.value = value; return this; }
  setDisabled(disabled: boolean): this { this.selectEl.disabled = disabled; return this; }
  onChange(callback: (value: string) => unknown): this {
    this.selectEl.addEventListener("change", () => { callback(this.selectEl.value); });
    return this;
  }
}

/** A text `<input>`; `onChange` fires on `input`, the way Obsidian's TextComponent reports each keystroke. */
export class TextComponent {
  readonly inputEl: HTMLInputElement;
  constructor(container: HTMLElement) {
    this.inputEl = container.createEl("input", { type: "text" });
  }
  getValue(): string { return this.inputEl.value; }
  setValue(value: string): this { this.inputEl.value = value; return this; }
  setPlaceholder(placeholder: string): this { this.inputEl.placeholder = placeholder; return this; }
  setDisabled(disabled: boolean): this { this.inputEl.disabled = disabled; return this; }
  onChange(callback: (value: string) => unknown): this {
    this.inputEl.addEventListener("input", () => { callback(this.inputEl.value); });
    return this;
  }
}

export class Setting {
  readonly settingEl: HTMLElement;
  readonly infoEl: HTMLElement;
  readonly nameEl: HTMLElement;
  readonly descEl: HTMLElement;
  readonly controlEl: HTMLElement;

  constructor(container: HTMLElement) {
    this.settingEl = container.createDiv({ cls: "setting-item" });
    this.infoEl = this.settingEl.createDiv({ cls: "setting-item-info" });
    this.nameEl = this.infoEl.createDiv({ cls: "setting-item-name" });
    this.descEl = this.infoEl.createDiv({ cls: "setting-item-description" });
    this.controlEl = this.settingEl.createDiv({ cls: "setting-item-control" });
  }
  setName(name: string | DocumentFragment): this { this.nameEl.setText(name); return this; }
  setDesc(desc: string | DocumentFragment): this { this.descEl.setText(desc); return this; }
  setClass(cls: string): this { this.settingEl.addClass(cls); return this; }
  setHeading(): this { this.settingEl.addClass("setting-item-heading"); return this; }
  setDisabled(disabled: boolean): this { this.settingEl.toggleClass("is-disabled", disabled); return this; }
  addButton(callback: (button: ButtonComponent) => unknown): this { callback(new ButtonComponent(this.controlEl)); return this; }
  addDropdown(callback: (dropdown: DropdownComponent) => unknown): this { callback(new DropdownComponent(this.controlEl)); return this; }
  addText(callback: (text: TextComponent) => unknown): this { callback(new TextComponent(this.controlEl)); return this; }
}

/**
 * The settings tab as Obsidian 1.13+ drives it (app.js 1.14.2): `addSettingTab` calls `update()`,
 * which stores `getSettingDefinitions()` in `settingItems`; the tab then renders those when there
 * are any and falls back to `display()` otherwise. A subclass member named like one of these
 * shadows the base, which is what this mock exists to catch.
 */
export abstract class PluginSettingTab {
  readonly containerEl: HTMLElement;
  settingItems: unknown[] = [];
  constructor(readonly app: App, readonly plugin: unknown) {
    this.containerEl = document.createElement("div");
    this.containerEl.className = "vertical-tab-content";
  }
  getSettingDefinitions(): unknown[] { return []; }
  update(): void { this.settingItems = this.getSettingDefinitions(); }
  getControlValue(key: string): unknown { return this.values[key]; }
  setControlValue(key: string, value: unknown): void | Promise<void> { this.values[key] = value; }
  /** Stand-in for `this.plugin.settings`, which the real default implementations read and write. */
  private readonly values: Record<string, unknown> = {};
  /** What Obsidian 1.13+ does when the tab is shown. */
  renderTab(): void { if (this.settingItems.length === 0) this.display(); }
  abstract display(): void;
  hide(): void { this.containerEl.empty(); }
}

/** Minimal line glyphs so the floating controls stay readable; not Lucide artwork. */
const ICON_PATHS: Record<string, string> = {
  minus: "M5 12h14",
  plus: "M12 5v14M5 12h14",
  scan: "M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2",
  "git-fork": "M12 15v6M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM12 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 9v3a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V9",
  "git-commit-horizontal": "M3 12h6M15 12h6M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  network: "M9 2h6v6H9zM3 16h6v6H3zM15 16h6v6h-6zM12 8v4M6 16v-4h12v4",
  "unfold-horizontal": "M12 22v-6M12 8V2M4 12H2M10 12H8M16 12h-2M22 12h-2M19 15l3-3-3-3M5 9l-3 3 3 3",
  "file-text": "M14 3v4a1 1 0 0 0 1 1h4M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2zM9 13h6M9 17h6",
  "panel-left": "M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM9 3v18",
  pencil: "M17 3l4 4L8 20H4v-4L17 3z",
  text: "M4 6h16M4 12h16M4 18h10",
  "image-plus": "M16 5h6M19 2v6M21 11v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8M3 16l5-5 8 8",
  "corner-down-right": "M15 10l5 5-5 5M4 4v7a4 4 0 0 0 4 4h12",
  "undo-2": "M9 14L4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11",
  "redo-2": "M15 14l5-5-5-5M20 9H9.5a5.5 5.5 0 0 0 0 11H13",
  "list-tree": "M21 12h-8M21 6H8M21 18h-8M3 6v4c0 1.1.9 2 2 2h3M3 10v6c0 1.1.9 2 2 2h3",
};

export function setIcon(parent: HTMLElement, icon: string): void {
  parent.empty();
  const svg = parent.createSvg("svg", { cls: `svg-icon lucide-${icon}`, attr: {
    viewBox: "0 0 24 24", width: "24", height: "24", fill: "none", stroke: "currentColor",
    "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true",
  } });
  const path = ICON_PATHS[icon];
  if (path) svg.createSvg("path", { attr: { d: path } });
  else svg.createSvg("circle", { attr: { cx: "12", cy: "12", r: "4" } });
  parent.dataset.icon = icon;
}

/** The resolver surface the mock renderer needs; the harness app provides it. */
interface RendererApp {
  metadataCache: { getFirstLinkpathDest(linkpath: string, sourcePath: string): ObsidianFile | null };
  vault: { getResourcePath(file: ObsidianFile): string };
}

const IMAGE_EXTENSION = /\.(?:avif|bmp|gif|jpe?g|png|svg|webp)$/iu;

function escapeHtml(text: string): string {
  return text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;");
}

function unescapeHtml(text: string): string {
  return text.replace(/&quot;/gu, "\"").replace(/&gt;/gu, ">").replace(/&lt;/gu, "<").replace(/&amp;/gu, "&");
}

function renderInline(escaped: string, app: RendererApp, sourcePath: string, references: Map<string, string>): string {
  const resolve = (target: string): ObsidianFile | null => app.metadataCache.getFirstLinkpathDest(unescapeHtml(target), sourcePath);
  const externalLink = (href: string, label: string): string =>
    `<a class="external-link" href="${href}" rel="noopener" target="_blank">${label}</a>`;
  // Inline code is literal, as in Obsidian: `![[note]]` in code is text, not an embed.
  const code: string[] = [];
  const withoutCode = escaped.replace(/`([^`]+)`/gu, (_match, text: string) => {
    code.push(`<code>${text}</code>`);
    return `\u0000${code.length - 1}\u0000`;
  });
  return withoutCode
    .replace(/!\[\[([^\]|#]+)(#[^\]|]*)?(?:\|([^\]]*))?\]\]/gu, (_match, target: string, subpath?: string, alias?: string) => {
      const file = resolve(target);
      if (!file && IMAGE_EXTENSION.test(target)) {
        return `<span class="internal-embed image-embed mod-empty" src="${target}">${target}</span>`;
      }
      // A note (or missing) embed stays Obsidian's placeholder span, `src` carrying the link as written; the map post
      // processor decides what becomes of it. Obsidian would load the note into it afterwards; this page does not.
      if (!file || !IMAGE_EXTENSION.test(file.path)) {
        const src = `${target}${subpath ?? ""}`;
        return `<span class="internal-embed${file ? "" : " mod-empty"}" src="${src}" alt="${alias ?? src}">${src}</span>`;
      }
      const size = alias?.match(/^(\d+)(?:x(\d+))?$/u);
      const width = size?.[1] ? ` width="${size[1]}"` : "";
      return `<span class="internal-embed image-embed is-loaded" src="${target}"><img src="${app.vault.getResourcePath(file)}" alt="${alias ?? target}"${width}></span>`;
    })
    .replace(/\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/gu, (_match, target: string, alias?: string) => {
      const path = target.split("#", 1)[0] ?? target;
      const unresolved = path && !resolve(path) ? " is-unresolved" : "";
      return `<a class="internal-link${unresolved}" data-href="${target}" href="${target}" target="_blank" rel="noopener">${alias || target}</a>`;
    })
    .replace(/!\[([^\]]*)\]\(([^\s)]+)(?:\s+&quot;[^&]*&quot;)?\)/gu, (_match, alt: string, source: string) => {
      const file = resolve(source);
      const src = file ? app.vault.getResourcePath(file) : source;
      return `<img src="${src}" alt="${alt}">`;
    })
    .replace(/\[([^\]]+)\]\(([^\s)]+)(?:\s+&quot;[^&]*&quot;)?\)/gu, (_match, label: string, href: string) => externalLink(href, label))
    .replace(/\[([^\]]+)\]\[([^\]]*)\]/gu, (match, label: string, id: string) => {
      const href = references.get((id || label).toLowerCase());
      return href ? externalLink(href, label) : match;
    })
    .replace(/&lt;(https?:\/\/[^&\s]+)&gt;/gu, (_match, href: string) => externalLink(href, href))
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/gu, (_match, lead: string, href: string) => `${lead}${externalLink(href, href)}`)
    .replace(/\*\*([^*]+)\*\*/gu, "<strong>$1</strong>")
    .replace(/==([^=]+)==/gu, "<mark>$1</mark>")
    .replace(/\u0000(\d+)\u0000/gu, (_match, index: string) => code[Number(index)] ?? "");
}

/**
 * Renders the inline subset the node renderer feeds it: titles, wiki links,
 * embeds, Markdown links, autolinks, reference definitions. Prose and code stay
 * plain text. Anything beyond this is Obsidian's job and is verified on device.
 */
export const MarkdownRenderer = {
  render(app: App, markdown: string, element: HTMLElement, sourcePath: string): Promise<void> {
    const renderer = app as unknown as RendererApp;
    const references = new Map<string, string>();
    const paragraphs: string[] = [];
    for (const block of markdown.split(/\n{2,}/u)) {
      const lines = block.split("\n").filter(line => {
        const definition = line.match(/^\s*\[([^\]]+)\]:\s*(\S+)/u);
        if (definition?.[1] && definition[2]) { references.set(definition[1].toLowerCase(), escapeHtml(definition[2])); return false; }
        return true;
      });
      if (lines.length) paragraphs.push(escapeHtml(lines.join("\n")));
    }
    const html = paragraphs.map(paragraph => `<p>${renderInline(paragraph, renderer, sourcePath, references).replace(/\n/gu, "<br>")}</p>`);
    element.insertAdjacentHTML("beforeend", html.join(""));
    return Promise.resolve();
  },
};

/** This page is a desktop browser tab: no Capacitor shell, so the export uses the desktop canvas limits. */
export const Platform = {
  isDesktop: true, isMobile: false, isDesktopApp: false, isMobileApp: false, isIosApp: false, isAndroidApp: false,
  isPhone: false, isTablet: false, isMacOS: false, isWin: false, isLinux: false, isSafari: false,
  resourcePathPrefix: "",
};

/** Same contract as Obsidian's helper; chunked so a large image does not overflow the call stack. */
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

/** Network requests are Obsidian's; the page has no vault-side client, so a remote image stays unread. */
export function requestUrl(): Promise<never> {
  return Promise.reject(new Error("requestUrl はこのページの対象外です（③ 実機で確認）。"));
}
