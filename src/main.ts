import { MarkdownView, Notice, Plugin, TFile, type WorkspaceLeaf } from "obsidian";
import { DocumentStore } from "./obsidian/document-store";
import { ExcalidrawBridge } from "./obsidian/excalidraw-bridge";
import { readMapLayout, writeMapLayout } from "./obsidian/frontmatter";
import { ViewRouter } from "./obsidian/view-routing";
import { MindmapView, VIEW_TYPE } from "./ui/mindmap-view";

export default class MappyPlugin extends Plugin {
  private router!: ViewRouter;
  private bridge!: ExcalidrawBridge;

  onload(): void {
    const store = new DocumentStore(this.app);
    this.router = new ViewRouter({
      mapViewType: VIEW_TYPE,
      isMapFile: path => {
        const file = this.app.vault.getFileByPath(path);
        return file !== null && file.extension === "md" && readMapLayout(this.app, file) !== null;
      },
    });
    this.register(this.router.install());
    this.bridge = new ExcalidrawBridge(this.app, store, undefined, message => { new Notice(message); });
    this.register(() => { this.bridge.dispose(); });
    // Excalidraw may load after Mappy or be reloaded; re-check on every layout change.
    this.app.workspace.onLayoutReady(() => { this.bridge.ensureHook(); });
    this.registerEvent(this.app.workspace.on("layout-change", () => { this.bridge.ensureHook(); }));

    this.registerView(VIEW_TYPE, leaf => new MindmapView(leaf, store, this.router));
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
      id: "toggle-mindmap", name: "マップと Markdown を切り替え",
      checkCallback: checking => {
        const map = this.app.workspace.getActiveViewOfType(MindmapView);
        if (map?.file) {
          if (!checking) this.run(() => map.showSource(false), "Markdown を開けませんでした。");
          return true;
        }
        const file = this.app.workspace.getActiveViewOfType(MarkdownView)?.file;
        if (file?.extension !== "md") return false;
        if (!checking) this.open(file, false);
        return true;
      },
    });
    this.addCommand({
      id: "set-default-map", name: "このノートを既定でマップとして開く",
      checkCallback: checking => {
        const file = this.activeFile();
        if (!file) return false;
        if (!checking) {
          const layout = this.app.workspace.getActiveViewOfType(MindmapView)?.snapshot()?.mode ?? "mindmap";
          this.run(() => writeMapLayout(this.app, file, layout), "設定を書き込めませんでした。");
        }
        return true;
      },
    });
    this.addCommand({
      id: "unset-default-map", name: "既定でマップとして開く設定を解除",
      checkCallback: checking => {
        const file = this.activeFile();
        if (!file || readMapLayout(this.app, file) === null) return false;
        if (!checking) this.run(() => writeMapLayout(this.app, file, null), "設定を書き込めませんでした。");
        return true;
      },
    });
    this.addCommand({
      id: "insert-into-excalidraw", name: "現在のマップを Excalidraw の図面に挿入",
      checkCallback: checking => {
        const snapshot = this.app.workspace.getActiveViewOfType(MindmapView)?.snapshot()
          ?? this.markdownSnapshot();
        if (!snapshot || !this.bridge.available) return false;
        if (!checking) this.run(() => this.bridge.insertIntoActiveDrawing(snapshot), "Excalidraw への挿入に失敗しました。");
        return true;
      },
    });
    this.addCommand({
      id: "convert-to-list", name: "現在のマップをリスト形式に変更",
      checkCallback: checking => {
        const map = this.app.workspace.getActiveViewOfType(MindmapView);
        if (!map?.file) return false;
        if (!checking) this.run(() => map.convertToList(), "形式を変更できませんでした。");
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
      const current = readMapLayout(this.app, file);
      menu.addItem(item => item.setTitle(current ? "既定でマップとして開く設定を解除" : "既定でマップとして開く").setIcon("git-fork")
        .onClick(() => { this.run(() => writeMapLayout(this.app, file, current ? null : "mindmap"), "設定を書き込めませんでした。"); }));
    }));
  }

  private activeFile(): TFile | null {
    const map = this.app.workspace.getActiveViewOfType(MindmapView);
    const file = map?.file ?? this.app.workspace.getActiveViewOfType(MarkdownView)?.file ?? this.app.workspace.getActiveFile();
    return file?.extension === "md" ? file : null;
  }

  /** A Markdown note is exported as it would open: frontmatter layout, nothing collapsed. */
  private markdownSnapshot(): { file: TFile; mode: "mindmap" | "timeline"; collapsed: ReadonlySet<string> } | null {
    const file = this.app.workspace.getActiveViewOfType(MarkdownView)?.file;
    if (file?.extension !== "md") return null;
    return { file, mode: readMapLayout(this.app, file) ?? "mindmap", collapsed: new Set() };
  }

  private run(action: () => Promise<void>, fallback: string): void {
    void action().catch((error: unknown) => { new Notice(error instanceof Error ? error.message : fallback); });
  }

  private open(file: TFile, split: boolean): void {
    const workspace = this.app.workspace;
    const map = workspace.getActiveViewOfType(MindmapView);
    if (split && map?.file === file) {
      this.run(() => map.showSource(true), "Markdown を開けませんでした。");
      return;
    }
    const current: WorkspaceLeaf = workspace.getActiveViewOfType(MarkdownView)?.leaf ?? workspace.getLeaf(false);
    const leaf = split ? workspace.createLeafBySplit(current, "vertical", true) : current;
    this.run(() => this.router.openMap(leaf, file), "マップを開けませんでした。");
  }
}
