import { Modal, Setting, type App } from "obsidian";
import type { ExportFormat } from "../obsidian/image-export";
import { t } from "../i18n";

/** One command, two formats (§5 M13): the choice is made here, the export runs after the modal closes. */
export class ExportModal extends Modal {
  constructor(
    app: App,
    private readonly canRasterize: boolean,
    private readonly choose: (format: ExportFormat) => void,
  ) { super(app); }

  onOpen(): void {
    this.setTitle(t().exportTitle);
    this.contentEl.addClass("mappy-export-modal");
    this.contentEl.createEl("p", { text: t().exportLead });
    this.contentEl.createEl("p", { cls: "mappy-export-note", text: t().exportFontNote });
    if (!this.canRasterize) this.contentEl.createEl("p", { cls: "mappy-export-note", text: t().exportSvgOnly });
    const pick = (format: ExportFormat): void => { this.close(); this.choose(format); };
    new Setting(this.contentEl)
      .setName(t().exportFormat)
      .addButton(button => button.setButtonText("SVG").setCta().onClick(() => { pick("svg"); }))
      .addButton(button => button.setButtonText("PNG").setDisabled(!this.canRasterize).onClick(() => { pick("png"); }));
  }

  onClose(): void { this.contentEl.empty(); }
}
