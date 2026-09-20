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

/** Edit at the node position; a failed save keeps the draft and error visible. */
export class InlineEditor {
  private readonly input: HTMLTextAreaElement;
  private readonly error: HTMLDivElement;
  private busy = false;
  private composing = false;
  private blurAfterComposition = false;
  private compositionBlurTimer: number | undefined;
  private disposed = false;
  private readonly suggestion: InlineSuggestion | undefined;

  constructor(private readonly host: HTMLElement, private readonly options: InlineEditorOptions) {
    host.addClass("is-editing");
    // About ten characters wide; longer text wraps onto more rows instead of widening the node.
    this.input = host.createEl("textarea", {
      cls: "mappy-inline-input", attr: { rows: "1", cols: "10", "aria-label": "ノードのテキスト" },
    });
    this.input.value = options.initial;
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

  private resize(): void {
    this.input.style.removeProperty("height");
    this.input.style.height = `${Math.max(26, this.input.scrollHeight)}px`;
    this.options.resize();
  }

  private async commit(next: "none" | "child"): Promise<void> {
    if (this.busy || this.disposed) return;
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
   * so a refused save is thrown to the caller instead of shown in place. A save already under way, or a
   * disposed editor, has nothing to do.
   */
  async flush(): Promise<void> {
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
