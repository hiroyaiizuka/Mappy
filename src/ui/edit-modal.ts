import { Modal, Setting, type App } from "obsidian";
import { REFRESHED_MESSAGE } from "./inline-editor";

/** Keep the draft open when a concurrent edit prevents saving. */
export class EditModal extends Modal {
  private error: HTMLDivElement | undefined;

  constructor(
    app: App,
    private readonly initial: string,
    private readonly titleText: string,
    private readonly multiline: boolean,
    private readonly submit: (text: string) => Promise<void>,
  ) { super(app); }

  onOpen(): void {
    this.setTitle(this.titleText);
    this.contentEl.addClass("mappy-edit-modal");
    const input = this.multiline
      ? this.contentEl.createEl("textarea", { cls: "mappy-edit-input", attr: { rows: "14", "aria-label": this.titleText } })
      : this.contentEl.createEl("input", { cls: "mappy-edit-input", type: "text", attr: { "aria-label": this.titleText } });
    input.value = this.initial;
    const error = this.contentEl.createDiv({ cls: "mappy-edit-error", attr: { role: "alert" } });
    this.error = error;
    let busy = false;
    const save = async (): Promise<void> => {
      if (busy) return;
      busy = true;
      try {
        await this.submit(input.value);
        this.close();
      } catch (reason) {
        error.setText(reason instanceof Error ? reason.message : "保存できませんでした。");
      } finally { busy = false; }
    };
    new Setting(this.contentEl)
      .addButton(button => button.setButtonText("キャンセル").onClick(() => this.close()))
      .addButton(button => button.setButtonText("保存").setCta().onClick(() => { void save(); }));
    let composing = false;
    input.addEventListener("compositionstart", () => { composing = true; });
    input.addEventListener("compositionend", () => { composing = false; });
    const keyboardTarget: HTMLElement = input;
    keyboardTarget.addEventListener("keydown", event => {
      if (event.isComposing || composing) return;
      if (event.key === "Enter" && (!this.multiline || event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        void save();
      }
    });
    input.focus();
    if (!this.multiline) input.select();
  }

  /** The map re-parsed under a draft kept by `stale` (the store's conflict line): the same save now applies to the new note. */
  refreshed(stale: string): void {
    if (this.error?.textContent === stale) this.error.setText(REFRESHED_MESSAGE);
  }

  onClose(): void { this.error = undefined; this.contentEl.empty(); }
}
