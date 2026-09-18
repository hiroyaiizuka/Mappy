/**
 * Browser stand-in for the `obsidian` module, the counterpart of
 * `tests/mocks/obsidian.ts` for a real DOM. The esbuild alias points `obsidian`
 * here, so `src/ui`, `src/obsidian/document-store.ts` and `src/obsidian/frontmatter.ts`
 * run unchanged. Everything below is a mock: Markdown rendering, link
 * resolution, notices and menus approximate Obsidian's DOM, they do not prove it.
 */
import type { App, EventRef, TFile as ObsidianFile, ViewState } from "obsidian";

export { TFile, normalizePath } from "../../tests/mocks/obsidian-file";

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
}

/** Minimal line glyphs so the floating controls stay readable; not Lucide artwork. */
const ICON_PATHS: Record<string, string> = {
  minus: "M5 12h14",
  plus: "M12 5v14M5 12h14",
  scan: "M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2",
  "git-fork": "M12 15v6M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM12 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 9v3a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V9",
  "git-commit-horizontal": "M3 12h6M15 12h6M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  network: "M9 2h6v6H9zM3 16h6v6H3zM15 16h6v6h-6zM12 8v4M6 16v-4h12v4",
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
  return escaped
    .replace(/!\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/gu, (_match, target: string, alias?: string) => {
      const file = resolve(target);
      if (!file || !IMAGE_EXTENSION.test(file.path)) {
        return `<span class="internal-embed image-embed mod-empty" src="${target}">${target}</span>`;
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
    .replace(/`([^`]+)`/gu, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/gu, "<strong>$1</strong>")
    .replace(/==([^=]+)==/gu, "<mark>$1</mark>");
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
