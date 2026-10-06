import { MarkdownView, Notice, Plugin, TFile, getLanguage, type WorkspaceLeaf } from "obsidian";
import { setLanguage, t } from "./i18n";
import { DocumentStore } from "./obsidian/document-store";
import { ExcalidrawBridge, type ImportRequest } from "./obsidian/excalidraw-bridge";
import {
  isMappyCandidate, readMapLayout, readPreferredMapLayout, writeMapLayout,
} from "./obsidian/frontmatter";
import { canSaveAttachments } from "./obsidian/image-export";
import { createMindmapFile, newMapSourcePath } from "./obsidian/map-files";
import { MapSearchModal } from "./obsidian/map-search";
import { runRibbon } from "./obsidian/ribbon";
import { DEFAULT_SETTINGS, normalizeSettings, showDefaultLayout, type MappySettings } from "./obsidian/settings";
import { MappySettingTab } from "./obsidian/settings-tab";
import type { LayoutMode } from "./layout/layout";
import { ViewRouter } from "./obsidian/view-routing";
import { canRasterizeForeignObject } from "./export/svg-capture";
import { ExportModal } from "./ui/export-modal";
import { rescueExitDrafts } from "./ui/exit-draft-recovery";
import { installExitDrafts } from "./ui/exit-drafts";
import { HOVER_SOURCE } from "./ui/link-preview";
import { MapEmbeds } from "./ui/map-embed";
import { MindmapView, VIEW_TYPE, type MapMenuAction } from "./ui/mindmap-view";
import { paintMap } from "./ui/offscreen-map";

export default class MappyPlugin extends Plugin {
  private router!: ViewRouter;
  private bridge!: ExcalidrawBridge;
  private settings: MappySettings = DEFAULT_SETTINGS;

  async onload(): Promise<void> {
    // Before anything shows text: Japanese when Obsidian runs in Japanese, English otherwise (src/i18n).
    setLanguage(getLanguage());
    // Missing or old data falls back field by field, so an unset option behaves as before the settings existed.
    this.settings = normalizeSettings(await this.loadData());
    this.addSettingTab(new MappySettingTab(this.app, this, {
      current: () => this.settings,
      save: next => this.saveSettings(next),
    }));
    const store = new DocumentStore(this.app);
    this.router = new ViewRouter({
      mapViewType: VIEW_TYPE,
      isMapFile: path => {
        const file = this.app.vault.getFileByPath(path);
        return file !== null && file.extension === "md" && readMapLayout(this.app, file) !== null;
      },
    });
    this.register(this.router.install());
    this.bridge = new ExcalidrawBridge(this.app, store, undefined, message => { new Notice(message); },
      (file, options) => paintMap(this.app, store, file, { ...options, owner: this }));
    this.register(() => { this.bridge.dispose(); });
    // Excalidraw may load after Mappy or be reloaded; re-check on every layout change.
    this.app.workspace.onLayoutReady(() => { this.bridge.ensureHook(); });
    this.registerEvent(this.app.workspace.on("layout-change", () => { this.bridge.ensureHook(); }));

    // The view's 操作 popover (§5 M3) offers, after its own Markdown switch, the two routes that live here (a modal
    // each) through the same callbacks as the commands below; the view only learns their names, lines, icons and
    // checks. The Excalidraw insertion stays a command only.
    const menuActions: MapMenuAction[] = [
      { title: t().cmdCallMap, description: t().popCallDesc, icon: "search",
        check: map => map.file !== null, run: map => { this.searchAndCallMap(map); } },
      { title: t().popExport, description: t().popExportDesc, icon: "image-down",
        check: map => map.file !== null && canSaveAttachments(this.app), run: map => { this.exportMapImage(map); } },
    ];
    // Page preview's switch for the map's links (LEV-265): ⌘／Ctrl by default, as in the Markdown editor, so moving
    // the pointer across a map does not open a popover at every link it passes.
    this.registerHoverLinkSource(HOVER_SOURCE, { display: "Mappy", defaultMod: true });
    this.registerView(VIEW_TYPE, leaf => {
      const view = new MindmapView(leaf, store, this.router, menuActions);
      view.setTheme(this.settings.theme);
      view.setVisibleLayouts(this.settings.visibleLayouts);
      return view;
    });
    // A title draft open when the window reloads or Obsidian quits, neither of which closes the view (LEV-230).
    installExitDrafts(this, this.app, store, () => this.app.workspace.getLeavesOfType(VIEW_TYPE)
      .map(leaf => leaf.view).filter((view): view is MindmapView => view instanceof MindmapView));
    // `![[map]]` in other notes (§5 M10). Cleanups run last-in-first-out, so on unload the processor is
    // unregistered first and the release below puts the plain embeds back without a new map taking over.
    const embeds = new MapEmbeds(this.app, store);
    this.register(() => { embeds.dispose(); });
    this.registerMarkdownPostProcessor(embeds.processor);
    this.addCommand({
      id: "create-mindmap", name: t().cmdCreateMap,
      callback: () => { this.createMap(); },
    });
    this.addCommand({
      id: "convert-note-to-mindmap", name: t().cmdConvertNote,
      checkCallback: checking => {
        const file = this.activeFile();
        if (!file || !isMappyCandidate(this.app, file) || readMapLayout(this.app, file) !== null) return false;
        if (!checking) this.enableMap(file);
        return true;
      },
    });
    this.addCommand({
      id: "open-mindmap", name: t().cmdOpen,
      checkCallback: checking => {
        const file = this.activeFile();
        const layout = file ? readMapLayout(this.app, file) : null;
        if (!file || !layout) return false;
        if (!checking) this.run(() => this.open(file, false, layout), t().openFailed);
        return true;
      },
    });
    this.addCommand({
      id: "open-mindmap-split", name: t().cmdOpenSplit,
      checkCallback: checking => {
        const file = this.activeFile();
        const layout = file ? readMapLayout(this.app, file) : null;
        if (!file || !layout) return false;
        if (!checking) this.run(() => this.open(file, true, layout), t().openFailed);
        return true;
      },
    });
    this.addCommand({
      id: "toggle-mindmap", name: t().cmdToggle,
      checkCallback: checking => {
        const map = this.app.workspace.getActiveViewOfType(MindmapView);
        if (map?.file) {
          if (!checking) this.run(() => map.showSource(false), t().markdownOpenFailed);
          return true;
        }
        const file = this.app.workspace.getActiveViewOfType(MarkdownView)?.file;
        const layout = file ? readMapLayout(this.app, file) : null;
        if (!file || !layout) return false;
        if (!checking) this.run(() => this.open(file, false, layout), t().openFailed);
        return true;
      },
    });
    this.addCommand({
      id: "remove-mindmap", name: t().cmdRemove,
      checkCallback: checking => {
        const file = this.activeFile();
        if (!file || readMapLayout(this.app, file) === null) return false;
        if (!checking) this.run(() => this.disableMap(file), t().removeFailed);
        return true;
      },
    });
    this.addCommand({
      id: "insert-into-excalidraw", name: t().cmdInsertExcalidraw,
      checkCallback: checking => {
        const snapshot = this.app.workspace.getActiveViewOfType(MindmapView)?.snapshot()
          ?? this.markdownSnapshot();
        if (!snapshot || !this.bridge.available) return false;
        if (!checking) this.insertIntoExcalidraw(snapshot);
        return true;
      },
    });
    this.addCommand({
      id: "export-map-image", name: t().cmdExport,
      checkCallback: checking => {
        const map = this.app.workspace.getActiveViewOfType(MindmapView);
        if (!map?.file || !canSaveAttachments(this.app)) return false;
        if (!checking) this.exportMapImage(map);
        return true;
      },
    });
    this.addCommand({
      id: "call-map", name: t().cmdCallMap,
      checkCallback: checking => {
        const map = this.app.workspace.getActiveViewOfType(MindmapView);
        if (!map?.file) return false;
        if (!checking) this.searchAndCallMap(map);
        return true;
      },
    });
    this.addCommand({
      id: "convert-to-list", name: t().cmdConvertToList,
      checkCallback: checking => {
        const map = this.app.workspace.getActiveViewOfType(MindmapView);
        if (!map?.file) return false;
        if (!checking) this.run(() => map.convertToList(), t().formatFailed);
        return true;
      },
    });
    // A draft kept at a reload or quit that could not be written stays kept; this saves it to a separate file (LEV-240).
    this.addCommand({
      id: "rescue-exit-drafts", name: t().cmdRescueDrafts,
      callback: () => { rescueExitDrafts(this.app); },
    });
    this.addRibbonIcon("git-fork", t().cmdOpen, () => {
      runRibbon(this.app, this.activeFile(), {
        open: (file, layout) => { this.run(() => this.open(file, false, layout), t().openFailed); },
        create: () => { this.createMap(); },
        notReady: () => { new Notice(t().noteNotIndexed); },
        convertFirst: () => { new Notice(t().convertFirst(t().cmdConvertNote)); },
      });
    });
    this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => {
      if (!(file instanceof TFile) || !isMappyCandidate(this.app, file)) return;
      const layout = readMapLayout(this.app, file);
      if (!layout) {
        menu.addItem(item => item.setTitle(t().cmdConvertNote).setIcon("git-fork")
          .onClick(() => { this.enableMap(file); }));
        return;
      }
      menu.addItem(item => item.setTitle(t().cmdOpen).setIcon("git-fork")
        .onClick(() => { this.run(() => this.open(file, false, layout), t().openFailed); }));
      menu.addItem(item => item.setTitle(t().menuRemove).setIcon("file-text")
        .onClick(() => { this.run(() => this.disableMap(file), t().removeFailed); }));
    }));
  }

  /**
   * The command's and the ribbon's route (LEV-300): an untitled map in the settings' folder, with their layout.
   * "Same folder as current file" counts from the active note (`activeFile()` asks the map first, so a map in a
   * sidebar counts too — LEV-89), else from the active file that is not a note (`newMapSourcePath`).
   */
  private createMap(): void {
    this.run(async () => {
      const { defaultLayout: layout, newMapFolder: folder } = this.settings;
      const file = await createMindmapFile(this.app, newMapSourcePath(this.app, this.activeFile()), { layout, folder });
      await this.open(file, false, layout);
    }, t().createFailed);
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

  /** The command's and the 操作 popover's route (§5 M12): pick a map, then the view adds it under the selected node. */
  private searchAndCallMap(map: MindmapView): void {
    const file = map.file;
    if (!file) return;
    new MapSearchModal(this.app, file, target => {
      this.run(() => map.callMap(target), t().callFailed);
    }).open();
  }

  /** The command's route (§5 M6; a command only since LEV-81): the map as shown goes into the last active drawing. */
  private insertIntoExcalidraw(snapshot: ImportRequest | null): void {
    if (!snapshot) return;
    this.run(() => this.bridge.insertIntoActiveDrawing(snapshot), t().excalidrawInsertFailed);
  }

  /** The command's and the 操作 popover's route (§5 M13): choose the format, then the view captures what it shows. */
  private exportMapImage(map: MindmapView): void {
    this.run(async () => {
      const png = await canRasterizeForeignObject();
      new ExportModal(this.app, png, format => {
        this.run(async () => { new Notice(t().exportedTo((await map.exportImage(format)).path)); }, t().exportFailed);
      }).open();
    }, t().exportStartFailed);
  }

  /**
   * Settings are presentation and defaults for new maps only: saving one never touches a note. The new
   * value is current as soon as it is asked for (the tab reads it back for its next change) and put
   * back if the data file cannot be written, so what the tab shows after its own revert is what is stored.
   */
  private async saveSettings(asked: MappySettings): Promise<void> {
    // The default layout's button is always shown (LEV-257), whoever asks for the save.
    const next = showDefaultLayout(asked);
    const previous = this.settings;
    const themeChanged = next.theme !== previous.theme;
    // Both lists are normalized (LAYOUT_MODES order, no repeats), so their text is their identity.
    const layoutsChanged = next.visibleLayouts.join() !== previous.visibleLayouts.join();
    this.settings = next;
    try {
      await this.saveData(next);
    } catch (error) {
      if (this.settings === next) this.settings = previous;
      throw error;
    }
    if (!themeChanged && !layoutsChanged) return;
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      if (!(leaf.view instanceof MindmapView)) continue;
      if (themeChanged) leaf.view.setTheme(next.theme);
      if (layoutsChanged) leaf.view.setVisibleLayouts(next.visibleLayouts);
    }
  }

  private enableMap(file: TFile): void {
    const layout = readPreferredMapLayout(this.app, file, this.settings.defaultLayout);
    this.run(async () => {
      await writeMapLayout(this.app, file, layout);
      await this.open(file, false, layout);
    }, t().convertNoteFailed);
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
