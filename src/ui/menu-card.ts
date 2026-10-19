import { setIcon } from "obsidian";

/**
 * A row of a menu card: an icon and a title, then one line of description (the gear's card) or, on the right, the key
 * that does the same on the map (the context card; only a key the map really answers, LEV-369), which the card answers
 * too. `keys` names those keys (`aria-keyshortcuts`, `KeyboardEvent.key` values), `cap` is how they are drawn. A
 * disabled row is still reached with the keys and does nothing, so it is found and read.
 */
export interface MenuCardItem {
  type: "item";
  title: string;
  icon: string;
  description?: string;
  key?: { cap: string; keys: string };
  /** Drawn in the error colour: the row deletes. */
  danger?: boolean;
  enabled?: boolean;
  run: () => void;
}

/** One colour of a row of them: its name (the tooltip and what a screen reader says), the value it draws, and whether the node has it now. */
export interface MenuCardSwatch {
  label: string;
  /** `data-mappy-color` of the circle, which the sheet fills as the map fills a node of that colour; null for none. */
  color: string | null;
  checked: boolean;
  run: () => void;
}

export type MenuCardRow = MenuCardItem | { type: "swatches"; label: string; swatches: readonly MenuCardSwatch[] } | { type: "separator" };

/**
 * Why a card went, for its owner to say where the focus goes: `escape`, `choose` (a row or a colour; it runs after the
 * close), `inside` (a press outside the card but inside `within`, the map's view), `outside` (a press anywhere else),
 * `focus` (the focus taken outside the card), `window` (the window lost the focus), `owner` (`close` from outside).
 */
export type MenuCardClose = "escape" | "choose" | "inside" | "outside" | "focus" | "window" | "owner";

export interface MenuCardOptions {
  /** The card's accessible name. */
  label: string;
  /** A class beside `mappy-popover`, for the sheet. */
  className?: string;
  rows: readonly MenuCardRow[];
  /** The control that toggles the card (the gear): its press is its click's to judge, and taking the focus does not close it. */
  anchor?: HTMLElement;
  /** Where a press closes the card as `inside`. */
  within: HTMLElement;
  closed: (reason: MenuCardClose) => void;
}

/**
 * A card of the map's own (§5 M3, LEV-369): the gear's 操作 and the context menu of a node, of a called map's node and
 * of the empty canvas. It is an element in `parent` (the view's), in that window's document — a popout's map shows it
 * in the popout — and drawn by the plugin's sheet, so it looks the same whether Obsidian's menus are the OS's or not
 * (1.14.4 on macOS draws `Menu` natively, where a row of coloured circles cannot be drawn).
 *
 * Its rows are stops, top to bottom: a row of items is one stop each, a row of colours is one stop whose circles are
 * cells. Keys, on the card: ↑↓ and Tab／Shift+Tab move between stops, wrapping (Home／End: the first and the last);
 * entering a row of colours lands on the checked one (the first when none is); ←→ move along that row, wrapping;
 * Enter／Space run the focused row or colour; a row's own key runs that row; Escape closes. The card goes, and says why (`MenuCardClose`), on any
 * of those, on a press outside it, when the focus leaves it (a known destination at once; a blur with no successor a
 * tick later, unless the focus came back), and when its window loses the focus. The keys live on the focus, so a card
 * left open without it would have no Escape.
 */
export class MenuCard {
  readonly element: HTMLDivElement;
  /** The stops, top to bottom, each its focusable elements: one for an item, the circles for a row of colours. */
  private readonly stops: HTMLButtonElement[][] = [];
  /** The rows by the keys they show (`MenuCardItem.key`): pressed on the card, a key runs its row. */
  private readonly shortcuts = new Map<string, HTMLButtonElement>();
  private open = true;
  private readonly release: () => void;

  constructor(parent: HTMLElement, private readonly options: MenuCardOptions) {
    const doc = parent.doc;
    const win = parent.win;
    const element = parent.createDiv({ cls: ["mappy-popover", ...(options.className ? [options.className] : [])], attr: { role: "menu", "aria-label": options.label } });
    this.element = element;
    for (const row of options.rows) {
      if (row.type === "separator") element.createDiv({ cls: "mappy-popover-separator", attr: { role: "separator" } });
      else if (row.type === "item") this.stops.push([this.item(row)]);
      else this.stops.push(this.swatches(row.label, row.swatches));
    }
    element.addEventListener("keydown", event => { if (this.key(event)) { event.preventDefault(); event.stopPropagation(); } });
    // A press on the card's own padding would move the focus to the body and take the keys with it.
    element.addEventListener("mousedown", event => {
      const target = event.targetNode;
      if (!target?.instanceOf(Element) || !target.closest("button")) event.preventDefault();
    });
    // The card is the menu: no other opens over it.
    element.addEventListener("contextmenu", event => { event.preventDefault(); });
    element.addEventListener("focusout", event => {
      const next = event.relatedTarget as Node | null;
      if (next && (element.contains(next) || options.anchor?.contains(next))) return;
      if (next) { this.close("focus"); return; }
      // No successor (a touch on nothing focusable, the window): judged once a press on the anchor has had its click
      // and a focus that merely returned (the window's) has shown itself.
      win.setTimeout(() => { if (this.open && !element.contains(doc.activeElement)) this.close("focus"); }, 0);
    });
    // The press outside, at the capture phase so no pane can swallow it; a press on the anchor is left to its click, which toggles.
    const outside = (event: PointerEvent): void => {
      const target = event.targetNode;
      if (!target || element.contains(target) || options.anchor?.contains(target)) return;
      this.close(options.within.contains(target) ? "inside" : "outside");
    };
    // The window losing the focus to another window (or app): a press there lands in another document, which has no
    // listener, and the focus stays on the card as far as this document can tell.
    const blurred = (): void => { this.close("window"); };
    doc.addEventListener("pointerdown", outside, true);
    win.addEventListener("blur", blurred);
    this.release = () => {
      doc.removeEventListener("pointerdown", outside, true);
      win.removeEventListener("blur", blurred);
    };
  }

  get isOpen(): boolean { return this.open; }

  /** The first stop takes the focus (the checked colour of a row of them). */
  focusFirst(): void { this.enter(0); }

  /** Takes the card down and tells the owner why; nothing happens on a card already closed. */
  close(reason: MenuCardClose): void {
    if (!this.open) return;
    this.open = false;
    this.release();
    this.element.remove();
    this.options.closed(reason);
  }

  private item(row: MenuCardItem): HTMLButtonElement {
    const enabled = row.enabled ?? true;
    const item = this.element.createEl("button", { cls: "mappy-popover-item", attr: { type: "button", role: "menuitem", tabindex: "-1" } });
    if (row.danger) item.addClass("mod-warning");
    setIcon(item.createSpan({ cls: "mappy-popover-icon" }), row.icon);
    const text = item.createSpan({ cls: "mappy-popover-text" });
    text.createSpan({ cls: "mappy-popover-title", text: row.title });
    if (row.description !== undefined) text.createSpan({ cls: "mappy-popover-description", text: row.description });
    if (row.key) {
      item.setAttribute("aria-keyshortcuts", row.key.keys);
      for (const key of row.key.keys.split(" ")) this.shortcuts.set(key, item);
      item.createSpan({ cls: "mappy-popover-key", text: row.key.cap, attr: { "aria-hidden": "true" } });
    }
    if (!enabled) { item.addClass("is-disabled"); item.setAttribute("aria-disabled", "true"); }
    item.addEventListener("click", () => {
      // Closing takes the card down; a second activation from the same press (Enter's native click) finds it gone and does nothing.
      if (!enabled || !this.open) return;
      this.close("choose");
      row.run();
    });
    return item;
  }

  /** A row of colours: a group of circles, each a radio item named by its colour, the node's own checked. */
  private swatches(label: string, swatches: readonly MenuCardSwatch[]): HTMLButtonElement[] {
    const group = this.element.createDiv({ cls: "mappy-swatches", attr: { role: "group", "aria-label": label } });
    group.createDiv({ cls: "mappy-swatches-label", text: label, attr: { "aria-hidden": "true" } });
    const circles = group.createDiv({ cls: "mappy-swatches-row" });
    return swatches.map(swatch => {
      const circle = circles.createEl("button", { cls: "mappy-swatch", attr: {
        type: "button", role: "menuitemradio", tabindex: "-1", "aria-label": swatch.label, "aria-checked": String(swatch.checked),
        "data-tooltip-position": "top",
      } });
      circle.createSpan({ cls: "mappy-swatch-fill", attr: swatch.color === null ? { "data-mappy-none": "" } : { "data-mappy-color": swatch.color } });
      if (swatch.checked) circle.addClass("is-checked");
      circle.addEventListener("click", () => {
        if (!this.open) return;
        this.close("choose");
        swatch.run();
      });
      return circle;
    });
  }

  /** Where the focus is: its stop and cell, or null outside the card. */
  private at(): [number, number] | null {
    const active = this.element.doc.activeElement;
    for (const [stop, cells] of this.stops.entries()) {
      const cell = cells.findIndex(candidate => candidate === active);
      if (cell >= 0) return [stop, cell];
    }
    return null;
  }

  /** Focus stop `index` (wrapping): its only element, or the checked circle of a row of colours (the first when none is). */
  private enter(index: number): void {
    const count = this.stops.length;
    const cells = this.stops[((index % count) + count) % count];
    (cells?.find(cell => cell.hasClass("is-checked")) ?? cells?.[0])?.focus({ preventScroll: true });
  }

  /** Acts on a key pressed on the card; true when it did. */
  private key(event: KeyboardEvent): boolean {
    const at = this.at();
    const previous = at ? at[0] - 1 : this.stops.length - 1;
    const next = at ? at[0] + 1 : 0;
    switch (event.key) {
      case "ArrowDown": this.enter(next); return true;
      case "ArrowUp": this.enter(previous); return true;
      case "Home": this.enter(0); return true;
      case "End": this.enter(this.stops.length - 1); return true;
      case "Tab": this.enter(event.shiftKey ? previous : next); return true;
      case "ArrowLeft": case "ArrowRight": {
        const cells = at ? this.stops[at[0]] : undefined;
        if (!at || !cells || cells.length < 2) return false;
        const step = event.key === "ArrowRight" ? 1 : -1;
        cells[(at[1] + step + cells.length) % cells.length]?.focus({ preventScroll: true });
        return true;
      }
      case "Enter": case " ": if (at) this.stops[at[0]]?.[at[1]]?.click(); return true;
      case "Escape": this.close("escape"); return true;
      default: {
        const row = event.metaKey || event.ctrlKey || event.altKey ? undefined : this.shortcuts.get(event.key);
        row?.click();
        return row !== undefined;
      }
    }
  }
}
