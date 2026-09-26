// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { TFile } from "obsidian";
import { MindmapView } from "../../src/ui/mindmap-view";
import { DocumentStore } from "../../src/obsidian/document-store";
import { readMapFromSource } from "../../src/core/embed";
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

/**
 * A map note held as text, as Obsidian holds it: the button writes through the view's store (LEV-196), and the
 * metadata cache reports the frontmatter of whatever the text says now — the same verdict `readMapLayout` gives.
 */
function fixture(initial = "---\nmappy: true\n---\n## Map\n\n- Node\n") {
  let text = initial;
  const file = new TFile();
  file.path = "Map.md";
  const frontmatter = (): Record<string, unknown> => {
    const layout = readMapFromSource(text);
    return layout === null ? {} : { mappy: true, ...(text.includes("mappy-layout:") ? { "mappy-layout": layout } : {}) };
  };
  const process = vi.fn((_file: TFile, change: (current: string) => string) => {
    text = change(text);
    return Promise.resolve(text);
  });
  const app = {
    vault: { getAbstractFileByPath: vi.fn(() => file), read: vi.fn(() => Promise.resolve(text)), process },
    metadataCache: { getFileCache: vi.fn(() => ({ frontmatter: frontmatter() })) },
    workspace: { requestSaveLayout: vi.fn(), getLeavesOfType: vi.fn(() => []) },
  };
  const store = new DocumentStore(app);
  const view = new MindmapView({ app } as never, store, {} as ViewRouter);
  view.file = file;
  return { app, file, process, store, text: () => text, view };
}

describe("MindmapView layout preference", () => {
  it.each(["timeline", "hierarchy", "balanced"] as const)("persists an explicit %s selection and restores it in a new map view", async layout => {
    const { app, process, store, text, view } = fixture();
    const draw = vi.spyOn(view as unknown as { draw: () => void }, "draw").mockImplementation(() => undefined);

    (view as unknown as { selectMode(mode: typeof layout): void }).selectMode(layout);
    await vi.waitFor(() => { expect(process).toHaveBeenCalledTimes(1); });

    // Only the key's line is written; the rest of the note keeps its bytes.
    expect(text()).toBe(`---\nmappy: true\nmappy-layout: ${layout}\n---\n## Map\n\n- Node\n`);
    expect(draw).toHaveBeenCalledTimes(1);
    expect(app.workspace.requestSaveLayout).toHaveBeenCalledTimes(1);

    const restored = new MindmapView({ app } as never, store, {} as ViewRouter);
    await restored.setState({ file: "Map.md" }, {} as never);
    expect(restored.snapshot()?.mode).toBe(layout);
    // The view state (leaf history, workspace layout) carries the layout as well.
    expect(restored.getState()).toMatchObject({ file: "Map.md", layout });
    const fromState = new MindmapView({ app } as never, store, {} as ViewRouter);
    await fromState.setState({ file: "Map.md", layout }, {} as never);
    expect(fromState.snapshot()?.mode).toBe(layout);
  });

  it("ignores an unknown layout in the view state and opens the note with its own preference", async () => {
    const { app, store } = fixture("---\nmappy: true\nmappy-layout: hierarchy\n---\n## Map\n");
    const view = new MindmapView({ app } as never, store, {} as ViewRouter);
    await view.setState({ file: "Map.md", layout: "issue-tree" }, {} as never);
    expect(view.snapshot()?.mode).toBe("hierarchy");
  });

  it("removes the optional layout key when the user selects the regular map", async () => {
    const { process, text, view } = fixture("---\ntags: [a]\nmappy: true\nmappy-layout: timeline\n---\n## Map\n");
    await view.setState({ file: "Map.md", layout: "timeline" }, {} as never);
    vi.spyOn(view as unknown as { draw: () => void }, "draw").mockImplementation(() => undefined);

    (view as unknown as { selectMode(mode: "mindmap"): void }).selectMode("mindmap");
    await vi.waitFor(() => { expect(process).toHaveBeenCalledTimes(1); });

    expect(text()).toBe("---\ntags: [a]\nmappy: true\n---\n## Map\n");
  });
});
