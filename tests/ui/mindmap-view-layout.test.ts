// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { TFile } from "obsidian";
import { MindmapView } from "../../src/ui/mindmap-view";
import type { DocumentStore } from "../../src/obsidian/document-store";
import type { ViewRouter } from "../../src/obsidian/view-routing";

vi.mock("obsidian", () => {
  class TFile {
    path = "";
    get name(): string { return this.path.split("/").pop() ?? ""; }
    get basename(): string { return this.name.replace(/\.[^.]+$/u, ""); }
    get extension(): string { return this.name.includes(".") ? this.name.split(".").pop() ?? "" : ""; }
  }
  /** The FileView members the layout preference passes through: `setState` resolves the state's `file`, `getState` reports it. */
  class FileView {
    app: { vault: { getAbstractFileByPath(path: string): TFile | null } };
    contentEl = document.createElement("div");
    scope: unknown = null;
    allowNoFile = false;
    navigation = true;
    file: TFile | null = null;
    constructor(public leaf: { app: unknown }) { this.app = leaf.app as FileView["app"]; }
    getState(): Record<string, unknown> { return this.file ? { file: this.file.path } : {}; }
    setState(state: { file?: string | null }): Promise<void> {
      if (Object.prototype.hasOwnProperty.call(state, "file")) {
        const found = typeof state.file === "string" ? this.app.vault.getAbstractFileByPath(state.file) : null;
        this.file = found instanceof TFile ? found : null;
      }
      return Promise.resolve();
    }
    onClose(): Promise<void> { return Promise.resolve(); }
    onUnloadFile(): Promise<void> { return Promise.resolve(); }
    onRename(): Promise<void> { return Promise.resolve(); }
  }
  return {
    FileView,
    MarkdownView: class {},
    Menu: class {},
    Notice: class {},
    Scope: class { register(): void { /* The view registers F2 on construction; this test does not press keys. */ } },
    TFile,
    setIcon: vi.fn(),
  };
});

vi.mock("../../src/ui/node-renderer", () => ({ NodeRenderer: class {} }));
vi.mock("../../src/ui/map-viewport", () => ({ MapViewport: class {} }));
vi.mock("../../src/ui/map-events", () => ({ MapEvents: class {} }));
vi.mock("../../src/ui/node-drag", () => ({ NodeDrag: class {} }));
vi.mock("../../src/ui/edit-modal", () => ({ EditModal: class {} }));
vi.mock("../../src/ui/inline-editor", () => ({ InlineEditor: class {} }));
vi.mock("../../src/ui/link-suggest", () => ({ LinkSuggest: class {} }));

function fixture() {
  const properties: Record<string, unknown> = { mappy: true };
  const file = new TFile();
  file.path = "Map.md";
  const processFrontMatter = vi.fn((_file, change: (value: Record<string, unknown>) => void) => {
    change(properties);
    return Promise.resolve();
  });
  const app = {
    vault: { getAbstractFileByPath: vi.fn(() => file) },
    metadataCache: { getFileCache: vi.fn(() => ({ frontmatter: properties })) },
    fileManager: { processFrontMatter },
    workspace: { requestSaveLayout: vi.fn() },
  };
  const view = new MindmapView(
    { app } as never,
    {} as DocumentStore,
    {} as ViewRouter,
  );
  view.file = file;
  return { app, file, processFrontMatter, properties, view };
}

describe("MindmapView layout preference", () => {
  it.each(["timeline", "hierarchy", "balanced"] as const)("persists an explicit %s selection and restores it in a new map view", async layout => {
    const { app, processFrontMatter, properties, view } = fixture();
    const draw = vi.spyOn(view as unknown as { draw: () => void }, "draw").mockImplementation(() => undefined);

    (view as unknown as { selectMode(mode: typeof layout): void }).selectMode(layout);
    await vi.waitFor(() => { expect(processFrontMatter).toHaveBeenCalledTimes(1); });

    expect(properties).toEqual({ mappy: true, "mappy-layout": layout });
    expect(draw).toHaveBeenCalledTimes(1);
    expect(app.workspace.requestSaveLayout).toHaveBeenCalledTimes(1);

    const restored = new MindmapView(
      { app } as never,
      {} as DocumentStore,
      {} as ViewRouter,
    );
    await restored.setState({ file: "Map.md" }, {} as never);
    expect(restored.snapshot()?.mode).toBe(layout);
    // The view state (leaf history, workspace layout) carries the layout as well.
    expect(restored.getState()).toMatchObject({ file: "Map.md", layout });
    const fromState = new MindmapView({ app } as never, {} as DocumentStore, {} as ViewRouter);
    await fromState.setState({ file: "Map.md", layout }, {} as never);
    expect(fromState.snapshot()?.mode).toBe(layout);
  });

  it("ignores an unknown layout in the view state and opens the note with its own preference", async () => {
    const { app, properties } = fixture();
    properties["mappy-layout"] = "hierarchy";
    const view = new MindmapView({ app } as never, {} as DocumentStore, {} as ViewRouter);
    await view.setState({ file: "Map.md", layout: "issue-tree" }, {} as never);
    expect(view.snapshot()?.mode).toBe("hierarchy");
  });

  it("removes the optional layout key when the user selects the regular map", async () => {
    const { processFrontMatter, properties, view } = fixture();
    properties["mappy-layout"] = "timeline";
    await view.setState({ file: "Map.md", layout: "timeline" }, {} as never);
    vi.spyOn(view as unknown as { draw: () => void }, "draw").mockImplementation(() => undefined);

    (view as unknown as { selectMode(mode: "mindmap"): void }).selectMode("mindmap");
    await vi.waitFor(() => { expect(processFrontMatter).toHaveBeenCalledTimes(1); });

    expect(properties).toEqual({ mappy: true });
  });
});
