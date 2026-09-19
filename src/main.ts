import { MarkdownView, Notice, Plugin, TFile, type WorkspaceLeaf } from "obsidian";
import { DocumentStore } from "./obsidian/document-store";
import { ExcalidrawBridge } from "./obsidian/excalidraw-bridge";
import {
  isMappyCandidate, readMapLayout, readPreferredMapLayout, writeMapLayout,
} from "./obsidian/frontmatter";
import { createMindmapFile } from "./obsidian/map-files";
import type { LayoutMode } from "./layout/layout";
import { ViewRouter } from "./obsidian/view-routing";
import { MapEmbeds } from "./ui/map-embed";
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
    // `![[map]]` in other notes (§5 M10). Cleanups run last-in-first-out, so on unload the processor is
    // unregistered first and the release below puts the plain embeds back without a new map taking over.
    const embeds = new MapEmbeds(this.app, store);
    this.register(() => { embeds.dispose(); });
    this.registerMarkdownPostProcessor(embeds.processor);
    this.addCommand({
      id: "create-mindmap", name: "新しいマインドマップを作成",
      callback: () => {
        this.run(async () => {
          const sourcePath = this.app.workspace.getActiveFile()?.path ?? "";
          const file = await createMindmapFile(this.app, sourcePath);
          await this.open(file, false, "mindmap");
        }, "マインドマップを作成できませんでした。");
      },
    });
    this.addCommand({
      id: "convert-note-to-mindmap", name: "このノートをマインドマップ化",
      checkCallback: checking => {
        const file = this.activeFile();
        if (!file || !isMappyCandidate(this.app, file) || readMapLayout(this.app, file) !== null) return false;
        if (!checking) this.enableMap(file);
        return true;
      },
    });
    this.addCommand({
      id: "open-mindmap", name: "マインドマップを開く",
      checkCallback: checking => {
        const file = this.activeFile();
        const layout = file ? readMapLayout(this.app, file) : null;
        if (!file || !layout) return false;
        if (!checking) this.run(() => this.open(file, false, layout), "マップを開けませんでした。");
        return true;
      },
    });
    this.addCommand({
      id: "open-mindmap-split", name: "マインドマップと Markdown を並べる",
      checkCallback: checking => {
        const file = this.activeFile();
        const layout = file ? readMapLayout(this.app, file) : null;
        if (!file || !layout) return false;
        if (!checking) this.run(() => this.open(file, true, layout), "マップを開けませんでした。");
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
        const layout = file ? readMapLayout(this.app, file) : null;
        if (!file || !layout) return false;
        if (!checking) this.run(() => this.open(file, false, layout), "マップを開けませんでした。");
        return true;
      },
    });
    this.addCommand({
      id: "remove-mindmap", name: "このノートのマインドマップ化を解除",
      checkCallback: checking => {
        const file = this.activeFile();
        if (!file || readMapLayout(this.app, file) === null) return false;
        if (!checking) this.run(() => this.disableMap(file), "マインドマップ化を解除できませんでした。");
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
      const layout = file ? readMapLayout(this.app, file) : null;
      if (file && layout) this.run(() => this.open(file, false, layout), "マップを開けませんでした。");
      else if (file && isMappyCandidate(this.app, file)) new Notice("先に「このノートをマインドマップ化」を実行してください。");
      else new Notice("Markdown ノートを開いてください。");
    });
    this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => {
      if (!(file instanceof TFile) || !isMappyCandidate(this.app, file)) return;
      const layout = readMapLayout(this.app, file);
      if (!layout) {
        menu.addItem(item => item.setTitle("このノートをマインドマップ化").setIcon("git-fork")
          .onClick(() => { this.enableMap(file); }));
        return;
      }
      menu.addItem(item => item.setTitle("マインドマップを開く").setIcon("git-fork")
        .onClick(() => { this.run(() => this.open(file, false, layout), "マップを開けませんでした。"); }));
      menu.addItem(item => item.setTitle("マインドマップ化を解除").setIcon("file-text")
        .onClick(() => { this.run(() => this.disableMap(file), "マインドマップ化を解除できませんでした。"); }));
    }));
  }

  private activeFile(): TFile | null {
    const map = this.app.workspace.getActiveViewOfType(MindmapView);
    const file = map?.file ?? this.app.workspace.getActiveViewOfType(MarkdownView)?.file ?? this.app.workspace.getActiveFile();
    return file?.extension === "md" ? file : null;
  }

  /** A Markdown note is exported as it would open: frontmatter layout, nothing collapsed. */
  private markdownSnapshot(): { file: TFile; mode: LayoutMode; collapsed: ReadonlySet<string> } | null {
    const file = this.app.workspace.getActiveViewOfType(MarkdownView)?.file;
    const mode = file ? readMapLayout(this.app, file) : null;
    if (!file || !mode) return null;
    return { file, mode, collapsed: new Set() };
  }

  private run(action: () => Promise<void>, fallback: string): void {
    void action().catch((error: unknown) => { new Notice(error instanceof Error ? error.message : fallback); });
  }

  private enableMap(file: TFile): void {
    const layout = readPreferredMapLayout(this.app, file);
    this.run(async () => {
      await writeMapLayout(this.app, file, layout);
      await this.open(file, false, layout);
    }, "ノートをマインドマップ化できませんでした。");
  }

  private async disableMap(file: TFile): Promise<void> {
    await writeMapLayout(this.app, file, null);
    const map = this.app.workspace.getActiveViewOfType(MindmapView);
    if (map?.file === file) await map.showSource(false);
  }

  private open(file: TFile, split: boolean, layout: LayoutMode): Promise<void> {
    const workspace = this.app.workspace;
    const map = workspace.getActiveViewOfType(MindmapView);
    if (split && map?.file === file) {
      return map.showSource(true);
    }
    const current: WorkspaceLeaf = workspace.getActiveViewOfType(MarkdownView)?.leaf ?? workspace.getLeaf(false);
    const leaf = split ? workspace.createLeafBySplit(current, "vertical", true) : current;
    return this.router.openMap(leaf, file, true, layout);
  }
}
