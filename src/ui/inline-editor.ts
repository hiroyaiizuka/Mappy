export interface InlineSuggestion {
  handleKey: (event: KeyboardEvent) => boolean;
  dispose: () => void;
}

export interface InlineEditorOptions {
  initial: string;
  save: (text: string) => Promise<void>;
  finish: (next: "none" | "child", cancelled: boolean) => void;
  resize: () => void;
  restore: () => void;
  suggest?: (input: HTMLTextAreaElement) => InlineSuggestion;
}

/** Shown in place of a conflict line once the map has re-read the note: the same Enter now applies the draft to it. */
export const REFRESHED_MESSAGE = "Markdown が更新されました。もう一度確定すると新しい内容に適用し、取り消すと閉じます。";

/** Pixels past the measured text width: scrollWidth is rounded, and a row that fits must not wrap on a fraction. */
const CARET_ALLOWANCE = 2;

/** Edit at the node position; a failed save keeps the draft and error visible. */
export class InlineEditor {
  private readonly input: HTMLTextAreaElement;
  private readonly error: HTMLDivElement;
  private busy = false;
  /** The save under way (`commit`), for a `flush` that must wait for it. */
  private pending: Promise<void> | undefined;
  private composing = false;
  private blurAfterComposition = false;
  private compositionBlurTimer: number | undefined;
  private disposed = false;
  private readonly suggestion: InlineSuggestion | undefined;
  /** Whether the stylesheet sizes the draft to its text (`field-sizing: content`); if not, `measure` does. */
  private readonly sizesItself: boolean;

  constructor(private readonly host: HTMLElement, private readonly options: InlineEditorOptions) {
    host.addClass("is-editing");
    // One row that widens with the text up to the node's wrap width (CSS max-width), then more rows (`resize`).
    this.input = host.createEl("textarea", {
      cls: "mappy-inline-input", attr: { rows: "1", "aria-label": "ノードのテキスト" },
    });
    this.input.value = options.initial;
    this.sizesItself = this.input.ownerDocument.defaultView?.CSS?.supports?.("field-sizing", "content") === true;
    this.suggestion = options.suggest?.(this.input);
    this.error = host.createDiv({ cls: "mappy-inline-error", attr: { role: "alert" } });
    this.input.addEventListener("compositionstart", () => { this.composing = true; });
    this.input.addEventListener("compositionend", () => {
      this.composing = false;
      this.resize();
      if (!this.blurAfterComposition) return;
      this.blurAfterComposition = false;
      // Some browsers deliver the final input event after compositionend.
      this.compositionBlurTimer = this.input.ownerDocument.defaultView?.setTimeout(() => {
        this.compositionBlurTimer = undefined;
        if (!this.disposed && !this.composing && this.input.ownerDocument.activeElement !== this.input
          && !this.error.textContent) void this.commit("none");
      }, 0);
    });
    this.input.addEventListener("input", () => { this.resize(); });
    this.input.addEventListener("pointerdown", event => { event.stopPropagation(); });
    this.input.addEventListener("click", event => { event.stopPropagation(); });
    this.input.addEventListener("dblclick", event => { event.stopPropagation(); });
    this.input.addEventListener("keydown", event => {
      event.stopPropagation();
      if (event.isComposing || this.composing || event.key === "Process") return;
      if (this.suggestion?.handleKey(event)) return;
      if (event.key === "Escape") {
        event.preventDefault();
        this.dispose();
        this.options.finish("none", true);
      } else if (event.key === "Enter" && event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
        // A line break inside the node (LEV-202), as XMind's Shift+Enter: the textarea's own insertion, which its
        // Undo knows. The save writes it as `<br>` in the title's one line (core/title-breaks).
        return;
      } else if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        void this.commit(event.key === "Tab" ? "child" : "none");
      }
    });
    this.input.addEventListener("blur", () => {
      if (this.composing) { this.blurAfterComposition = true; return; }
      // Keep an invalid/conflicted draft available instead of repeatedly saving on blur.
      if (!this.disposed && !this.error.textContent) void this.commit("none");
    });
    this.resize();
    this.input.focus({ preventScroll: true });
    this.input.select();
  }

  /**
   * The draft is one row as wide as its text up to the width a confirmed label wraps at, then more rows (LEV-198).
   * The stylesheet does that with `field-sizing: content`; without it (older WebKit) the box is measured here.
   * Either way the map lays out again for the node's new size.
   */
  private resize(): void {
    if (!this.sizesItself) this.measure();
    this.options.resize();
  }

  /**
   * Width first: the text's width on one row (measured unwrapped), which the CSS max-width caps. The height then
   * follows the rows, never under the 26px the stylesheet's min-height gives the other path. The width follows the
   * IME's composition too, as `field-sizing` does: a draft typed in kana stays one row as it grows.
   */
  private measure(): void {
    const measured = this.input.style.width;
    // `is-measuring` lays the text out on one row in a box of no width, so scrollWidth is the text's own width.
    this.input.style.removeProperty("width");
    this.input.classList.add("is-measuring");
    const natural = this.input.scrollWidth;
    this.input.classList.remove("is-measuring");
    // A laid-out empty draft reads 1 (the class's padding). 0 means no layout (a hidden pane): nothing can be read,
    // so the box keeps what it had, and the view's onResize measures once the pane has a layout.
    if (natural === 0) {
      if (measured) this.input.style.width = measured;
      return;
    }
    this.input.style.width = `${natural + CARET_ALLOWANCE}px`;
    this.input.style.removeProperty("height");
    this.input.style.height = `${Math.max(26, this.input.scrollHeight)}px`;
  }

  /**
   * Measure the draft again because the node or the pane changed under it: a redraw (an external change, a layout
   * switch) can make it a root or a first-level node, whose bolder text is wider than the width measured before, and
   * a pane that had no layout has one now. Only the measuring fallback holds a width that can go stale.
   */
  fit(unmeasuredOnly = false): void {
    // The callers (draw, onResize) lay the map out themselves. A resize changes neither the text nor the node's
    // style, so it only has to measure a draft that has never been measured (opened in a hidden pane).
    if (this.disposed || this.sizesItself || (unmeasuredOnly && this.input.style.width)) return;
    this.measure();
  }

  /**
   * Save the draft the way Enter does — a refusal keeps the draft with its reason on the error line — and
   * answer whether the editor closed. A caller that must write its own edit against the note this draft
   * leaves behind (`MindmapView.execute`) uses it instead of refusing outright (LEV-140), and stops when
   * the answer is false: the reason is already on screen where the user is typing.
   */
  async confirm(): Promise<boolean> {
    if (this.pending) await this.pending;
    if (this.disposed) return true;
    await this.commit("none");
    return this.disposed;
  }

  private commit(next: "none" | "child"): Promise<void> {
    if (this.busy || this.disposed) return Promise.resolve();
    const task = this.settle(next).finally(() => { if (this.pending === task) this.pending = undefined; });
    this.pending = task;
    return task;
  }

  /** One save: the editor closes on success, keeps the draft with the error on refusal. */
  private async settle(next: "none" | "child"): Promise<void> {
    this.busy = true;
    this.input.readOnly = true;
    try {
      await this.options.save(this.input.value);
      if (this.disposed) return;
      this.dispose();
      this.options.finish(next, false);
    } catch (error) {
      if (this.disposed) return;
      this.error.setText(error instanceof Error ? error.message : "保存できませんでした。");
      this.input.focus({ preventScroll: true });
    } finally {
      this.busy = false;
      this.input.readOnly = false;
    }
  }

  /**
   * Save the draft because the view is leaving the note under it (a navigation into this leaf: a link, the
   * explorer, back／forward — LEV-74), the way a Markdown tab keeps its buffer. The draft is not kept afterwards,
   * so a refused save is thrown to the caller instead of shown in place. A save already under way (the blur of
   * the click that navigates commits first) is waited for: it either closes the editor, or keeps the draft with
   * its error, which is then saved here or refused to the caller. A disposed editor has nothing to do.
   */
  async flush(): Promise<void> {
    if (this.pending) await this.pending;
    if (this.busy || this.disposed) return;
    this.busy = true;
    this.input.readOnly = true;
    try {
      await this.options.save(this.input.value);
      if (this.disposed) return;
      this.dispose();
      this.options.finish("none", false);
    } finally {
      this.busy = false;
      this.input.readOnly = false;
    }
  }

  /**
   * Whether the draft is held with a reason on its error line (a refusal, a conflict, the map re-read under it):
   * only Enter saves it then, as blur does not (LEV-202: a double click elsewhere must not either).
   */
  held(): boolean {
    return !this.disposed && Boolean(this.error.textContent);
  }

  /** Bring the keyboard back to a held draft another edit was asked for over. */
  focus(): void {
    if (!this.disposed) this.input.focus({ preventScroll: true });
  }

  /** The map re-parsed under a draft kept by `stale` (the store's conflict line), which would still tell the user to wait for that. */
  refreshed(stale: string): void {
    if (this.disposed || this.error.textContent !== stale) return;
    this.error.setText(REFRESHED_MESSAGE);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.compositionBlurTimer !== undefined) this.input.ownerDocument.defaultView?.clearTimeout(this.compositionBlurTimer);
    this.suggestion?.dispose();
    this.input.remove();
    this.error.remove();
    this.host.removeClass("is-editing");
    this.options.restore();
  }
}
