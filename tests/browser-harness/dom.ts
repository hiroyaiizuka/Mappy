/**
 * The subset of Obsidian's global DOM helpers that the product UI calls
 * (`createDiv`, `addClass`, `event.targetNode`, `node.win`, ...). Obsidian
 * installs these on the prototypes at startup; this page does the same so
 * `src/ui` runs unchanged. Only members used by `src/` are implemented.
 */

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

function classList(value: string | string[] | undefined): string[] {
  if (!value) return [];
  return (Array.isArray(value) ? value : value.split(" ")).filter(Boolean);
}

function applyInfo(element: Element, info: DomElementInfo | SvgElementInfo | undefined, parent: Node): void {
  const classes = classList(info?.cls);
  if (classes.length) element.classList.add(...classes);
  for (const [name, value] of Object.entries(info?.attr ?? {})) {
    if (value !== null) element.setAttribute(name, String(value));
  }
  if (info && "text" in info && info.text !== undefined) {
    if (typeof info.text === "string") element.textContent = info.text;
    else element.replaceChildren(info.text);
  }
  if (info && "title" in info && info.title !== undefined) element.setAttribute("title", info.title);
  if (info && "type" in info && info.type !== undefined) element.setAttribute("type", info.type);
  if (info && "placeholder" in info && info.placeholder !== undefined) element.setAttribute("placeholder", info.placeholder);
  if (info && "href" in info && info.href !== undefined) element.setAttribute("href", info.href);
  if (info && "value" in info && info.value !== undefined && "value" in element) {
    (element as HTMLInputElement).value = info.value;
  }
  const target = info?.parent ?? parent;
  if (info?.prepend) target.insertBefore(element, target.firstChild);
  else target.appendChild(element);
}

let installed = false;

/** Idempotent; the page calls it once before any product module touches the DOM. */
export function installObsidianDom(): void {
  if (installed) return;
  installed = true;
  const nodeMethods: Partial<Node> & ThisType<Node> = {
    createEl(tag, options, callback) {
      const element = document.createElement(tag);
      applyInfo(element, typeof options === "string" ? { cls: options } : options, this);
      callback?.(element);
      return element;
    },
    createDiv(options, callback) { return this.createEl("div", options, callback); },
    createSpan(options, callback) { return this.createEl("span", options, callback); },
    createSvg(tag, options, callback) {
      const element = document.createElementNS(SVG_NAMESPACE, tag);
      applyInfo(element, typeof options === "string" ? { cls: options } : options, this);
      callback?.(element);
      return element;
    },
    empty() { while (this.lastChild) this.removeChild(this.lastChild); },
    appendText(value) { this.appendChild(document.createTextNode(value)); },
    detach() { this.parentNode?.removeChild(this); },
    instanceOf<T>(type: new () => T): this is T { return this instanceof type; },
  };
  for (const [name, value] of Object.entries(nodeMethods)) {
    Object.defineProperty(Node.prototype, name, { value, configurable: true, writable: true });
  }
  // The window-level creators make detached elements (no parent to append to).
  const globalCreators = {
    createEl<K extends keyof HTMLElementTagNameMap>(tag: K, options?: DomElementInfo | string, callback?: (el: HTMLElementTagNameMap[K]) => void): HTMLElementTagNameMap[K] {
      const element = document.createElement(tag);
      const info = typeof options === "string" ? { cls: options } : options;
      applyInfo(element, info, document.createDocumentFragment());
      element.remove();
      callback?.(element);
      return element;
    },
    createDiv(options?: DomElementInfo | string, callback?: (el: HTMLDivElement) => void): HTMLDivElement {
      return globalCreators.createEl("div", options, callback);
    },
    createSpan(options?: DomElementInfo | string, callback?: (el: HTMLSpanElement) => void): HTMLSpanElement {
      return globalCreators.createEl("span", options, callback);
    },
  };
  // vitest's jsdom copies window keys onto Node's global once at setup, so both need the creators.
  for (const target of new Set<object>([window, globalThis])) {
    for (const [name, value] of Object.entries(globalCreators)) {
      Object.defineProperty(target, name, { value, configurable: true, writable: true });
    }
  }
  Object.defineProperty(Node.prototype, "win", {
    configurable: true,
    get(this: Node): Window { return (this.ownerDocument ?? document).defaultView ?? window; },
  });
  Object.defineProperty(Node.prototype, "doc", {
    configurable: true,
    get(this: Node): Document { return this.ownerDocument ?? document; },
  });
  const elementMethods: Partial<Element> & ThisType<Element> = {
    setText(value) {
      if (typeof value === "string") this.textContent = value;
      else this.replaceChildren(value);
    },
    getText() { return this.textContent ?? ""; },
    addClass(...classes) { this.classList.add(...classes.flatMap(classList)); },
    removeClass(...classes) { this.classList.remove(...classes.flatMap(classList)); },
    toggleClass(classes, value) { for (const name of classList(classes)) this.classList.toggle(name, value); },
    hasClass(name) { return this.classList.contains(name); },
    setAttr(name, value) { if (value === null) this.removeAttribute(name); else this.setAttribute(name, String(value)); },
    getAttr(name) { return this.getAttribute(name); },
  };
  for (const [name, value] of Object.entries(elementMethods)) {
    Object.defineProperty(Element.prototype, name, { value, configurable: true, writable: true });
  }
  // Obsidian also exposes creation as globals: detached unless `parent` is given (`createEl("canvas")` for scratch elements).
  const detachedEl = (tag: string, options?: DomElementInfo | string, callback?: (element: HTMLElement) => void): HTMLElement => {
    const element = document.createElement(tag);
    const info = typeof options === "string" ? { cls: options } : options;
    applyInfo(element, info, document.createDocumentFragment());
    if (!info?.parent) element.remove();
    callback?.(element);
    return element;
  };
  const globalHelpers: Record<string, unknown> = {
    createEl: detachedEl,
    createDiv: (options?: DomElementInfo | string, callback?: (element: HTMLElement) => void) => detachedEl("div", options, callback),
    createSpan: (options?: DomElementInfo | string, callback?: (element: HTMLElement) => void) => detachedEl("span", options, callback),
    createFragment: (callback?: (fragment: DocumentFragment) => void): DocumentFragment => {
      const fragment = document.createDocumentFragment();
      callback?.(fragment);
      return fragment;
    },
  };
  for (const [name, value] of Object.entries(globalHelpers)) {
    Object.defineProperty(window, name, { value, configurable: true, writable: true });
  }
  Object.defineProperty(UIEvent.prototype, "targetNode", {
    configurable: true,
    get(this: UIEvent): Node | null { return this.target instanceof Node ? this.target : null; },
  });
  Object.defineProperty(UIEvent.prototype, "win", { configurable: true, get(): Window { return window; } });
  Object.defineProperty(UIEvent.prototype, "doc", { configurable: true, get(): Document { return document; } });
  Object.defineProperty(UIEvent.prototype, "instanceOf", {
    configurable: true, writable: true,
    value(this: UIEvent, type: new (...data: unknown[]) => unknown): boolean { return this instanceof type; },
  });
}
