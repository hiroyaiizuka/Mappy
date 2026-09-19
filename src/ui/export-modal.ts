import { Modal, Setting, type App } from "obsidian";
import type { ExportFormat } from "../obsidian/image-export";

/** One command, two formats (§5 M13): the choice is made here, the export runs after the modal closes. */
export class ExportModal extends Modal {
  constructor(
    app: App,
    private readonly canRasterize: boolean,
    private readonly choose: (format: ExportFormat) => void,
  ) { super(app); }

  onOpen(): void {
    this.setTitle("SVG／PNG に書き出し");
    this.contentEl.addClass("mappy-export-modal");
    this.contentEl.createEl("p", { text: "現在のレイアウトと折りたたみを、いまのテーマの見た目で添付ファイルの保存先に保存します。元のノートは変更しません。" });
    this.contentEl.createEl("p", { cls: "mappy-export-note", text: "フォントは埋め込まないため、文字の幅と折り返しは閲覧環境のフォントに依存します。" });
    if (!this.canRasterize) this.contentEl.createEl("p", { cls: "mappy-export-note", text: "この環境では PNG を作れないため、SVG だけを書き出せます。" });
    const pick = (format: ExportFormat): void => { this.close(); this.choose(format); };
    new Setting(this.contentEl)
      .setName("形式")
      .addButton(button => button.setButtonText("SVG").setCta().onClick(() => { pick("svg"); }))
      .addButton(button => button.setButtonText("PNG").setDisabled(!this.canRasterize).onClick(() => { pick("png"); }));
  }

  onClose(): void { this.contentEl.empty(); }
}
