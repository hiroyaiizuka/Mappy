import { MarkdownView, Notice, Plugin, TFile } from "obsidian";
import { DocumentStore } from "./obsidian/document-store";
import { MindmapView, VIEW_TYPE } from "./ui/mindmap-view";

export default class MappyPlugin extends Plugin {
  onload(): void {
    const store = new DocumentStore(this.app);
    this.registerView(VIEW_TYPE, leaf => new MindmapView(leaf, store));
    this.addCommand({
      id: "open-mindmap", name: "マインドマップを開く",
      checkCallback: checking => {
        const file = this.activeFile();
        if (!file) return false;
        if (!checking) this.open(file, false);
        return true;
      },
    });
    this.addCommand({
      id: "open-mindmap-split", name: "マインドマップと Markdown を並べる",
      checkCallback: checking => {
        const file = this.activeFile();
        if (!file) return false;
        if (!checking) this.open(file, true);
        return true;
      },
    });
    this.addCommand({
      id: "convert-to-list", name: "現在のマップをリスト形式に変更",
      checkCallback: checking => {
        const map = this.app.workspace.getActiveViewOfType(MindmapView);
        if (!map?.file) return false;
        if (!checking) void map.convertToList().catch(error => {
          new Notice(error instanceof Error ? error.message : "形式を変更できませんでした。");
        });
        return true;
      },
    });
    this.addRibbonIcon("git-fork", "マインドマップを開く", () => {
      const file = this.activeFile();
      if (file) this.open(file, false); else new Notice("Markdown ノートを開いてください。");
    });
    this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => {
      if (!(file instanceof TFile) || file.extension !== "md") return;
      menu.addItem(item => item.setTitle("マインドマップを開く").setIcon("git-fork")
        .onClick(() => { this.open(file, false); }));
    }));
  }

  private activeFile(): TFile | null {
    const map = this.app.workspace.getActiveViewOfType(MindmapView);
    const file = map?.file ?? this.app.workspace.getActiveViewOfType(MarkdownView)?.file ?? this.app.workspace.getActiveFile();
    return file?.extension === "md" ? file : null;
  }

  private open(file: TFile, split: boolean): void {
    const workspace = this.app.workspace;
    const map = workspace.getActiveViewOfType(MindmapView);
    if (split && map?.file === file) {
      void map.showSource(true).catch(error => { new Notice(error instanceof Error ? error.message : "Markdown を開けませんでした。"); });
      return;
    }
    const current = workspace.getActiveViewOfType(MarkdownView)?.leaf ?? workspace.getLeaf(false);
    const leaf = split ? workspace.createLeafBySplit(current, "vertical", true) : current;
    void leaf.setViewState({ type: VIEW_TYPE, state: { file: file.path }, active: true }).catch(error => {
      new Notice(error instanceof Error ? error.message : "マップを開けませんでした。");
    });
  }
}
